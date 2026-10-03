const ERROR_MESSAGES = {
  engine_unavailable: "로컬 인식 엔진을 사용할 수 없습니다.",
  engine_integrity_error: "로컬 인식 엔진 상태를 확인할 수 없습니다.",
  engine_busy: "다른 인식 작업이 진행 중입니다. 잠시 후 다시 시도하세요.",
  recognition_timeout: "로컬 인식 시간이 초과되었습니다. 이미지는 그대로 유지했습니다.",
  recognition_worker_failed: "로컬 인식 처리에 실패했습니다. 이미지는 그대로 유지했습니다.",
  invalid_batch: "인식 요청을 확인할 수 없습니다. 대기 이미지는 유지했습니다.",
  invalid_capture_parts: "캡처 이미지 구성이 올바르지 않습니다. 대기 이미지는 유지했습니다.",
  duplicate_capture_id: "중복된 캡처가 있습니다. 대기 이미지는 유지했습니다.",
  image_too_large: "이미지 용량이 너무 큽니다. 대기 이미지는 유지했습니다.",
  invalid_image: "캡처 이미지가 올바르지 않습니다. 기존 이미지는 유지했습니다.",
  frame_mismatch: "전송한 이미지와 크기 정보가 다릅니다. 기존 이미지는 유지했습니다.",
  invalid_task_type: "물교 캡처가 아닌 이미지가 포함되어 있습니다. 대기 이미지는 유지했습니다.",
};

const FIELD_KEYS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];

export class TradeRecognitionError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] ?? "로컬 인식 요청에 실패했습니다. 대기 이미지는 유지했습니다.", diagnostics = {}) {
    super(message);
    this.name = "TradeRecognitionError";
    this.code = code;
    this.stage = diagnostics.stage ?? (code === "contract_violation" ? "RAW_OCR" : "REQUEST_BUILD");
    this.diagnostics = { ...diagnostics, stage: this.stage, code };
  }
}

async function responseJson(response) {
  try { return await response.json(); } catch { return null; }
}

export async function getTradeRecognitionRuntime() {
  let response;
  try { response = await fetch("/api/recognition/trade-runtime", { method: "GET", credentials: "same-origin" }); }
  catch { throw new TradeRecognitionError("runtime_status_failed", "로컬 인식 상태를 확인하지 못했습니다."); }
  const body = await responseJson(response);
  if (!response.ok || body?.ok !== true || !body.runtime || typeof body.runtime.available !== "boolean") {
    throw new TradeRecognitionError("runtime_status_failed", "로컬 인식 상태를 확인하지 못했습니다.");
  }
  return body.runtime;
}

