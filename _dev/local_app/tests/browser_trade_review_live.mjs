#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = path.resolve(ROOT, "..");
const APP_ROOT = path.join(ROOT, "local_app");
const R011_ROOT = path.join(ROOT, "recognition-local", "live-validation", "r011");
const EXPECTED_PARENT = "442aef24090a4a738c90fb7cb4b47fd61562087e";
const EXPECTED_MAIN = "f13b8e15af392f167d153c873448a4b2abec5a0c";
const HARNESS_SUBJECT = "fix: simplify live capture validation";
const EVALUATION_POLICY = "trade-review-evaluation-v1";
const RAW_EVALUATION = "trade-raw-eval-v1";
const MAPPING_POLICY = "reviewed-trade-dto-mapping-v1";
const FIELDS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const PROTECTED_DIRTY = new Set([
  "_dev/local_app/.venv/Lib/site-packages/__pycache__/_virtualenv.cpython-312.pyc",
  "마스터.png",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
let interrupted = false;
process.on("SIGINT", () => { interrupted = true; process.stderr.write("\n중단 요청을 받았습니다. 현재까지의 case 기록을 보존하고 종료합니다.\n"); });

function usage() {
  return `R011-A 독립 실사 harness

사용법:
  node _dev/local_app/tests/browser_trade_review_live.mjs --help
  node _dev/local_app/tests/browser_trade_review_live.mjs --preflight [--run-dir <ignored r011 path>] [--device-scale-factor <수치>]
  node _dev/local_app/tests/browser_trade_review_live.mjs --live --run-dir <ignored r011 path> --case-id <고유 ID> \\
    --input-mode STREAM|FILE|PASTE --cohort INDEPENDENT [--display-width <정수>] [--display-height <정수>] \\
    [--windows-scale-percent <수치>] [--chrome-zoom-percent <수치>] [--device-scale-factor <수치>] \\
    [--notes <설명>] [--human-timeout-minutes <분>]

--preflight는 실제 게임 화면을 캡처하지 않고 격리 backend/sidecar, 실제 로컬 OCR runtime/model,
표시 모드 Chrome, 1920×1080 브라우저 viewport 및 capture 창 열기만 확인합니다.

--live가 시작되면 Chrome에서 화면을 연결하고 ROI를 지정한 뒤, 게임을 직접 스크롤하며 필요한 만큼 캡처하세요.
캡처를 마치면 화면의 ‘로컬 인식 실행’을 누르세요. 프로그램은 자동 스크롤하지 않으며 이후 터미널 입력도 필요하지 않습니다.

--live에서는 사용자가 실제 BDO 화면을 직접 캡처하고 인식 결과의 모든 행/필드를 검수해야 합니다.
이 도구는 후보 정답을 입력하거나 행을 제외하거나 회차 적용 버튼을 대신 누르지 않습니다.
인식 요청 시작 시점의 캡처 evidence와 저장된 observation export의 source provenance를 비교해 기록합니다.
이전 R011 evidence와 source/bitmap 해시가 일치하는 캡처는 independent로 분류하지 않습니다.

실제 live 검증은 평소 사용 환경 그대로 실행합니다. Windows 배율이나 Chrome zoom을 바꿀 필요가 없습니다.
환경 인자를 모르면 생략해도 됩니다. 인자는 사용자가 아는 실제 값을 기록하는 용도이며, 생략 값은 null로 남습니다.
기존 --display-scale-percent는 의미가 모호한 deprecated alias이며 --windows-scale-percent로 대체되었습니다.
CDP deviceScaleFactor/browser DPR은 Windows 배율이나 Chrome zoom이 아닙니다. --live의 기본은 native rendering입니다.
이 harness의 준비 완료는 R011 usability 승인, auto-accept 승인, release/package 승인을 뜻하지 않습니다.\n`;
}

function parseArgs(argv) {
  const result = { mode: null, options: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") { result.mode = "help"; continue; }
    if (token === "--preflight" || token === "--live") {
      if (result.mode) throw new Error("모드는 하나만 지정할 수 있습니다.");
      result.mode = token.slice(2); continue;
    }
    if (!token.startsWith("--")) throw new Error(`알 수 없는 인자: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} 값이 필요합니다.`);
    result.options[token.slice(2)] = value; index += 1;
  }
  if (!result.mode) result.mode = "help";
  return result;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 실패: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function assertInsideR011(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(R011_ROOT, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`산출물 경로는 ${R011_ROOT} 아래여야 합니다: ${resolved}`);
  }
  return resolved;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isoNow() { return new Date().toISOString(); }
function cleanPythonDefault() { return path.join(ROOT, "recognition-local", "r006-env-recovery", "venv314", "Scripts", "python.exe"); }
function selectedPython() {
  const candidate = process.env.R011_PYTHON || cleanPythonDefault();
  if (!path.isAbsolute(candidate)) throw new Error("R011_PYTHON은 절대 경로여야 합니다.");
  return candidate;
}
function selectedChrome() {
  const candidate = process.env.BDO_CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!path.isAbsolute(candidate)) throw new Error("BDO_CHROME은 Chrome 실행 파일의 절대 경로여야 합니다.");
  return candidate;
}

function probePython(pythonPath) {
  const source = `import json, pathlib, sys, flask, waitress, numpy, pytest, PIL, PIL._imaging\n` +
    `print(json.dumps({"executable":sys.executable,"version":sys.version,"prefix":sys.prefix,"basePrefix":sys.base_prefix,` +
    `"sysPath":sys.path,"flask":{"version":getattr(flask,"__version__","import-ok"),"path":flask.__file__},` +
    `"waitress":{"version":getattr(waitress,"__version__","import-ok"),"path":waitress.__file__},` +
    `"numpy":{"version":numpy.__version__,"path":numpy.__file__},"pytest":{"version":pytest.__version__,"path":pytest.__file__},` +
    `"pillow":{"version":PIL.__version__,"path":PIL.__file__,"imagingPath":PIL._imaging.__file__}}))`;
  const result = spawnSync(pythonPath, ["-B", "-c", source], { cwd: ROOT, encoding: "utf8", windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (result.status !== 0) throw new Error(`clean Python ABI/import 검증 실패 (${pythonPath}):\n${result.stderr || result.stdout}`);
  let details;
  try { details = JSON.parse(result.stdout.trim()); } catch { throw new Error(`Python probe JSON을 읽을 수 없습니다:\n${result.stdout}\n${result.stderr}`); }
  const prefix = path.resolve(details.prefix).toLowerCase();
  const paths = [details.flask.path, details.waitress.path, details.numpy.path, details.pytest.path,
    details.pillow.path, details.pillow.imagingPath].map((item) => path.resolve(item).toLowerCase());
  const foreign = paths.filter((item) => !item.startsWith(`${prefix}${path.sep}`));
  const repoVenv = path.resolve(APP_ROOT, ".venv").toLowerCase();
  if (foreign.length || details.sysPath.some((item) => path.resolve(item || ".").toLowerCase().startsWith(`${repoVenv}${path.sep}`))) {
    throw new Error(`Python probe가 격리 환경 밖 package를 사용합니다: ${foreign.join(", ")}`);
  }
  return details;
}

async function findPort() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => error ? reject(error) : resolve(port)); });
  });
}

async function waitFor(predicate, label, timeoutMs = 30000, intervalMs = 150) {
  const started = Date.now();
  let lastError;
  while (!interrupted && Date.now() - started < timeoutMs) {
    try { const value = await predicate(); if (value) return value; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (interrupted) throw new Error("사용자가 중단했습니다.");
  throw new Error(`${label} 대기 시간 초과${lastError ? `: ${lastError.message}` : ""}`);
}

async function startServer({ pythonPath, workspace, port }) {
  await mkdir(workspace, { recursive: true });
  const mainDb = path.join(workspace, "isolated-main.sqlite3");
  const sidecar = path.join(workspace, "isolated-recognition.sqlite3");
  const code = `import sys\nfrom waitress import serve\nfrom local_app.backend.app import create_app\n` +
    `app=create_app(sys.argv[1], recognition_database_path=sys.argv[2], testing=True)\n` +
    `if app.extensions.get('recognition_store') is None: raise RuntimeError('isolated recognition sidecar unavailable')\n` +
    `serve(app, host='127.0.0.1', port=int(sys.argv[3]), threads=4)\n`;
  const child = spawn(pythonPath, ["-B", "-c", code, mainDb, sidecar, String(port)], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOCALAPPDATA: path.join(workspace, "localappdata"),
      PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12000); });
  const baseUrl = `http://127.0.0.1:${port}/`;
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`isolated backend 종료: ${output}`);
      const response = await fetch(`${baseUrl}api/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok ? response : false;
    }, "isolated app /api/health", 45000);
    const health = await (await fetch(`${baseUrl}api/health`)).json();
    const bootstrap = await (await fetch(`${baseUrl}api/bootstrap`)).json();
    if (!health.ok || bootstrap.workingSession !== null) throw new Error("초기 격리 DB가 비어 있지 않거나 health 검증이 실패했습니다.");
    const runtimeResponse = await fetch(`${baseUrl}api/recognition/trade-runtime`);
    const runtimePayload = await runtimeResponse.json();
    if (!runtimeResponse.ok || runtimePayload.ok !== true || !runtimePayload.runtime) throw new Error("실제 recognition runtime 상태 API가 실패했습니다.");
    const runtime = runtimePayload.runtime;
    return { child, baseUrl, mainDb, sidecar, health, runtime, initialRevision: health.revision,
      stopOutput: () => output };
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n${output}`);
  }
}

async function stopChild(child, force = false) {
  if (!child) return;
  if (process.platform === "win32" && force && child.pid) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${Number(child.pid)} -Force -ErrorAction SilentlyContinue`],
      { encoding: "utf8", windowsHide: true, timeout: 5000 });
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
        spawnSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${Number(child.pid)} -Force -ErrorAction SilentlyContinue`],
          { encoding: "utf8", windowsHide: true, timeout: 5000 });
      } else child.kill("SIGKILL");
    }
  }
}

