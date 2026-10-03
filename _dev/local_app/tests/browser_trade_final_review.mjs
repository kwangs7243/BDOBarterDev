import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFinalProjection3 } from "../frontend/js/domain/trade-final-evidence.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contract = await readFile(resolve(root, "specs/008-capture-recognition-v2/EVIDENCE-V3-CONTRACT.md"), "utf8");
const section = contract.slice(contract.indexOf("### 12.1 FinalProjection3"), contract.indexOf("### 12.2 Completion3"));
const match = section.match(/```json\s*([\s\S]*?)```/);
assert.ok(match, "FinalProjection3 contract example is available");
const contractProjection = JSON.parse(match[1]);
const port = Number(process.env.BDO_TEST_PORT ?? 18798);
const baseUrl = process.env.BDO_TEST_URL ?? `http://127.0.0.1:${port}/`;
const python = process.env.PYTHON ?? "python";
const chromePath = process.env.BDO_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "bdo-arch-u1-final-review-"));
const database = join(profile, "isolated.sqlite3");
const masterDatabase = join(profile, "master", "master.sqlite3");
const pythonCode = `from local_app.backend.app import create_app; create_app(r'${database}', master_database_path=r'${masterDatabase}', testing=True).run(host='127.0.0.1', port=${port}, use_reloader=False, threaded=True)`;
let server;
let chrome;
let socket;

async function waitFor(predicate, label, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await Promise.race([done, new Promise((resolveWait) => setTimeout(resolveWait, 3000))]);
}

function makeProjection(classification = "NEEDS_REVIEW", { conflict = false, edge = false, pixels = null } = {}) {
  const input = {
    recognitionBatchId: contractProjection.recognitionBatchId,
    rawEvidenceHash: contractProjection.rawEvidenceHash,
    masterBinding: structuredClone(contractProjection.masterBinding),
    correctionVersion: contractProjection.correctionVersion,
    reconciliation: structuredClone(contractProjection.reconciliation),
    pixelAvailability: pixels ?? structuredClone(contractProjection.pixelAvailability),
    rows: structuredClone(contractProjection.rows),
    edgeWorkItems: edge ? [{ workItemId: "edge-work-1", edgeId: "edge-1", classification: "NEEDS_RECAPTURE",
      reason: "ROW_BOUNDARY_CONTACT", sourceRefs: [{ captureId: "capture-example-1" }] }] : [],
  };
  input.rows[0].classification = classification;
  input.rows[0].classificationReasons = classification === "FINAL_READY" ? [] : [classification === "CONFLICT" ? "RECONCILIATION_CONFLICT" : "MASTER_UNRESOLVED"];
  if (conflict) {
    const field = input.rows[0].fields.find((item) => item.field === "yield");
    field.finalValue = null;
    field.selectedCandidateIndex = null;
    field.valueState = "CONFLICT";
    field.alternatives = [
      { value: 48, sourceRefs: [{ sourceRowId: "draft-example-1", captureId: "capture-example-1", ordinal: 0 }], riskReasons: ["RECONCILIATION_CONFLICT"] },
      { value: 148, sourceRefs: [{ sourceRowId: "draft-example-1", captureId: "capture-example-1", ordinal: 0 }], riskReasons: ["RECONCILIATION_CONFLICT"] },
    ];
    field.riskReasons = ["RECONCILIATION_CONFLICT"];
  }
  return buildFinalProjection3(input);
}