function validateResult(body, expectedCaptureIds, expectedBatchId) {
  const result = body?.result;
  const approval = result?.approval;
  if (body?.ok !== true || !result || typeof result !== "object" || Array.isArray(result)
      || result.version !== 1 || typeof result.batchId !== "string" || result.batchId !== expectedBatchId
      || !Array.isArray(result.captures) || !Array.isArray(result.draftRows)
      || !Array.isArray(result.edgeSegments) || result.metrics?.boundaryPolicy !== "edge-segments-evidence-only-v1"
      || ["detectedCandidateCount", "completeRowCount", "edgeSegmentCount", "draftRowCount"]
        .some((key) => !Number.isInteger(result.metrics[key]) || result.metrics[key] < 0)
      || result.metrics.detectedCandidateCount !== result.metrics.completeRowCount + result.metrics.edgeSegmentCount
      || result.metrics.draftRowCount !== result.metrics.completeRowCount
      || result.metrics.edgeSegmentCount !== result.edgeSegments.length
      || result.status !== "DRAFT_UNVERIFIED" || approval?.production !== false || approval?.HIGH !== 0
      || approval?.importerIntegration !== false || approval?.automationDecision !== "REVIEW") {
    throw new TradeRecognitionError("contract_violation");
  }
  const responseCaptureIds = result.captures.map((capture) => capture?.captureId);
  if (responseCaptureIds.length !== expectedCaptureIds.length
      || responseCaptureIds.some((id, index) => id !== expectedCaptureIds[index])) {
    throw new TradeRecognitionError("contract_violation");
  }
  for (const edge of result.edgeSegments) {
    if (!edge || typeof edge !== "object" || typeof edge.captureId !== "string"
        || !responseCaptureIds.includes(edge.captureId)
        || !edge.rowBox || typeof edge.rowBox !== "object"
        || ["x", "y", "width", "height"].some((key) => !Number.isFinite(edge.rowBox[key]))
        || edge.classification !== "EDGE_SEGMENT_UNCERTAIN"
        || !["top", "bottom", "both"].includes(edge.boundarySide)
        || Object.hasOwn(edge, "fields")) {
      throw new TradeRecognitionError("contract_violation");
    }
  }
  let detectedCount = 0;
  let completeCount = 0;
  let edgeCount = 0;
  for (const capture of result.captures) {
    const values = [capture?.detectedCandidateCount, capture?.completeRowCount, capture?.edgeSegmentCount];
    if (values.some((value) => !Number.isInteger(value) || value < 0)
        || values[0] !== values[1] + values[2]) throw new TradeRecognitionError("contract_violation");
    detectedCount += values[0]; completeCount += values[1]; edgeCount += values[2];
  }
  if (detectedCount !== result.metrics.detectedCandidateCount || completeCount !== result.metrics.completeRowCount
      || edgeCount !== result.metrics.edgeSegmentCount || completeCount !== result.metrics.draftRowCount) {
    throw new TradeRecognitionError("contract_violation");
  }
  for (const row of result.draftRows) {
    if (!row || typeof row !== "object" || row.status !== "DRAFT_UNVERIFIED" || row.automationDecision !== "REVIEW"
        || !row.fields || typeof row.fields !== "object" || Array.isArray(row.fields)
        || FIELD_KEYS.length !== Object.keys(row.fields).length
        || FIELD_KEYS.some((key) => !Object.hasOwn(row.fields, key))) {
      throw new TradeRecognitionError("contract_violation");
    }
    if (FIELD_KEYS.some((key) => row.fields[key]?.reasonCodes?.includes("ROW_BOUNDARY_CONTACT"))) {
      throw new TradeRecognitionError("contract_violation");
    }
    if (FIELD_KEYS.some((key) => !row.fields[key] || typeof row.fields[key] !== "object"
        || !Object.hasOwn(row.fields[key], "value") || row.fields[key].value !== null)) {
      throw new TradeRecognitionError("contract_violation");
    }
  }
  return result;
}

export async function recognizeTradeLiveList(captures) {
  return recognizeTradeBatch(captures, { liveList: true });
}

export async function recognizeTradeBatch(captures, { liveList = false } = {}) {
  if (!Array.isArray(captures) || captures.length === 0) throw new TradeRecognitionError("invalid_batch");
  for (const capture of captures) {
    if (!(capture?.blob instanceof Blob) || capture.blob.type !== "image/png"
        || capture.metadata?.taskType !== "trade" || typeof capture.metadata.captureId !== "string") {
      throw new TradeRecognitionError("invalid_image");
    }
  }
  if (typeof globalThis.crypto?.randomUUID !== "function") throw new TradeRecognitionError("request_id_unavailable");
  const batchId = globalThis.crypto.randomUUID();
  const batch = {
    version: 1,
    batchId,
    captures: captures.map((capture) => ({ captureId: capture.metadata.captureId, metadata: capture.metadata })),
  };
  const form = new FormData();
  form.append("batch", JSON.stringify(batch));
  captures.forEach((capture, index) => form.append("image", capture.blob, `capture-${String(index + 1).padStart(4, "0")}.png`));
  let response;
  try {
    response = await fetch(liveList ? "/api/recognition/trade-live-list" : "/api/recognition/trade-batch", { method: "POST", credentials: "same-origin", body: form });
  } catch {
    throw new TradeRecognitionError("network_error");
  }
  const body = await responseJson(response);
  if (!response.ok) {
    const code = typeof body?.error?.code === "string" ? body.error.code : "recognition_failed";
    throw new TradeRecognitionError(code, undefined, { ...body?.diagnostics, httpStatus: response.status, backendCode: code, backendMessage: body?.error?.message });
  }
  if (liveList) {
    const result = body?.result;
    const ids = captures.map((capture) => capture.metadata.captureId);
    if (body?.ok !== true || result?.version !== 3 || result.batchId !== batchId
        || !Array.isArray(result.rows) || !Array.isArray(result.captures)
        || result.captures.length !== ids.length || result.captures.some((item, i) => item.captureId !== ids[i])
        || result.rows.some((row) => !ids.includes(row.captureId) || !row.fields
          || FIELD_KEYS.some((field) => typeof row.fields[field]?.rawOCR !== "string"
            || typeof row.fields[field]?.reviewRequired !== "boolean"))) {
      throw new TradeRecognitionError("contract_violation");
    }
    return result;
  }
  return validateResult(body, captures.map((capture) => capture.metadata.captureId), batchId);
}