async function devtoolsJson(debugPort, endpoint, { method = "GET", value } = {}) {
  const response = await fetch(`http://127.0.0.1:${debugPort}${endpoint}`, {
    method, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Chrome DevTools ${method} ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

function summarizeTarget(target) {
  return { id: target.id ?? null, type: target.type ?? null, url: target.url ?? null,
    hasTargetWebSocket: typeof target.webSocketDebuggerUrl === "string" && /\/devtools\/page\//.test(target.webSocketDebuggerUrl),
    websocketTargetKind: target.webSocketDebuggerUrl?.match(/\/devtools\/([^/?]+)/)?.[1] ?? null };
}

async function connectPageTarget(target, { timeoutMs = 10000 } = {}) {
  if (target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string"
    || !/\/devtools\/page\//.test(target.webSocketDebuggerUrl)) {
    throw new Error(`Page target/websocket이 아닙니다: ${JSON.stringify(summarizeTarget(target))}`);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const observations = { opened: false, close: null, errors: [], messageCount: 0, responseCount: 0,
    eventCount: 0, lastMethod: null, lastError: null, outstandingRequestId: null, commandTimings: [] };
  const requestMeta = new Map();
  const observationReplies = [];
  const recognitionRequests = [];
  const targetFailures = [];
  const protocolMessages = [];
  socket.addEventListener("open", () => { observations.opened = true; });
  socket.addEventListener("error", (event) => observations.errors.push({ message: event.message ?? "WebSocket error" }));
  socket.addEventListener("close", (event) => { observations.close = { code: event.code, reason: event.reason, wasClean: event.wasClean }; });
  socket.addEventListener("message", (event) => {
    observations.messageCount += 1;
    let message;
    try { message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")); }
    catch (error) { if (protocolMessages.length < 30) protocolMessages.push({ parseError: error.message }); return; }
    if (message.method) {
      observations.eventCount += 1; observations.lastMethod = message.method;
      if (message.method === "Network.requestWillBeSent") {
        const request = message.params.request;
        requestMeta.set(message.params.requestId, { url: request.url, method: request.method });
        if (request.method === "POST" && /\/api\/recognition\/trade-batch(?:\?|$)/.test(request.url)) {
          recognitionRequests.push({ requestId: message.params.requestId, url: request.url,
            method: request.method, observedAt: new Date().toISOString() });
        }
      } else if (message.method === "Network.responseReceived") {
        const request = requestMeta.get(message.params.requestId);
        if (request?.method === "POST" && /\/api\/recognition\/trade-review-observations\/?$/.test(request.url)) {
          observationReplies.push({ requestId: message.params.requestId, status: message.params.response.status, body: null, error: null });
        }
      } else if (message.method === "Network.loadingFinished") {
        const reply = observationReplies.find((item) => item.requestId === message.params.requestId && item.body === null && item.error === null);
        if (reply) void send("Network.getResponseBody", { requestId: reply.requestId }).then((body) => {
          const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
          try { reply.body = JSON.parse(text); } catch { reply.error = "observation response was not JSON"; }
        }).catch((error) => { reply.error = error.message; });
      } else if (message.method === "Network.loadingFailed") {
        const reply = observationReplies.find((item) => item.requestId === message.params.requestId && item.body === null);
        if (reply) reply.error = message.params.errorText;
      } else if (message.method === "Inspector.targetCrashed" || message.method === "Target.targetCrashed") {
        targetFailures.push({ method: message.method, params: message.params });
      }
    }
    if (message.id === undefined || !pending.has(message.id)) return;
    observations.responseCount += 1;
    const waiter = pending.get(message.id); pending.delete(message.id); clearTimeout(waiter.timer);
    observations.outstandingRequestId = pending.size ? [...pending.keys()].at(-1) : null;
    observations.commandTimings.push({ id: message.id, method: waiter.method, elapsedMs: Date.now() - waiter.startedAt,
      ok: !message.error });
    if (message.error) { observations.lastError = message.error; waiter.reject(new Error(`${waiter.method}: ${message.error.message}`)); }
    else waiter.resolve(message.result);
    if (protocolMessages.length < 30) protocolMessages.push({ id: message.id, method: waiter.method, error: message.error?.message ?? null });
  });
  await new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) { resolve(); return; }
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (event) => { cleanup(); reject(new Error(`page WebSocket open failed: ${event.message ?? "error"}`)); };
    const cleanup = () => { socket.removeEventListener("open", onOpen); socket.removeEventListener("error", onError); };
    socket.addEventListener("open", onOpen, { once: true }); socket.addEventListener("error", onError, { once: true });
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id); observations.outstandingRequestId = pending.size ? [...pending.keys()].at(-1) : null;
        observations.commandTimings.push({ id, method, elapsedMs: timeoutMs, ok: false, timeout: true });
        reject(new Error(`${method} CDP response timed out after ${timeoutMs}ms (id=${id}, readyState=${socket.readyState})`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, method, timer, startedAt: Date.now() }); observations.outstandingRequestId = id;
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(new Error(`${method}: ${error.message}`)); }
    });
  }
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  return { socket, send, evaluate, observations, protocolMessages, observationReplies, recognitionRequests, targetFailures,
    close: () => { if (socket.readyState < WebSocket.CLOSING) socket.close(); } };
}