function makeMultiSourceFixture() {
  const input = {
    recognitionBatchId: contractProjection.recognitionBatchId,
    rawEvidenceHash: contractProjection.rawEvidenceHash,
    masterBinding: structuredClone(contractProjection.masterBinding),
    correctionVersion: contractProjection.correctionVersion,
    reconciliation: structuredClone(contractProjection.reconciliation),
    pixelAvailability: [],
    rows: structuredClone(contractProjection.rows),
    edgeWorkItems: [],
  };
  const firstId = "draft-example-1";
  const secondId = "draft-example-2";
  const firstCapture = "capture-example-1";
  const secondCapture = "capture-example-2";
  const firstCropIds = input.rows[0].fields.flatMap((field) => field.cropRefs);
  const secondCropIds = firstCropIds.map((id) => `${id}-second`);
  const sources = [
    { sourceRowId: firstId, captureId: firstCapture, ordinal: 0, projectionSourceIndex: 0 },
    { sourceRowId: secondId, captureId: secondCapture, ordinal: 0, projectionSourceIndex: 1 },
  ];
  const group = { groupId: "group-example-1", status: "EXACT_OVERLAP", memberSourceRowIds: [firstId, secondId],
    representativeSourceRowId: firstId, logicalRowId: "logical-example-1", memberEvidence: [] };
  const memberFields = (sourceRowId, cropIds) => input.rows[0].fields.map((field, index) => ({ ...structuredClone(field),
    rawEvidenceRefs: [{ sourceRowId, field: field.field }], cropRefs: [cropIds[index]] }));
  group.memberEvidence = [{ sourceRowId: firstId, fields: memberFields(firstId, firstCropIds) },
    { sourceRowId: secondId, fields: memberFields(secondId, secondCropIds) }];
  input.reconciliation.captureOrder = [firstCapture, secondCapture];
  input.reconciliation.sourceRows = sources;
  input.reconciliation.groups = [group];
  input.reconciliation.sourceToLogical = sources.map((source) => ({ sourceRowId: source.sourceRowId, logicalRowId: group.logicalRowId }));
  input.rows[0].sourceRefs = sources.map(({ sourceRowId, captureId, ordinal }) => ({ sourceRowId, captureId, ordinal }));
  input.rows[0].fields = input.rows[0].fields.map((field, index) => ({ ...field,
    rawEvidenceRefs: [{ sourceRowId: firstId, field: field.field }, { sourceRowId: secondId, field: field.field }],
    cropRefs: [firstCropIds[index], secondCropIds[index]] }));
  input.pixelAvailability = [...firstCropIds, ...secondCropIds].map((cropRefId) => ({ cropRefId, state: "IN_MEMORY" }));
  const rawRows = sources.map(({ sourceRowId, captureId }, sourceIndex) => ({ sourceRowId, captureId, ordinal: 0,
    rowBox: { x: 0, y: 0, width: 140, height: 30 }, fields: contractProjection.rows[0].fields.map((field, fieldIndex) => ({
      field: field.field, rawText: typeof field.finalValue === "string" ? field.finalValue : null,
      rawNumeric: Number.isSafeInteger(field.finalValue) ? field.finalValue : null,
      readerStatus: "RAW_OCR_CANDIDATE", confidence: "0.8",
      cropRefs: [{ cropRefId: sourceIndex === 0 ? firstCropIds[fieldIndex] : secondCropIds[fieldIndex], sourceRowId,
        captureId, field: field.field, bitmapSha256: "b".repeat(64), frame: { width: 140, height: 30 },
        coordinateSpace: "CAPTURE_BITMAP_PIXELS", box: { x: 0, y: 0, width: 20, height: 10 },
        pixelHashBasis: "RGB8_ROW_MAJOR_V1", pixelSha256: "c".repeat(64), pngArtifactSha256: null }],
    })) }));
  return {
    projection: buildFinalProjection3(input),
    rawEvidence: { schemaVersion: 2, recognitionBatchId: contractProjection.recognitionBatchId,
      captures: [firstCapture, secondCapture].map((captureId) => ({ captureId, frame: { width: 140, height: 30 }, imageSha256: "a".repeat(64), bitmapSha256: "b".repeat(64) })),
      sourceRows: rawRows, edgeSegments: [] },
  };
}

