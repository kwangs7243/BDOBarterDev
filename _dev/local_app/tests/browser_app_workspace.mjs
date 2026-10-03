import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.BDO_TEST_PORT ?? 18786);
const baseUrl = "http://127.0.0.1:" + port + "/";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-app-workspace-"));
const database = join(profile, "isolated.sqlite3").replaceAll("\\", "/");
const pythonCode = "from local_app.backend.app import create_app; create_app(r'" + database + "', testing=True).run(host='127.0.0.1', port=" + port + ", use_reloader=False, threaded=True)";
const server = spawn(process.env.PYTHON ?? "python", ["-B", "-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
let chrome;
let socket;
const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Timed out waiting for " + label);
};
try {
  await waitFor(async () => { try { return (await fetch(baseUrl + "api/health")).ok; } catch { return false; } }, "isolated app health");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", "--user-data-dir=" + join(profile, "chrome-profile"), "about:blank"], { stdio: "ignore", windowsHide: true });
  const portFile = join(profile, "chrome-profile", "DevToolsActivePort");
  const portText = await waitFor(async () => { try { return await readFile(portFile, "utf8"); } catch { return false; } }, "Chrome DevTools port");
  const debugPort = portText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch("http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent(baseUrl), { method: "PUT" });
  if (!targetResponse.ok) throw new Error("Chrome target create failed: " + targetResponse.status);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveMessage, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression: "(()=>eval(" + JSON.stringify(expression) + "))()", awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "inventory render");

  const ids = ["runtime-status","ship-root","parley-root","presets-root","open-tuning","open-map-tools","reload-state","screen-capture-session","screen-capture-status","connect-screen-capture","disconnect-screen-capture","mainPanel","open-warehouse-scan","inventory-root","trade-session-panel","session-trade-count","open-json-import","open-trade-capture","add-manual-trade","toggle-all-trades","reset-session","remaining-parley","open-schedule","open-map-speed","open-map-balance","trade-import-status","trade-list-root"];
  const structure = JSON.parse(await evaluate("JSON.stringify({ids:" + JSON.stringify(ids) + ".map(id=>[id,!!document.getElementById(id)]),order:[...document.querySelector('.workspace').children].map(node=>node.id),headings:[...document.querySelectorAll('.workspace h2')].map(node=>node.textContent),aria:[document.querySelector('#runtime-status').getAttribute('role'),document.querySelector('#screen-capture-status').getAttribute('aria-live')]})"));
  assert(structure.ids.every(entry => entry[1]), "all protected shell IDs remain");
  assert.deepEqual(structure.order, ["trade-session-panel", "mainPanel"], "DOM order prioritizes current session");
  assert.deepEqual(structure.headings, ["현재 회차", "창고"]);
  assert.deepEqual(structure.aria, ["status", "polite"]);

  const empty = await evaluate("JSON.stringify({heading:document.querySelector('.session-empty-state h3')?.textContent,text:document.querySelector('.session-empty-state')?.textContent,capture:document.querySelector('.session-empty-state .primary')?.textContent,json:[...document.querySelectorAll('.session-empty-state button')].some(button=>button.textContent==='JSON 입력')})");
  const emptyState = JSON.parse(empty);
  assert.equal(emptyState.heading, "현재 회차가 없습니다.");
  assert.equal(emptyState.capture, "물교 화면 가져오기");
  assert.equal(emptyState.json, true);
  assert.match(emptyState.text, /JSON/);

  await evaluate("document.querySelector('.session-empty-state .primary').click()");
  assert.equal(await evaluate("document.querySelector('#trade-capture-dialog').open"), true, "empty capture CTA uses existing capture handler");
  await evaluate("document.querySelector('[data-close-trade-capture]').click()");
  await evaluate("document.querySelector('.session-empty-state button:not(.primary)').click()");
  assert.equal(await evaluate("document.querySelector('#json-import-dialog').open"), true, "empty JSON CTA opens existing import dialog");
  await evaluate("document.querySelector('#json-import-dialog [data-close-dialog]').click()");
  await evaluate("document.querySelector('.header-tools>summary').click()");
  const headerTools = JSON.parse(await evaluate("JSON.stringify({open:document.querySelector('.header-tools').open,tools:[...document.querySelectorAll('.header-tool-actions button')].map(button=>button.id),reload:document.querySelector('#reload-state').getAttribute('aria-label'),screen:document.querySelector('.header-utilities #screen-capture-session')!==null})"));
  assert.equal(headerTools.open, true);
  assert.deepEqual(headerTools.tools, ["open-tuning","open-map-tools","reload-state"]);
  assert.equal(headerTools.reload, "영구 설정 다시 읽기");
  assert.equal(headerTools.screen, true);

  await evaluate("import('/assets/js/state.js').then(async ({state})=>{state.session.scannedTrades=[{island:'A',fromItem:'I',toItem:'O',reqAmount:1,count:2,yield:3},{island:'B',fromItem:'I',toItem:'O',reqAmount:1,count:2,yield:3,disabled:true},{island:'C',fromItem:'I',toItem:'O',reqAmount:1,count:2,yield:3,deleted:true},{island:'D',fromItem:'I',toItem:'O',reqAmount:1,count:2,yield:3}];const m=await import('/assets/js/trade-ui.js');m.renderTradeList();})");
  const summary = await evaluate("JSON.stringify({text:document.querySelector('#session-trade-count').textContent,status:[...document.querySelectorAll('.trade-row-state')].map(node=>node.textContent.trim()),management:document.querySelector('.session-management summary').textContent,resetInManagement:document.querySelector('#reset-session').closest('.session-management')!==null,primary:document.querySelector('#open-trade-capture').classList.contains('primary'),schedule:document.querySelector('#open-schedule').classList.contains('primary'),maps:[document.querySelector('#open-map-speed').classList.contains('primary'),document.querySelector('#open-map-balance').classList.contains('primary')]})");
  const summaryState = JSON.parse(summary);
  assert.match(summaryState.text, /물교 4행/);
  assert.match(summaryState.text, /사용 2/);
  assert.match(summaryState.text, /제외 1/);
  assert.match(summaryState.text, /삭제됨 1/);
  assert.deepEqual(summaryState.status, ["사용","제외","사용삭제됨","사용"]);
  assert.equal(summaryState.management, "회차 관리");
  await evaluate("document.querySelector('.session-management>summary').click()");
  assert.equal(await evaluate("document.querySelector('.session-management').open"), true);
  assert.equal(await evaluate("document.querySelector('#reset-session').closest('.session-management') !== null"), true);
  assert.equal(summaryState.resetInManagement, true);
  assert.equal(summaryState.primary, true);
  assert.equal(summaryState.schedule, true);
  assert.deepEqual(summaryState.maps, [false,false]);

  const viewportResults = [];
  for (const [width,height] of [[1440,900],[1024,768],[768,720]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(100);
    const metrics = JSON.parse(await evaluate("JSON.stringify((()=>{const r=s=>document.querySelector(s).getBoundingClientRect();const visible=s=>{const x=r(s);return x.width>0&&x.height>0&&x.top<innerHeight&&x.bottom>0};const s=r('#trade-session-panel'),i=r('#mainPanel'),capture=r('#open-trade-capture'),budget=r('#remaining-parley'),schedule=r('#open-schedule'),table=r('.trade-session-table thead'),warehouse=r('#mainPanel h2'),scan=r('#open-warehouse-scan'),headerControls=['#runtime-status','#ship-root','#parley-root','#presets-root','.header-tools>summary','#connect-screen-capture'].map(r);return {width:innerWidth,height:innerHeight,sessionWidth:s.width,inventoryWidth:i.width,sessionBeforeInventory:innerWidth>1050?s.left<i.left:s.top<i.top,overflow:document.documentElement.scrollWidth>innerWidth,docScroll:document.documentElement.scrollWidth,docClient:document.documentElement.clientWidth,bodyScroll:document.body.scrollWidth,bodyClient:document.body.clientWidth,overflowNodes:[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>document.documentElement.clientWidth+1).slice(0,12).map(n=>[n.tagName,n.id,String(n.className),Math.round(n.getBoundingClientRect().right)]),bodyOverflow:document.body.scrollWidth>document.body.clientWidth,actions:[capture,budget,schedule,table,warehouse,scan].map(x=>x.width>0&&x.height>0&&x.top<innerHeight&&x.bottom>0),headerActions:headerControls.map(x=>x.width>0&&x.height>0&&x.top<innerHeight&&x.bottom>0),captureVisible:visible('#open-trade-capture'),sessionTop:s.top,inventoryTop:i.top,tableTop:table.top}})())"));
    assert.equal(metrics.overflow, false, width + " document horizontal overflow: " + JSON.stringify(metrics));
    assert.equal(metrics.bodyOverflow, false, width + " body horizontal overflow");
    assert.equal(metrics.sessionBeforeInventory, true, width + " session precedes inventory");
    if (width > 1050) assert(metrics.sessionWidth > metrics.inventoryWidth, width + " current session receives more width");
    assert(metrics.actions.every(Boolean), width + " key workspace controls are accessible in viewport");
    assert(metrics.headerActions.every(Boolean), width + " header settings/tools are accessible in viewport");
    if (width > 1050) assert(metrics.sessionWidth > metrics.inventoryWidth * 1.4, "desktop session workspace is clearly primary");
    if (width <= 1050) assert(metrics.sessionTop < metrics.inventoryTop, width + " stacked order is session then inventory");
    viewportResults.push({ width, height, sessionWidth: Math.round(metrics.sessionWidth), inventoryWidth: Math.round(metrics.inventoryWidth), overflow: metrics.overflow, controlsVisible: metrics.actions.every(Boolean) });
  }
  assert.equal(await evaluate("document.querySelector('.header-tools>summary').tabIndex"), 0, "native details summary is keyboard reachable");
  assert.equal(await evaluate("document.querySelector('.session-management>summary').tabIndex"), 0, "session management summary is keyboard reachable");
  assert.equal(await evaluate("document.querySelector('#screen-capture-status').getAttribute('role')"), "status");
  console.log(JSON.stringify({ ok: true, appWorkspace: "PASS", emptyCaptureAndJson: "PASS", preservedIds: ids.length, sourceOrder: structure.order, sessionSummary: "PASS", headerToolsAndScreenUtility: "PASS", responsive: viewportResults, horizontalOverflow: "NONE", keyboardAndAria: "PASS" }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { server.kill(); } catch {}
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}