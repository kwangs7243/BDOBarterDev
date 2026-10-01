import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = "http://127.0.0.1:18774/";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const python = process.env.PYTHON ?? "python";
const profile = await mkdtemp(join(tmpdir(), "bdo-recognition-browser-"));
const mainDatabase = join(profile, "main.sqlite3");
const sidecarDatabase = join(profile, "recognition", "recognition.sqlite3");
const isolatedLocalAppData = join(profile, "local-app-data");
// Keep production origin enforcement active on the isolated test server's own port.
const pythonCode = `import local_app.backend.app as application; application.PORT=18774; application.create_app(r'${mainDatabase}', recognition_database_path=r'${sidecarDatabase}', testing=False).run(host='127.0.0.1', port=18774, use_reloader=False, threaded=True)`;
let serverProcess;
let chrome;
let socket;
let attacker;
try {
  serverProcess = spawn(python, ["-B", "-c", pythonCode], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: isolatedLocalAppData },
  });
  serverProcess.once("error", error => { serverProcess.startupError = error; });
  await waitFor(async () => {
    if (serverProcess.startupError) throw serverProcess.startupError;
    if (serverProcess.exitCode !== null) throw new Error(`Isolated security server exited: ${serverProcess.exitCode}`);
    try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated T002 server");

  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePortText = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePortText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: ${targetResponse.status}`);
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
  await waitFor(async () => {
    try {
      return await evaluate(`location.origin === ${JSON.stringify(new URL(baseUrl).origin)} && document.readyState === 'complete'`);
    } catch (error) {
      if (/context.*destroyed|Cannot find context/i.test(error.message)) return false;
      throw error;
    }
  }, "same-origin application page");

  const sameOriginSave = await evaluate(`(async()=>{const initial=await fetch('/api/recognition/config').then(r=>r.json());const flags=Object.fromEntries(Object.keys(initial.config.flags).map(k=>[k,false]));const response=await fetch('/api/recognition/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,expectedConfigRevision:initial.config.configRevision,flags,profiles:[]})});return {status:response.status,body:await response.json()}})()`);
  if (sameOriginSave.status !== 200 || sameOriginSave.body.config.configRevision !== 1) throw new Error(`same-origin config save failed: ${JSON.stringify(sameOriginSave)}`);

  attacker = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>foreign origin test</title><p>foreign test page</p>");
  });
  await new Promise((resolveListen, reject) => { attacker.once("error", reject); attacker.listen(0, "127.0.0.1", resolveListen); });
  const attackerAddress = attacker.address();
  const attackerUrl = `http://127.0.0.1:${attackerAddress.port}/`;
  await send("Page.navigate", { url: attackerUrl });
  await waitFor(async () => evaluate("location.origin" ).then((value) => value === new URL(attackerUrl).origin), "foreign-origin page");
  const foreignAttempt = await evaluate(`(async()=>{try{const response=await fetch(${JSON.stringify(`${baseUrl}api/recognition/config`)},{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,expectedConfigRevision:1,flags:{},profiles:[]})});return {blocked:false,status:response.status}}catch(error){return {blocked:true,name:error.name}}})()`);
  if (!foreignAttempt.blocked) throw new Error(`foreign-origin mutation unexpectedly completed: ${JSON.stringify(foreignAttempt)}`);
  const serverConfig = await fetch(`${baseUrl}api/recognition/config`).then((response) => response.json());
  if (serverConfig.config.configRevision !== 1) throw new Error(`foreign page changed config revision: ${serverConfig.config.configRevision}`);

  console.log(JSON.stringify({
    ok: true,
    browser: "Chrome headless",
    sameOriginConfigPut: "PASS",
    foreignOriginMutation: "BLOCKED_BY_BROWSER_PREFLIGHT",
    configRevisionAfterAttack: serverConfig.config.configRevision,
    isolatedMainAndSidecarDatabases: true,
  }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { serverProcess?.kill(); } catch {}
  if (attacker?.listening) await new Promise((resolveClose) => attacker.close(resolveClose));
  await delay(500);
  if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
}

async function waitFor(predicate, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await predicate();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