const projection = makeProjection("NEEDS_REVIEW", { edge: true });
const rawEvidence = {
  schemaVersion: 2,
  recognitionBatchId: projection.recognitionBatchId,
  captures: [{ captureId: "capture-example-1", frame: { width: 140, height: 30 }, imageSha256: "a".repeat(64), bitmapSha256: "b".repeat(64) }],
  sourceRows: [{ sourceRowId: "draft-example-1", captureId: "capture-example-1", ordinal: 0, rowBox: { x: 0, y: 0, width: 140, height: 30 },
    fields: projection.rows[0].fields.map((field) => ({ field: field.field,
      rawText: typeof field.finalValue === "string" ? field.finalValue : null,
      rawNumeric: Number.isSafeInteger(field.finalValue) ? field.finalValue : null,
      readerStatus: "RAW_OCR_CANDIDATE", confidence: "0.8",
      cropRefs: field.cropRefs.map((cropRefId) => ({ cropRefId, sourceRowId: "draft-example-1", captureId: "capture-example-1", field: field.field,
        bitmapSha256: "b".repeat(64), frame: { width: 140, height: 30 }, coordinateSpace: "CAPTURE_BITMAP_PIXELS",
        box: { x: 0, y: 0, width: 20, height: 10 }, pixelHashBasis: "RGB8_ROW_MAJOR_V1", pixelSha256: "c".repeat(64), pngArtifactSha256: null })),
    })) }],
  edgeSegments: [{ edgeId: "edge-1", captureId: "capture-example-1", rowBox: { x: 0, y: 20, width: 140, height: 10 } }],
};
rawEvidence.sourceRows[0].fields[0].rawText = '<img src=x onerror="window.__u1Injected=1"> & "원문"';
const projectionJson = JSON.stringify(projection);
const rawEvidenceJson = JSON.stringify(rawEvidence);

