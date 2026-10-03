const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_BATCH_FRAMES = 100;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
export const DEFAULT_TRADE_ROI = Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });

export function normalizeRegion(region) {
  const values = [region?.x, region?.y, region?.width, region?.height].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0 || values[0] < 0 || values[1] < 0 || values[0] + values[2] > 1 || values[1] + values[3] > 1) {
    throw new CaptureError("invalid_capture_region", "캡처 영역이 올바른 화면 범위가 아닙니다.");
  }
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

export function regionToSourceRect(region, frameWidth, frameHeight) {
  const normalized = normalizeRegion(region);
  if (!Number.isSafeInteger(frameWidth) || !Number.isSafeInteger(frameHeight) || frameWidth < 1 || frameHeight < 1) {
    throw new CaptureError("screen_frame_unavailable", "화면 크기를 확인할 수 없습니다.");
  }
  const x = Math.max(0, Math.min(frameWidth, Math.floor(normalized.x * frameWidth)));
  const y = Math.max(0, Math.min(frameHeight, Math.floor(normalized.y * frameHeight)));
  const right = Math.max(x, Math.min(frameWidth, Math.ceil((normalized.x + normalized.width) * frameWidth)));
  const bottom = Math.max(y, Math.min(frameHeight, Math.ceil((normalized.y + normalized.height) * frameHeight)));
  const rect = { x, y, width: right - x, height: bottom - y };
  if (rect.width < 1 || rect.height < 1) throw new CaptureError("capture_region_too_small", "선택 영역이 너무 작습니다.");
  return rect;
}

export function displayedVideoContentRect(video, container = video) {
  const box = container.getBoundingClientRect();
  const left = box.left + (Number(container.clientLeft) || 0);
  const top = box.top + (Number(container.clientTop) || 0);
  const boxWidth = Number(container.clientWidth) || box.width;
  const boxHeight = Number(container.clientHeight) || box.height;
  const videoWidth = Number(video.videoWidth);
  const videoHeight = Number(video.videoHeight);
  if (!(boxWidth > 0 && boxHeight > 0 && videoWidth > 0 && videoHeight > 0)) return null;
  const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { left: left + (boxWidth - width) / 2, top: top + (boxHeight - height) / 2, width, height };
}

export function moveNormalizedRegion(region, dx, dy, minWidth, minHeight) {
  const current = normalizeRegion(region);
  const width = Math.max(minWidth, current.width);
  const height = Math.max(minHeight, current.height);
  return { ...current, x: Math.max(0, Math.min(1 - width, current.x + dx)), y: Math.max(0, Math.min(1 - height, current.y + dy)) };
}