async function launchChrome({ chromePath, baseUrl, profile, deviceScaleFactor, windowSize = { width: 1920, height: 1080 }, headless = false }) {
  await mkdir(profile, { recursive: true });
  const args = [
    ...(headless ? ["--headless=new"] : []), "--no-sandbox", "--disable-gpu", "--no-first-run",
    "--disable-extensions", "--disable-crash-reporter", "--disable-breakpad", "--disable-background-networking",
    ...(windowSize ? [`--window-size=${windowSize.width},${windowSize.height}`] : []),
    "--remote-debugging-port=0", "--remote-allow-origins=*",
    `--user-data-dir=${profile}`, "about:blank",
  ];
  const child = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: headless });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-30000); });
  const activePortPath = path.join(profile, "DevToolsActivePort");
  let page; let version = null; let blankTarget = null; let appTarget = null; let initialTargets = [];
  let debugPort = null;
  try {
    const activePortText = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Chrome가 시작 직후 종료됐습니다 (pid=${child.pid}). ${stderr.slice(-5000)}`);
      try { return await readFile(activePortPath, "utf8"); } catch { return false; }
    }, `${headless ? "headless" : "visible"} Chrome DevTools endpoint`, 30000);
    const lines = activePortText.trim().split(/\r?\n/);
    debugPort = Number(lines[0]);
    if (!Number.isInteger(debugPort) || debugPort < 1 || !lines[1]?.startsWith("/devtools/browser/")) {
      throw new Error(`DevToolsActivePort 형식이 올바르지 않습니다: ${activePortPath}`);
    }
    version = await devtoolsJson(debugPort, "/json/version");
    initialTargets = await devtoolsJson(debugPort, "/json/list");
    blankTarget = await devtoolsJson(debugPort, `/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    page = await connectPageTarget(blankTarget);
    await page.send("Page.enable"); await page.send("Runtime.enable");
    const blankReadyState = await page.evaluate("document.readyState");
    if (!blankReadyState) throw new Error("about:blank document.readyState가 비어 있습니다.");
    const blankFacts = await page.evaluate("JSON.stringify({url:location.href,readyState:document.readyState})").then(JSON.parse);
    if (baseUrl) {
      appTarget = await devtoolsJson(debugPort, `/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
      page.close();
      page = await connectPageTarget(appTarget);
      await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("DOM.enable"); await page.send("Network.enable");
      if (deviceScaleFactor != null) {
        await page.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080,
          deviceScaleFactor, mobile: false });
      }
      await waitFor(async () => page.evaluate(`location.href.startsWith(${JSON.stringify(baseUrl)}) && document.readyState==='complete'`),
        "app page navigation and document ready", 30000);
    }
    return { child, page, send: page.send, evaluate: page.evaluate, version, debugPort, activePortPath,
      spawnedPid: child.pid, headless, profile, initialTargets: initialTargets.map(summarizeTarget),
      blankTarget: summarizeTarget(blankTarget), blankFacts,
      appTarget: appTarget ? summarizeTarget(appTarget) : null, stderr: () => stderr, observationReplies: page.observationReplies,
      recognitionRequests: page.recognitionRequests,
      targetFailures: page.targetFailures, diagnostics: page.observations,
      close: async () => { page.close(); await stopChild(child, true); } };
  } catch (error) {
    const details = page ? { websocketReadyState: page.socket.readyState, ...page.observations,
      targetFailures: page.targetFailures, protocolMessages: page.protocolMessages } : null;
    page?.close(); await stopChild(child, true);
    const wrapped = new Error(`${error.message}\nChrome diagnostics: ${JSON.stringify({ pid: child.pid, profile, activePortPath,
      debugPort, browserVersion: version?.Browser ?? null, initialTargets: initialTargets.map(summarizeTarget),
      blankTarget: blankTarget ? summarizeTarget(blankTarget) : null,
      appTarget: appTarget ? summarizeTarget(appTarget) : null, websocketTarget: page ? "page" : null, pageDiagnostics: details,
      stderr: stderr.slice(-6000) })}`);
    wrapped.chromeVersion = error.chromeVersion ?? null;
    throw wrapped;
  }
}

async function runCdpControlExperiments({ chromePath, baseUrl, workspace, outputDir, deviceScaleFactor }) {
  const controls = [];
  for (const headless of [true, false]) {
    const label = headless ? "headless" : "visible";
    const profile = path.join(workspace, `chrome-control-${label}`);
    let browser;
    const record = { mode: label, headless, profile, status: "FAIL" };
    try {
      browser = await launchChrome({ chromePath, baseUrl, profile, deviceScaleFactor, headless });
      const appFacts = await browser.evaluate("JSON.stringify({url:location.href,readyState:document.readyState})").then(JSON.parse);
      record.status = "PASS";
      const appViewport = await browser.evaluate("JSON.stringify({innerWidth,innerHeight,devicePixelRatio,screen:{width:screen.width,height:screen.height}})").then(JSON.parse);
      Object.assign(record, { pid: browser.spawnedPid, debugPort: browser.debugPort,
        devToolsActivePort: browser.activePortPath, chromeVersion: browser.version.Browser,
        browserLevelWebSocketUsedForPageCommands: false, initialTargets: browser.initialTargets,
        aboutBlankTarget: browser.blankTarget, aboutBlankFacts: browser.blankFacts,
        appTarget: browser.appTarget, appFacts, appViewport, pageWebSocket: { ...browser.diagnostics,
          readyState: browser.page.socket.readyState } });
    } catch (error) {
      record.error = error.message;
      const diagMatch = error.message.match(/Chrome diagnostics: (\{.*\})/s);
      if (diagMatch) { try { record.chromeDiagnostics = JSON.parse(diagMatch[1]); } catch {} }
    } finally {
      if (browser) {
        record.stderrTail = browser.stderr().slice(-6000);
        await writeFile(path.join(outputDir, `chrome-${label}.stderr.log`), browser.stderr(), { flag: "wx" }).catch(() => {});
        await browser.close().catch(() => {});
      } else {
        await writeFile(path.join(outputDir, `chrome-${label}.stderr.log`), record.chromeDiagnostics?.stderr ?? "stderr capture unavailable\n", { flag: "wx" }).catch(() => {});
      }
    }
    controls.push(record);
    await writeFile(path.join(outputDir, "cdp-controls.json"), `${JSON.stringify({ schemaVersion: 1, controls }, null, 2)}\n`);
  }
  return controls;
}

async function pageFacts(browser) {
  return await browser.evaluate(`JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,
    innerWidth,innerHeight,devicePixelRatio,screen:{width:screen.width,height:screen.height},
    visualViewportScale:window.visualViewport?.scale??null,appReady:document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'})`).then(JSON.parse);
}

async function openTradeDialog(browser, baseUrl) {
  await waitFor(async () => (await fetch(`${baseUrl}api/health`)).ok, "backend health before page load");
  await waitFor(async () => browser.evaluate("document.readyState==='complete' && Boolean(document.querySelector('#app-content'))"), "production UI document");
  await waitFor(async () => browser.evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'"), "production UI bootstrap");
  const bootstrap = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  if (bootstrap.workingSession !== null) throw new Error("격리 working session이 사전 데이터 없이 비어 있어야 합니다.");
  await browser.evaluate("document.querySelector('#open-trade-capture')?.click()");
  await waitFor(async () => browser.evaluate("Boolean(document.querySelector('#trade-capture-dialog')?.open)"), "trade capture dialog open");
  await waitFor(async () => browser.evaluate("document.querySelector('[data-role=trade-runtime-status]')?.textContent==='로컬 인식 사용 가능'"),
    "visible local recognition runtime readiness");
  const runtimePayload = await (await fetch(`${baseUrl}api/recognition/trade-runtime`)).json();
  const runtimeStatus = runtimePayload.runtime;
  const runtimeText = await browser.evaluate("document.querySelector('[data-role=trade-runtime-status]')?.textContent||''");
  if (runtimeStatus.available !== true || runtimeStatus.modelReady !== true || runtimeText !== "로컬 인식 사용 가능") {
    throw new Error(`실제 로컬 인식 runtime/model이 준비되지 않았습니다: ${JSON.stringify({ runtimeStatus, runtimeText })}`);
  }
  return { bootstrap, runtimeStatus };
}

function installBlobEvidenceRegistryInPage() {
  if (window.__r011BlobEvidenceByUrl instanceof Map && window.__r011RestoreCreateObjectURL) {
    throw new Error("CAPTURE_BLOB_EVIDENCE_REGISTRY_ALREADY_INSTALLED");
  }
  const descriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const original = URL.createObjectURL;
  if (typeof original !== "function" || !descriptor) throw new Error("CAPTURE_BLOB_EVIDENCE_UNSUPPORTED");
  const registry = new Map();
  const wrapper = function (blob) {
    const objectUrl = Reflect.apply(original, URL, [blob]);
    if (blob instanceof Blob) {
      const evidence = (async () => {
        const bytes = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const bitmapSha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
        return { bitmapSha256, bitmapBytes: bytes.byteLength, blobType: blob.type || "" };
      })();
      registry.set(objectUrl, evidence);
    }
    return objectUrl;
  };
  Object.defineProperty(URL, "createObjectURL", { ...descriptor, value: wrapper });
  window.__r011OriginalCreateObjectURL = original;
  window.__r011WrappedCreateObjectURL = wrapper;
  window.__r011CreateObjectURLDescriptor = descriptor;
  window.__r011BlobEvidenceByUrl = registry;
  window.__r011RestoreCreateObjectURL = () => {
    if (URL.createObjectURL === wrapper) Object.defineProperty(URL, "createObjectURL", descriptor);
    return URL.createObjectURL === original;
  };
  return { installed: URL.createObjectURL === wrapper, registry: window.__r011BlobEvidenceByUrl };
}

async function runCaptureBlobEvidenceProbe(browser) {
  const sample = "r011-capture-blob-evidence-probe";
  const expectedSha256 = createHash("sha256").update(sample, "utf8").digest("hex");
  return await browser.evaluate(`(async()=>{
    const sample=${JSON.stringify(sample)};
    const expectedSha256=${JSON.stringify(expectedSha256)};
    let objectUrl=null;let result=null;let failure=null;let createObjectUrlRestored=false;let objectUrlRevoked=false;
    try{
      const install=(${installBlobEvidenceRegistryInPage.toString()})();
      if(!install.installed)throw new Error("CAPTURE_BLOB_EVIDENCE_INSTALL_FAILED");
      objectUrl=URL.createObjectURL(new Blob([sample],{type:"text/plain"}));
      const pending=window.__r011BlobEvidenceByUrl.get(objectUrl);
      if(!pending)throw new Error("CAPTURE_BLOB_EVIDENCE_MISSING");
      const evidence=await pending;
      result={status:"PASS",bytes:evidence.bitmapBytes,expectedBytes:new TextEncoder().encode(sample).byteLength,
        sha256:evidence.bitmapSha256,sha256Matched:evidence.bitmapSha256===expectedSha256,
        previewFetchUsed:false};
      if(result.bytes!==result.expectedBytes||!result.sha256Matched)throw new Error("CAPTURE_BLOB_EVIDENCE_PROBE_MISMATCH");
    }catch(error){failure=error.message;}
    finally{
      const restore=window.__r011RestoreCreateObjectURL;
      createObjectUrlRestored=restore?restore():true;
      window.__r011RestoreCreateObjectURL=null;
      if(objectUrl){try{URL.revokeObjectURL(objectUrl);objectUrlRevoked=true;}catch{}}
    }
    if(failure)throw new Error(failure);
    return {...result,createObjectUrlRestored,objectUrlRevoked};
  })()`);
}

function installLiveCaptureObserverInPage(installBlobEvidenceRegistry) {
  const install = installBlobEvidenceRegistry();
  if (!install.installed) throw new Error("CAPTURE_BLOB_EVIDENCE_INSTALL_FAILED");
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('[data-action="recognize-trade"]') || window.__r011RecognitionStartSnapshotPromise) return;
    const items = [...document.querySelectorAll(".capture-draft-item")];
    const pendingRows = items.map((item) => {
      const heading = item.querySelector("h4")?.textContent || "";
      const detail = item.querySelector(".capture-draft-details")?.textContent || "";
      const image = item.querySelector("img");
      const previewUrl = image?.currentSrc || image?.src || null;
      const registry = window.__r011BlobEvidenceByUrl;
      const pending = previewUrl && registry instanceof Map ? registry.get(previewUrl) : null;
      const match = heading.match(/(\\d+)×(\\d+)/);
      const sourceType = detail.includes("클립보드") ? "clipboard" : detail.includes("화면") ? "browser-stream"
        : detail.includes("파일") ? "file" : null;
      return { captureId: item.dataset.captureId || null, queueStatus: item.dataset.status || null,
        sourceType, frame: match ? { width: Number(match[1]), height: Number(match[2]) } : null,
        reencoded: detail.includes("PNG 변환"), pending };
    });
    window.__r011RecognitionStartClick = { observedAt: new Date().toISOString(), captureCount: pendingRows.length };
    window.__r011RecognitionStartSnapshotPromise = Promise.all(pendingRows.map(async (row) => {
      let evidence = null;
      let evidenceError = null;
      try { if (row.pending) evidence = await row.pending; else evidenceError = "CAPTURE_BLOB_EVIDENCE_MISSING"; }
      catch (error) { evidenceError = error.message || String(error); }
      return { captureId: row.captureId, queueStatus: row.queueStatus, sourceType: row.sourceType,
        frame: row.frame, bitmapSha256: evidence?.bitmapSha256 ?? null, bitmapBytes: evidence?.bitmapBytes ?? null,
        blobType: evidence?.blobType ?? null, reencoded: row.reencoded, evidenceError };
    })).then((captures) => ({ observedAt: window.__r011RecognitionStartClick.observedAt,
      captureCount: captures.length, captures }));
  };
  document.addEventListener("click", listener, { capture: true, passive: true });
  window.__r011RecognitionStartClickListener = listener;
  return { observerInstalled: true, blobEvidenceInstalled: install.installed };
}

async function restoreLiveCaptureObserver(browser) {
  return await browser.evaluate(`(()=>{
    const listener=window.__r011RecognitionStartClickListener;
    if(listener)document.removeEventListener("click",listener,true);
    window.__r011RecognitionStartClickListener=null;
    const restore=window.__r011RestoreCreateObjectURL;
    const createObjectUrlRestored=restore?restore():URL.createObjectURL===window.__r011OriginalCreateObjectURL;
    window.__r011RestoreCreateObjectURL=null;
    return {observerRemoved:!window.__r011RecognitionStartClickListener,createObjectUrlRestored};
  })()`);
}

async function runRecognitionInteractionProbe(browser) {
  const result = await browser.evaluate(`(()=>{
    const installed=(${installLiveCaptureObserverInPage.toString()})(${installBlobEvidenceRegistryInPage.toString()});
    const button=document.createElement("button");
    button.type="button";button.dataset.action="recognize-trade";button.textContent="harness interaction probe";
    let bubbled=false;
    button.addEventListener("click",()=>{bubbled=true;});
    document.body.append(button);
    const event=new MouseEvent("click",{bubbles:true,cancelable:true});
    const dispatched=button.dispatchEvent(event);
    button.remove();
    const clickObserved=Boolean(window.__r011RecognitionStartClick);
    document.removeEventListener("click",window.__r011RecognitionStartClickListener,true);
    window.__r011RecognitionStartClickListener=null;
    const restore=window.__r011RestoreCreateObjectURL;
    const createObjectUrlRestored=restore?restore():false;
    window.__r011RestoreCreateObjectURL=null;
    return {status:installed.observerInstalled&&installed.blobEvidenceInstalled&&bubbled&&dispatched
      &&!event.defaultPrevented&&clickObserved&&createObjectUrlRestored?"PASS":"FAIL",
      observerInstalled:installed.observerInstalled,bubbled,dispatched,defaultPrevented:event.defaultPrevented,
      clickObserved,createObjectUrlRestored,gameCapturePerformed:false};
  })()`);
  if (result.status !== "PASS") throw new Error(`RECOGNITION_INTERACTION_PROBE_FAILED: ${JSON.stringify(result)}`);
  return result;
}

async function runPreflight(options) {
  const defaultDir = path.join(R011_ROOT, `preflight-${new Date().toISOString().replaceAll(":", "-")}`);
  const outputDir = assertInsideR011(options["run-dir"] || defaultDir);
  const pythonPath = selectedPython(); const chromePath = selectedChrome();
  await mkdir(outputDir, { recursive: true });
  let stage = "python_abi_import_probe";
  const probe = probePython(pythonPath);
  stage = "required_files_check";
  if (!(await stat(chromePath).catch(() => null))?.isFile()) throw new Error(`Chrome 실행 파일이 없습니다: ${chromePath}`);
  if (!(await stat(path.join(APP_ROOT, "tools", "trade_review_evaluation.mjs")).catch(() => null))?.isFile()) throw new Error("R010 evaluator 파일이 없습니다.");
  const workspace = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), "bdo-r011-preflight-")));
  const port = await findPort(); let server; let browser; let result; let cdpControls = null;
  let captureBlobEvidenceProbe = null; let recognitionInteractionProbe = null;
  const deviceScaleFactor = Number(options["device-scale-factor"] ?? "1.3");
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0 || deviceScaleFactor > 4) throw new Error("--device-scale-factor는 0 초과 4 이하 수치여야 합니다.");
  try {
    stage = "isolated_backend_and_sidecar_start";
    server = await startServer({ pythonPath, workspace, port });
    if (server.runtime.available !== true || server.runtime.modelReady !== true) throw new Error(`로컬 recognition runtime/model unavailable: ${JSON.stringify(server.runtime)}`);
    stage = "headless_visible_cdp_control";
    cdpControls = await runCdpControlExperiments({ chromePath, baseUrl: server.baseUrl, workspace, outputDir, deviceScaleFactor });
    if (cdpControls.some((item) => item.status !== "PASS")) {
      throw new Error(`headless/visible CDP control이 모두 PASS하지 않았습니다: ${JSON.stringify(cdpControls.map(({ mode, status, error }) => ({ mode, status, error })))}`);
    }
    const profile = path.join(workspace, "chrome-preflight-visible");
    stage = "visible_chrome_and_page_target";
    browser = await launchChrome({ chromePath, baseUrl: server.baseUrl, profile, deviceScaleFactor });
    stage = "production_page_and_capture_ui";
    const ui = await openTradeDialog(browser, server.baseUrl);
    stage = "capture_blob_evidence_probe";
    captureBlobEvidenceProbe = await runCaptureBlobEvidenceProbe(browser);
    if (captureBlobEvidenceProbe.status !== "PASS" || !captureBlobEvidenceProbe.sha256Matched
      || captureBlobEvidenceProbe.previewFetchUsed !== false || !captureBlobEvidenceProbe.createObjectUrlRestored
      || !captureBlobEvidenceProbe.objectUrlRevoked) {
      throw new Error(`CAPTURE_BLOB_EVIDENCE_PROBE_FAILED: ${JSON.stringify(captureBlobEvidenceProbe)}`);
    }
    stage = "passive_recognition_interaction_probe";
    recognitionInteractionProbe = await runRecognitionInteractionProbe(browser);
    const viewport = await pageFacts(browser);
    if (!viewport.appReady || !viewport.url.startsWith(server.baseUrl) || !viewport.innerWidth || !viewport.innerHeight) throw new Error("visible Chrome의 production UI/viewport 확인이 실패했습니다.");
    const mode = deviceScaleFactor;
    result = {
      schemaVersion: 1, task: "R011-A", status: "PREFLIGHT_PASS", createdAt: isoNow(),
      gameCapturePerformed: false, independentEvidenceCreated: false,
      git: { branch: git(["branch", "--show-current"]), head: git(["rev-parse", "HEAD"]), main: git(["rev-parse", "main"]) },
      python: probe,
      chrome: { executable: chromePath, version: browser.version.Browser, product: browser.version.Product, visible: true },
      chromeStderrTail: browser.stderr().slice(-6000),
      cdpControls,
      cdp: { debugPort: browser.debugPort, spawnedPid: browser.spawnedPid, devToolsActivePort: browser.activePortPath,
        initialTargets: browser.initialTargets, blankTarget: browser.blankTarget, appTarget: browser.appTarget,
        browserLevelWebSocketUsedForPageCommands: false, websocket: browser.diagnostics },
      runtime: ui.runtimeStatus,
      captureBlobEvidenceProbe,
      recognitionInteractionProbe,
      model: { available: ui.runtimeStatus.available, modelReady: ui.runtimeStatus.modelReady,
        engineId: ui.runtimeStatus.engineId, modelBundleSha256: ui.runtimeStatus.modelBundleSha256 ?? null },
      storageIsolation: { isolatedMainDb: server.mainDb, isolatedRecognitionSidecar: server.sidecar,
        tempLocalAppData: path.join(workspace, "localappdata"), realMainDbAccessed: false, realUserDbAccessed: false,
        productionSidecarAccessed: false },
      browser: { ...viewport, targetViewport: { width: 1920, height: 1080 },
        cdpDeviceScaleFactor: mode, cdpDeviceScaleFactorIsOsScale: false,
        cdpDeviceScaleFactorIsWindowsScale: false, cdpDeviceScaleFactorIsChromeZoom: false,
        captureDialogOpened: true, runtimeLabel: "로컬 인식 사용 가능" },
      r010Evaluator: path.join(APP_ROOT, "tools", "trade_review_evaluation.mjs"),
    };
    await writeFile(path.join(outputDir, "preflight.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    const failed = { schemaVersion: 1, task: "R011-A", status: "PREFLIGHT_FAILED", createdAt: isoNow(),
      failedStage: stage, errorSummary: error.message.split(/\r?\n/)[0],
      gameCapturePerformed: false, independentEvidenceCreated: false,
      python: { executable: pythonPath, version: probe.version, importsPassed: true },
      chrome: { executable: chromePath, visibleLaunchAttempted: stage === "visible_chrome_and_page_target" || stage === "production_page_and_capture_ui",
        version: browser?.version?.Browser ?? error.chromeVersion ?? null,
        pid: browser?.spawnedPid ?? null, debugPort: browser?.debugPort ?? null,
        devToolsActivePort: browser?.activePortPath ?? null, stderrTail: browser?.stderr?.().slice(-6000) ?? null },
      cdpControls,
      captureBlobEvidenceProbe,
      recognitionInteractionProbe,
      runtime: server?.runtime ?? null,
      storageIsolation: server ? { isolatedMainDb: server.mainDb, isolatedRecognitionSidecar: server.sidecar,
        realMainDbAccessed: false, realUserDbAccessed: false, productionSidecarAccessed: false } : null };
    await writeFile(path.join(outputDir, "preflight.json"), `${JSON.stringify(failed, null, 2)}\n`, { flag: "wx" }).catch(() => {});
    throw error;
  } finally {
    if (browser) await restoreLiveCaptureObserver(browser).catch(() => false);
    if (browser) await browser.close().catch(() => {});
    if (server?.child) await stopChild(server.child);
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
  console.log(JSON.stringify({ status: result.status, preflight: path.join(outputDir, "preflight.json"),
    gameCapturePerformed: false, independentEvidenceCreated: false, runtime: result.runtime,
    captureBlobEvidenceProbe: result.captureBlobEvidenceProbe,
    recognitionInteractionProbe: result.recognitionInteractionProbe,
    chrome: result.chrome, browser: result.browser }, null, 2));
}

async function hashFile(filePath) {
  const digest = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function listImages(directory, base = directory) {
  const records = [];
  for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) records.push(...await listImages(full, base));
    else if (item.isFile() && IMAGE_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
      records.push({ path: path.relative(REPO, full).replaceAll(path.sep, "/"), sha256: await hashFile(full) });
    }
  }
  return records;
}

