import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  adaptLegacyCatalog,
} from "../frontend/js/domain/trade-master-registry.js";
import {
  adaptRegistrySnapshotV1ToMasterBundleV2,
  createMasterBundleV2,
  masterBundleContentHash,
} from "../frontend/js/domain/trade-master-bundle.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18791/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-arch-m2-master-"));
const database = join(profile, "isolated.sqlite3");
const port = Number(new URL(baseUrl).port || 18791);
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
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${label}${serverOutput ? `; server: ${serverOutput}` : ""}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await exited;
}

function legacyRecord(legacyNameKey, legacyKind, rawName, tier, locator, scope) {
  return {
    legacyNameKey,
    legacyKind,
    rawName,
    tier,
    occurrences: [{ locator, scope, tier }],
    authorityStatus: "LEGACY_UNVERIFIED",
  };
}

function syntheticBundle() {
  const item = legacyRecord("fixture-item-legacy", "MASTER_ITEM", "기존 품목", 1, "/masterData/1/0", "MASTER_TIER_1");
  const island = legacyRecord("fixture-island-legacy", "ISLAND", "기존 섬", null, "/islands/0", "GENERAL_ISLANDS");
  const unresolvedItem = { ...legacyRecord("fixture-unresolved-item", "SPECIAL_ITEM", "검토할 특수 품목", null, "/specialItems/0", "SPECIAL_ITEMS"), reason: "NO_CURATED_IDENTITY" };
  const unresolvedIsland = { ...legacyRecord("fixture-unresolved-island", "ISLAND", "검토할 섬", null, "/t6Islands/0", "T6_ISLANDS"), reason: "NO_CURATED_IDENTITY" };
  return createMasterBundleV2({
    createdAt: "2026-10-01T00:00:00.000Z",
    entities: [
      {
        stableId: "opaque-fixture-item-id", kind: "ITEM", canonicalName: "기존 품목", displayNames: [], aliases: [],
        legacyNames: [item], tier: 1, category: null, status: "LEGACY_UNVERIFIED", provenance: { note: null }, replacedBy: null,
      },
      {
        stableId: "opaque-fixture-island-id", kind: "ISLAND", canonicalName: "기존 섬", displayNames: [], aliases: [],
        legacyNames: [island], tier: null, category: null, status: "LEGACY_UNVERIFIED", provenance: { note: null }, replacedBy: null,
      },
    ],
    compatibilityMappings: [
      { stableId: "opaque-fixture-item-id", legacyNameKeys: [item.legacyNameKey], sourceLocators: ["/masterData/1/0"] },
      { stableId: "opaque-fixture-island-id", legacyNameKeys: [island.legacyNameKey], sourceLocators: ["/islands/0"] },
    ],
    unresolvedLegacyNames: [unresolvedItem, unresolvedIsland],
    sourceRevisions: [{ sourceType: "BROWSER_FIXTURE", revision: "fixture-v1", sha256: "c".repeat(64) }],
    provenance: { purpose: "browser-only synthetic curation fixture" },
  });
}