export function resizeNormalizedRegion(region, handle, dx, dy, minWidth, minHeight) {
  const current = normalizeRegion(region);
  const west = handle.includes("w"); const east = handle.includes("e");
  const north = handle.includes("n"); const south = handle.includes("s");
  let left = current.x; let right = current.x + current.width;
  let top = current.y; let bottom = current.y + current.height;
  if (west) left = Math.max(0, Math.min(right - minWidth, left + dx));
  if (east) right = Math.min(1, Math.max(left + minWidth, right + dx));
  if (north) top = Math.max(0, Math.min(bottom - minHeight, top + dy));
  if (south) bottom = Math.min(1, Math.max(top + minHeight, bottom + dy));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

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

const SCREEN_DISCONNECT_REASONS = new Set(["user", "track-ended", "pagehide", "beforeunload", "connect-error", "capture-error"]);

export class ScreenCaptureSession {
  #mediaDevices;
  #document;
  #lifecycleTarget;
  #createVideo;
  #createCanvas;
  #now;
  #uuid;
  #frameTimeoutMs;
  #stream = null;
  #track = null;
  #video = null;
  #state = "IDLE";
  #reason = null;
  #generation = 0;
  #connectPromise = null;
  #capturing = false;
  #listeners = new Set();
  #previewElements = new Set();
  #onTrackEnded = () => this.disconnectScreen("track-ended");
  #onPageHide = () => this.disconnectScreen("pagehide");
  #onBeforeUnload = () => this.disconnectScreen("beforeunload");

  constructor(adapters = {}) {
    this.#mediaDevices = adapters.mediaDevices ?? globalThis.navigator?.mediaDevices;
    this.#document = adapters.document ?? globalThis.document;
    this.#lifecycleTarget = adapters.lifecycleTarget ?? globalThis.window;
    this.#createVideo = adapters.createVideo ?? (() => this.#document.createElement("video"));
    this.#createCanvas = adapters.createCanvas ?? (() => this.#document.createElement("canvas"));
    this.#now = adapters.now ?? (() => new Date());
    this.#uuid = adapters.uuid ?? defaultUuid;
    this.#frameTimeoutMs = adapters.frameTimeoutMs ?? 3000;
    this.#lifecycleTarget?.addEventListener?.("pagehide", this.#onPageHide);
    this.#lifecycleTarget?.addEventListener?.("beforeunload", this.#onBeforeUnload);
  }

  get state() { return this.#state; }
  get reason() { return this.#reason; }
  get connected() { return this.#state === "CONNECTED" || this.#state === "CAPTURING"; }

  attachPreview(videoElement) {
    if (!videoElement) throw new TypeError("videoElement is required");
    this.#previewElements.add(videoElement);
    videoElement.muted = true;
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    if (this.connected && this.#stream) {
      if (videoElement.srcObject !== this.#stream) {
        videoElement.srcObject = this.#stream;
        try { void videoElement.play?.().catch?.(() => {}); } catch {}
      }
      return true;
    }
    videoElement.srcObject = null;
    return false;
  }

  detachPreview(videoElement) {
    this.#previewElements.delete(videoElement);
    if (videoElement) {
      try { videoElement.pause?.(); } catch {}
      videoElement.srcObject = null;
    }
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(state, reason = null) {
    this.#state = state;
    this.#reason = reason;
    const snapshot = { state, reason };
    for (const listener of this.#listeners) listener(snapshot);
  }

  connectScreen() {
    if (this.#state === "CONNECTED") return Promise.resolve(this.#stream);
    if (this.#state === "CAPTURING") return Promise.reject(new CaptureError("capture_in_progress", "화면 캡처가 끝난 뒤 다시 연결해 주세요."));
    if (this.#connectPromise) return this.#connectPromise;
    if (typeof this.#mediaDevices?.getDisplayMedia !== "function") {
      this.#setState("DISCONNECTED", "unsupported");
      return Promise.reject(new CaptureError("screen_unsupported", "이 브라우저는 화면 공유를 지원하지 않습니다."));
    }

    this.#setState("CONNECTING");
    const generation = this.#generation;
    let request;
    try {
      // This call stays synchronous in connectScreen so its caller can invoke it directly from a user click.
      request = this.#mediaDevices.getDisplayMedia({ video: { displaySurface: "window" }, audio: false });
    } catch (error) {
      this.#setState("DISCONNECTED", error?.name === "NotAllowedError" ? "permission-denied" : "connect-error");
      return Promise.reject(error);
    }

    this.#connectPromise = Promise.resolve(request).then(async (stream) => {
      if (generation !== this.#generation) {
        for (const track of stream?.getTracks?.() ?? []) track.stop?.();
        throw new CaptureError("screen_disconnected", "화면 연결 요청이 종료되었습니다. 다시 연결해 주세요.");
      }
      const tracks = stream?.getTracks?.() ?? [];
      const videoTracks = tracks.filter((track) => track.kind === "video");
      const audioTracks = tracks.filter((track) => track.kind === "audio");
      if (audioTracks.length) {
        for (const track of tracks) track.stop?.();
        throw new CaptureError("audio_track_unexpected", "화면 연결에서 오디오 트랙이 감지되어 연결을 종료했습니다.");
      }
      const track = videoTracks[0];
      if (!track || track.readyState !== "live") {
        for (const item of tracks) item.stop?.();
        throw new CaptureError("screen_unavailable", "사용 가능한 화면 트랙을 얻지 못했습니다. 화면 연결을 다시 시작해 주세요.");
      }

      this.#stream = stream;
      this.#track = track;
      for (const preview of this.#previewElements) {
        preview.muted = true;
        preview.autoplay = true;
        preview.playsInline = true;
        preview.srcObject = stream;
        try { void preview.play?.().catch?.(() => {}); } catch {}
      }
      const video = this.#createVideo();
      this.#video = video;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute?.("aria-hidden", "true");
      if (video.style) {
        video.style.position = "fixed";
        video.style.width = "1px";
        video.style.height = "1px";
        video.style.opacity = "0";
        video.style.pointerEvents = "none";
      }
      video.srcObject = stream;
      this.#document?.body?.append?.(video);
      track.addEventListener?.("ended", this.#onTrackEnded);
      await video.play?.();
      if (generation !== this.#generation || track.readyState !== "live") {
        throw new CaptureError("screen_disconnected", "화면 연결이 종료되었습니다. 다시 연결해 주세요.");
      }
      this.#setState("CONNECTED");
      return stream;
    }).catch((error) => {
      if (generation === this.#generation) {
        this.#clearStream();
        this.#setState("DISCONNECTED", error?.name === "NotAllowedError" ? "permission-denied" : "connect-error");
      }
      throw error;
    }).finally(() => { this.#connectPromise = null; });
    return this.#connectPromise;
  }

  async captureFrame(context) {
    if (this.#state !== "CONNECTED" || !this.#stream || !this.#track || !this.#video) {
      throw new CaptureError("screen_not_connected", "먼저 화면 연결을 시작해 주세요.");
    }
    if (this.#capturing) throw new CaptureError("capture_in_progress", "화면 캡처가 진행 중입니다.");
    const normalizedContext = normalizeContext(context);
    this.#capturing = true;
    this.#setState("CAPTURING");
    const startedAt = performance.now();
    let canvas;
    try {
      const video = this.#video;
      const track = this.#track;
      if (track.readyState !== "live") throw new CaptureError("screen_unavailable", "화면 공유가 종료되었습니다. 다시 연결해 주세요.");
      const readiness = await this.#waitForFrame(video, track);
      if (this.#state !== "CAPTURING" || track.readyState !== "live") throw new CaptureError("screen_unavailable", "화면 공유가 종료되었습니다. 다시 연결해 주세요.");
      const width = Number(video.videoWidth);
      const height = Number(video.videoHeight);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw new CaptureError("screen_frame_unavailable", "화면 크기를 확인할 수 없습니다. 공유 상태를 확인해 주세요.");
      }
      if (width * height > MAX_IMAGE_PIXELS) throw new CaptureError("image_too_large", "화면 프레임이 32메가픽셀 제한을 초과합니다.");

      canvas = this.#createCanvas();
      canvas.width = width;
      canvas.height = height;
      const context2d = canvas.getContext("2d", { alpha: true });
      if (!context2d) throw new CaptureError("canvas_unavailable", "화면 프레임을 준비할 수 없습니다.");
      context2d.drawImage(video, 0, 0, width, height);
      if (Number(video.videoWidth) !== width || Number(video.videoHeight) !== height) {
        throw new CaptureError("STREAM_RESIZING", "공유 화면 크기가 바뀌는 중입니다. 잠시 후 다시 캡처해 주세요.");
      }
      const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new CaptureError("encode_failed", "화면 프레임을 PNG로 만들지 못했습니다.")), "image/png"));
      if (Number(video.videoWidth) !== width || Number(video.videoHeight) !== height) {
        throw new CaptureError("STREAM_RESIZING", "공유 화면 크기가 바뀌는 중입니다. 잠시 후 다시 캡처해 주세요.");
      }
      if (!(blob instanceof Blob) || blob.type.toLowerCase() !== "image/png" || blob.size < 1 || blob.size > MAX_IMAGE_BYTES) {
        throw new CaptureError("screen_frame_invalid", "화면 프레임을 제한된 PNG로 준비하지 못했습니다.");
      }

      const settings = (() => { try { return track.getSettings?.() ?? {}; } catch { return {}; } })();
      const sourceWidth = Number.isSafeInteger(settings.width) && settings.width > 0 ? settings.width : null;
      const sourceHeight = Number.isSafeInteger(settings.height) && settings.height > 0 ? settings.height : null;
      const hasTrackDimensions = sourceWidth !== null && sourceHeight !== null;
      const fidelity = {
        sourceWidth: hasTrackDimensions ? sourceWidth : null,
        sourceHeight: hasTrackDimensions ? sourceHeight : null,
        rescaled: hasTrackDimensions ? sourceWidth !== width || sourceHeight !== height : null,
        evidence: hasTrackDimensions ? "track-settings" : "unknown",
      };
      const capturedAt = this.#now();
      const capturedAtIso = capturedAt instanceof Date ? capturedAt.toISOString() : new Date(capturedAt).toISOString();
      const metadata = {
        version: 1,
        captureId: this.#uuid(),
        batchId: null,
        taskType: normalizedContext.taskType,
        sourceType: "browser-stream",
        capturedAt: capturedAtIso,
        frame: { width, height },
        fidelity,
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
      return {
        metadata,
        blob,
        sha256: await defaultHash(blob),
        sourceSha256: null,
        reencoded: false,
        sourceBytes: null,
        bytes: blob.size,
        observation: {
          freshnessEvidence: readiness.evidence,
          mediaTime: readiness.mediaTime,
          presentedFrames: readiness.presentedFrames,
          elapsedMs: Math.max(0, performance.now() - startedAt),
        },
      };
    } catch (error) {
      if (this.#state === "CAPTURING" && this.#track?.readyState === "live") this.#setState("CONNECTED");
      else if (this.#state === "CAPTURING") this.disconnectScreen("capture-error");
      throw error;
    } finally {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      this.#capturing = false;
      if (this.#state === "CAPTURING") this.#setState("CONNECTED");
    }
  }

  async captureRegion(context, region, batchId = null) {
    if (this.#state !== "CONNECTED" || !this.#stream || !this.#track || !this.#video) {
      throw new CaptureError("screen_not_connected", "먼저 화면 연결을 시작해 주세요.");
    }
    if (this.#capturing) throw new CaptureError("capture_in_progress", "화면 캡처가 진행 중입니다.");
    const normalizedContext = normalizeContext(context);
    const normalizedRegion = normalizeRegion(region);
    this.#capturing = true;
    this.#setState("CAPTURING");
    const startedAt = performance.now();
    let canvas;
    try {
      const video = this.#video;
      const track = this.#track;
      if (track.readyState !== "live") throw new CaptureError("screen_unavailable", "화면 공유가 종료되었습니다. 다시 연결해 주세요.");
      const readiness = await this.#waitForFrame(video, track);
      if (this.#state !== "CAPTURING" || track.readyState !== "live") throw new CaptureError("screen_unavailable", "화면 공유가 종료되었습니다. 다시 연결해 주세요.");
      const frameWidth = Number(video.videoWidth); const frameHeight = Number(video.videoHeight);
      const sourceRect = regionToSourceRect(normalizedRegion, frameWidth, frameHeight);
      if (sourceRect.width < 8 || sourceRect.height < 8) throw new CaptureError("capture_region_too_small", "선택 영역이 너무 작습니다.");
      if (sourceRect.width * sourceRect.height > MAX_IMAGE_PIXELS) throw new CaptureError("image_too_large", "선택 영역이 32메가픽셀 제한을 초과합니다.");
      canvas = this.#createCanvas(); canvas.width = sourceRect.width; canvas.height = sourceRect.height;
      const context2d = canvas.getContext("2d", { alpha: true });
      if (!context2d) throw new CaptureError("canvas_unavailable", "선택 영역을 준비할 수 없습니다.");
      context2d.drawImage(video, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, sourceRect.width, sourceRect.height);
      if (Number(video.videoWidth) !== frameWidth || Number(video.videoHeight) !== frameHeight) throw new CaptureError("STREAM_RESIZING", "공유 화면 크기가 바뀌는 중입니다. 잠시 후 다시 캡처해 주세요.");
      const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new CaptureError("encode_failed", "선택 영역을 PNG로 만들지 못했습니다.")), "image/png"));
      if (Number(video.videoWidth) !== frameWidth || Number(video.videoHeight) !== frameHeight) throw new CaptureError("STREAM_RESIZING", "공유 화면 크기가 바뀌는 중입니다. 잠시 후 다시 캡처해 주세요.");
      if (!(blob instanceof Blob) || blob.type.toLowerCase() !== "image/png" || blob.size < 1 || blob.size > MAX_IMAGE_BYTES) throw new CaptureError("screen_frame_invalid", "선택 영역을 제한된 PNG로 준비하지 못했습니다.");
      const settings = (() => { try { return track.getSettings?.() ?? {}; } catch { return {}; } })();
      const sourceWidth = Number.isSafeInteger(settings.width) && settings.width > 0 ? settings.width : null;
      const sourceHeight = Number.isSafeInteger(settings.height) && settings.height > 0 ? settings.height : null;
      const hasTrackDimensions = sourceWidth !== null && sourceHeight !== null;
      const capturedAt = this.#now();
      const capturedAtIso = capturedAt instanceof Date ? capturedAt.toISOString() : new Date(capturedAt).toISOString();
      const metadata = {
        version: 1, captureId: this.#uuid(), batchId, taskType: normalizedContext.taskType, sourceType: "browser-stream", capturedAt: capturedAtIso,
        frame: { width: sourceRect.width, height: sourceRect.height },
        fidelity: { sourceWidth: hasTrackDimensions ? sourceWidth : null, sourceHeight: hasTrackDimensions ? sourceHeight : null, rescaled: hasTrackDimensions ? sourceWidth !== frameWidth || sourceHeight !== frameHeight : null, evidence: hasTrackDimensions ? "track-settings" : "unknown" },
        profileId: normalizedContext.profileId, profileVersion: normalizedContext.profileVersion,
        context: { baseRevision: normalizedContext.baseRevision, sessionId: normalizedContext.sessionId, sessionRevision: normalizedContext.sessionRevision },
        observed: { browserDpr: Number.isFinite(globalThis.devicePixelRatio) && globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : null, windowsDpi: null, gameResolution: null, gameUiScale: null },
      };
      return {
        metadata, blob, sha256: await defaultHash(blob), sourceSha256: null, reencoded: false, sourceBytes: null, bytes: blob.size,
        regionEvidence: { normalized: normalizedRegion, sourceRect, sourceFrame: { width: frameWidth, height: frameHeight } },
        observation: { freshnessEvidence: readiness.evidence, mediaTime: readiness.mediaTime, presentedFrames: readiness.presentedFrames, elapsedMs: Math.max(0, performance.now() - startedAt) },
      };
    } catch (error) {
      if (this.#state === "CAPTURING" && this.#track?.readyState === "live") this.#setState("CONNECTED");
      else if (this.#state === "CAPTURING") this.disconnectScreen("capture-error");
      throw error;
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      this.#capturing = false;
      if (this.#state === "CAPTURING") this.#setState("CONNECTED");
    }
  }

  #waitForFrame(video, track) {
    const haveCurrentData = Number(globalThis.HTMLMediaElement?.HAVE_CURRENT_DATA ?? 2);
    if (track.readyState !== "live" || video.readyState < haveCurrentData || video.paused || video.videoWidth < 1 || video.videoHeight < 1) {
      return Promise.reject(new CaptureError("screen_frame_unavailable", "공유 화면 프레임이 준비되지 않았습니다. 화면 연결 상태를 확인해 주세요."));
    }
    if (typeof video.requestVideoFrameCallback !== "function") {
      if (track.muted && video.readyState < haveCurrentData) return Promise.reject(new CaptureError("screen_frame_unavailable", "화면 트랙이 일시 중지되어 사용할 프레임이 없습니다."));
      return Promise.resolve({ evidence: "video-state", mediaTime: null, presentedFrames: null });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let callbackId;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error && callbackId != null) video.cancelVideoFrameCallback?.(callbackId);
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(() => finish(new CaptureError("screen_frame_stale", "새 화면 프레임을 확인하지 못했습니다. 다시 시도해 주세요.")), this.#frameTimeoutMs);
      try {
        callbackId = video.requestVideoFrameCallback((_now, metadata = {}) => {
          if (track.readyState !== "live") return finish(new CaptureError("screen_unavailable", "화면 공유가 종료되었습니다."));
          finish(null, {
            evidence: "request-video-frame-callback",
            mediaTime: Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : null,
            presentedFrames: Number.isSafeInteger(metadata.presentedFrames) ? metadata.presentedFrames : null,
          });
        });
      } catch {
        finish(new CaptureError("screen_frame_unavailable", "화면 프레임 확인을 시작하지 못했습니다."));
      }
      if (settled && callbackId != null) video.cancelVideoFrameCallback?.(callbackId);
    });
  }

  #clearStream() {
    const stream = this.#stream;
    const video = this.#video;
    this.#track?.removeEventListener?.("ended", this.#onTrackEnded);
    this.#stream = null;
    this.#track = null;
    this.#video = null;
    for (const preview of this.#previewElements) {
      try { preview.pause?.(); } catch {}
      preview.srcObject = null;
    }
    if (video) {
      try { video.pause?.(); } catch {}
      video.srcObject = null;
      video.remove?.();
    }
    for (const track of stream?.getTracks?.() ?? []) {
      try { track.stop?.(); } catch {}
    }
  }

  disconnectScreen(reason = "user") {
    const safeReason = SCREEN_DISCONNECT_REASONS.has(reason) ? reason : "user";
    this.#generation += 1;
    this.#clearStream();
    this.#setState("DISCONNECTED", safeReason);
    return true;
  }
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