function statusEntries() {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: REPO, encoding: "buffer", windowsHide: true });
  if (result.status !== 0) throw new Error(`git status 실패: ${result.stderr.toString("utf8")}`);
  const porcelain = result.stdout.toString("utf8");
  return porcelain ? porcelain.split("\0").filter(Boolean).map((line) => ({ raw: line, path: line.slice(3) })) : [];
}

function verifyLiveGit() {
  const branch = git(["branch", "--show-current"]);
  const head = git(["rev-parse", "HEAD"]);
  const remote = git(["rev-parse", "origin/v2"]);
  const main = git(["rev-parse", "main"]);
  if (branch !== "v2") throw new Error(`live run은 v2에서만 허용됩니다 (현재 ${branch}).`);
  if (git(["rev-parse", "HEAD^"]) !== EXPECTED_PARENT) throw new Error(`R011-A-R5 parent가 예상 SHA와 다릅니다: ${git(["rev-parse", "HEAD^"])}`);
  if (git(["log", "-1", "--format=%s"]) !== HARNESS_SUBJECT) throw new Error(`HEAD가 R011-A-R5 harness commit이 아닙니다 (필요 commit 제목: ${HARNESS_SUBJECT}).`);
  if (remote !== head) throw new Error("origin/v2와 HEAD가 같지 않습니다. R011-A harness commit push 후 실행해야 합니다.");
  if (main !== EXPECTED_MAIN) throw new Error(`main SHA가 승인 기준과 다릅니다: ${main}`);
  const entries = statusEntries();
  const unexpected = entries.filter((entry) => !PROTECTED_DIRTY.has(entry.path.replaceAll("\\", "/")));
  if (unexpected.length) throw new Error(`보호된 기존 dirty 외 tracked/untracked 변경이 있어 live freeze를 거부합니다: ${unexpected.map((item) => item.raw).join(" | ")}`);
  return { branch, head, originV2: remote, main, protectedDirty: entries.map((item) => item.path) };
}

