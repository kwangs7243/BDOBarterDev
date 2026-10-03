import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.BDO_TEST_PORT ?? 18799);
const baseUrl = `http://127.0.0.1:${port}/`;
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-secondary-tools-"));
const database = join(profile, "isolated.sqlite3");
const pythonCode = `from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=${port}, use_reloader=False, threaded=True)`;
let server;
let chrome;
let socket;
let serverOutput = "";

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
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: ${targetResponse.status}`);
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
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveMessage, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression: `(()=>eval(${JSON.stringify(expression)}))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  const click = async (selector) => {
    const found = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`);
    assert.equal(found, true, `missing clickable element: ${selector}`);
  };
  const clickHeaderTool = async (selector) => {
    if (!await evaluate("document.querySelector('.header-tools').open")) await click(".header-tools > summary");
    await click(selector);
  };
  const open = async (dialogId, opener) => {
    await click(opener);
    await waitFor(async () => evaluate(`document.querySelector(${JSON.stringify(`#${dialogId}`)})?.open === true`), `${dialogId} open`);
  };
  const close = async (dialogId) => {
    const dialog = `#${dialogId}`;
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(dialog)}).querySelectorAll('[data-close-dialog],[data-master-close]').length`), 1,
      `${dialogId} has exactly one visible close action`);
    await click(`${dialog} [data-close-dialog], ${dialog} [data-master-close]`);
    await waitFor(async () => evaluate(`document.querySelector(${JSON.stringify(dialog)})?.open === false`), `${dialogId} close`);
  };
  const assertViewport = async (width, height, dialogs) => {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(120);
    const geometry = await evaluate(`(()=>{
      const d=[${dialogs.map(({ id }) => `document.querySelector('#${id}')`).join(",")}].filter(Boolean);
      return {w:innerWidth,h:innerHeight,bodyScroll:document.documentElement.scrollWidth,dialogs:d.map(x=>{const r=x.getBoundingClientRect();return {id:x.id,open:x.open,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,resize:getComputedStyle(x).resize,title:x.querySelector('.dialog-titlebar')?.getBoundingClientRect().toJSON(),close:x.querySelector('.dialog-titlebar [data-close-dialog],.dialog-titlebar [data-master-close]')?.getAttribute('aria-label')}})}
    })()`);
    assert.equal(geometry.bodyScroll <= width + 1, true, `${width}x${height} page horizontal overflow: ${JSON.stringify(geometry)}`);
    for (const item of geometry.dialogs.filter((entry) => entry.open)) {
      assert.equal(item.title.width > 0 && item.title.height > 0, true, `${item.id} title visible at ${width}x${height}`);
      assert.equal(item.close?.endsWith("닫기"), true, `${item.id} close remains accessible`);
      assert.equal(item.resize, "both", `${item.id} keeps native resize contract`);
      assert.equal(item.right <= width + 2 && item.bottom <= height + 2, true, `${item.id} remains within viewport`);
    }
    return geometry;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await waitFor(async () => evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.inventory-row').length === 70"), "app workspace ready");

  const requiredIds = ["open-schedule", "open-tuning", "brief-open-tuning", "open-map-tools", "open-map-speed", "open-map-balance", "brief-map-speed", "brief-map-balance", "open-engine-diagnostics", "schedule-dialog", "tuning-dialog", "map-tools-dialog", "engine-diagnostics-dialog"];
  assert.deepEqual(await evaluate(`(${JSON.stringify(requiredIds)}).map(id=>!!document.getElementById(id))`), requiredIds.map(() => true), "all secondary tool and opener IDs remain");
  assert.equal(await evaluate("document.querySelectorAll('#schedule-dialog .dialog-titlebar [data-close-dialog]').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('#tuning-dialog .dialog-titlebar [data-close-dialog]').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('#map-tools-dialog .dialog-titlebar [data-close-dialog]').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('#engine-diagnostics-dialog .dialog-titlebar [data-close-dialog]').length"), 1);

  for (const [width, height] of [[1440, 900], [1024, 768], [768, 720]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(120);

    await clickHeaderTool("#open-tuning");
    assert.equal(await evaluate("document.querySelector('.header-tools').open"), true, "header tools menu remains available during tool navigation");
    await waitFor(async () => evaluate("document.querySelector('#tuning-dialog').open"), "tuning dialog");
    let tuning = await evaluate("(()=>({title:document.querySelector('#tuning-title').textContent,tabs:[...document.querySelectorAll('#tuning-dialog [role=tab]')].map(x=>[x.textContent,x.getAttribute('aria-selected'),x.getAttribute('aria-controls')]),scope:document.querySelector('.tool-dialog-scope').textContent,body:document.querySelector('#tuning-dialog .dialog-body').scrollHeight,client:document.querySelector('#tuning-dialog .dialog-body').clientHeight}))()");
    assert.equal(tuning.title, "계산 튜닝");
    assert.deepEqual(tuning.tabs.map((item) => item[0]), ["이번 회차 임시 적용", "영구 기본값 저장"]);
    assert.ok(tuning.tabs.every((item) => item[2] === "tuning-root"));
    assert.match(tuning.scope, /현재 회차만/);
    assert.match(tuning.scope, /다음 새 회차부터/);
    await click('#tuning-dialog [data-tuning-tab="durable"]');
    assert.equal(await evaluate("document.querySelector('#tuning-dialog [data-tuning-tab=durable]').getAttribute('aria-selected')"), "true");
    assert.equal(await evaluate("document.querySelector('#tuning-root').dataset.mode"), "durable");
    await click('#tuning-dialog [data-tuning-tab="temporary"]');
    await assertViewport(width, height, [{ id: "tuning-dialog" }]);
    await close("tuning-dialog");

    await clickHeaderTool("#open-map-tools");
    await waitFor(async () => evaluate("document.querySelector('#map-tools-dialog').open"), "map tools dialog");
    const map = await evaluate("(()=>({title:document.querySelector('#map-tools-title').textContent,sections:[...document.querySelectorAll('#map-tools-dialog .tool-dialog-workspace h3')].map(x=>x.textContent),cols:getComputedStyle(document.querySelector('.map-tools-grid')).gridTemplateColumns,roots:['navigation-root','map-root','viewer-root'].map(id=>!!document.getElementById(id))}))()");
    assert.equal(map.title, "지도·항로");
    assert.deepEqual(map.sections, ["경로·좌표 설정", "지도 뷰어"]);
    assert.deepEqual(map.roots, [true, true, true]);
    if (width <= 1050) assert.equal(map.cols.trim().split(/\s+/).length, 1, `map uses one column at ${width}`);
    await assertViewport(width, height, [{ id: "map-tools-dialog" }]);
    await close("map-tools-dialog");

    await open("schedule-dialog", "#open-schedule");
    const schedule = await evaluate("(()=>({heading:document.querySelector('#briefing-title').textContent,primary:document.querySelector('#generate-schedule').textContent,modeRole:document.querySelector('.brief-mode-tabs').getAttribute('role'),modes:[...document.querySelectorAll('[data-brief-mode]')].map(x=>[x.dataset.briefMode,x.getAttribute('role'),x.getAttribute('aria-selected')]),slotLabel:document.querySelector('.briefing-saved-schedule .tool-dialog-group-label')?.textContent,aux:document.querySelector('.briefing-secondary-tools .tool-dialog-group-label')?.textContent,status:document.querySelector('#schedule-status').getAttribute('role'),cols:getComputedStyle(document.querySelector('#schedule-columns')).gridTemplateColumns,freeRoot:!!document.querySelector('#free-route-root .mv-free-route'),diagnostics:document.querySelector('.schedule-diagnostics').open}))()");
    assert.equal(schedule.primary, "스케줄 생성 / 다시 계산");
    assert.equal(schedule.modeRole, "tablist");
    assert.deepEqual(schedule.modes.map((item) => item[0]), ["speed", "balance", "both"]);
    assert.ok(schedule.modes.every((item) => item[1] === "tab"));
    assert.equal(schedule.slotLabel, "저장된 스케줄");
    assert.equal(schedule.aux, "보조 도구");
    assert.equal(schedule.status, "status");
    assert.equal(schedule.diagnostics, false, "raw schedule diagnostics starts collapsed");
    if (width <= 900) assert.equal(schedule.cols.trim().split(/\s+/).length, 1, `schedule columns stack at ${width}`);
    await assertViewport(width, height, [{ id: "schedule-dialog" }]);

    await click("#open-engine-diagnostics");
    await waitFor(async () => evaluate("document.querySelector('#engine-diagnostics-dialog').open"), "route diagnostics");
    const diagnostics = await evaluate("(()=>({title:document.querySelector('#engine-diagnostics-title').textContent,context:document.querySelector('#engine-diagnostics-dialog .tool-dialog-context').textContent,rawOpen:document.querySelector('#engine-diagnostics-dialog .tool-dialog-raw').open,copy:!!document.querySelector('#copy-engine-diagnostics-dialog'),status:document.querySelector('#diagnostics-copy-status').getAttribute('role')}))()");
    assert.equal(diagnostics.title, "항로 결정 과정");
    assert.match(diagnostics.context, /ENGINE_DEBUG/);
    assert.equal(diagnostics.rawOpen, false);
    assert.equal(diagnostics.copy, true);
    assert.equal(diagnostics.status, "status");
    await assertViewport(width, height, [{ id: "schedule-dialog" }, { id: "engine-diagnostics-dialog" }]);
    await close("engine-diagnostics-dialog");
    await close("schedule-dialog");

    const overflow = await evaluate("({document:document.documentElement.scrollWidth,body:document.body.scrollWidth,viewport:innerWidth})");
    assert.ok(overflow.document <= width + 1 && overflow.body <= width + 1, `page overflows horizontally at ${width}: ${JSON.stringify(overflow)}`);
  }

  await send("Emulation.clearDeviceMetricsOverride");
  console.log("PASS browser_secondary_tools.mjs");
} finally {
  try { socket?.close(); } catch {}
  await stopChild(chrome);
  await stopChild(server);
  await rm(profile, { recursive: true, force: true });
}