const RAW_FIELD_KEYS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const SHA256_RE = /^[0-9a-f]{64}$/;

function validRawBox(box, frame) {
  return !!box && typeof box === "object" && !Array.isArray(box) && Object.keys(box).length === 4
    && ["x", "y", "width", "height"].every((key) => Object.hasOwn(box, key) && Number.isSafeInteger(box[key]))
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= frame.width && box.y + box.height <= frame.height;
}

function validateSourceFidelity(fidelity) {
  if (!fidelity || typeof fidelity !== "object" || Array.isArray(fidelity)
      || Object.keys(fidelity).length !== 4
      || !["sourceWidth", "sourceHeight", "rescaled", "evidence"].every((key) => Object.hasOwn(fidelity, key))) return false;
  if (fidelity.sourceWidth === null && fidelity.sourceHeight === null && fidelity.rescaled === null
      && fidelity.evidence === "unknown") return true;
  return Number.isSafeInteger(fidelity.sourceWidth) && fidelity.sourceWidth > 0
    && Number.isSafeInteger(fidelity.sourceHeight) && fidelity.sourceHeight > 0
    && typeof fidelity.rescaled === "boolean" && typeof fidelity.evidence === "string"
    && fidelity.evidence.length > 0 && fidelity.evidence !== "unknown";
}