const catalogBytes = await readFile(resolve(root, "local_app/frontend/data/trade-catalog.json"));
const sourceSha256 = createHash("sha256").update(catalogBytes).digest("hex");
assert.equal(sourceSha256, "8183b03e6aa0ee354142cf9720b401494bec365e528632f3c0c84ec11b46b4b3");
const catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(catalogBytes));
const v1Preview = adaptLegacyCatalog(catalog, {
  sourceRevision: "current-trade-catalog",
  sourceSha256,
  curatedMappings: null,
});
const v2Preview = adaptRegistrySnapshotV1ToMasterBundleV2(v1Preview, { createdAt: "2026-10-01T00:00:00.000Z" });
assert.equal(masterBundleContentHash(v2Preview), "473e898ad722787b1fd0ecfedf131681d316e079501a0cf0fd55915518dd65e7");
const fakePreview = syntheticBundle();
const fakePreviewJson = JSON.stringify(fakePreview);

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
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePort = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePort.trim().split(/\r?\n/)[0];
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
    const result = await send("Runtime.evaluate", {
      expression: `(()=>eval(${JSON.stringify(expression)}))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await waitFor(async () => evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy') === 'false'"), "app bootstrap");
  const beforeRuntime = await fetch(`${baseUrl}api/bootstrap`).then((response) => response.json());
  const beforeStorage = await evaluate("JSON.stringify({local:Object.keys(localStorage),session:Object.keys(sessionStorage)})").then(JSON.parse);
  await evaluate("window.__masterApiRequests=[]; window.__masterOriginalFetch=window.fetch; window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname.startsWith('/api/'))window.__masterApiRequests.push({url:url.pathname,method:init?.method??'GET'});return window.__masterOriginalFetch(input,init)}");

  await evaluate("document.querySelector('#open-trade-master').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-master-dialog [data-master-summary=occurrences]')?.textContent === '241'"), "production catalog preview");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [data-master-summary=names]').textContent"), "230");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [data-master-summary=verified]').textContent"), "0");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [data-master-summary=unresolved]').textContent"), "230");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [data-master-summary=saved]').textContent"), "0");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [data-master-save]').disabled"), true);
  const allCount = await evaluate("document.querySelectorAll('#trade-master-dialog [data-master-list] [role=option]').length");
  assert.equal(allCount, 230, "every unresolved legacy name is reachable in the production list");
  const filterCounts = await evaluate("(()=>{const d=document.querySelector('#trade-master-dialog');const count=(kind)=>{d.querySelector(`[data-master-filter=${kind}]`).click();return d.querySelectorAll('[data-master-list] [role=option]').length};const item=count('ITEM'),island=count('ISLAND');d.querySelector('[data-master-filter=ALL]').click();return {item,island,all:d.querySelectorAll('[data-master-list] [role=option]').length}})()");
  assert.ok(filterCounts.item > 0 && filterCounts.island > 0);
  assert.equal(filterCounts.item + filterCounts.island, 230);
  const firstRawName = await evaluate("document.querySelector('#trade-master-dialog .trade-master-list-name').textContent");
  await evaluate(`(()=>{const d=document.querySelector('#trade-master-dialog');const s=d.querySelector('[data-master-search]');s.value=${JSON.stringify(firstRawName.slice(0, 2))};s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  assert.ok(await evaluate("document.querySelectorAll('#trade-master-dialog [data-master-list] [role=option]').length") > 0);
  await evaluate("document.querySelector('#trade-master-dialog [data-master-search]').value='';document.querySelector('#trade-master-dialog [data-master-search]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#trade-master-dialog [data-master-list] [role=option]').click()");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [aria-label=\"stableId\"]').textContent"), "미발급");
  const selectedRawName = await evaluate("document.querySelector('#trade-master-dialog .trade-master-editor-title h3').textContent");
  const masterPayload = "<script>window.__masterXss=true</script> & \"따옴표\"";
  await evaluate(`(()=>{const d=document.querySelector('#trade-master-dialog');const c=d.querySelector('[aria-label="Canonical 이름 초안"]');c.value=${JSON.stringify(masterPayload)};c.dispatchEvent(new Event('input',{bubbles:true}));const display=d.querySelector('[aria-label="게임 표시명 초안"]');display.value='표시 & 이름';display.dispatchEvent(new Event('input',{bubbles:true}));const a=d.querySelector('[aria-label="추가할 별칭 초안"]');a.value=${JSON.stringify("<img src=x onerror=window.__masterXss=true>")};d.querySelector('.trade-master-alias-tools button').click();const status=d.querySelector('[aria-label="목표 lifecycle 초안"]');status.value='VERIFIED_CURATED';status.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [data-master-unsaved]').textContent.includes('초안 1개')"), true);
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog .trade-master-review-action button').disabled"), true, "verified target requires explicit owner confirmation");
  await evaluate("document.querySelector('#trade-master-dialog [aria-label=\"owner 확인\"]').click()");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog .trade-master-review-action button').disabled"), false);
  await evaluate("document.querySelector('#trade-master-dialog .trade-master-review-action button').click()");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog .trade-master-review-state').dataset.state"), "DRAFT_REVIEWED_PENDING_SAVE");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [data-master-save]').disabled"), true);
  await evaluate("document.querySelector('#trade-master-dialog [data-master-close]').click()");
  await evaluate("document.querySelector('#open-trade-master').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-master-dialog').open"), "production dialog reopen");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [aria-label=\"Canonical 이름 초안\"]').value"), masterPayload);
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog .trade-master-review-state').dataset.state"), "DRAFT_REVIEWED_PENDING_SAVE");
  assert.equal(await evaluate("document.querySelectorAll('#trade-master-dialog script,#trade-master-dialog img').length"), 0, "owner text is rendered without HTML interpretation");
  assert.equal(await evaluate("window.__masterXss === true"), false);
  const afterRuntime = await fetch(`${baseUrl}api/bootstrap`).then((response) => response.json());
  assert.deepEqual(afterRuntime, beforeRuntime, "editing a Master draft does not change the active app/session");
  assert.deepEqual(await evaluate("window.__masterApiRequests"), [], "Master preview does not call application APIs");
  const afterStorage = await evaluate("JSON.stringify({local:Object.keys(localStorage),session:Object.keys(sessionStorage)})").then(JSON.parse);
  assert.deepEqual(afterStorage, beforeStorage);
  assert.equal([...afterStorage.local, ...afterStorage.session].some((key) => /master/i.test(key)), false);

  await evaluate("window.__m2ReloadMarker=true");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(async () => evaluate("!window.__m2ReloadMarker && document.querySelector('#app-content')?.getAttribute('aria-busy') === 'false'"), "new app document reload");
  await evaluate("window.__masterApiRequests=[];window.__masterOriginalFetch=window.fetch;window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname.startsWith('/api/'))window.__masterApiRequests.push({url:url.pathname,method:init?.method??'GET'});return window.__masterOriginalFetch(input,init)}");
  await evaluate("document.querySelector('#open-trade-master').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-master-dialog [data-master-summary=occurrences]')?.textContent === '241'"), "preview after reload");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [data-master-unsaved]').textContent"), "저장되지 않은 초안은 없습니다. 창을 닫았다 다시 열면 유지되지만 새로고침하면 사라집니다.");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog [aria-label=\"Canonical 이름 초안\"]').value"), selectedRawName, "reload clears in-memory draft and restores the source preview");

  const fakeDialog = await evaluate(`(async()=>{const template=document.querySelector('#trade-master-dialog');const dialog=template.cloneNode(true);dialog.id='trade-master-dialog-fixture';document.body.append(dialog);const {initTradeMasterUI}=await import('/assets/js/trade-master-ui.js');window.__fakeMasterUi=initTradeMasterUI({dialog,openButton:null,loadMasterPreview:async()=>window.__fakeMasterPreview,saveMaster:null});return true})()`);
  assert.equal(fakeDialog, true);
  await evaluate(`window.__fakeMasterPreview=${fakePreviewJson}`);
  await evaluate("window.__fakeMasterBefore=JSON.stringify(window.__fakeMasterPreview);window.__fakeMasterUi.open()");
  await waitFor(async () => evaluate("document.querySelector('#trade-master-dialog-fixture [data-master-list-count]')?.textContent.includes('4개 표시')"), "synthetic existing and unresolved fixture");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog-fixture [aria-label=\"stableId\"]').textContent"), "opaque-fixture-item-id");
  assert.equal(await evaluate("document.querySelectorAll('#trade-master-dialog-fixture input[aria-label=\\\"stableId\\\"],#trade-master-dialog-fixture textarea[aria-label=\\\"stableId\\\"],#trade-master-dialog-fixture select[aria-label=\\\"stableId\\\"]').length"), 0);
  const fixturePayload = "<img src=x onerror=window.__fixtureXss=true> & 'quoted'";
  await evaluate(`(()=>{const d=document.querySelector('#trade-master-dialog-fixture');const c=d.querySelector('[aria-label="Canonical 이름 초안"]');c.value=${JSON.stringify(fixturePayload)};c.dispatchEvent(new Event('input',{bubbles:true}));const disp=d.querySelector('[aria-label="게임 표시명 초안"]');disp.value=${JSON.stringify("<script>no</script> 표시")};disp.dispatchEvent(new Event('input',{bubbles:true}));const note=d.querySelector('[aria-label="owner 메모 초안"]');note.value=${JSON.stringify("메모 & <script>")};note.dispatchEvent(new Event('input',{bubbles:true}));const a=d.querySelector('[aria-label="추가할 별칭 초안"]');a.value=${JSON.stringify(fixturePayload)};d.querySelector('.trade-master-alias-tools button').click();d.querySelector('.trade-master-review-action button').click()})()`);
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog-fixture [aria-label=\"Canonical 이름 초안\"]').value"), fixturePayload);
  assert.equal(await evaluate("(()=>{const c=document.querySelector('#trade-master-dialog-fixture [aria-label=\"category 초안\"]');c.value='owner category draft';c.dispatchEvent(new Event('input',{bubbles:true}));return c.value})()"), "owner category draft");  assert.equal(await evaluate("document.querySelectorAll('#trade-master-dialog-fixture script,#trade-master-dialog-fixture img').length"), 0);
  assert.equal(await evaluate("window.__fixtureXss === true"), false);
  assert.equal(await evaluate("JSON.stringify(window.__fakeMasterPreview) === window.__fakeMasterBefore"), true, "editing and confirming never mutates the supplied immutable bundle");
  assert.equal(await evaluate("document.querySelector('#trade-master-dialog-fixture [data-master-save]').disabled"), true);
  await evaluate("document.querySelector('#trade-master-dialog-fixture [data-master-save]').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  assert.equal(await evaluate("window.__masterApiRequests.length"), 0);

  await evaluate(`(async()=>{const template=document.querySelector('#trade-master-dialog');const dialog=template.cloneNode(true);dialog.id='trade-master-dialog-error';document.body.append(dialog);const {initTradeMasterUI}=await import('/assets/js/trade-master-ui.js');window.__failedMasterUi=initTradeMasterUI({dialog,openButton:null,loadMasterPreview:async()=>{throw new Error('synthetic catalog unavailable')},saveMaster:null});window.__failedMasterUi.open()})()`);
  await waitFor(async () => evaluate("document.querySelector('#trade-master-dialog-error [data-master-error]:not([hidden])')?.textContent.includes('synthetic catalog unavailable')"), "in-dialog loader error");
  assert.equal(await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy') === 'false'"), true, "Master preview failure does not fail app bootstrap");
  assert.equal(await evaluate("window.__masterApiRequests.length"), 0);
  console.log("PASS browser_trade_master: production preview 241/230/0, filters/search, draft memory lifecycle, synthetic stable IDs, safe text, no save/API/runtime mutation, loader error isolation");
} finally {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  await stopChild(chrome);
  await stopChild(server);
  let cleanupComplete = false;
  for (let attempt = 0; attempt < 25 && !cleanupComplete; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      cleanupComplete = true;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 24) throw error;
      await delay(200);
    }
  }
}