async function loadOrCreateFreeze(runDir, gitState, environment) {
  const freezePath = path.join(runDir, "freeze-manifest.json");
  const existing = await readFile(freezePath, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) {
    if (existing.task !== "R011" || existing.frozenGitSha !== gitState.head || existing.mainSha !== gitState.main || existing.branch !== "v2") {
      throw new Error("기존 freeze-manifest가 현재 harness commit/main/branch와 달라 덮어쓰지 않고 중단합니다.");
    }
    if (existing.evaluationPolicyVersion !== EVALUATION_POLICY || existing.rawEvaluationVersion !== RAW_EVALUATION) throw new Error("freeze-manifest의 R010 policy가 현재와 다릅니다.");
    if (existing.liveUserEnvironmentRequirement !== "USE_ACTUAL_USER_ENVIRONMENT_WITHOUT_FORCED_SCALING_OR_ZOOM") {
      throw new Error("기존 freeze-manifest에 실제 사용자 환경 정책이 없습니다. 기존 evidence를 덮어쓰지 않고 중단합니다.");
    }
    return existing;
  }
  const legacyRoot = path.join(ROOT, "recognition-local", "live-validation");
  const oldEvidence = await listImages(legacyRoot).then((items) => items.filter((item) => !item.path.startsWith("_dev/recognition-local/live-validation/r011/")));
  const freeze = {
    schemaVersion: 1, task: "R011", frozenGitSha: gitState.head, mainSha: gitState.main, branch: gitState.branch,
    evaluationPolicyVersion: EVALUATION_POLICY, rawEvaluationVersion: RAW_EVALUATION,
    mappingPolicyVersion: MAPPING_POLICY, correctionVersion: null, registryVersion: null,
    runtime: environment.runtime, model: environment.model,
    createdAt: isoNow(), automatedBrowserReference: { viewport: { width: 1920, height: 1080 },
      cdpDeviceScaleFactor: 1.3, purpose: "DETERMINISTIC_BROWSER_REGRESSION_REFERENCE",
      cdpDeviceScaleFactorIsWindowsScale: false, cdpDeviceScaleFactorIsChromeZoom: false },
    liveUserEnvironmentRequirement: "USE_ACTUAL_USER_ENVIRONMENT_WITHOUT_FORCED_SCALING_OR_ZOOM",
    preFreezeImageEvidence: oldEvidence,
    preFreezeImageHashes: [...new Set(oldEvidence.map((item) => item.sha256))].sort(),
    protectedExistingDirty: gitState.protectedDirty,
  };
  await writeFile(freezePath, `${JSON.stringify(freeze, null, 2)}\n`, { flag: "wx" });
  return freeze;
}

async function readPriorR011Cases() {
  const records = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name === "case-manifest.json") {
        const record = await readFile(fullPath, "utf8").then(JSON.parse).catch(() => null);
        if (record?.task === "R011" && record.caseId) records.push({ ...record, caseManifestPath: fullPath });
      }
    }
  }
  await visit(R011_ROOT);
  return records;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function updateRunManifest(runDir, gitState, cases, evaluationReport, limitations = []) {
  const caseRefs = cases.map((item) => ({ caseId: item.caseId, status: item.status,
    caseManifest: path.relative(runDir, item.caseManifestPath).replaceAll(path.sep, "/"),
    userAttestedEnvironment: item.userAttestedEnvironment ?? null,
    browserObservedEnvironment: item.browserObservedEnvironment ?? null,
    observationId: item.observationId ?? null, exportPath: item.exportPath ?? null }));
  const manifest = {
    schemaVersion: 1, task: "R011", status: "LIVE_CASES_RECORDED_NOT_FINAL_R011", frozenGitSha: gitState.head,
    environmentPolicy: "ACTUAL_USER_ENVIRONMENT_RECORDED_NOT_FORCED", cases: caseRefs,
    observationRefs: caseRefs.filter((item) => item.observationId).map(({ caseId, observationId, exportPath }) => ({ caseId, observationId, exportPath })),
    evaluationReport, sessionResults: cases.map((item) => ({ caseId: item.caseId, status: item.sessionStatus ?? "NOT_RECORDED" })),
    automatedRegressionRefs: [], limitations: [...limitations, "R011-A harness does not issue final R011 usability approval."],
    ownerUsabilityDecision: null,
  };
  await writeJson(path.join(runDir, "run-manifest.json"), manifest);
  return manifest;
}

function parseNumber(value, label, { integer = true, minimum = 1 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isInteger(number))) throw new Error(`${label} 값이 올바르지 않습니다: ${value}`);
  return number;
}

function optionalNumber(value, label, options) {
  return value == null ? null : parseNumber(value, label, options);
}