function validateRawEvidenceResult(body, expectedCaptureIds, expectedBatchId) {
  const result = body?.result;
  const raw = result?.rawEvidence;
  if (body?.ok !== true || !result || typeof result !== "object" || Array.isArray(result)
      || Object.keys(result).length !== 5
      || !["version", "batchId", "status", "rawEvidence", "runtime"].every((key) => Object.hasOwn(result, key))
      || result.version !== 2 || result.batchId !== expectedBatchId || result.status !== "RAW_EVIDENCE_ONLY"
      || !raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).length !== 5
      || !["schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"].every((key) => Object.hasOwn(raw, key))
      || raw.schemaVersion !== 2 || raw.recognitionBatchId !== expectedBatchId
      || !Array.isArray(raw.captures) || !Array.isArray(raw.sourceRows) || !Array.isArray(raw.edgeSegments)) {
    throw new TradeRecognitionError("contract_violation");
  }
  const captureIds = raw.captures.map((capture) => capture?.captureId);
  if (captureIds.length !== expectedCaptureIds.length
      || captureIds.some((id, index) => id !== expectedCaptureIds[index])
      || new Set(captureIds).size !== captureIds.length) throw new TradeRecognitionError("contract_violation");
  const captureMap = new Map();
  for (const [index, capture] of raw.captures.entries()) {
    if (!capture || typeof capture !== "object" || Object.keys(capture).length !== 9
        || !["captureId", "captureOrdinal", "imageSha256", "bitmapSha256", "sourceType", "frame", "sourceFidelity", "reencoded", "completeRowCount"]
          .every((key) => Object.hasOwn(capture, key))
        || capture.captureOrdinal !== index + 1 || !["FILE", "CLIPBOARD", "STREAM"].includes(capture.sourceType)
        || typeof capture.reencoded !== "boolean" || !validateSourceFidelity(capture.sourceFidelity)
        || !capture.frame || typeof capture.frame !== "object" || Object.keys(capture.frame).length !== 2
        || !Number.isSafeInteger(capture.frame.width) || capture.frame.width < 1
        || !Number.isSafeInteger(capture.frame.height) || capture.frame.height < 1
        || !SHA256_RE.test(capture.imageSha256) || !SHA256_RE.test(capture.bitmapSha256)
        || !Number.isSafeInteger(capture.completeRowCount) || capture.completeRowCount < 0) {
      throw new TradeRecognitionError("contract_violation");
    }
    captureMap.set(capture.captureId, capture);
  }
  const sourceRows = new Map();
  const sourceOrdinals = new Map(captureIds.map((id) => [id, new Set()]));
  let lastCaptureOrdinal = 0;
  let lastOrdinal = -1;
  for (const row of raw.sourceRows) {
    const capture = row && captureMap.get(row.captureId);
    if (!row || typeof row !== "object" || Object.keys(row).length !== 5
        || !["sourceRowId", "captureId", "ordinal", "rowBox", "fields"].every((key) => Object.hasOwn(row, key))
        || typeof row.sourceRowId !== "string" || !row.sourceRowId || sourceRows.has(row.sourceRowId)
        || !capture || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0
        || sourceOrdinals.get(row.captureId)?.has(row.ordinal)
        || captureIds.includes(row.sourceRowId) || !validRawBox(row.rowBox, capture.frame)
        || capture.captureOrdinal < lastCaptureOrdinal
        || (capture.captureOrdinal === lastCaptureOrdinal && row.ordinal < lastOrdinal)
        || !Array.isArray(row.fields) || row.fields.length !== RAW_FIELD_KEYS.length
        || row.fields.some((field, index) => !field || typeof field !== "object"
          || Object.keys(field).length !== 6
          || !["field", "rawText", "rawNumeric", "readerStatus", "confidence", "cropRefs"].every((key) => Object.hasOwn(field, key))
          || field.field !== RAW_FIELD_KEYS[index]
          || (field.rawText !== null && typeof field.rawText !== "string")
          || (field.rawNumeric !== null && !Number.isSafeInteger(field.rawNumeric))
          || (!(["reqAmount", "count", "yield"].includes(field.field)) && field.rawNumeric !== null)
          || typeof field.readerStatus !== "string" || !field.readerStatus
          || (field.confidence !== null && typeof field.confidence !== "string")
          || !Array.isArray(field.cropRefs) || field.cropRefs.length > 1)) {
      throw new TradeRecognitionError("contract_violation");
    }
    lastCaptureOrdinal = capture.captureOrdinal;
    lastOrdinal = row.ordinal;
    sourceOrdinals.get(row.captureId).add(row.ordinal);
    sourceRows.set(row.sourceRowId, row);
    for (const field of row.fields) {
      for (const crop of field.cropRefs) {
        if (!crop || typeof crop !== "object" || Object.keys(crop).length !== 11
            || !["cropRefId", "sourceRowId", "captureId", "field", "bitmapSha256", "frame", "coordinateSpace", "box", "pixelHashBasis", "pixelSha256", "pngArtifactSha256"]
              .every((key) => Object.hasOwn(crop, key))
            || typeof crop.cropRefId !== "string" || !crop.cropRefId || crop.sourceRowId !== row.sourceRowId
            || crop.captureId !== row.captureId || crop.field !== field.field
            || crop.bitmapSha256 !== capture.bitmapSha256 || crop.frame?.width !== capture.frame.width
            || crop.frame?.height !== capture.frame.height || crop.coordinateSpace !== "CAPTURE_BITMAP_PIXELS"
            || crop.pixelHashBasis !== "RGB8_ROW_MAJOR_V1" || !SHA256_RE.test(crop.pixelSha256)
            || crop.pngArtifactSha256 !== null || !crop.box || typeof crop.box !== "object") {
          throw new TradeRecognitionError("contract_violation");
        }
      }
    }
  }
  const cropIds = new Set();
  for (const row of raw.sourceRows) {
    const capture = captureMap.get(row.captureId);
    for (const field of row.fields) {
      for (const crop of field.cropRefs) {
        const box = crop?.box;
        if (cropIds.has(crop?.cropRefId) || !validRawBox(box, capture.frame)) {
          throw new TradeRecognitionError("contract_violation");
        }
        cropIds.add(crop.cropRefId);
      }
    }
  }
  const rowCounts = Object.fromEntries(captureIds.map((id) => [id, 0]));
  for (const row of raw.sourceRows) rowCounts[row.captureId] += 1;
  if (raw.captures.some((capture) => rowCounts[capture.captureId] !== capture.completeRowCount)) {
    throw new TradeRecognitionError("contract_violation");
  }
  const edgeIds = new Set();
  for (const edge of raw.edgeSegments) {
    if (!edge || typeof edge !== "object" || Object.keys(edge).length !== 6
        || !["edgeId", "captureId", "ordinal", "reason", "rowBox", "sourceRefs"].every((key) => Object.hasOwn(edge, key))
        || typeof edge.edgeId !== "string" || !edge.edgeId || edgeIds.has(edge.edgeId) || sourceRows.has(edge.edgeId)
        || captureIds.includes(edge.edgeId) || !captureMap.has(edge.captureId)
        || !Number.isSafeInteger(edge.ordinal) || edge.ordinal < 0 || typeof edge.reason !== "string" || !edge.reason
        || !validRawBox(edge.rowBox, captureMap.get(edge.captureId).frame)
        || !Array.isArray(edge.sourceRefs) || edge.sourceRefs.length !== 1
        || Object.keys(edge.sourceRefs[0] ?? {}).length !== 3
        || !["sourceRowId", "captureId", "ordinal"].every((key) => Object.hasOwn(edge.sourceRefs[0] ?? {}, key))
        || edge.sourceRefs[0]?.sourceRowId !== edge.edgeId || edge.sourceRefs[0]?.captureId !== edge.captureId
        || edge.sourceRefs[0]?.ordinal !== edge.ordinal) throw new TradeRecognitionError("contract_violation");
    edgeIds.add(edge.edgeId);
  }
  const runtime = result.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)
      || typeof runtime.available !== "boolean" || typeof runtime.engineId !== "string"
      || !SHA256_RE.test(runtime.modelBundleSha256) || typeof runtime.workerVersion !== "string"
      || !Number.isSafeInteger(runtime.durationMs) || runtime.durationMs < 0
      || runtime.captureCount !== expectedCaptureIds.length) throw new TradeRecognitionError("contract_violation");
  return result;
}

