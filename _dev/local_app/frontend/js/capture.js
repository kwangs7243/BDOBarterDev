const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_BATCH_FRAMES = 100;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class CaptureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
  }
}

function equalPrefix(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

function readFormat(bytes) {
  if (bytes.length >= PNG_SIGNATURE.length && equalPrefix(bytes, PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (String.fromCharCode(...bytes.subarray(0, 6)) === "GIF87a" || String.fromCharCode(...bytes.subarray(0, 6)) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  throw new CaptureError("invalid_image", "선택한 파일이 지원되는 이미지가 아닙니다.");
}

function isAnimatedPng(bytes) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    if (offset + 12 + length > bytes.length) return false;
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (name === "acTL") return true;
    offset += 12 + length;
    if (name === "IEND") break;
  }
  return false;
}

function isAnimatedGif(bytes) {
  if (bytes.length < 13) return false;
  let offset = 13;
  const packed = bytes[10];
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (offset >= bytes.length) break;
      offset += 1;
      while (offset < bytes.length) {
        const size = bytes[offset++];
        if (size === 0) break;
        offset += size;
      }
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) break;
    frames += 1;
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
    if (offset >= bytes.length) break;
    offset += 1;
    while (offset < bytes.length) {
      const size = bytes[offset++];
      if (size === 0) break;
      offset += size;
    }
    if (frames > 1) return true;
  }
  return false;
}

function isAnimatedWebp(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const end = offset + 8 + size;
    if (end > bytes.length) return false;
    if (name === "ANIM" || name === "ANMF") return true;
    if (name === "VP8X" && size > 0 && (bytes[offset + 8] & 0x02)) return true;
    offset = end + (size & 1);
  }
  return false;
}

function isAnimated(format, bytes) {
  if (format === "image/png") return isAnimatedPng(bytes);
  if (format === "image/gif") return isAnimatedGif(bytes);
  if (format === "image/webp") return isAnimatedWebp(bytes);
  return false;
}

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new CaptureError("uuid_unavailable", "안전한 capture ID를 생성할 수 없습니다.");
}

async function defaultDecode(blob) {
  if (typeof createImageBitmap !== "function") throw new CaptureError("decode_unavailable", "이 브라우저에서 이미지 확인을 시작할 수 없습니다.");
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new CaptureError("invalid_image", "이미지를 열 수 없습니다.");
  }
}

async function defaultEncodePng(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  try {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new CaptureError("canvas_unavailable", "이미지를 PNG로 준비할 수 없습니다.");
    context.drawImage(bitmap, 0, 0);
    const result = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new CaptureError("encode_failed", "이미지를 PNG로 준비할 수 없습니다.")), "image/png"));
    return result;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function defaultHash(blob) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeContext(context) {
  if (!context || !["warehouse", "trade"].includes(context.taskType)) {
    throw new CaptureError("inactive_context", "이미지 입력 대상을 먼저 선택해 주세요.");
  }
  const safeInteger = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  return {
    taskType: context.taskType,
    baseRevision: safeInteger(context.baseRevision),
    sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
    sessionRevision: context.sessionRevision == null ? null : safeInteger(context.sessionRevision),
    profileId: typeof context.profileId === "string" ? context.profileId : null,
    profileVersion: safeInteger(context.profileVersion, 1) || 1,
  };
}

export async function captureFromFile(file, context, adapters = {}) {
  return captureBlob(file, context, "file", null, adapters);
}

