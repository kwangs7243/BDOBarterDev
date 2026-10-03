import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.BDO_TEST_PORT ?? 18813);
const baseUrl = `http://127.0.0.1:${port}/`;
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-release-ui-audit-"));
const database = join(profile, "isolated.sqlite3");
const masterDatabase = join(profile, "master", "master.sqlite3");
const pythonCode = `from local_app.backend.app import create_app; create_app(r'${database}', master_database_path=r'${masterDatabase}', testing=True).run(host='127.0.0.1', port=${port}, use_reloader=False, threaded=True)`;
let server;
let chrome;
let socket;
let serverOutput = "";
const fatalConsole = [];
const failedLocalRequests = [];

async function waitFor(predicate, label, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await delay(70);
  }
  throw new Error(`Timed out waiting for ${label}${serverOutput ? `; server: ${serverOutput}` : ""}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await exited;
}

try {
  server = spawn(python, ["-B", "-c", pythonCode], {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated app server");

  chrome = spawn(chromePath, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*",
    `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  const portText = await waitFor(async () => {
    try { return await readFile(join(profile, "chrome-profile", "DevToolsActivePort"), "utf8"); } catch { return false; }
  }, "Chrome DevTools");
  const debugPort = portText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  assert.equal(targetResponse.ok, true, `Chrome target create failed: ${targetResponse.status}`);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") fatalConsole.push(message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      fatalConsole.push(message.params.args.map((item) => item.value ?? item.description ?? "").join(" "));
    }
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400) {
      const url = message.params.response.url;
      if (url.startsWith(baseUrl) && !url.endsWith("/favicon.ico")) failedLocalRequests.push(`${message.params.response.status} ${url}`);
    }
    if (message.method === "Network.loadingFailed") {
      const url = message.params.requestId && requestUrls.get(message.params.requestId);
      if (url?.startsWith(baseUrl)) failedLocalRequests.push(`${message.params.errorText} ${url}`);
    }
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  const requestUrls = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent") requestUrls.set(message.params.requestId, message.params.request.url);
  });
  const send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveMessage, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression: `(()=>eval(${JSON.stringify(expression)}))()`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  const click = async (selector) => {
    const found = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`);
    assert.equal(found, true, `missing clickable element: ${selector}`);
  };
  const waitOpen = async (id) => waitFor(async () => evaluate(`document.getElementById(${JSON.stringify(id)})?.open === true`), `${id} open`);
  const close = async (id, selector) => {
    await click(selector);
    await waitFor(async () => evaluate(`document.getElementById(${JSON.stringify(id)})?.open === false`), `${id} close`);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await waitFor(async () => evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.inventory-row').length === 70"), "app workspace ready");

  const structure = await evaluate(`JSON.stringify((()=>{
    const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);
    const dialogs=[...document.querySelectorAll('dialog')].map(d=>({id:d.id,open:d.open,label:d.getAttribute('aria-labelledby'),title:d.getAttribute('aria-labelledby')?document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim():null}));
    const brokenLabels=dialogs.filter(d=>d.open&&(!d.label||!d.title));
    const unnamedButtons=[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.disabled&&!b.getAttribute('aria-hidden')&&!((b.getAttribute('aria-label')||b.textContent||b.title||'').trim())).map(b=>b.outerHTML.slice(0,180));
    const brokenFor=[...document.querySelectorAll('label[for]')].filter(l=>!document.getElementById(l.htmlFor)).map(l=>l.htmlFor);
    const tabs=[...document.querySelectorAll('[role=tab]')].map(t=>({name:(t.getAttribute('aria-label')||t.textContent).trim(),selected:t.getAttribute('aria-selected'),controls:t.getAttribute('aria-controls')}));
    return {duplicateIds:ids.filter((id,i)=>ids.indexOf(id)!==i),dialogs,brokenLabels,unnamedButtons,brokenFor,tabs,staleMaster:document.querySelector('.trade-master-safety')?.textContent,finalMessage:document.querySelector('#trade-final-review-dialog')?.textContent};
  })())`);
  const staticAudit = JSON.parse(structure);
  assert.deepEqual(staticAudit.duplicateIds, [], "HTML has no duplicate IDs");
  assert.deepEqual(staticAudit.brokenLabels, [], "all dialog aria-labelledby references resolve to a title");
  assert.deepEqual(staticAudit.unnamedButtons, [], "visible enabled buttons have accessible names");
  assert.deepEqual(staticAudit.brokenFor, [], "label[for] references resolve");
  assert.ok(staticAudit.tabs.every((tab) => tab.selected === "true" || tab.selected === "false"), "tabs expose selected state");
  assert.ok(staticAudit.tabs.every((tab) => !tab.controls || documentHasId(staticAudit, tab.controls)), "tab controls resolve");

  const staleText = await evaluate(`(()=>{
    const text=document.body.innerText;
    return ["미지원 · M3 예정","저장 기능은 다음 단계에서 활성화됩니다","현재 단계에서는 변경 내용이 저장되거나 인식에 적용되지 않습니다.","검수 완료. 다음 단계에서 검수 자료를 저장"].filter(x=>text.includes(x));
  })()`);
  assert.deepEqual(staleText, [], "completed feature surfaces do not contain stale M2/M3/save instructions");

  const viewports = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 720], [640, 720]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(120);
    const metrics = await evaluate(`(()=>{
      const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0&&r.left<innerWidth&&r.right>0};
      const buttons=['#open-trade-capture','#open-json-import','#add-manual-trade','#open-warehouse-scan'].map(s=>document.querySelector(s));
      return {width:innerWidth,height:innerHeight,docScroll:document.documentElement.scrollWidth,bodyScroll:document.body.scrollWidth,bodyClient:document.body.clientWidth,buttons:buttons.map(e=>e&&visible(e)),sessionCount:visible(document.querySelector('#session-trade-count'))};
    })()`);
    assert.equal(metrics.docScroll <= width + 1, true, `${width}x${height} document horizontal overflow: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.bodyScroll <= metrics.bodyClient + 1, true, `${width}x${height} body horizontal overflow: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.buttons.slice(0, 2).every(Boolean), `${width}x${height} capture and JSON actions remain reachable: ${JSON.stringify(metrics)}`);
    if (width >= 768) assert.ok(metrics.buttons.every(Boolean), `${width}x${height} supporting actions remain in the initial workspace: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.sessionCount, true, `${width}x${height} current-session status remains visible`);
    viewports.push({ width, height, overflow: false, actionsReachable: true });
  }

  for (const [id, opener, closer] of [
    ["trade-capture-dialog", "#open-trade-capture", "#trade-capture-dialog [data-close-trade-capture]"],
    ["json-import-dialog", "#open-json-import", "#json-import-dialog [data-close-dialog]"],
    ["schedule-dialog", "#open-schedule", "#schedule-dialog [data-close-dialog]"],
    ["tuning-dialog", "#open-tuning", "#tuning-dialog [data-close-dialog]"],
    ["map-tools-dialog", "#open-map-tools", "#map-tools-dialog [data-close-dialog]"],
    ["trade-master-dialog", "#open-trade-master", "#trade-master-dialog [data-master-close]"],
    ["warehouse-scan-dialog", "#open-warehouse-scan", "#warehouse-scan-dialog [data-action=close]"],
  ]) {
    await click(opener);
    await waitOpen(id);
    const dialog = await evaluate(`(()=>{const d=document.getElementById(${JSON.stringify(id)}),label=d.getAttribute('aria-labelledby'),title=label&&document.getElementById(label),close=d.querySelector(${JSON.stringify(closer.slice(closer.indexOf(" ")+1))});const r=d.getBoundingClientRect(),c=close?.getBoundingClientRect();return {title:title?.textContent.trim(),closeName:close?.getAttribute('aria-label')||close?.textContent.trim(),closeVisible:!!c&&c.width>0&&c.height>0&&c.right<=innerWidth+2&&c.bottom<=innerHeight+2,scrollable:[...d.querySelectorAll('.dialog-body,[class*=content]')].some(e=>e.scrollHeight>e.clientHeight||getComputedStyle(e).overflowY==='auto'),box:{x:r.x,y:r.y,right:r.right,bottom:r.bottom}}})()`);
    assert.ok(dialog.title, `${id} has a readable accessible title`);
    assert.ok(dialog.closeName, `${id} has a named close control`);
    assert.equal(dialog.closeVisible, true, `${id} close control is visible and reachable`);
    await close(id, closer);
  }

  await click("#open-schedule"); await waitOpen("schedule-dialog");
  await click("#open-engine-diagnostics"); await waitOpen("engine-diagnostics-dialog");
  await close("engine-diagnostics-dialog", "#engine-diagnostics-dialog [data-close-dialog]");
  await close("schedule-dialog", "#schedule-dialog [data-close-dialog]");

  await evaluate("document.getElementById('trade-final-review-dialog').showModal()");
  const finalReview = await evaluate(`(()=>{const d=document.getElementById('trade-final-review-dialog'),id=d.getAttribute('aria-labelledby'),title=document.getElementById(id);return {title:title?.textContent.trim(),hiddenTitle:getComputedStyle(title).clip!=='auto',bounds:(()=>{const r=d.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()}})()`);
  assert.ok(finalReview.title && finalReview.bounds, "full-screen final review has an accessible title and fits the viewport");
  await evaluate("document.getElementById('trade-final-review-dialog').close()");

  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.documentElement.style.setProperty('--app-zoom','1.1');window.__bdoApplyAppZoom?.()");
  await delay(120);
  const zoom = await evaluate("({zoom:getComputedStyle(document.body).zoom,overflow:document.documentElement.scrollWidth>innerWidth,primary:document.querySelector('#open-trade-capture').getBoundingClientRect().width>0})");
  assert.equal(zoom.overflow, false, `zoomed workspace horizontal overflow: ${JSON.stringify(zoom)}`);
  assert.equal(zoom.primary, true, "primary capture CTA remains visible at app zoom");
  await evaluate("document.documentElement.style.removeProperty('--app-zoom');window.__bdoApplyAppZoom?.()");

  await delay(250);
  assert.deepEqual(fatalConsole, [], `browser console/runtime has no fatal errors: ${fatalConsole.join(" | ")}`);
  assert.deepEqual(failedLocalRequests, [], `same-origin app has no unexpected failed requests: ${failedLocalRequests.join(" | ")}`);
  console.log(JSON.stringify({
    ok: true,
    releaseUiAudit: "PASS",
    duplicateIds: 0,
    dialogAccessibleNames: staticAudit.dialogs.length,
    activeTabs: staticAudit.tabs.length,
    completedFeatureStaleWording: "NONE",
    responsiveViewports: viewports,
    majorDialogs: ["capture", "JSON", "briefing", "tuning", "map", "Master", "diagnostics", "warehouse", "final review"],
    appZoom: "PASS",
    consoleFatal: 0,
    failedLocalRequests: 0,
  }, null, 2));
} finally {
  try { if (socket?.readyState === WebSocket.OPEN) socket.close(); } catch {}
  await stopChild(chrome);
  await stopChild(server);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

function documentHasId(audit, id) {
  return audit.dialogs.some((dialog) => dialog.id === id) || ["tuning-root"].includes(id);
}