export async function recognizeTradeBatchV2(captures) {
  const supportedSourceTypes = new Set(["file", "clipboard", "browser-stream"]);
  if (!Array.isArray(captures) || captures.length === 0) throw new TradeRecognitionError("invalid_batch");
  for (const capture of captures) {
    if (!(capture?.blob instanceof Blob) || capture.blob.type !== "image/png"
        || capture.metadata?.version !== 1 || capture.metadata?.taskType !== "trade"
        || typeof capture.metadata.captureId !== "string" || !capture.metadata.captureId
        || !supportedSourceTypes.has(capture.metadata.sourceType)
        || !validateSourceFidelity(capture.metadata.fidelity) || typeof capture.reencoded !== "boolean") {
      throw new TradeRecognitionError("invalid_image", undefined, { stage: "REQUEST_BUILD",
        captureId: capture?.metadata?.captureId, sourceType: capture?.metadata?.sourceType,
        blobType: capture?.blob?.type, blobSize: capture?.blob?.size,
        frame: capture?.metadata?.frame, fidelity: capture?.metadata?.fidelity });
    }
  }
  if (typeof globalThis.crypto?.randomUUID !== "function") throw new TradeRecognitionError("request_id_unavailable");
  const batchId = globalThis.crypto.randomUUID();
  const batch = {
    version: 2,
    batchId,
    captures: captures.map((capture) => ({ captureId: capture.metadata.captureId,
      metadata: capture.metadata, reencoded: capture.reencoded })),
  };
  const form = new FormData();
  form.append("batch", JSON.stringify(batch));
  captures.forEach((capture, index) => form.append("image", capture.blob, `capture-${String(index + 1).padStart(4, "0")}.png`));
  let response;
  try {
    response = await fetch("/api/recognition/trade-batch", { method: "POST", credentials: "same-origin", body: form });
  } catch {
    throw new TradeRecognitionError("network_error");
  }
  const body = await responseJson(response);
  if (!response.ok) {
    const code = typeof body?.error?.code === "string" ? body.error.code : "recognition_failed";
    throw new TradeRecognitionError(code, undefined, { ...body?.diagnostics, httpStatus: response.status, backendCode: code, backendMessage: body?.error?.message });
  }
  return validateRawEvidenceResult(body, captures.map((capture) => capture.metadata.captureId), batchId);
}
