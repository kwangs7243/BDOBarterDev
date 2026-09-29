import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = process.env.BDO_TEST_URL ?? "http://127.0.0.1:18768/";
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-t003-capture-browser-"));
const database = join(profile, "isolated.sqlite3");
const fixture = resolve(root, "fixtures/warehouse_patch/barter_only.png");
const port = new URL(baseUrl).port || "18768";
const pythonCode = `from local_app.backend.app import create_app; create_app(r'${database}', testing=True).run(host='127.0.0.1', port=${Number(port)}, use_reloader=False, threaded=True)`;
let server;
let chrome;
let socket;
let send;

async function waitFor(predicate, label, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  server = spawn(python, ["-B", "-c", pythonCode], { cwd: root, stdio: "ignore", windowsHide: true, env: { ...process.env, LOCALAPPDATA: profile, PYTHONDONTWRITEBYTECODE: "1" } });
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated localhost server");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"], { stdio: "ignore", windowsHide: true });
  const activePortPath = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePortText = await waitFor(async () => { try { return await readFile(activePortPath, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePortText.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  assert.equal(targetResponse.ok, true, "Chrome creates the app target");
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
  send = (method, params = {}) => new Promise((resolveMessage, reject) => {
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
  await send("DOM.enable");
  await waitFor(async () => (await evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy')")) === "false", "app bootstrap");
  const initial = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  const hashFixture = await readFile(fixture);
  const nodeHash = await crypto.subtle.digest("SHA-256", hashFixture);
  const expectedHash = [...new Uint8Array(nodeHash)].map((value) => value.toString(16).padStart(2, "0")).join("");

  await evaluate("document.querySelector('#open-warehouse-scan').click()");
  await waitFor(async () => evaluate("document.querySelector('#warehouse-scan-dialog')?.open"), "warehouse capture context");
  const editablePaste = await evaluate("(() => { const input=document.querySelector('#warehouse-image'); input.focus(); const transfer=new DataTransfer(); transfer.setData('text/plain','ordinary text'); const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}); input.dispatchEvent(event); return event.defaultPrevented; })()");
  assert.equal(editablePaste, false, "input focus preserves ordinary text paste");
  const contenteditablePaste = await evaluate("(() => { const target=document.createElement('div'); target.contentEditable='true'; document.querySelector('#warehouse-scan-dialog .warehouse-dialog-content').append(target); target.focus(); const file=new File([new Uint8Array([1,2,3])],'image.png',{type:'image/png'}); const transfer=new DataTransfer(); transfer.items.add(file); const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}); target.dispatchEvent(event); target.remove(); return event.defaultPrevented; })()");
  assert.equal(contenteditablePaste, false, "contenteditable focus preserves its paste workflow");
  const fileNode = await send("DOM.getDocument");
  const inputNode = await send("DOM.querySelector", { nodeId: fileNode.root.nodeId, selector: "#warehouse-image" });
  await send("DOM.setFileInputFiles", { nodeId: inputNode.nodeId, files: [fixture] });
  await waitFor(async () => (await evaluate("document.querySelector('#warehouse-scan-dialog')?.dataset.queueLength")) === "1", "file captured into shared queue");
  const fileCapture = await evaluate("JSON.stringify({source:document.querySelector('.capture-queue-item').textContent,preview:document.querySelector('.warehouse-preview').src,queue:document.querySelector('#warehouse-scan-dialog').dataset.queueLength})").then(JSON.parse);
  const fileHash = await evaluate("(async()=>{const r=await fetch(document.querySelector('.warehouse-preview').src);const b=await r.arrayBuffer();const d=await crypto.subtle.digest('SHA-256',b);return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')})()");
  assert.equal(fileHash, expectedHash, "PNG selected through the real Chrome file input retains exact bytes");
  assert.match(fileCapture.source, /파일/);

  await evaluate("document.querySelector('.capture-queue-remove').click()");
  await waitFor(async () => (await evaluate("document.querySelector('#warehouse-scan-dialog').dataset.queueLength")) === "0", "file capture removed");
  await evaluate(`(() => { const button=document.querySelector('#warehouse-scan-dialog [data-capture-paste-target]'); button.focus(); const bytes=${JSON.stringify([...hashFixture])}; const file=new File([new Uint8Array(bytes)],'clipboard.png',{type:'image/png'}); const transfer=new DataTransfer(); transfer.items.add(file); const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}); window.__capturePasteEvent=event; button.dispatchEvent(event); })()`);
  await waitFor(async () => (await evaluate("document.querySelector('#warehouse-scan-dialog')?.dataset.queueLength")) === "1", "synthetic browser image paste enters warehouse queue");
  assert.equal(await evaluate("window.__capturePasteEvent.defaultPrevented"), true, "active capture surface handles image paste");
  const clipboardHash = await evaluate("(async()=>{const r=await fetch(document.querySelector('.warehouse-preview').src);const b=await r.arrayBuffer();const d=await crypto.subtle.digest('SHA-256',b);return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')})()");
  assert.equal(clipboardHash, expectedHash, "synthetic clipboard PNG also retains exact bytes");
  assert.match(await evaluate("document.querySelector('.capture-queue-item').textContent"), /클립보드/);

  await evaluate("document.querySelector('#warehouse-scan-dialog [data-action=cancel]').click()");
  await waitFor(async () => evaluate("!document.querySelector('#warehouse-scan-dialog')?.open && !document.querySelector('.warehouse-preview')?.src"), "warehouse preview cleanup on cancel");
  console.log("browser capture: warehouse file/paste and cleanup PASS");

  await evaluate("document.querySelector('#open-json-import').click()");
  await waitFor(async () => evaluate("document.querySelector('#json-import-dialog')?.open"), "JSON importer dialog");
  const unrelatedDialogPaste = await evaluate(`(() => { const file=new File([new Uint8Array([1,2,3])],'image.png',{type:'image/png'}); const transfer=new DataTransfer(); transfer.items.add(file); const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}); document.querySelector('#json-import-dialog').dispatchEvent(event); return event.defaultPrevented; })()`);
  assert.equal(unrelatedDialogPaste, false, "image paste in another dialog stays with that dialog");
  const textPaste = await evaluate("(() => { const field=document.querySelector('#trade-json-input'); field.focus(); const transfer=new DataTransfer(); transfer.setData('text/plain','[{\"island\":\"paste-test\"}]'); const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}); field.dispatchEvent(event); return {prevented:event.defaultPrevented,active:document.activeElement===field,dialogCount:document.querySelectorAll('dialog[open]').length}; })()");
  assert.equal(textPaste.prevented, false, "JSON textarea text paste is not intercepted");
  assert.equal(textPaste.active, true);
  await evaluate("document.querySelector('#json-import-dialog').close()");
  console.log("browser capture: text and JSON paste routing PASS");

  const tradeListBefore = await evaluate("document.querySelector('#trade-list-root').textContent");
  await evaluate("document.querySelector('#open-trade-capture').click()");
  await waitFor(async () => evaluate("document.querySelector('#trade-capture-dialog')?.open"), "trade capture context");
  const tradeDialogNode = await send("DOM.getDocument");
  const tradeInputNode = await send("DOM.querySelector", { nodeId: tradeDialogNode.root.nodeId, selector: "#trade-capture-files" });
  await send("DOM.setFileInputFiles", { nodeId: tradeInputNode.nodeId, files: [fixture] });
  await waitFor(async () => (await evaluate("document.querySelector('#trade-capture-dialog')?.dataset.queueLength")) === "1", "trade file captured as draft");
  console.log("browser capture: trade PNG draft PASS");
  const tradeState = await evaluate("JSON.stringify({text:document.querySelector('.capture-draft-item').textContent,images:document.querySelectorAll('.capture-draft-item img').length,list:document.querySelector('#trade-list-root').textContent})").then(JSON.parse);
  assert.match(tradeState.text, /인식 미실행/);
  assert.equal(tradeState.images, 1);
  assert.equal(tradeState.list, tradeListBefore, "trade draft does not change the existing trade list");
  await evaluate("(async()=>{const canvas=document.createElement('canvas');canvas.width=8;canvas.height=6;const context=canvas.getContext('2d');const pixels=context.createImageData(8,6);for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=(i*3)%256;pixels.data[i+1]=(i*7)%256;pixels.data[i+2]=(i*11)%256;pixels.data[i+3]=255;}context.putImageData(pixels,0,0);const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.9));const file=new File([jpeg],'capture.jpg',{type:'image/jpeg'});const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});const sourceCanvas=document.createElement('canvas');sourceCanvas.width=bitmap.width;sourceCanvas.height=bitmap.height;const sourceContext=sourceCanvas.getContext('2d');sourceContext.drawImage(bitmap,0,0);window.__jpegSourcePixels=[...sourceContext.getImageData(0,0,bitmap.width,bitmap.height).data];window.__jpegSourceDimensions=[bitmap.width,bitmap.height];bitmap.close();const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#trade-capture-files');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));canvas.width=0;canvas.height=0;sourceCanvas.width=0;sourceCanvas.height=0;})()");
  await waitFor(async () => (await evaluate("document.querySelector('#trade-capture-dialog')?.dataset.queueLength")) === "2", "non-PNG file normalized into trade draft");
  console.log("browser capture: JPEG normalized in draft");
  const jpegResult = await evaluate("(async()=>{const image=document.querySelectorAll('.capture-draft-item img')[1];const response=await fetch(image.src);const blob=await response.blob();const bitmap=await createImageBitmap(blob);const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);const pixels=[...context.getImageData(0,0,canvas.width,canvas.height).data];const dimensions=[bitmap.width,bitmap.height];bitmap.close();canvas.width=0;canvas.height=0;return {type:blob.type,dimensions,pixelsEqual:JSON.stringify(pixels)===JSON.stringify(window.__jpegSourcePixels),sourceDimensions:window.__jpegSourceDimensions,label:document.querySelectorAll('.capture-draft-item')[1].textContent};})()");
  assert.equal(jpegResult.type, "image/png", "non-PNG image is normalized to PNG");
  assert.deepEqual(jpegResult.dimensions, jpegResult.sourceDimensions);
  assert.equal(jpegResult.pixelsEqual, true, "lossless PNG keeps the browser-decoded source pixels");
  assert.match(jpegResult.label, /PNG 변환/);
  await evaluate("document.querySelectorAll('#trade-capture-dialog [aria-label=\"물교 이미지 초안 제거\"]')[0].click(); document.querySelector('#trade-capture-dialog [aria-label=\"물교 이미지 초안 제거\"]')?.click()");
  await waitFor(async () => (await evaluate("document.querySelector('#trade-capture-dialog')?.dataset.queueLength")) === "0", "trade file drafts removed");
  await evaluate(`(() => { const target=document.querySelector('#trade-capture-dialog [data-capture-paste-target]'); target.focus(); const file=new File([new Uint8Array(${JSON.stringify([...hashFixture])})],'clipboard.png',{type:'image/png'}); const transfer=new DataTransfer(); transfer.items.add(file); const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}); window.__tradePasteEvent=event; target.dispatchEvent(event); })()`);
  await waitFor(async () => (await evaluate("document.querySelector('#trade-capture-dialog')?.dataset.queueLength")) === "1", "trade clipboard image becomes a draft");
  assert.equal(await evaluate("window.__tradePasteEvent.defaultPrevented"), true, "active trade capture handles image paste");
  const tradeClipboardDraft = await evaluate("JSON.stringify({text:document.querySelector('.capture-draft-item').textContent,list:document.querySelector('#trade-list-root').textContent})").then(JSON.parse);
  assert.match(tradeClipboardDraft.text, /클립보드/);
  assert.match(tradeClipboardDraft.text, /인식 미실행/);
  assert.equal(tradeClipboardDraft.list, tradeListBefore, "trade clipboard draft does not modify trade rows");
  await evaluate("document.querySelector('#trade-capture-dialog [aria-label=\"물교 이미지 초안 제거\"]').click(); document.querySelector('#trade-capture-dialog [data-close-trade-capture]').click()");
  await waitFor(async () => await evaluate("!document.querySelector('#trade-capture-dialog')?.open && !document.querySelector('#trade-capture-dialog img')?.src"), "trade preview cleanup");

  const after = await (await fetch(`${baseUrl}api/bootstrap`)).json();
  assert.equal(after.revision, initial.revision, "capture-only flows do not write the main DB");
  assert.deepEqual(after.inventory, initial.inventory, "capture-only flows preserve inventory");
  console.log(JSON.stringify({
    ok: true,
    actualChrome: true,
    actualOsClipboardCtrlV: false,
    syntheticClipboardImagePaste: "PASS",
    warehouseFileInput: "PASS",
    pngBytesUnchanged: "PASS",
    textPasteDefaultPreserved: "PASS",
    inputAndContenteditablePasteDefaultPreserved: "PASS",
    unrelatedDialogImagePastePreserved: "PASS",
    jsonTextareaPaste: "PASS",
    tradeImageDraftWithoutOCR: "PASS",
    tradeClipboardImageDraftWithoutOCR: "PASS",
    nonPngBrowserPixelEquivalentPng: "PASS",
    previewCleanup: "PASS",
    mainDbSemanticStateUnchanged: "PASS",
    fixtureSha256: expectedHash,
  }, null, 2));
} finally {
  try { if (socket?.readyState === WebSocket.OPEN) await send("Browser.close"); } catch {}
  try { socket?.close(); } catch {}
  for (const process of [chrome, server]) {
    if (process?.pid) {
      try {
        process.kill();
        await Promise.race([new Promise((resolveExit) => process.once("exit", resolveExit)), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1500))]);
      } catch {}
    }
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  try { await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch {}
}
