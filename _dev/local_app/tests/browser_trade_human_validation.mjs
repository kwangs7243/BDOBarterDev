import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-t010b2-browser-"));
const dataDir = join(profile, "human-validation");
let server;
let chrome;
let socket;
let serverStderr = "";

async function waitFor(predicate, label, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  const script = resolve(root, "local_app/tools/trade_human_validation.py");
  server = spawn(python, ["-B", script, "--data-dir", dataDir, "--no-browser"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  let stdout = "";
  server.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  server.stderr.setEncoding("utf8").on("data", (chunk) => { serverStderr += chunk; });
  const baseUrl = await waitFor(() => stdout.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0], "localhost validation server");

  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
    "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0",
    "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"],
  { stdio: "ignore", windowsHide: true });
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePortText = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePortText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  assert.equal(targetResponse.ok, true, "Chrome creates the validation page target");
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolveMessage, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolveMessage(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveMessage, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: baseUrl });
  await waitFor(async () => (await evaluate("document.querySelector('#position')?.textContent"))?.includes("1 / 24"), "24-row validation UI");
  await waitFor(async () => evaluate("document.querySelector('#row-crop')?.naturalWidth > 0"), "row image crop");
  assert.equal(await evaluate("document.querySelectorAll('.field').length"), 6, "six field cards render");

  await evaluate("document.querySelector('.field[data-field=island] [data-action=CONFIRM]').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#saved')?.textContent")) === "저장됨", "island confirmation save");
  await evaluate("(() => { const card=document.querySelector('.field[data-field=fromItem]'); card.querySelector('input').value='브라우저 모의 수정'; card.querySelector('[data-action=CORRECT]').click(); })()");
  await waitFor(async () => evaluate("document.querySelector('.field[data-field=fromItem] .label-state')?.textContent.includes('CORRECT')"), "correction save");
  await evaluate("document.querySelector('.field[data-field=yield] [data-action=UNREADABLE]').click()");
  await waitFor(async () => evaluate("document.querySelector('.field[data-field=yield] .label-state')?.textContent.includes('UNREADABLE')"), "unreadable save");
  await evaluate("document.querySelector('#next').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#position')?.textContent"))?.includes("2 / 24"), "next row navigation");
  await waitFor(async () => evaluate("fetch('/api/state').then(r=>r.json()).then(state=>state.currentIndex===1)"), "navigation position save");
  await evaluate("location.reload()");
  await waitFor(async () => (await evaluate("document.querySelector('#position')?.textContent"))?.includes("2 / 24"), "refresh and resume at saved row");
  const resumedLabels = await evaluate("(async()=>{const state=await (await fetch('/api/state')).json();return {currentIndex:state.currentIndex,labels:state.rows[0].labels}})()");
  assert.equal(resumedLabels.currentIndex, 1, "navigation position resumes from local progress");
  assert.equal(resumedLabels.labels.island.action, "CONFIRM", "confirmation resumes from local labels");
  assert.equal(resumedLabels.labels.fromItem.action, "CORRECT", "correction resumes from local labels");
  assert.equal(resumedLabels.labels.yield.action, "UNREADABLE", "unreadable decision resumes from local labels");

  const mockResult = await evaluate(`(async()=>{const fields=['island','fromItem','reqAmount','toItem','count','yield'];let state=await (await fetch('/api/state')).json();let saved=0;for(const item of state.rows){for(const field of fields){if(item.labels[field])continue;const numeric=['reqAmount','count','yield'].includes(field);const humanValue=numeric?(field==='count'?'0':'1'):'모의-'+field;const response=await fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rowId:item.row.rowId,field,action:'CORRECT',humanValue})});if(!response.ok)throw new Error((await response.json()).error);saved++;}}state=await (await fetch('/api/state')).json();const summary=await (await fetch('/api/summary')).json();return {rowCount:state.rowCount,completedRows:state.completedRows,pilotComplete:state.pilotComplete,fullListExact:summary.fullListExact,humanVerifiedFields:summary.humanVerifiedFields,mockLabelsAdded:saved};})()`);
  assert.deepEqual(mockResult, { rowCount: 24, completedRows: 24, pilotComplete: true,
    fullListExact: null, humanVerifiedFields: 143, mockLabelsAdded: 141 }, "mock-only labels complete all rows without claiming oracle truth");
  await evaluate("location.reload()");
  await waitFor(async () => evaluate("document.querySelector('#pilot-complete')?.hidden === false"), "completed pilot state after refresh");
  console.log("browser trade OCR human validation: crop, confirm/correct/unreadable, resume, and mock 24/24 completion PASS (mock labels only)");
  if (serverStderr.trim()) console.error(serverStderr.trim());
} catch (error) {
  console.error(error);
  if (serverStderr.trim()) console.error(serverStderr.trim());
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch {}
  for (const child of [chrome, server]) {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveDelay) => setTimeout(resolveDelay, 3000))]);
    }
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
}