function liveArgs(options) {
  const required = ["run-dir", "case-id", "input-mode", "cohort"];
  const missing = required.filter((name) => !options[name]);
  if (missing.length) throw new Error(`--live 필수 옵션 누락: ${missing.map((name) => `--${name}`).join(", ")}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(options["case-id"])) throw new Error("--case-id는 영문/숫자/._-로 구성된 1~80자여야 합니다.");
  const inputMode = options["input-mode"].toUpperCase();
  if (!["STREAM", "FILE", "PASTE"].includes(inputMode)) throw new Error("--input-mode는 STREAM, FILE, PASTE 중 하나여야 합니다.");
  if (options.cohort !== "INDEPENDENT") throw new Error("R011 primary live case는 --cohort INDEPENDENT만 허용합니다.");
  if (options["display-scale-percent"] && options["windows-scale-percent"]) {
    throw new Error("--display-scale-percent와 --windows-scale-percent를 함께 사용할 수 없습니다.");
  }
  if (options["display-scale-percent"]) {
    console.warn("--display-scale-percent는 폐기 예정의 모호한 별칭입니다. --windows-scale-percent를 사용하세요.");
  }
  return { caseId: options["case-id"], inputMode, cohort: "INDEPENDENT",
    displayWidth: optionalNumber(options["display-width"], "--display-width"),
    displayHeight: optionalNumber(options["display-height"], "--display-height"),
    windowsScalePercent: optionalNumber(options["windows-scale-percent"] ?? options["display-scale-percent"],
      options["display-scale-percent"] ? "--display-scale-percent (deprecated Windows scale alias)" : "--windows-scale-percent", { integer: false }),
    chromeZoomPercent: optionalNumber(options["chrome-zoom-percent"], "--chrome-zoom-percent", { integer: false }),
    notes: options.notes ?? null,
    humanTimeoutMs: parseNumber(options["human-timeout-minutes"] ?? "120", "--human-timeout-minutes", { minimum: 1 }) * 60 * 1000 };
}

function sourceRowsFromExport(exportRecord) {
  const semantic = exportRecord?.semantic;
  const observation = semantic?.observation;
  const captures = observation?.sourceContext?.captures;
  const captureEvidence = observation?.sourceContext?.recognition?.captureEvidence?.captures;
  if (!Array.isArray(captures) || !Array.isArray(captureEvidence)) throw new Error("저장된 observation export에 capture provenance/evidence가 없습니다.");
  const evidenceById = new Map(captureEvidence.map((item) => [item.captureId, item]));
  return captures.map((item) => {
    const evidence = evidenceById.get(item.captureId);
    if (!evidence) throw new Error(`observation capture evidence 누락: ${item.captureId}`);
    return { captureId: item.captureId, sourceType: item.metadata?.sourceType ?? null,
      capturedAt: item.metadata?.capturedAt ?? null, frame: item.metadata?.frame ?? null,
      fidelity: item.metadata?.fidelity ?? null, sourceSha256: item.sourceSha256 ?? null,
      bitmapSha256: item.bitmapSha256 ?? evidence.imageHash ?? null,
      bitmapBytes: item.bitmapBytes ?? null, sourceBytes: item.sourceBytes ?? null,
      reencoded: item.reencoded === true, recognitionImageHash: evidence.imageHash,
      imageDimensions: evidence.imageDimensions ?? null, completeRowCount: evidence.completeRowCount,
      edgeSegmentCount: evidence.edgeSegmentCount };
  });
}

function getQueuedCapturesExpression() {
  return `(async()=>{
    const items=[...document.querySelectorAll('.capture-draft-item')];
    return await Promise.all(items.map(async item=>{
      const heading=item.querySelector('h4')?.textContent||'';
      const detail=item.querySelector('.capture-draft-details')?.textContent||'';
      const image=item.querySelector('img');
      const previewUrl=image?.currentSrc||image?.src||null;
      const registry=window.__r011BlobEvidenceByUrl;
      const pending=previewUrl&&registry instanceof Map?registry.get(previewUrl):null;
      const match=heading.match(/(\\d+)×(\\d+)/);
      const sourceType=detail.includes('클립보드')?'clipboard':detail.includes('화면')?'browser-stream':detail.includes('파일')?'file':null;
      if(!pending)throw new Error('CAPTURE_BLOB_EVIDENCE_MISSING: '+(item.dataset.captureId||previewUrl||'unknown'));
      const evidence=await pending;
      return {captureId:item.dataset.captureId||null,queueStatus:item.dataset.status||null,heading,detail,sourceType,
        frame:match?{width:Number(match[1]),height:Number(match[2])}:null,
        bitmapSha256:evidence.bitmapSha256,bitmapBytes:evidence.bitmapBytes,blobType:evidence.blobType,
        reencoded:detail.includes('PNG 변환')};
    }));
  })()`;
}

async function queuedCaptures(browser) {
  const result = await browser.evaluate(getQueuedCapturesExpression());
  if (!Array.isArray(result)) throw new Error("캡처 큐를 읽지 못했습니다.");
  return result;
}

function modeMatches(mode, sourceType) {
  return (mode === "STREAM" && sourceType === "browser-stream") || (mode === "FILE" && sourceType === "file")
    || (mode === "PASTE" && sourceType === "clipboard");
}

function classifyCaptureSources(queued, freeze, priorCases, inputMode) {
  const knownHashes = new Set(freeze.preFreezeImageHashes || []);
  const priorExports = priorCases.flatMap((item) => item.sourceCaptures || []);
  for (const item of priorExports) {
    if (item.bitmapSha256) knownHashes.add(item.bitmapSha256);
    if (item.sourceSha256) knownHashes.add(item.sourceSha256);
  }
  const captures = queued.map((item, index) => {
    const matchingPriorHashes = [item.bitmapSha256, item.sourceSha256].filter((hash) => hash && knownHashes.has(hash));
    const modeExpected = item.sourceType ? modeMatches(inputMode, item.sourceType) : null;
    return { captureOrdinal: index + 1, ...item,
      matchingPriorHashes: [...new Set(matchingPriorHashes)], modeExpected };
  });
  const duplicateCaptures = captures.filter((item) => item.matchingPriorHashes.length > 0);
  const incomplete = captures.filter((item) => !item.captureId || !item.bitmapSha256 || !item.frame || !item.sourceType);
  const duplicateCaptureIds = captures.filter((item, index) => captures.findIndex((entry) => entry.captureId === item.captureId) !== index);
  return { captures, duplicateCaptures, incomplete, duplicateCaptureIds,
    status: duplicateCaptures.length ? "DUPLICATE_KNOWN_PRIOR_EVIDENCE"
      : incomplete.length || duplicateCaptureIds.length ? "SOURCE_EVIDENCE_INCOMPLETE"
        : "NO_KNOWN_PRIOR_HASH_MATCH" };
}

function compareRecognitionSourceWithExport(startSnapshot, exportCaptures) {
  if (!Array.isArray(startSnapshot?.captures)) {
    return { status: "SOURCE_PROVENANCE_UNVERIFIABLE", comparedCaptureCount: 0,
      reason: "recognition-start queue snapshot unavailable" };
  }
  const starts = startSnapshot.captures;
  const byId = new Map(starts.map((item) => [item.captureId, item]));
  const mismatches = [];
  if (!starts.length || !exportCaptures.length) mismatches.push({ field: "captureCount", reason: "no capture provenance available" });
  if (starts.length !== exportCaptures.length) mismatches.push({ field: "captureCount", start: starts.length, exported: exportCaptures.length });
  for (const exported of exportCaptures) {
    const observed = byId.get(exported.captureId);
    if (!observed) { mismatches.push({ captureId: exported.captureId, field: "captureId", reason: "missing from recognition-start snapshot" }); continue; }
    for (const field of ["sourceType", "bitmapSha256"]) {
      if (observed[field] !== exported[field]) mismatches.push({ captureId: exported.captureId, field,
        recognitionStart: observed[field] ?? null, observationExport: exported[field] ?? null });
    }
    for (const dimension of ["width", "height"]) {
      if (observed.frame?.[dimension] !== exported.frame?.[dimension]) mismatches.push({ captureId: exported.captureId,
        field: `frame.${dimension}`, recognitionStart: observed.frame?.[dimension] ?? null,
        observationExport: exported.frame?.[dimension] ?? null });
    }
  }
  return { status: mismatches.length ? "SOURCE_PROVENANCE_MISMATCH" : "SOURCE_PROVENANCE_MATCH",
    comparedCaptureCount: Math.min(starts.length, exportCaptures.length), mismatches };
}

function classifyExportIndependence(exportCaptures, freeze, priorCases, sourceComparison, inputMode) {
  const evidenceByHash = new Map();
  const addHash = (hash, ref) => {
    if (!hash) return;
    const refs = evidenceByHash.get(hash) || [];
    refs.push(ref);
    evidenceByHash.set(hash, refs);
  };
  for (const item of freeze.preFreezeImageEvidence || []) addHash(item.sha256, { type: "PRE_R011_IMAGE", path: item.path });
  for (const prior of priorCases) for (const capture of prior.sourceCaptures || []) {
    addHash(capture.bitmapSha256, { type: "PRIOR_R011_CAPTURE", caseId: prior.caseId, hashBasis: "bitmapSha256" });
    addHash(capture.sourceSha256, { type: "PRIOR_R011_CAPTURE", caseId: prior.caseId, hashBasis: "sourceSha256" });
  }
  const matches = [];
  for (const capture of exportCaptures) for (const hashBasis of ["bitmapSha256", "sourceSha256"]) {
    const hash = capture[hashBasis];
    for (const prior of evidenceByHash.get(hash) || []) matches.push({ captureId: capture.captureId, hashBasis, hash, prior });
  }
  const priorCasesWithoutHashes = priorCases.filter((item) => !(item.sourceCaptures || []).some((capture) => capture.bitmapSha256 || capture.sourceSha256))
    .map((item) => ({ caseId: item.caseId, status: item.status, caseManifestPath: item.caseManifestPath }));
  const inputModeMismatches = exportCaptures.filter((item) => !modeMatches(inputMode, item.sourceType))
    .map((item) => ({ captureId: item.captureId, inputMode, sourceType: item.sourceType }));
  const status = matches.length ? "DUPLICATE_NON_INDEPENDENT"
    : sourceComparison.status !== "SOURCE_PROVENANCE_MATCH" ? "INDEPENDENCE_UNVERIFIABLE_SOURCE_MISMATCH"
      : inputModeMismatches.length ? "INDEPENDENCE_UNVERIFIABLE_INPUT_MODE_MISMATCH"
      : "NO_KNOWN_PRIOR_HASH_MATCH";
  return { status, independentCandidate: status === "NO_KNOWN_PRIOR_HASH_MATCH", matches,
    priorCasesWithoutHashes, inputModeMismatches, comparedCaptureCount: exportCaptures.length };
}

async function waitForRecognitionStart(browser, timeoutMs) {
  console.log(`\nChrome에서 화면 연결 후 ROI를 정하고, 게임을 직접 스크롤하며 필요한 만큼 캡처하세요.`);
  console.log("캡처가 끝나면 Chrome 화면의 ‘로컬 인식 실행’을 직접 누르세요. 터미널 입력은 필요하지 않습니다.");
  const request = await waitFor(async () => browser.recognitionRequests[0] || false,
    "user-triggered local trade recognition request", timeoutMs, 250);
  let clickSnapshot = null;
  try {
    clickSnapshot = await browser.evaluate(`(async()=>window.__r011RecognitionStartSnapshotPromise
      ?await window.__r011RecognitionStartSnapshotPromise:null)()`);
  } catch {}
  let fallbackCaptures = null;
  if (!clickSnapshot?.captures?.length) {
    try { fallbackCaptures = await queuedCaptures(browser); }
    catch (error) { fallbackCaptures = { error: error.message, captures: [] }; }
  }
  const sourceSnapshot = clickSnapshot?.captures?.length
    ? { authority: "PASSIVE_USER_CLICK_QUEUE_SNAPSHOT", ...clickSnapshot }
    : { authority: "POST_START_DOM_BEST_EFFORT", observedAt: request.observedAt,
      captures: Array.isArray(fallbackCaptures) ? fallbackCaptures : fallbackCaptures?.captures || [],
      evidenceError: fallbackCaptures?.error ?? null };
  const cleanup = await restoreLiveCaptureObserver(browser).catch((error) => ({
    observerRemoved: false, createObjectUrlRestored: false, error: error.message }));
  return { request, sourceSnapshot, cleanup };
}

async function waitForRecognition(browser, timeoutMs) {
  console.log("\n인식이 끝나면 모든 logical row와 6개 필드를 직접 확인·수정하고, 모르는 값은 UNKNOWN으로 표시한 뒤 ‘검수 완료’를 누르세요.");
  return await waitFor(async () => {
    const state = await browser.evaluate(`JSON.stringify({rows:document.querySelectorAll('.trade-review-table tbody tr[data-projection-row-id],.trade-review-table tbody tr[data-capture-id]').length,
      table:Boolean(document.querySelector('.trade-review-table')),recognizeDisabled:document.querySelector('[data-action=recognize-trade]')?.disabled??null,
      queued:Number(document.querySelector('#trade-capture-dialog')?.dataset.queueLength||0)})`).then(JSON.parse);
    return state.table && state.rows > 0 ? state : false;
  }, "real recognition result/review rows", timeoutMs, 500);
}

async function waitForObservation(browser, timeoutMs) {
  console.log("검수 완료 후 backend가 observation을 저장하면 export를 자동 보관합니다.");
  return await waitFor(async () => {
    const reply = [...browser.observationReplies].reverse().find((item) => item.body?.ok === true && item.body?.receipt?.observationId);
    if (reply) return reply;
    const status = await browser.evaluate(`document.querySelector('[data-role=trade-recognition-status]')?.textContent||document.querySelector('#trade-recognition-status')?.textContent||''`);
    const hasSaveFailure = /저장.*실패|저장 요청이 거부|저장소/.test(status);
    if (hasSaveFailure) return false;
    return false;
  }, "successful saved observation POST", timeoutMs, 400);
}

async function observationStatus(browser) {
  return await browser.evaluate(`JSON.stringify({status:[...document.querySelectorAll('[data-role]')].find(node=>node.dataset.role==='trade-recognition-status')?.textContent||'',
    sessionStatus:document.querySelector('[data-role=session-apply-status]')?.textContent||'',
    newDisabled:document.querySelector('[data-action=apply-reviewed-new]')?.disabled??true,
    exclusions:[...document.querySelectorAll('.trade-review-held-exclusion input[type=checkbox]')].filter(node=>node.checked).map(node=>node.dataset.projectionRowId),
    exclusionOptions:[...document.querySelectorAll('.trade-review-held-exclusion input[type=checkbox]')].map(node=>node.dataset.projectionRowId)})`).then(JSON.parse);
}

async function waitForDtoReadiness(browser, timeoutMs) {
  console.log("R008 상태가 준비되면 보류 행이 있는 경우 사용자가 직접 제외 여부를 결정합니다.");
  console.log("그 뒤 ‘새 회차로 적용’과 ‘이 내용으로 회차 저장’을 직접 눌러 주세요. harness는 버튼을 누르지 않습니다.");
  const ready = await waitFor(async () => {
    const state = await observationStatus(browser);
    return state.sessionStatus && state.sessionStatus !== "저장된 검수 자료를 확인하는 중입니다." && !state.newDisabled ? state : false;
  }, "R008 READY and user exclusions", timeoutMs, 500);
  return ready;
}

function bootstrapSessionFacts(body) {
  const session = body?.workingSession;
  return session ? { exists: true, id: session.id ?? null, revision: session.revision ?? null,
    scannedTradeCount: Array.isArray(session.scannedTrades) ? session.scannedTrades.length : null,
    diagnostics: session.diagnostics ?? null, schedule: session.schedule ?? null, completed: session.completed ?? null }
    : { exists: false };
}

async function waitForAppliedSession(browser, timeoutMs) {
  return await waitFor(async () => {
    const state = await observationStatus(browser);
    if (/저장된 회차를 다시 읽어 확인하고 화면에 적용했습니다/.test(state.sessionStatus)) return state;
    return false;
  }, "durable session commit and R009 readback", timeoutMs, 500);
}

async function evaluateRun(runDir, caseId, exportsForEvaluation) {
  const evalDir = path.join(runDir, "evaluation"); await mkdir(evalDir, { recursive: true });
  const manifestPath = path.join(evalDir, `manifest-${caseId}.json`);
  const outputPath = path.join(evalDir, `report-${caseId}.json`);
  const manifest = { schemaVersion: 1, evaluationPolicyVersion: EVALUATION_POLICY,
    rawEvaluationVersion: RAW_EVALUATION, splitSeed: "r011-independent-live-v1",
    observations: exportsForEvaluation.map((item) => ({ exportPath: path.relative(evalDir, item.exportPath).replaceAll(path.sep, "/"),
      exclusions: item.exclusions, cohort: item.cohort })) };
  await writeJson(manifestPath, manifest);
  const evaluator = path.join(APP_ROOT, "tools", "trade_review_evaluation.mjs");
  const result = spawnSync(process.execPath, [evaluator, "--manifest", manifestPath, "--out", outputPath], {
    cwd: REPO, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`R010 evaluator 실패:\n${result.stderr || result.stdout}`);
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  return { manifestPath, reportPath: outputPath, semanticHash: report.semanticHash,
    evaluationStatus: report.evaluationStatus, splitLeakage: report.warnings?.some((item) => String(item).includes("SPLIT_LEAKAGE")) ?? false };
}

async function runLive(options) {
  const input = liveArgs(options);
  const runDir = assertInsideR011(options["run-dir"]);
  const caseDir = path.join(runDir, "cases", input.caseId);
  await mkdir(runDir, { recursive: true });
  await mkdir(path.join(runDir, "cases"), { recursive: true });
  try { await mkdir(caseDir, { recursive: false }); } catch (error) {
    if (error.code === "EEXIST") throw new Error(`case-id가 이미 존재합니다. 기존 기록을 덮어쓰지 않습니다: ${input.caseId}`);
    throw error;
  }
  const caseManifestPath = path.join(caseDir, "case-manifest.json");
  const caseRecord = { schemaVersion: 1, task: "R011", caseId: input.caseId, status: "STARTED_CAPTURE_PENDING",
    cohort: input.cohort, inputMode: input.inputMode,
    userAttestedEnvironment: { displayWidth: input.displayWidth, displayHeight: input.displayHeight,
      windowsScalePercent: input.windowsScalePercent, chromeZoomPercent: input.chromeZoomPercent,
      source: "USER_ATTESTED_OPTIONAL" },
    notes: input.notes, createdAt: isoNow(), sourceCaptures: [], observationId: null, exportPath: null,
    exportSha256: null, explicitExclusions: [], r008Status: null, sessionStatus: "NOT_STARTED" };
  await writeJson(caseManifestPath, caseRecord);
  const caseFiles = { browserObservationsPath: path.join(caseDir, "browser-observations.json"),
    sessionResultPath: path.join(caseDir, "session-result.json"), runLogPath: path.join(caseDir, "run-log.json") };
  const log = { schemaVersion: 1, events: [{ at: isoNow(), event: "CASE_STARTED", caseId: input.caseId }] };
  let server; let browser; let profile; let workspace;
  let gitState; let freeze;
  const timeoutMs = input.humanTimeoutMs;
  try {
    gitState = verifyLiveGit();
    const pythonPath = selectedPython(); const probe = probePython(pythonPath);
    const chromePath = selectedChrome();
    if (!(await stat(chromePath).catch(() => null))?.isFile()) throw new Error(`Chrome 실행 파일이 없습니다: ${chromePath}`);
    if (!(await stat(path.join(APP_ROOT, "tools", "trade_review_evaluation.mjs")).catch(() => null))?.isFile()) throw new Error("R010 evaluator 파일이 없습니다.");
    const existingCases = [];
    for (const item of await readdir(path.join(runDir, "cases"), { withFileTypes: true }).catch(() => [])) {
      if (!item.isDirectory() || item.name === input.caseId) continue;
      const existing = await readFile(path.join(runDir, "cases", item.name, "case-manifest.json"), "utf8").then(JSON.parse).catch(() => null);
      if (existing) existingCases.push(existing);
    }
    const priorR011Cases = (await readPriorR011Cases()).filter((item) =>
      path.resolve(item.caseManifestPath) !== path.resolve(caseManifestPath));
    workspace = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), "bdo-r011-live-")));
    const port = await findPort();
    server = await startServer({ pythonPath, workspace: path.join(runDir, "session", input.caseId), port });
    if (server.runtime.available !== true || server.runtime.modelReady !== true) throw new Error(`실제 로컬 OCR runtime/model unavailable: ${JSON.stringify(server.runtime)}`);
    const environment = { pythonPath, probe, runtime: server.runtime,
      model: { engineId: server.runtime.engineId, modelBundleSha256: server.runtime.modelBundleSha256 ?? null } };
    freeze = await loadOrCreateFreeze(runDir, gitState, environment);
    profile = path.join(workspace, "chrome-profile"); await mkdir(profile, { recursive: true });
    const dsf = optionalNumber(options["device-scale-factor"], "--device-scale-factor", { integer: false, minimum: 0.01 });
    if (dsf != null && dsf > 4) throw new Error("--device-scale-factor는 0 초과 4 이하 수치여야 합니다.");
    browser = await launchChrome({ chromePath, baseUrl: server.baseUrl, profile, deviceScaleFactor: dsf,
      windowSize: dsf == null ? null : { width: 1920, height: 1080 } });
    const opened = await openTradeDialog(browser, server.baseUrl);
    const viewport = await pageFacts(browser);
    const environmentObservation = { ...viewport, chromeVersion: browser.version.Browser,
      cdpDeviceScaleFactor: dsf, cdpDeviceMetricsOverrideApplied: dsf != null,
      cdpDeviceScaleFactorIsWindowsScale: false, cdpDeviceScaleFactorIsChromeZoom: false,
      userAttestedEnvironment: caseRecord.userAttestedEnvironment };
    caseRecord.browserObservedEnvironment = environmentObservation;
    if (!viewport.innerWidth || !viewport.innerHeight) throw new Error("Chrome의 실제 viewport 값을 읽을 수 없습니다.");
    if (opened.runtimeStatus.available !== true) throw new Error("actual runtime status unavailable");
    const observerInstall = await browser.evaluate(`(${installLiveCaptureObserverInPage.toString()})(${installBlobEvidenceRegistryInPage.toString()})`);
    if (!observerInstall.observerInstalled || !observerInstall.blobEvidenceInstalled) throw new Error("LIVE_CAPTURE_OBSERVER_INSTALL_FAILED");
    caseRecord.captureFlow = { type: "USER_CONTROLLED_MANUAL_MULTI_CAPTURE", automaticScroll: false,
      recognitionTriggeredBy: "USER_RECOGNITION_BUTTON", terminalInputAfterStartup: false };
    caseRecord.status = "WAITING_FOR_USER_RECOGNITION";
    log.events.push({ at: isoNow(), event: "CAPTURE_OBSERVER_INSTALLED", passive: true,
      blobEvidenceInstalled: observerInstall.blobEvidenceInstalled });
    await writeJson(caseManifestPath, caseRecord);
    await writeJson(caseFiles.browserObservationsPath, { schemaVersion: 1, environment: environmentObservation,
      python: { executable: probe.executable, version: probe.version, prefix: probe.prefix }, chrome: browser.version,
      runtime: opened.runtimeStatus, isolatedStorage: { mainDb: server.mainDb, recognitionSidecar: server.sidecar,
        realMainDbAccessed: false, realUserDbAccessed: false, productionSidecarAccessed: false },
      recognitionStart: null, captureMetadataAtRecognitionStart: null, sourceProvenanceComparison: null,
      observationResponse: null,
      observationExport: null, preReviewTruthInferred: false });
    await updateRunManifest(runDir, gitState, [...existingCases.map((item) => ({ ...item,
      caseManifestPath: path.join(runDir, "cases", item.caseId, "case-manifest.json") })),
      { ...caseRecord, caseManifestPath }], null);
    const recognitionStart = await waitForRecognitionStart(browser, timeoutMs);
    const sourceClassification = classifyCaptureSources(recognitionStart.sourceSnapshot.captures || [], freeze, priorR011Cases, input.inputMode);
    caseRecord.recognitionStart = { request: recognitionStart.request, sourceSnapshotAuthority: recognitionStart.sourceSnapshot.authority,
      sourceSnapshotObservedAt: recognitionStart.sourceSnapshot.observedAt ?? null,
      captureCount: recognitionStart.sourceSnapshot.captureCount ?? recognitionStart.sourceSnapshot.captures?.length ?? 0,
      captureIds: sourceClassification.captures.map((item) => item.captureId),
      observerCleanup: recognitionStart.cleanup };
    caseRecord.captureMetadataAtRecognitionStart = sourceClassification;
    caseRecord.captureModeMismatches = sourceClassification.captures.filter((item) => item.modeExpected === false)
      .map((item) => ({ captureId: item.captureId, inputMode: input.inputMode, sourceType: item.sourceType }));
    caseRecord.sourceCaptures = sourceClassification.captures;
    caseRecord.status = "RECOGNITION_STARTED_HUMAN_REVIEW_PENDING";
    log.events.push({ at: recognitionStart.request.observedAt, event: "RECOGNITION_STARTED",
      requestId: recognitionStart.request.requestId, captureCount: sourceClassification.captures.length,
      captureIds: sourceClassification.captures.map((item) => item.captureId), sourceSnapshotAuthority: recognitionStart.sourceSnapshot.authority });
    await writeJson(caseManifestPath, caseRecord);
    const browserObservations = { schemaVersion: 1, environment: environmentObservation,
      python: { executable: probe.executable, version: probe.version, prefix: probe.prefix }, chrome: browser.version,
      runtime: opened.runtimeStatus, isolatedStorage: { mainDb: server.mainDb, recognitionSidecar: server.sidecar,
        realMainDbAccessed: false, realUserDbAccessed: false, productionSidecarAccessed: false },
      recognitionStart: caseRecord.recognitionStart, captureMetadataAtRecognitionStart: sourceClassification,
      sourceProvenanceComparison: null, observationResponse: null, observationExport: null, preReviewTruthInferred: false };
    await writeJson(caseFiles.browserObservationsPath, browserObservations);
    const recognition = await waitForRecognition(browser, timeoutMs);
    caseRecord.status = "RECOGNITION_RESULT_MOUNTED_HUMAN_REVIEW_PENDING";
    caseRecord.recognitionUi = recognition;
    log.events.push({ at: isoNow(), event: "RECOGNITION_RESULT_MOUNTED", reviewRowCount: recognition.rows });
    const reply = await waitForObservation(browser, timeoutMs);
    if (reply.status !== 200 || reply.body?.ok !== true) throw new Error(`observation save was not successful: ${JSON.stringify({ status: reply.status, body: reply.body })}`);
    const observationId = reply.body.receipt.observationId;
    caseRecord.observationId = observationId;
    caseRecord.observationPersistedAt = isoNow();
    log.events.push({ at: isoNow(), event: "OBSERVATION_SAVED", observationId });
    const exportResponse = await fetch(`${server.baseUrl}api/recognition/trade-review-observations/${encodeURIComponent(observationId)}/export`, { cache: "no-store" });
    if (!exportResponse.ok) throw new Error(`observation export failed: HTTP ${exportResponse.status}`);
    const exportBytes = Buffer.from(await exportResponse.arrayBuffer());
    const exportPath = path.join(runDir, "exports", `${input.caseId}-observation.json`);
    await mkdir(path.dirname(exportPath), { recursive: true });
    await writeFile(exportPath, exportBytes, { flag: "wx" });
    const exportRecord = JSON.parse(exportBytes.toString("utf8"));
    const sourceCaptures = sourceRowsFromExport(exportRecord);
    const sourceProvenanceComparison = compareRecognitionSourceWithExport(recognitionStart.sourceSnapshot, sourceCaptures);
    const exportIndependence = classifyExportIndependence(sourceCaptures, freeze, priorR011Cases,
      sourceProvenanceComparison, input.inputMode);
    const recognitionStartById = new Map((recognitionStart.sourceSnapshot.captures || []).map((item) => [item.captureId, item]));
    caseRecord.sourceCaptures = sourceCaptures.map((item, index) => ({
      ...(recognitionStartById.get(item.captureId) || {}), ...item, captureOrdinal: index + 1,
    }));
    caseRecord.sourceProvenanceComparison = sourceProvenanceComparison;
    caseRecord.sourceIndependence = exportIndependence;
    caseRecord.independenceBasis = "POST_RECOGNITION_SOURCE_HASH_COMPARISON_WITH_RECORDED_R011_EVIDENCE";
    caseRecord.cohort = exportIndependence.independentCandidate ? input.cohort : "UNASSIGNED";
    log.events.push({ at: isoNow(), event: sourceProvenanceComparison.status,
      comparedCaptureCount: sourceProvenanceComparison.comparedCaptureCount, mismatches: sourceProvenanceComparison.mismatches ?? [] });
    log.events.push({ at: isoNow(), event: "SOURCE_INDEPENDENCE_CLASSIFIED", status: exportIndependence.status,
      cohort: caseRecord.cohort, matchedPriorHashes: exportIndependence.matches.length,
      priorCasesWithoutHashes: exportIndependence.priorCasesWithoutHashes });
    caseRecord.exportPath = path.relative(runDir, exportPath).replaceAll(path.sep, "/");
    caseRecord.exportSha256 = sha256(exportBytes);
    caseRecord.exportBytes = exportBytes.byteLength;
    caseRecord.status = "OBSERVATION_EXPORTED_R008_REVIEW_PENDING";
    caseRecord.registryVersion = exportRecord.semantic?.observation?.completion?.registryVersion ?? null;
    caseRecord.correctionVersion = exportRecord.semantic?.observation?.completion?.correctionVersion ?? null;
    const observationFacts = { observationId,
      response: { status: reply.status, receipt: reply.body.receipt },
      export: { path: caseRecord.exportPath, sha256: caseRecord.exportSha256, bytes: caseRecord.exportBytes,
        semanticHash: exportRecord.semanticHash ?? null },
      sourceCaptures: caseRecord.sourceCaptures, correctionVersion: caseRecord.correctionVersion,
      registryVersion: caseRecord.registryVersion, projectionHash: exportRecord.semantic?.observation?.completion?.projectionHash ?? null,
      rowCounts: { logicalReviewRows: exportRecord.semantic?.observation?.completion?.rows?.length ?? null,
        captureSourceCompleteRows: exportRecord.semantic?.observation?.sourceContext?.recognition?.captureEvidence?.captures?.reduce((sum, item) => sum + item.completeRowCount, 0) ?? null },
      rawExportBytesPreserved: true, preReviewTruthInferred: false };
    browserObservations.observationResponse = { status: reply.status, receipt: reply.body.receipt };
    browserObservations.sourceProvenanceComparison = sourceProvenanceComparison;
    browserObservations.observationExport = observationFacts.export;
    browserObservations.captureMetadataFromPersistedExport = caseRecord.sourceCaptures;
    await writeJson(caseFiles.browserObservationsPath, browserObservations);
    await writeJson(caseManifestPath, caseRecord);
    const readiness = await waitForDtoReadiness(browser, timeoutMs);
    caseRecord.r008Status = readiness.newDisabled ? "NOT_READY" : "READY";
    caseRecord.explicitExclusions = readiness.exclusions.map((projectionRowId) => ({ projectionRowId,
      action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" }));
    caseRecord.reviewedProjectionRowCount = observationFacts.rowCounts.logicalReviewRows;
    caseRecord.sessionStatus = "R008_READY_WAITING_FOR_HUMAN_NEW_AND_COMMIT";
    await writeJson(caseManifestPath, caseRecord);
    const applied = await waitForAppliedSession(browser, timeoutMs);
    caseRecord.sessionStatus = "APPLIED_READBACK_VERIFIED";
    caseRecord.appliedStatusText = applied.sessionStatus;
    const bootstrapBeforeReloadResponse = await fetch(`${server.baseUrl}api/bootstrap`, { cache: "no-store" });
    const bootstrapBeforeReload = await bootstrapBeforeReloadResponse.json();
    const beforeReloadFacts = bootstrapSessionFacts(bootstrapBeforeReload);
    if (!beforeReloadFacts.exists || beforeReloadFacts.diagnostics?.type !== "TRADE_REVIEW_SESSION_APPLY"
      || beforeReloadFacts.diagnostics?.mode !== "NEW" || !beforeReloadFacts.scannedTradeCount) {
      throw new Error(`NEW session durable bootstrap readback did not match: ${JSON.stringify(beforeReloadFacts)}`);
    }
    caseRecord.sessionDurableState = beforeReloadFacts;
    await browser.send("Page.reload", { ignoreCache: true });
    await waitFor(async () => browser.evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')==='false'"), "reload app bootstrap", 60000);
    const bootstrapAfterReload = await (await fetch(`${server.baseUrl}api/bootstrap`, { cache: "no-store" })).json();
    const afterReloadFacts = bootstrapSessionFacts(bootstrapAfterReload);
    const rendered = await browser.evaluate("document.querySelector('#trade-list-root')?.textContent||''");
    if (!afterReloadFacts.exists || afterReloadFacts.id !== beforeReloadFacts.id
      || afterReloadFacts.scannedTradeCount !== beforeReloadFacts.scannedTradeCount || !rendered.trim()) {
      throw new Error(`R009 durable session restore/render did not match: ${JSON.stringify({ beforeReloadFacts, afterReloadFacts, renderedLength: rendered.length })}`);
    }
    caseRecord.sessionAfterReload = afterReloadFacts;
    caseRecord.renderedTradeListAfterReload = true;
    caseRecord.status = "COMPLETE_LIVE_CASE_NOT_FINAL_R011";
    caseRecord.completedAt = isoNow();
    caseRecord.sessionStatus = "NEW_COMMIT_READBACK_RELOAD_RENDER_PASS";
    await writeJson(caseFiles.sessionResultPath, { schemaVersion: 1, caseId: input.caseId,
      r008Status: caseRecord.r008Status, explicitExclusions: caseRecord.explicitExclusions,
      userTriggeredNewApply: true, durableSessionBeforeReload: beforeReloadFacts,
      durableSessionAfterReload: afterReloadFacts, listRenderedAfterReload: true,
      realMainDbAccessed: false, realUserDbAccessed: false, productionSidecarAccessed: false });
    await writeJson(caseManifestPath, caseRecord);
    log.events.push({ at: isoNow(), event: "NEW_SESSION_READBACK_RELOAD_PASS", scannedTradeCount: afterReloadFacts.scannedTradeCount });
    const allCases = [];
    for (const item of await readdir(path.join(runDir, "cases"), { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const value = await readFile(path.join(runDir, "cases", item.name, "case-manifest.json"), "utf8").then(JSON.parse).catch(() => null);
      if (value) allCases.push(value);
    }
    const eligible = allCases.filter((item) => item.status === "COMPLETE_LIVE_CASE_NOT_FINAL_R011" && item.exportPath
      && item.cohort === "INDEPENDENT").map((item) => ({ exportPath: path.join(runDir, item.exportPath), exclusions: item.explicitExclusions, cohort: item.cohort }));
    const evaluation = await evaluateRun(runDir, input.caseId, eligible);
    await writeJson(path.join(runDir, "evaluation", `case-${input.caseId}-reference.json`), evaluation);
    await updateRunManifest(runDir, gitState, allCases.map((item) => ({ ...item,
      caseManifestPath: path.join(runDir, "cases", item.caseId, "case-manifest.json") })), evaluation,
      ["Evaluation is descriptive evidence only; user ownerUsabilityDecision remains null."]);
    log.events.push({ at: isoNow(), event: "R010_EVALUATION_COMPLETED", status: evaluation.evaluationStatus, report: evaluation.reportPath });
    await writeJson(caseFiles.runLogPath, log);
    console.log(JSON.stringify({ task: "R011-B case evidence", status: caseRecord.status,
      caseId: input.caseId, observationId, exportPath, exportSha256: caseRecord.exportSha256,
      r008Status: caseRecord.r008Status, explicitExclusions: caseRecord.explicitExclusions,
      sessionStatus: caseRecord.sessionStatus, evaluation, finalR011UsabilityDecision: null,
      message: "독립 case가 기록되었습니다. 이것만으로 R011 최종 usability 승인이나 auto-accept 승인을 뜻하지 않습니다." }, null, 2));
  } catch (error) {
    caseRecord.status = caseRecord.sessionStatus === "NEW_COMMIT_READBACK_RELOAD_PASS"
      ? "CASE_RECORDED_BUT_POST_CASE_GATE_FAILED"
      : caseRecord.observationId ? "OBSERVATION_SAVED_CASE_INCOMPLETE_EVIDENCE_PRESERVED"
        : caseRecord.recognitionStart ? "CASE_INCOMPLETE_EVIDENCE_PRESERVED" : "PRECONDITION_FAILED";
    caseRecord.failure = { at: isoNow(), message: error.message };
    await writeJson(caseManifestPath, caseRecord).catch(() => {});
    log.events.push({ at: isoNow(), event: "CASE_STOPPED", message: error.message });
    await writeJson(caseFiles.runLogPath, log).catch(() => {});
    if (gitState) {
      const currentCases = await readdir(path.join(runDir, "cases"), { withFileTypes: true }).then(async (items) => Promise.all(items
        .filter((item) => item.isDirectory())
        .map(async (item) => await readFile(path.join(runDir, "cases", item.name, "case-manifest.json"), "utf8")
          .then(JSON.parse).then((value) => ({ ...value, caseManifestPath: path.join(runDir, "cases", item.name, "case-manifest.json") }))
          .catch(() => null)))).catch(() => []);
      const cases = currentCases.filter(Boolean);
      await updateRunManifest(runDir, gitState, cases, null, [error.message]).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) {
      const cleanup = await restoreLiveCaptureObserver(browser).catch((error) => ({
        observerRemoved: false, createObjectUrlRestored: false, error: error.message }));
      caseRecord.captureObserverCleanup = cleanup;
      await writeJson(caseManifestPath, caseRecord).catch(() => {});
      await browser.close().catch(() => {});
    }
    if (server?.child) await stopChild(server.child);
    if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === "help") { process.stdout.write(usage()); process.exitCode = 0; }
  else if (parsed.mode === "preflight") await runPreflight(parsed.options);
  else if (parsed.mode === "live") await runLive(parsed.options);
  else throw new Error(`지원하지 않는 모드: ${parsed.mode}`);
} catch (error) {
  process.stderr.write(`R011 live harness 오류: ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
