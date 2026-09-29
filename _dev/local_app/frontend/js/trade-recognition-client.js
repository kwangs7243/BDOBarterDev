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
  frame_mismatch: "캡처 이미지가 올바르지 않습니다. 기존 이미지는 유지했습니다.",
  invalid_task_type: "물교 캡처가 아닌 이미지가 포함되어 있습니다. 대기 이미지는 유지했습니다.",
};

const FIELD_KEYS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];

export class TradeRecognitionError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] ?? "로컬 인식 요청에 실패했습니다. 대기 이미지는 유지했습니다.") {
    super(message);
    this.name = "TradeRecognitionError";
    this.code = code;
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

export async function recognizeTradeBatch(captures) {
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
    response = await fetch("/api/recognition/trade-batch", { method: "POST", credentials: "same-origin", body: form });
  } catch {
    throw new TradeRecognitionError("network_error");
  }
  const body = await responseJson(response);
  if (!response.ok) {
    const code = typeof body?.error?.code === "string" ? body.error.code : "recognition_failed";
    throw new TradeRecognitionError(code);
  }
  return validateResult(body, captures.map((capture) => capture.metadata.captureId), batchId);
}
