import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18767/";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-spec002-browser-"));
const database = join(profile, "isolated.sqlite3");
const extraSitePackages = process.env.BDO_EXTRA_SITE_PACKAGES;
const pythonPrelude = extraSitePackages ? `import sys; p=${JSON.stringify(extraSitePackages)}; sys.path.remove(p); sys.path.append(p); ` : "";
const pythonCode = `${pythonPrelude}from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=18767, use_reloader=False, threaded=True)`;
let server = spawn(process.env.PYTHON ?? "python", ["-c", pythonCode], { stdio: "ignore", windowsHide: true });
let chrome;
let socket;
try {
  await waitFor(async () => {
    try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; }
  }, "temporary local server");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePortText = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePortText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  if (!targetResponse.ok) throw new Error(`Chrome target create failed: ${targetResponse.status}`);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value; };
  await send("Page.enable"); await send("Runtime.enable");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "70 inventory rows rendered");
  const itemName = await evaluate("document.querySelector('.inventory-row').dataset.name");
  const encodedName = JSON.stringify(itemName);
  await evaluate(`(() => { const n=${encodedName}; const i=[...document.querySelectorAll('input')].find(x=>x.getAttribute('aria-label')===n+' 현재 재고'); i.value='37'; i.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes(`${itemName} 재고 저장을 확인했습니다`), "stock UI save confirmation");
  const stockAfterSave = await evaluate(`[...document.querySelectorAll('input')].find(x=>x.getAttribute('aria-label')===${encodedName}+' 현재 재고')?.value`);
  if (stockAfterSave !== "37") throw new Error(`stock input did not reflect saved value: ${stockAfterSave}`);
  const expectedTierOrder = await evaluate("(() => { const rows=[...document.querySelectorAll('.tier-section')[0].querySelectorAll('.inventory-row')]; const names=rows.map(r=>r.dataset.name); return [names[1],names[0],...names.slice(2)]; })()");
  await evaluate("(() => { const rows=[...document.querySelectorAll('.tier-section')[0].querySelectorAll('.inventory-row')]; const transfer=new DataTransfer(); transfer.setData('text/plain',rows[0].dataset.name); rows[2].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})); })()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("단계별 표시 순서를 저장했습니다"), "drag order save confirmation");
  const orderAfterDrop = await evaluate("[...document.querySelectorAll('.tier-section')[0].querySelectorAll('.inventory-row')].map(r=>r.dataset.name)");
  if (JSON.stringify(orderAfterDrop) !== JSON.stringify(expectedTierOrder)) throw new Error("drag-and-drop order was not applied as dropped");

  await evaluate("document.querySelector('#tier-rule-1').value='27'; document.querySelector('#tier-rules-root button').click()");
  await waitFor(async () => (await evaluate("document.querySelector(\"#runtime-status\").textContent")).includes("단계 규칙 저장을 확인했습니다"), "tier rule save confirmation");
  await evaluate("document.querySelector('#ship-speed').value='172'; document.querySelector('#ship-root button').click()");
  await waitFor(async () => (await evaluate("document.querySelector(\"#runtime-status\").textContent")).includes("선박 설정 저장을 확인했습니다"), "ship settings save confirmation");
  await evaluate("document.querySelectorAll('#presets-root .preset-card button')[0].click()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("1번 프리셋 저장을 확인했습니다"), "ship preset save");
  await evaluate("document.querySelector('#ship-speed').value='173'; document.querySelector('#ship-root button').click()");
  await waitFor(async () => (await evaluate("document.querySelector(\"#runtime-status\").textContent")).includes("선박 설정 저장을 확인했습니다"), "ship change save confirmation");
  await evaluate("document.querySelectorAll('#presets-root .preset-card button')[1].click()");
  await waitFor(async () => (await evaluate("document.querySelector('#ship-speed')?.value")) === "172", "ship preset explicit load");
  await evaluate("document.querySelector('#parley-budget').value='1500002'; document.querySelector('#parley-root button').click()");
  await waitFor(async () => (await evaluate("document.querySelector(\"#runtime-status\").textContent")).includes("교섭력 설정 저장을 확인했습니다"), "parley save confirmation");
  await evaluate("document.querySelector('#durable-tune-useClustering').value='20002'; document.querySelector('[data-tuning-durable] button').click()");
  await waitFor(async () => (await evaluate("document.querySelector(\"#runtime-status\").textContent")).includes("튜닝 기본값 저장을 확인했습니다"), "tuning save confirmation");

  await evaluate("document.querySelector('#nav-coords').value=JSON.stringify({Current:{x:111,y:222,isOcean:false}}); document.querySelector('#nav-calibrations').value=JSON.stringify({'A>B':1.25}); document.querySelector('#nav-memos').value=JSON.stringify([{id:'m1',startName:'A',endName:'B',timeStr:'1:20',text:'smoke'}]); document.querySelector('#navigation-root button').click()");
  await waitFor(async () => (await evaluate("document.querySelector(\"#runtime-status\").textContent")).includes("현재 항법 설정 저장을 확인했습니다"), "navigation save confirmation");
  await evaluate("document.querySelector('#map-routes').value=JSON.stringify([{id:'r1',startNodeName:'A',endNodeName:'B',customSeconds:80}]); document.querySelectorAll('#map-root .preset-card button')[0].click()");
  await waitFor(async () => (await evaluate("document.querySelector('#map-root .preset-card')?.textContent")).includes('1개 경로'), "map slot snapshot saved");
  await evaluate("document.querySelector('#nav-coords').value=JSON.stringify({Current:{x:333,y:444,isOcean:false}}); document.querySelector('#navigation-root button').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#nav-coords')?.value")).includes('333'), "navigation changed away from slot snapshot");
  await evaluate("document.querySelector('#map-routes').value='[]'; document.querySelectorAll('#map-root .preset-card')[3].querySelector('button').click()");
  await waitFor(async () => (await evaluate("document.querySelectorAll('#map-root .preset-card')[3]?.textContent")).includes('1개 좌표'), "map base snapshot saved");
  await evaluate("document.querySelectorAll('#map-root .preset-card button')[1].click()");
  await waitFor(async () => (await evaluate("document.querySelector('#nav-coords')?.value")).includes('111'), "explicit map slot load updates active navigation");
  await evaluate("document.querySelector('#viewer-zoom').value='130'; document.querySelector('[aria-label=\"mainPanel left\"]').value='17'; [...document.querySelectorAll('#viewer-root button')].find(b=>b.textContent==='배율·패널 배치 저장').click()");
  await waitFor(async () => (await evaluate("document.querySelector(\"#runtime-status\").textContent")).includes("화면 배율·패널 배치 저장을 확인했습니다"), "viewer save confirmation");

  await evaluate("window.__beforeReloadMarker = true");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(async () => (await evaluate("!window.__beforeReloadMarker && document.querySelector('#app-content')?.getAttribute('aria-busy')==='false' && document.querySelectorAll('.inventory-row').length===70")) === true, "new document initialized after reload");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "page reload");
  const restored = await evaluate(`({stock:[...document.querySelectorAll('input')].find(x=>x.getAttribute('aria-label')===${encodedName}+' 현재 재고')?.value,rule:document.querySelector('#tier-rule-1')?.value,speed:document.querySelector('#ship-speed')?.value,parley:document.querySelector('#parley-budget')?.value,clustering:document.querySelector('#durable-tune-useClustering')?.value,nav:document.querySelector('#nav-coords')?.value,zoom:document.querySelector('#viewer-zoom')?.value,slot:document.querySelectorAll('#map-root .preset-card')[0]?.textContent,base:document.querySelectorAll('#map-root .preset-card')[3]?.textContent,order:[...document.querySelectorAll('.tier-section')[0].querySelectorAll('.inventory-row')].map(r=>r.dataset.name),panelLeft:document.querySelector('[aria-label="mainPanel left"]')?.value,zoomStyle:getComputedStyle(document.body).zoom})`);
  if (JSON.stringify(restored.order) !== JSON.stringify(expectedTierOrder) || restored.stock !== "37" || restored.rule !== "27" || restored.speed !== "172" || restored.parley !== "1500002" || restored.clustering !== "20002" || restored.zoom !== "130" || restored.panelLeft !== "17" || restored.zoomStyle !== "1.3" || !restored.nav.includes("111") || !restored.slot.includes("1개 경로") || !restored.base.includes("1개 좌표")) throw new Error(`reloaded UI state mismatch: ${JSON.stringify(restored)}`);
  await new Promise((resolve) => { if (server.exitCode !== null) resolve(); else { server.once("exit", resolve); server.kill(); } });
  server = spawn(process.env.PYTHON ?? "python", ["-c", pythonCode], { stdio: "ignore", windowsHide: true });
  await waitFor(async () => { try { return (await fetch(baseUrl + "api/health")).ok; } catch { return false; } }, "server process restart against same temporary SQLite");
  await evaluate("window.__beforeReloadMarker = true");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(async () => (await evaluate("!window.__beforeReloadMarker && document.querySelector('#app-content')?.getAttribute('aria-busy')==='false' && document.querySelectorAll('.inventory-row').length===70")) === true, "new document initialized after reload");
  await waitFor(async () => (await evaluate("document.querySelectorAll('.inventory-row').length")) === 70, "page reload after server restart");
  const processRestored = await evaluate("JSON.stringify({nav:document.querySelector('#nav-coords')?.value,base:document.querySelectorAll('#map-root .preset-card')[3]?.textContent})");
  if (!JSON.parse(processRestored).nav.includes("111") || !JSON.parse(processRestored).base.includes("1개 좌표")) throw new Error("state after server process restart did not restore without applying mapBase");

  // Another client advances the revision; the UI must expose conflict and not mark its stale write as saved.
  const current = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  await fetch(`${baseUrl}api/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mutationId: "external-revision", baseRevision: current.revision, settings: { viewer: { uiZoom: 131 } } }) });
  await evaluate("document.querySelector('#tier-rule-1').value='28'; document.querySelector('#tier-rules-root button').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("저장 실패"), "UI reports stale-revision failure");
  const failedWriteRule = await evaluate("document.querySelector('#tier-rule-1')?.value");
  if (failedWriteRule !== "27") throw new Error(`failed stale write replaced confirmed UI value: ${failedWriteRule}`);
  await evaluate("document.querySelector('#tier-rule-2').value='-1'; document.querySelector('#tier-rules-root button').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#runtime-status').textContent")).includes("저장 실패"), "invalid server write shown as failure");
  const unchanged = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  if (unchanged.settings.tierRules["2"] !== 20) throw new Error("rejected settings mutation changed persisted value");
  console.log(JSON.stringify({ ok: true, renderedItems: 70, inventoryOrderRoundTrip: restored.order.slice(0, 3), stockRoundTrip: restored.stock, settingsRoundTrip: true, viewerPanelRoundTrip: restored.panelLeft, snapshotExplicitLoad: true, staleRevisionShownAsFailure: true, invalidSaveShownAsFailure: true, database: "isolated temporary SQLite" }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  try { chrome?.kill(); } catch {}
  try { server.kill(); } catch {}
  await delay(500);
  if (profile.startsWith(tmpdir())) await rm(profile, { recursive: true, force: true });
}

async function waitFor(predicate, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await predicate(); if (result) return result; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