async function captureBlob(blob, rawContext, sourceType, batchId, adapters) {
  if (!blob || typeof blob.size !== "number" || typeof blob.arrayBuffer !== "function") {
    throw new CaptureError("invalid_file", "이미지 파일을 읽을 수 없습니다.");
  }
  if (blob.size === 0) throw new CaptureError("empty_image", "빈 이미지 파일은 사용할 수 없습니다.");
  if (blob.size > MAX_IMAGE_BYTES) throw new CaptureError("image_too_large", "이미지는 20 MiB 이하여야 합니다.");

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sourceFormat = readFormat(bytes);
  if (isAnimated(sourceFormat, bytes)) throw new CaptureError("animated_image", "움직이는 이미지는 아직 입력할 수 없습니다.");
  const decode = adapters.decode ?? defaultDecode;
  const encodePng = adapters.encodePng ?? defaultEncodePng;
  let bitmap;
  let outputBlob;
  let reencoded = false;
  try {
    try {
      bitmap = await decode(blob, { orientation: "from-image" });
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      throw new CaptureError("invalid_image", "이미지를 열 수 없습니다.");
    }
    const width = Number(bitmap?.width);
    const height = Number(bitmap?.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new CaptureError("invalid_dimensions", "이미지 크기를 확인할 수 없습니다.");
    }
    if (width * height > MAX_IMAGE_PIXELS) throw new CaptureError("image_too_large", "이미지는 32메가픽셀 이하여야 합니다.");
    if (sourceFormat === "image/png") {
      outputBlob = new Blob([bytes], { type: "image/png" });
    } else {
      try {
        outputBlob = await encodePng(bitmap);
      } catch (error) {
        if (error instanceof CaptureError) throw error;
        throw new CaptureError("encode_failed", "이미지를 PNG로 준비할 수 없습니다.");
      }
      if (!(outputBlob instanceof Blob) || outputBlob.type.toLowerCase() !== "image/png" || outputBlob.size === 0 || outputBlob.size > MAX_IMAGE_BYTES) {
        throw new CaptureError("encode_failed", "이미지를 제한된 PNG로 준비하지 못했습니다.");
      }
      reencoded = true;
    }
    const normalizedContext = normalizeContext(rawContext);
    const now = adapters.now?.() ?? new Date().toISOString();
    const uuid = adapters.uuid ?? defaultUuid;
    const metadata = {
      version: 1,
      captureId: uuid(),
      batchId,
      taskType: normalizedContext.taskType,
      sourceType,
      capturedAt: now,
      frame: { width, height },
      fidelity: {
        sourceWidth: sourceType === "file" ? width : null,
        sourceHeight: sourceType === "file" ? height : null,
        rescaled: sourceType === "file" ? false : null,
        evidence: sourceType === "file" ? "file-metadata" : "unknown",
      },
      profileId: normalizedContext.profileId,
      profileVersion: normalizedContext.profileVersion,
      context: {
        baseRevision: normalizedContext.baseRevision,
        sessionId: normalizedContext.sessionId,
        sessionRevision: normalizedContext.sessionRevision,
      },
      observed: {
        browserDpr: Number.isFinite(globalThis.devicePixelRatio) && globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : null,
        windowsDpi: null,
        gameResolution: null,
        gameUiScale: null,
      },
    };
    const hash = adapters.hash ?? defaultHash;
    return {
      metadata,
      blob: outputBlob,
      sha256: await hash(outputBlob),
      sourceSha256: await hash(blob),
      reencoded,
      sourceBytes: blob.size,
      bytes: outputBlob.size,
    };
  } finally {
    bitmap?.close?.();
    bitmap = null;
  }
}

export async function captureFromPaste(event, context, adapters = {}) {
  const images = [...(event?.clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file" && String(item.type ?? "").toLowerCase().startsWith("image/"))
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
  if (!context || !images.length) return { handled: false, inputs: [] };
  event.preventDefault?.();
  if (images.length > MAX_BATCH_FRAMES) {
    throw new CaptureError("batch_too_large", `한 번에 최대 ${MAX_BATCH_FRAMES}개 이미지까지 입력할 수 있습니다.`);
  }
  const totalBytes = images.reduce((sum, image) => sum + image.size, 0);
  if (totalBytes > MAX_BATCH_BYTES) throw new CaptureError("batch_bytes_exceeded", "한 번의 이미지 묶음은 원본 기준 20 MiB 이하여야 합니다.");
  const batchId = (adapters.uuid ?? defaultUuid)();
  const inputs = [];
  for (const image of images) {
    inputs.push(await captureBlob(image, context, "clipboard", batchId, adapters));
  }
  return { handled: true, inputs };
}

export function isEditableTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
}

export class CaptureQueue {
  #items = [];

  get items() { return [...this.#items]; }
  get length() { return this.#items.length; }
  get bytes() { return this.#items.reduce((sum, item) => sum + item.bytes, 0); }

  append(inputs) {
    if (!Array.isArray(inputs) || this.#items.length + inputs.length > MAX_BATCH_FRAMES) {
      throw new CaptureError("queue_full", `대기 이미지는 최대 ${MAX_BATCH_FRAMES}개입니다. 기존 대기는 유지했습니다.`);
    }
    const incomingBytes = inputs.reduce((sum, item) => sum + item.bytes, 0);
    if (this.bytes + incomingBytes > MAX_BATCH_BYTES) {
      throw new CaptureError("queue_bytes_exceeded", "대기 이미지의 전체 용량은 20 MiB 이하여야 합니다. 기존 대기는 유지했습니다.");
    }
    this.#items.push(...inputs);
    return this.items;
  }

  remove(captureId) {
    const before = this.#items.length;
    this.#items = this.#items.filter((item) => item.metadata.captureId !== captureId);
    return this.#items.length !== before;
  }

  clear() { this.#items = []; }
}

export class PreviewRegistry {
  #urls = new Set();
  #urlApi;

  constructor(urlApi = URL) { this.#urlApi = urlApi; }
  create(blob) {
    const url = this.#urlApi.createObjectURL(blob);
    this.#urls.add(url);
    return url;
  }
  revoke(url) {
    if (!this.#urls.delete(url)) return false;
    this.#urlApi.revokeObjectURL(url);
    return true;
  }
  clear() {
    for (const url of this.#urls) this.#urlApi.revokeObjectURL(url);
    this.#urls.clear();
  }
  get size() { return this.#urls.size; }
}

export const captureLimits = Object.freeze({ MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_BATCH_FRAMES, MAX_BATCH_BYTES });