try {
  server = spawn(python, ["-B", "-c", pythonCode], { cwd: root, stdio: "ignore", windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: profile, PYTHONDONTWRITEBYTECODE: "1" } });
  await waitFor(async () => { try { return (await fetch(`${baseUrl}api/health`)).ok; } catch { return false; } }, "isolated app server");
  chrome = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--disable-background-networking", "--remote-debugging-port=0", "--remote-allow-origins=*", `--user-data-dir=${join(profile, "chrome-profile")}`, "about:blank"],
  { stdio: "ignore", windowsHide: true });
  const activePortFile = join(profile, "chrome-profile", "DevToolsActivePort");
  const activePort = await waitFor(async () => { try { return await readFile(activePortFile, "utf8"); } catch { return false; } }, "Chrome DevTools endpoint");
  const debugPort = activePort.trim().split(/\r?\n/)[0];
  const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" });
  assert.equal(targetResponse.ok, true);
  const target = await targetResponse.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map(); let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data); if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id); pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveMessage, reject) => {
    const id = ++nextId; pending.set(id, { resolve: resolveMessage, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1.3, mobile: false });
  await waitFor(async () => evaluate("document.querySelector('#app-content')?.getAttribute('aria-busy') === 'false'"), "app bootstrap");
  await evaluate(`(async()=>{window.__u1Projection=${projectionJson};window.__u1RawEvidence=${rawEvidenceJson};window.__u1Completion=null;window.__u1ConfirmCalls=0;window.__u1NowCalls=0;window.__u1Hash=window.__u1Projection.projectionHash;window.__u1Pixels=structuredClone(window.__u1Projection.pixelAvailability);window.__u1ApiCalls=0;window.__u1Urls=new Set();window.__u1Revoked=[];const oldCreate=URL.createObjectURL.bind(URL),oldRevoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=(blob)=>{const url=oldCreate(blob);window.__u1Urls.add(url);return url};URL.revokeObjectURL=(url)=>{window.__u1Revoked.push(url);window.__u1Urls.delete(url);oldRevoke(url)};const pngBlob=async()=>{const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;canvas.getContext('2d').fillRect(0,0,1,1);return await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))};window.__u1Source={buildPixelAvailability:async()=>structuredClone(window.__u1Pixels),createDisplayRowCrop:async()=>({width:140,height:30,blob:await pngBlob()}),createDisplayCrop:async()=>({width:20,height:10,blob:await pngBlob()}),createDisplayCapture:async()=>({frame:{width:140,height:30},blob:await pngBlob()})};window.__u1Import=import('/assets/js/trade-final-review.js');window.__u1Mount=async(projection)=>{window.__u1Controller?.destroy();window.__u1Completion=null;window.__u1Projection=projection;window.__u1Hash=projection.projectionHash;window.__u1Pixels=structuredClone(projection.pixelAvailability);const module=await window.__u1Import;document.querySelector('#trade-final-review-dialog').showModal();window.__u1Controller=await module.mountTradeFinalReview({root:document.querySelector('[data-role=trade-final-review-root]'),projection,rawEvidence:window.__u1RawEvidence,sourceEvidence:window.__u1Source,reviewRevision:7,getCurrentProjectionHash:async()=>window.__u1Hash,getCurrentPixelAvailability:async()=>structuredClone(window.__u1Pixels),getConfirmedAt:async()=>{window.__u1NowCalls++;return '2026-10-03T01:02:03Z'},onConfirm:async(completion)=>{window.__u1ConfirmCalls++;window.__u1Completion=completion}})};await window.__u1Mount(window.__u1Projection)})()`);
  await waitFor(async () => evaluate("!document.querySelector('[data-action=confirm]').disabled"), "initial source availability check");
  assert.equal(await evaluate("document.querySelector('[role=tab][data-tab=problem]').getAttribute('aria-selected')"), "true");
  assert.equal(await evaluate("document.querySelectorAll('.trade-final-review-summary-item').length"), 8, "all eight metrics remain visible in grouped summary");
  assert.equal(await evaluate("document.querySelector('.trade-final-review-summary-primary').getAttribute('aria-label')"), "주요 결과");
  assert.equal(await evaluate("document.querySelector('.trade-final-review-summary-details').getAttribute('aria-label')"), "세부 정보");
  assert.equal(await evaluate("document.querySelector('#trade-final-review-dialog').getAttribute('aria-labelledby')"), "trade-final-review-title");
  assert.equal(await evaluate("document.querySelector('.trade-final-review-confirmation').textContent.includes('회차에는 아직 적용되지 않습니다')"), true);
  assert.equal(await evaluate("document.querySelector('[data-action=confirm]').textContent"), "검수 완료");
  assert.equal(await evaluate("document.querySelectorAll('.trade-final-review-field').length"), 6);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"남은 횟수 최종 값\"]').value"), "0");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"필요 수량 최종 값\"]').disabled"), true, "review values are readable before explicit edit");
  assert.equal(await evaluate("document.querySelector('[data-action=toggle-edit]').textContent"), "수정하기");
  await evaluate("document.querySelector('[data-action=toggle-edit]').click()");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"필요 수량 최종 값\"]').disabled"), false, "explicit row edit enables correction controls");
  assert.equal(await evaluate("document.querySelectorAll('[data-action=confirm]').length"), 1);
  assert.equal(await evaluate("document.querySelector('.trade-final-review-diagnostics > summary').textContent"), "왜 이렇게 보정됐나");
  await waitFor(async () => evaluate("document.querySelector('.trade-final-review-source img') !== null"), "verified row crop display");
  await evaluate("document.querySelector('[data-action=show-capture]').click()");
  await waitFor(async () => evaluate("document.querySelector('.trade-final-review-location') !== null"), "capture location overlay");
  await evaluate("document.querySelector('[role=tab][data-tab=original]').click()");
  assert.equal(await evaluate("document.querySelectorAll('.trade-final-review-ocr-field').length"), 6);
  assert.equal(await evaluate("document.querySelector('.trade-final-review-ocr-source').textContent.includes('<img src=x onerror=')"), true, "owner/OCR text is displayed as text");
  assert.equal(await evaluate("document.querySelectorAll('img[onerror]').length"), 0, "OCR content cannot inject HTML");
  assert.equal(await evaluate("window.__u1Injected"), undefined);
  await evaluate("document.querySelector('[data-action=show-ocr-crop]').click()");
  await waitFor(async () => evaluate("document.querySelector('.trade-final-review-source .trade-final-review-image-panel img') !== null"), "field crop display");
  await evaluate("document.querySelector('[role=tab][data-tab=all]').click()");
  assert.equal(await evaluate("document.querySelectorAll('.trade-final-review-list-item').length"), 1);
  assert.equal(await evaluate("document.body.scrollWidth <= window.innerWidth"), true, "workspace has no horizontal page overflow");

  const multi = makeMultiSourceFixture();
  await evaluate("window.__u1RowCropCalls=[];const original=window.__u1Source.createDisplayRowCrop;window.__u1Source.createDisplayRowCrop=async(id)=>{window.__u1RowCropCalls.push(id);return original(id)}");
  await evaluate(`(async()=>{window.__u1RawEvidence=${JSON.stringify(multi.rawEvidence)};await window.__u1Mount(${JSON.stringify(multi.projection)})})()`);
  assert.equal(await evaluate("document.querySelectorAll('.trade-final-review-source-selector [data-action=select-source]').length"), 2);
  await waitFor(async () => evaluate("document.querySelector('.trade-final-review-source img') !== null"), "representative overlap source crop");
  await evaluate("document.querySelector('[data-action=select-source][data-index=\"1\"]').click()");
  await waitFor(async () => evaluate("window.__u1RowCropCalls.at(-1)==='draft-example-2'"), "alternate overlap source request");
  await waitFor(async () => evaluate("document.querySelector('.trade-final-review-source img') !== null"), "alternate overlap source crop");
  assert.equal(await evaluate("document.querySelector('.trade-final-review-source-label').textContent"), "원본 2 · 행 1");
  await evaluate(`(async()=>{window.__u1RawEvidence=${rawEvidenceJson};window.__u1Projection=${projectionJson};await window.__u1Mount(window.__u1Projection)})()`);

  await evaluate(`(async()=>{const projection=window.__u1Projection;const m=await import('/assets/js/domain/trade-final-evidence.js');const i={recognitionBatchId:projection.recognitionBatchId,rawEvidenceHash:projection.rawEvidenceHash,masterBinding:structuredClone(projection.masterBinding),correctionVersion:projection.correctionVersion,reconciliation:structuredClone(projection.reconciliation),pixelAvailability:structuredClone(projection.pixelAvailability),rows:structuredClone(projection.rows),edgeWorkItems:[]};i.rows[0].classification='FINAL_READY';i.rows[0].classificationReasons=[];await window.__u1Mount(m.buildFinalProjection3(i))})()`);
  await evaluate("document.querySelector('[role=tab][data-tab=all]').click()");
  assert.equal(await evaluate("document.querySelector('.trade-final-review-list-item .status-FINAL_READY').textContent"), "추가 확인 없음");
  assert.equal(await evaluate("document.querySelector('.trade-final-review-ready-note').textContent.includes('사람 정답으로 독립 검증')"), true);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"남은 횟수 최종 값\"]').disabled"), true, "ready rows start read-only");
  await evaluate("document.querySelector('[data-action=toggle-edit]').click()");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"남은 횟수 최종 값\"]').disabled"), false);
  await evaluate("document.querySelector('[aria-label=\"필요 수량 최종 값\"]').value='2';document.querySelector('[aria-label=\"필요 수량 최종 값\"]').dispatchEvent(new Event('input',{bubbles:true}))");
  await evaluate("document.querySelector('[data-action=confirm]').click()");
  await waitFor(async () => evaluate("window.__u1Completion !== null"), "Completion3 callback");
  assert.equal(await evaluate("window.__u1Completion.rows[0].fields[2].finalValue"), 2, "numeric edits become integer values");
  assert.equal(await evaluate("window.__u1Completion.rows[0].fields[2].operationalDecision"), "USER_EDITED");
  assert.equal(await evaluate("window.__u1Completion.rows[0].fields[4].finalValue"), 0, "zero count is preserved");
  assert.equal(await evaluate("window.__u1Completion.rows[0].fields[4].operationalDecision"), "CANDIDATE_RETAINED");
  assert.equal(await evaluate("window.__u1Completion.rows[0].fields[0].operationalDecision"), "CANDIDATE_RETAINED");
  assert.equal(await evaluate("window.__u1Completion.rows[0].fields.some(field=>field.truthEvidence||field.knownTruthEligible)"), false);
  assert.equal(await evaluate("window.__u1Completion.batchConfirmation.method"), "USER_FINAL_LIST_CONFIRMED");
  assert.equal(await evaluate("window.__u1ConfirmCalls"), 1);

  await evaluate(`(async()=>{const projection=window.__u1Projection;const m=await import('/assets/js/domain/trade-final-evidence.js');const i={recognitionBatchId:projection.recognitionBatchId,rawEvidenceHash:projection.rawEvidenceHash,masterBinding:structuredClone(projection.masterBinding),correctionVersion:projection.correctionVersion,reconciliation:structuredClone(projection.reconciliation),pixelAvailability:structuredClone(projection.pixelAvailability),rows:structuredClone(projection.rows),edgeWorkItems:[]};i.rows[0].classification='CONFLICT';i.rows[0].classificationReasons=['RECONCILIATION_CONFLICT'];const f=i.rows[0].fields.find(x=>x.field==='yield');f.finalValue=null;f.selectedCandidateIndex=null;f.valueState='CONFLICT';f.riskReasons=['RECONCILIATION_CONFLICT'];f.alternatives=[{value:48,sourceRefs:[{sourceRowId:'draft-example-1',captureId:'capture-example-1',ordinal:0}],riskReasons:['RECONCILIATION_CONFLICT']},{value:148,sourceRefs:[{sourceRowId:'draft-example-1',captureId:'capture-example-1',ordinal:0}],riskReasons:['RECONCILIATION_CONFLICT']}];await window.__u1Mount(m.buildFinalProjection3(i))})()`);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"획득 수량 최종 값\"]').value"), "", "conflict is not silently selected");
  assert.equal(await evaluate("document.querySelectorAll('.trade-final-review-alternative').length"), 2);
  assert.equal(await evaluate("document.querySelector('.trade-final-review-list-item .status-CONFLICT').textContent"), "결과 충돌");
  await evaluate("document.querySelector('.trade-final-review-alternative [data-action=choose-alternative]').click()");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"획득 수량 최종 값\"]').value"), "48");
  await evaluate("document.querySelector('[data-action=mark-unknown][data-field=yield]')?.click() || document.querySelector('[data-field=yield] [data-action=mark-unknown]').click()");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"획득 수량 최종 값\"]').value"), "");
  await evaluate("document.querySelector('[data-action=confirm]').click()");
  await waitFor(async () => evaluate("window.__u1Completion !== null"), "unknown field Completion3");
  assert.equal(await evaluate("window.__u1Completion.rows[0].fields[5].operationalDecision"), "USER_MARKED_UNKNOWN");

  await evaluate(`(async()=>{const p=window.__u1Projection;const m=await import('/assets/js/domain/trade-final-evidence.js');const i={recognitionBatchId:p.recognitionBatchId,rawEvidenceHash:p.rawEvidenceHash,masterBinding:structuredClone(p.masterBinding),correctionVersion:p.correctionVersion,reconciliation:structuredClone(p.reconciliation),pixelAvailability:structuredClone(p.pixelAvailability),rows:structuredClone(p.rows),edgeWorkItems:[]};i.rows[0].classification='NEEDS_RECAPTURE';i.rows[0].classificationReasons=['FIELD_CLIPPED'];i.edgeWorkItems=[{workItemId:'edge-work-1',edgeId:'edge-1',classification:'NEEDS_RECAPTURE',reason:'ROW_BOUNDARY_CONTACT',sourceRefs:[{captureId:'capture-example-1'}]}];await window.__u1Mount(m.buildFinalProjection3(i))})()`);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"교환 장소 최종 값\"]').disabled"), true, "recapture values cannot be used to include a row");
  await evaluate("document.querySelector('[data-action=exclude-row]').click()");
  await evaluate("document.querySelector('[data-action=confirm]').click()");
  assert.match(await evaluate("document.querySelector('[data-role=message]').textContent"), /사유/);
  await evaluate("const reason=document.querySelector('[data-action=row-exclusion-reason]');reason.value='화면에서 확인할 수 없음';reason.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=select-item][data-item-type=edge]').click();document.querySelector('[data-action=exclude-edge]').click();const edgeReason=document.querySelector('[data-action=edge-exclusion-reason]');edgeReason.value='화면 밖 항목';edgeReason.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=confirm]').click()");
  await waitFor(async () => evaluate("window.__u1Completion !== null"), "explicit row and edge exclusions");
  assert.equal(await evaluate("window.__u1Completion.rows[0].disposition"), "EXCLUDE");
  assert.equal(await evaluate("window.__u1Completion.rows[0].dispositionReason"), "화면에서 확인할 수 없음");
  assert.equal(await evaluate("window.__u1Completion.workItems[0].decision"), "EXPLICITLY_EXCLUDED");

  await evaluate("window.__u1Mount(window.__u1Projection)");
  await evaluate("window.__u1Hash='stale';document.querySelector('[data-action=confirm]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(await evaluate("window.__u1Completion"), null, "stale projection blocks confirmation");
  assert.equal(await evaluate("window.__u1NowCalls"), 3, "timestamp is not requested for stale projection");
  await evaluate("window.__u1Hash=window.__u1Projection.projectionHash;window.__u1Pixels[0].state='EXPIRED';document.querySelector('[data-action=confirm]').click()");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(await evaluate("window.__u1Completion"), null, "changed pixel availability blocks confirmation");
  assert.equal(await evaluate("window.__u1NowCalls"), 3, "timestamp is not requested for stale pixels");

  await evaluate(`(async()=>{window.__u1NormalRowCrop=window.__u1Source.createDisplayRowCrop;window.__u1Source.createDisplayRowCrop=()=>new Promise(resolve=>{window.__u1RaceResolve=resolve});await window.__u1Mount(window.__u1Projection)})()`);
  await waitFor(async () => evaluate("typeof window.__u1RaceResolve === 'function'"), "delayed source response");
  await evaluate("document.querySelector('[data-action=select-item][data-item-type=edge]').click();window.__u1RaceResolve({width:140,height:30,blob:new Blob(['late'],{type:'image/png'})})");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(await evaluate("document.querySelector('.trade-final-review-source img')"), null, "late row image cannot replace the selected edge details");
  await evaluate("window.__u1Source.createDisplayRowCrop=window.__u1NormalRowCrop");

  for (const [width, height] of [[1440, 900], [1024, 768], [768, 720]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1.3, mobile: false });
    assert.equal(await evaluate("(()=>{const d=document.querySelector('#trade-final-review-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=window.innerWidth&&d.scrollWidth<=d.clientWidth})()"), true, `workspace has no horizontal overflow at ${width}x${height}`);
    assert.equal(await evaluate("document.querySelector('.trade-final-review-footer').getBoundingClientRect().bottom <= window.innerHeight"), true, `footer visible at ${width}x${height}`);
  }
  await evaluate("window.__u1Controller.destroy()");
  assert.equal(await evaluate("window.__u1Urls.size"), 0, "all preview object URLs are released");
  assert.equal(await evaluate("document.querySelector('#trade-final-review-dialog').open"), false);
  assert.equal(await evaluate("window.__u1ApiCalls"), 0, "preview workspace sends no API requests");
  console.log("browser_trade_final_review: PASS · workspace, classifications, six-field editing, source previews, stale guards, exclusions, Completion3, responsive Chrome");
} finally {
  try { if (socket?.readyState === WebSocket.OPEN) socket.close(); } catch {}
  await stopChild(chrome); await stopChild(server);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  try { await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
  catch (error) { console.warn(`Temporary Chrome profile cleanup warning: ${error.message}`); }
}
