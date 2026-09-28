import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18769/";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-spec004-browser-"));
const database = join(profile, "isolated.sqlite3");
const pythonPrelude = process.env.BDO_EXTRA_SITE_PACKAGES ? `import sys; p=${JSON.stringify(process.env.BDO_EXTRA_SITE_PACKAGES)}; sys.path.remove(p); sys.path.append(p); ` : "";
const pythonCode = `${pythonPrelude}from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=18769, use_reloader=False, threaded=True)`;
let server = spawn(process.env.PYTHON ?? "python", ["-c", pythonCode], { stdio: "ignore", windowsHide: true, cwd: root });
let chrome;
let socket;
try {
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "temporary localhost app");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const portFile = join(profile, "chrome-profile", "DevToolsActivePort");
  const portText = await waitFor(async () => { try { return await readFile(portFile, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const port = portText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT", signal: AbortSignal.timeout(10000) });
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: ${targetResponse.status}`);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); }),
    delay(10000).then(() => { throw new Error("Chrome DevTools WebSocket did not open."); }),
  ]);
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    if (message.id && pending.has(message.id)) { const { resolve: resolveCall, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolveCall(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolveCall, reject) => { const id = ++nextId; pending.set(id, { resolve: resolveCall, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value; };
  await send("Page.enable"); await send("Runtime.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "SPEC-002 UI and trade panel");
  const seed = JSON.parse(await readFile(resolve(root, "fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json"), "utf8"))[0];
  const second = JSON.parse(await readFile(resolve(root, "fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json"), "utf8"))[1];
  const encodedSeed = JSON.stringify(JSON.stringify([seed]));
  const initialDefault = await evaluate("fetch('/api/bootstrap').then(r=>r.json()).then(snapshot=>JSON.stringify(snapshot.settings.parley))");
  await evaluate(`document.querySelector('#trade-json-input').value=${encodedSeed}; document.querySelector('#apply-new-session').click()`);
  await waitFor(async () => (await evaluate("document.querySelectorAll('.trade-row').length")) === 1, "new session row");
  const sessionStart = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({count:state.session.scannedTrades.length,parley:state.session.remainingParley,table:document.querySelectorAll('.trade-row').length}))");
  if (JSON.parse(sessionStart).parley !== 1500000) throw new Error(`new session did not use durable default: ${sessionStart}`);
  await evaluate("document.querySelector('#remaining-parley').value='7777'; document.querySelector('#remaining-parley').dispatchEvent(new Event('change',{bubbles:true}))");
  await evaluate("document.querySelector('#trade-json-input').value='[{bad json]'; document.querySelector('#apply-new-session').click()");
  const afterMalformed = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({count:state.session.scannedTrades.length,parley:state.session.remainingParley,status:document.querySelector('#trade-import-status').textContent,schedule:state.session.schedule}))");
  if (JSON.parse(afterMalformed).count !== 1 || JSON.parse(afterMalformed).parley !== 7777 || !JSON.parse(afterMalformed).status.includes("JSON 파싱 실패")) throw new Error(`malformed input changed the current session: ${afterMalformed}`);

  await evaluate(`document.querySelector('#trade-json-input').value=${encodedSeed}; document.querySelector('#append-current-trades').click()`);
  await evaluate("document.querySelector('.trade-import-review button').click()");
  const afterDuplicate = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({count:state.session.scannedTrades.length,status:document.querySelector('#trade-import-status').textContent}))");
  if (JSON.parse(afterDuplicate).count !== 1 || !JSON.parse(afterDuplicate).status.includes("중복")) throw new Error(`duplicate append contract changed: ${afterDuplicate}`);

  const conflict = { ...seed, fromItem: second.fromItem };
  await evaluate(`document.querySelector('#trade-json-input').value=${JSON.stringify(JSON.stringify([conflict]))}; document.querySelector('#append-current-trades').click()`);
  await evaluate("document.querySelector('.trade-import-review button').click()");
  const afterConflict = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({count:state.session.scannedTrades.length,status:document.querySelector('#trade-import-status').textContent}))");
  if (JSON.parse(afterConflict).count !== 1 || !JSON.parse(afterConflict).status.includes("충돌")) throw new Error(`conflicting append was not held: ${afterConflict}`);

  await evaluate("import('/assets/js/state.js').then(({state})=>{state.session.schedule={old:true}})");
  await evaluate(`document.querySelector('#trade-json-input').value=${JSON.stringify(JSON.stringify([second]))}; document.querySelector('#append-current-trades').click()`);
  await waitFor(async () => (await evaluate("document.querySelectorAll('.trade-row').length")) === 2, "normal current-list append");
  const afterAdd = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({count:state.session.scannedTrades.length,schedule:state.session.schedule,second:state.session.scannedTrades[1]}))");
  if (JSON.parse(afterAdd).count !== 2 || JSON.parse(afterAdd).schedule !== null || JSON.parse(afterAdd).second.toItem !== second.toItem) throw new Error(`normal append or schedule invalidation failed: ${afterAdd}`);

  await evaluate("import('/assets/js/state.js').then(({state})=>{state.session.schedule={old:true}; document.querySelector('.trade-row input[aria-label^=count]').value='5'; document.querySelector('.trade-row input[aria-label^=count]').dispatchEvent(new Event('change',{bubbles:true}))})");
  const edited = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({count:state.session.scannedTrades[0].count,schedule:state.session.schedule}))");
  if (JSON.parse(edited).count !== 5 || JSON.parse(edited).schedule !== null) throw new Error(`edit did not update row and invalidate schedule: ${edited}`);
  await evaluate("document.querySelector('.trade-row input[aria-label^=yield]').value='7'; document.querySelector('.trade-row input[aria-label^=yield]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('.trade-row input[type=checkbox]').click()");
  await evaluate("document.querySelector('.trade-row button').click()");
  const rowFlags = await evaluate("import('/assets/js/state.js').then(({state})=>JSON.stringify({yield:state.session.scannedTrades[0].yield,disabled:state.session.scannedTrades[0].disabled,deleted:state.session.scannedTrades[0].deleted}))");
  if (JSON.stringify(JSON.parse(rowFlags)) !== JSON.stringify({ yield: 7, disabled: true, deleted: true })) throw new Error(`row yield/disabled/deleted state mismatch: ${rowFlags}`);

  const settingAfter = await evaluate("fetch('/api/bootstrap').then(r=>r.json()).then(snapshot=>JSON.stringify(snapshot.settings.parley))");
  if (settingAfter !== initialDefault) throw new Error(`current parley changed durable defaults: ${initialDefault} -> ${settingAfter}`);
  await evaluate("import('/assets/js/persistence.js').then(({whenPersistenceIdle})=>whenPersistenceIdle())");
  await evaluate("import('/assets/js/persistence.js').then(({whenPersistenceIdle})=>whenPersistenceIdle())");
  await evaluate("window.__beforeReloadMarker = true");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(async () => (await evaluate("!window.__beforeReloadMarker && document.querySelector('#app-content')?.getAttribute('aria-busy')==='false' && document.querySelectorAll('.inventory-row').length===70")) === true, "new document initialized after reload");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70 && (await evaluate("document.querySelectorAll('.trade-row').length")) === 2, "reload restores current trades");
  const afterReload = await evaluate("Promise.all([import('/assets/js/state.js'),fetch('/api/bootstrap').then(r=>r.json())]).then(([{state},snapshot])=>JSON.stringify({session:state.session.scannedTrades,parley:snapshot.settings.parley.defaultBudget}))");
  if (!Array.isArray(JSON.parse(afterReload).session) || JSON.parse(afterReload).session.length !== 2 || !JSON.parse(afterReload).session[0].deleted || JSON.parse(afterReload).session[0].count !== 5 || JSON.parse(afterReload).parley !== 1500000) throw new Error(`reload session/persistent setting mismatch: ${afterReload}`);
  const missingApi = await fetch(`${baseUrl}api/current-trades`);
  if (missingApi.status !== 404) throw new Error(`unexpected current-trades endpoint: HTTP ${missingApi.status}`);
  server.kill(); await new Promise((resolveExit) => server.once("exit", resolveExit)); server = null;
  const inspect = spawnSync(process.env.PYTHON ?? "python", ["-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps({'tables':sorted(x[0] for x in c.execute(\"select name from sqlite_master where type='table'\")),'settings':sorted(x[0] for x in c.execute(\"select section from settings\"))}))", process.env.BDO_TEST_DATABASE ?? database], { encoding: "utf8", cwd: root, windowsHide: true });
  if (inspect.status !== 0) throw new Error(`SQLite inspection failed: ${inspect.stderr}`);
  const db = JSON.parse(inspect.stdout.trim());
  if (JSON.stringify(db.tables) !== JSON.stringify(["app_meta", "inventory", "mutation_receipt", "saved_schedule_slot", "settings", "warehouse_feedback", "warehouse_scan", "working_session"])) throw new Error(`unexpected SQLite tables: ${JSON.stringify(db.tables)}`);
  if (db.settings.includes("currentTrades") || db.settings.includes("session") || db.settings.includes("schedule")) throw new Error(`session state leaked into settings: ${JSON.stringify(db.settings)}`);
  console.log(JSON.stringify({ ok: true, browser: "Chrome headless", newSession: true, defaultParley: true, malformedJsonPreservedSession: true, duplicateAndConflictHeld: true, normalAppendInvalidatedSchedule: true, editInvalidatedSchedule: true, countYieldDisabledDeleted: true, currentParleyStayedSessionOnly: true, reloadRestoredSession: true, durableSettingsRestored: true, noCurrentTradesApi: true, sqliteTables: db.tables, temporaryDatabase: true }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { server?.kill(); } catch {}
  await delay(300);
  if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
}

async function waitFor(predicate, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await predicate(); if (result) return result; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
