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

export async function recognizeTradeLiveList(captures) {
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
    response = await fetch("/api/recognition/trade-live-list", { method: "POST", credentials: "same-origin", body: form });
  } catch {
    throw new TradeRecognitionError("network_error");
  }
  const body = await responseJson(response);
  if (!response.ok) {
    const code = typeof body?.error?.code === "string" ? body.error.code : "recognition_failed";
    throw new TradeRecognitionError(code, undefined, { ...body?.diagnostics, httpStatus: response.status, backendCode: code, backendMessage: body?.error?.message });
  }
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


export async function saveTradeCorrections(captures, result, corrections, feedbackId) {
  const ids = new Set(corrections.map((row) => row.captureId));
  const selected = captures.filter((capture) => ids.has(capture.metadata.captureId));
  const feedback = { version: 1, feedbackId,
    engineId: result.runtime.engineId, modelVersion: result.runtime.modelBundleSha256,
    workerVersion: result.runtime.workerVersion,
    captures: selected.map((capture) => ({ captureId: capture.metadata.captureId, metadata: capture.metadata })),
    corrections };
  const form = new FormData();
  form.append("feedback", JSON.stringify(feedback));
  selected.forEach((capture, i) => form.append("image", capture.blob, `capture-${i + 1}.png`));
  const response = await fetch("/api/recognition/trade-corrections", { method: "POST", credentials: "same-origin", body: form });
  const body = await responseJson(response);
  if (!response.ok || body?.ok !== true) throw new Error("수정 기록을 저장하지 못했습니다. 입력값을 유지했으니 다시 확인해 주세요.");
}
