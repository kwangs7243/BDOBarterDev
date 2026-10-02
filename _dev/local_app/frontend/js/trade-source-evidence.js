const FIELDS = ["island", "fromItem", "reqAmount", "toItem", "count", "yield"];
const NUMERIC_FIELDS = new Set(["reqAmount", "count", "yield"]);
const SNAPSHOT_KEYS = ["schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"];
const CAPTURE_KEYS = ["captureId", "captureOrdinal", "imageSha256", "bitmapSha256", "sourceType", "frame",
  "sourceFidelity", "reencoded", "completeRowCount"];
const ROW_KEYS = ["sourceRowId", "captureId", "ordinal", "rowBox", "fields"];
const FIELD_KEYS = ["field", "rawText", "rawNumeric", "readerStatus", "confidence", "cropRefs"];
const CROP_KEYS = ["cropRefId", "sourceRowId", "captureId", "field", "bitmapSha256", "frame",
  "coordinateSpace", "box", "pixelHashBasis", "pixelSha256", "pngArtifactSha256"];
const EDGE_KEYS = ["edgeId", "captureId", "ordinal", "reason", "rowBox", "sourceRefs"];
const SOURCE_REF_KEYS = ["sourceRowId", "captureId", "ordinal"];
const SHA256 = /^[0-9a-f]{64}$/;

export class TradeSourceEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "TradeSourceEvidenceError";
    this.code = code;
  }
}

function fail(code) { throw new TradeSourceEvidenceError(code); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sameKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function nonempty(value) { return typeof value === "string" && value.length > 0 && value.trim() === value; }
function validHash(value) { return typeof value === "string" && SHA256.test(value); }
function validFrame(value) {
  return isRecord(value) && sameKeys(value, ["width", "height"])
    && Number.isSafeInteger(value.width) && value.width > 0
    && Number.isSafeInteger(value.height) && value.height > 0;
}
function sameFrame(left, right) { return left?.width === right?.width && left?.height === right?.height; }
function validBox(value, frame) {
  return isRecord(value) && sameKeys(value, ["x", "y", "width", "height"])
    && Number.isSafeInteger(value.x) && value.x >= 0
    && Number.isSafeInteger(value.y) && value.y >= 0
    && Number.isSafeInteger(value.width) && value.width > 0
    && Number.isSafeInteger(value.height) && value.height > 0
    && value.x + value.width <= frame.width && value.y + value.height <= frame.height;
}
function validSourceFidelity(value) {
  if (!isRecord(value) || !sameKeys(value, ["sourceWidth", "sourceHeight", "rescaled", "evidence"])) return false;
  if (value.sourceWidth === null && value.sourceHeight === null && value.rescaled === null && value.evidence === "unknown") return true;
  return Number.isSafeInteger(value.sourceWidth) && value.sourceWidth > 0
    && Number.isSafeInteger(value.sourceHeight) && value.sourceHeight > 0
    && typeof value.rescaled === "boolean" && nonempty(value.evidence) && value.evidence !== "unknown";
}
function validPortableId(value) { return nonempty(value) && value.length <= 128; }
function hasPngSignature(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function validateRawEvidence(rawEvidence) {
  if (!sameKeys(rawEvidence, SNAPSHOT_KEYS) || rawEvidence.schemaVersion !== 2
      || !nonempty(rawEvidence.recognitionBatchId) || !Array.isArray(rawEvidence.captures)
      || rawEvidence.captures.length < 1 || !Array.isArray(rawEvidence.sourceRows)
      || !Array.isArray(rawEvidence.edgeSegments)) fail("INVALID_RAW_EVIDENCE");

  const captures = new Map();
  const captureOrder = [];
  rawEvidence.captures.forEach((capture, index) => {
    if (!sameKeys(capture, CAPTURE_KEYS) || !validPortableId(capture.captureId)
        || captures.has(capture.captureId) || capture.captureOrdinal !== index + 1
        || !validHash(capture.imageSha256) || !validHash(capture.bitmapSha256)
        || !["FILE", "CLIPBOARD", "STREAM"].includes(capture.sourceType)
        || !validFrame(capture.frame) || !validSourceFidelity(capture.sourceFidelity)
        || typeof capture.reencoded !== "boolean" || !Number.isSafeInteger(capture.completeRowCount)
        || capture.completeRowCount < 0) fail("INVALID_RAW_EVIDENCE");
    captures.set(capture.captureId, capture);
    captureOrder.push(capture.captureId);
  });

  const sourceRows = new Map();
  const sourceOrder = [];
  const sourceOrdinals = new Map(captureOrder.map((captureId) => [captureId, new Set()]));
  const rowCounts = new Map(captureOrder.map((captureId) => [captureId, 0]));
  let previousPosition = [-1, -1];
  const crops = new Map();
  const invalidCropIds = new Set();
  rawEvidence.sourceRows.forEach((row) => {
    if (!sameKeys(row, ROW_KEYS) || !validPortableId(row.sourceRowId) || sourceRows.has(row.sourceRowId)
        || captures.has(row.sourceRowId) || !captures.has(row.captureId)
        || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0
        || sourceOrdinals.get(row.captureId).has(row.ordinal)
        || !(row.rowBox === null || validBox(row.rowBox, captures.get(row.captureId).frame))
        || !Array.isArray(row.fields) || row.fields.length !== FIELDS.length) fail("INVALID_RAW_EVIDENCE");
    const captureOrdinal = captures.get(row.captureId).captureOrdinal;
    const position = [captureOrdinal, row.ordinal];
    if (position[0] < previousPosition[0] || position[0] === previousPosition[0] && position[1] < previousPosition[1]) {
      fail("INVALID_RAW_EVIDENCE");
    }
    previousPosition = position;
    sourceOrdinals.get(row.captureId).add(row.ordinal);
    rowCounts.set(row.captureId, rowCounts.get(row.captureId) + 1);
    sourceRows.set(row.sourceRowId, row);
    sourceOrder.push(row.sourceRowId);

    row.fields.forEach((field, fieldIndex) => {
      if (!sameKeys(field, FIELD_KEYS) || field.field !== FIELDS[fieldIndex]
          || field.rawText !== null && typeof field.rawText !== "string"
          || field.rawNumeric !== null && !Number.isSafeInteger(field.rawNumeric)
          || !NUMERIC_FIELDS.has(field.field) && field.rawNumeric !== null
          || !nonempty(field.readerStatus)
          || field.confidence !== null && typeof field.confidence !== "string"
          || !Array.isArray(field.cropRefs) || field.cropRefs.length > 1) fail("INVALID_RAW_EVIDENCE");
      field.cropRefs.forEach((cropRef) => {
        if (!sameKeys(cropRef, CROP_KEYS) || !validPortableId(cropRef.cropRefId) || crops.has(cropRef.cropRefId)) {
          fail("INVALID_RAW_EVIDENCE");
        }
        const parentCapture = captures.get(row.captureId);
        const ownerIsValid = cropRef.sourceRowId === row.sourceRowId && cropRef.captureId === row.captureId
          && cropRef.field === field.field;
        const cropIsValid = ownerIsValid && validHash(cropRef.bitmapSha256)
          && cropRef.bitmapSha256 === parentCapture.bitmapSha256
          && validFrame(cropRef.frame) && sameFrame(cropRef.frame, parentCapture.frame)
          && cropRef.coordinateSpace === "CAPTURE_BITMAP_PIXELS"
          && cropRef.pixelHashBasis === "RGB8_ROW_MAJOR_V1"
          && validHash(cropRef.pixelSha256)
          && (cropRef.pngArtifactSha256 === null || validHash(cropRef.pngArtifactSha256))
          && validBox(cropRef.box, parentCapture.frame);
        crops.set(cropRef.cropRefId, { capture: parentCapture, sourceRow: row, field, cropRef });
        if (!cropIsValid) invalidCropIds.add(cropRef.cropRefId);
      });
    });
  });

  const edgeIds = new Set();
  const edgeOrdinals = new Map(captureOrder.map((captureId) => [captureId, new Set()]));
  rawEvidence.edgeSegments.forEach((edge) => {
    if (!sameKeys(edge, EDGE_KEYS) || !validPortableId(edge.edgeId) || edgeIds.has(edge.edgeId)
        || captures.has(edge.edgeId) || sourceRows.has(edge.edgeId) || !captures.has(edge.captureId)
        || !Number.isSafeInteger(edge.ordinal) || edge.ordinal < 0
        || edgeOrdinals.get(edge.captureId).has(edge.ordinal) || !nonempty(edge.reason)
        || !validBox(edge.rowBox, captures.get(edge.captureId).frame)
        || !Array.isArray(edge.sourceRefs) || edge.sourceRefs.length !== 1
        || !sameKeys(edge.sourceRefs[0], SOURCE_REF_KEYS)
        || edge.sourceRefs[0].sourceRowId !== edge.edgeId
        || edge.sourceRefs[0].captureId !== edge.captureId || edge.sourceRefs[0].ordinal !== edge.ordinal) {
      fail("INVALID_RAW_EVIDENCE");
    }
    edgeIds.add(edge.edgeId);
    edgeOrdinals.get(edge.captureId).add(edge.ordinal);
  });
  if (captureOrder.some((captureId) => rowCounts.get(captureId) !== captures.get(captureId).completeRowCount)) {
    fail("INVALID_RAW_EVIDENCE");
  }
  return { captures, sourceRows, sourceOrder, captureOrder, crops, invalidCropIds };
}

export function locateTradeCropRef(rawEvidence, cropRefId) {
  const validated = validateRawEvidence(rawEvidence);
  const found = validated.crops.get(cropRefId);
  if (!found) fail("CROP_REF_NOT_FOUND");
  return found;
}

export function projectTradeCropBoxToDisplay(cropRef, displayFrame) {
  if (!isRecord(cropRef) || !validFrame(cropRef.frame) || !validBox(cropRef.box, cropRef.frame)
      || cropRef.coordinateSpace !== "CAPTURE_BITMAP_PIXELS" || !validFrame(displayFrame)) {
    fail("INVALID_DISPLAY_GEOMETRY");
  }
  const scaleX = displayFrame.width / cropRef.frame.width;
  const scaleY = displayFrame.height / cropRef.frame.height;
  return {
    x: Math.round(cropRef.box.x * scaleX),
    y: Math.round(cropRef.box.y * scaleY),
    width: Math.round(cropRef.box.width * scaleX),
    height: Math.round(cropRef.box.height * scaleY),
  };
}

async function defaultSha256Bytes(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") fail("SHA256_UNAVAILABLE");
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function defaultDecodePngToRgba(blob) {
  if (typeof globalThis.createImageBitmap !== "function" || typeof document === "undefined") fail("PNG_DECODER_UNAVAILABLE");
  let bitmap;
  let canvas;
  try {
    bitmap = await globalThis.createImageBitmap(blob, {
      imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none",
    });
    canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true, alpha: true });
    if (!context) fail("PNG_DECODER_UNAVAILABLE");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, rgbaBytes: new Uint8Array(image.data) };
  } catch (error) {
    if (error instanceof TradeSourceEvidenceError) throw error;
    fail("PNG_DECODE_FAILED");
  } finally {
    bitmap?.close?.();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

async function defaultEncodeDisplayCrop({ width, height, rgbBytes }) {
  if (typeof document === "undefined") fail("PNG_ENCODER_UNAVAILABLE");
  const canvas = document.createElement("canvas");
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) fail("PNG_ENCODER_UNAVAILABLE");
    const image = context.createImageData(width, height);
    for (let pixel = 0, source = 0; pixel < width * height; pixel += 1, source += 3) {
      const target = pixel * 4;
      image.data[target] = rgbBytes[source];
      image.data[target + 1] = rgbBytes[source + 1];
      image.data[target + 2] = rgbBytes[source + 2];
      image.data[target + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => {
      if (value) resolve(value); else reject(new TradeSourceEvidenceError("PNG_ENCODE_FAILED"));
    }, "image/png"));
    if (blob.type.toLowerCase() !== "image/png") fail("PNG_ENCODE_FAILED");
    return blob;
  } catch (error) {
    if (error instanceof TradeSourceEvidenceError) throw error;
    fail("PNG_ENCODE_FAILED");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function rgbaToRgb(rgbaBytes, width, height) {
  if (rgbaBytes.length !== width * height * 4) fail("DECODED_PIXEL_LENGTH_INVALID");
  const rgbBytes = new Uint8Array(width * height * 3);
  for (let source = 0, target = 0; source < rgbaBytes.length; source += 4, target += 3) {
    if (rgbaBytes[source + 3] !== 255) fail("ALPHA_NOT_OPAQUE");
    rgbBytes[target] = rgbaBytes[source];
    rgbBytes[target + 1] = rgbaBytes[source + 1];
    rgbBytes[target + 2] = rgbaBytes[source + 2];
  }
  return rgbBytes;
}

function cropRgb(rgbBytes, frame, box) {
  const output = new Uint8Array(box.width * box.height * 3);
  for (let row = 0; row < box.height; row += 1) {
    const start = ((box.y + row) * frame.width + box.x) * 3;
    output.set(rgbBytes.subarray(start, start + box.width * 3), row * box.width * 3);
  }
  return output;
}

function errorCode(error, fallback = "SOURCE_EVIDENCE_INVALID") {
  return error instanceof TradeSourceEvidenceError ? error.code : fallback;
}

export function createTradeSourceEvidenceCache(adapters = {}) {
  const sha256Bytes = adapters.sha256Bytes ?? defaultSha256Bytes;
  const decodePngToRgba = adapters.decodePngToRgba ?? defaultDecodePngToRgba;
  const encodeDisplayCrop = adapters.encodeDisplayCrop ?? defaultEncodeDisplayCrop;
  const captures = new Map();
  let lastRawEvidence = null;
  let lastRawEvidenceSignature = null;
  let lastStateById = new Map();

  function inspectCapture(capture) {
    const metadata = capture?.metadata;
    const blob = capture?.blob;
    const captureId = metadata?.captureId;
    if (!validPortableId(captureId) || typeof blob?.arrayBuffer !== "function"
        || typeof blob.type !== "string" || blob.type.toLowerCase() !== "image/png"
        || !Number.isSafeInteger(blob.size) || blob.size < 1
        || !Number.isSafeInteger(capture.bytes) || capture.bytes !== blob.size
        || !validHash(capture.sha256) || capture.sourceSha256 !== null && !validHash(capture.sourceSha256)
        || !validFrame(metadata.frame) || !nonempty(metadata.sourceType)
        || !isRecord(metadata.fidelity)
        || !sameKeys(metadata.fidelity, ["sourceWidth", "sourceHeight", "rescaled", "evidence"])) fail("INVALID_CAPTURE_INPUT");
    const frame = { width: metadata.frame.width, height: metadata.frame.height };
    const sourceWidth = metadata.fidelity.sourceWidth;
    const sourceHeight = metadata.fidelity.sourceHeight;
    const unknownFidelity = sourceWidth === null && sourceHeight === null && metadata.fidelity.rescaled === null
      && metadata.fidelity.evidence === "unknown";
    const knownFidelity = Number.isSafeInteger(sourceWidth) && sourceWidth > 0
      && Number.isSafeInteger(sourceHeight) && sourceHeight > 0
      && (typeof metadata.fidelity.rescaled === "boolean" || metadata.fidelity.rescaled === null)
      && nonempty(metadata.fidelity.evidence);
    if (!unknownFidelity && !knownFidelity) fail("INVALID_CAPTURE_INPUT");
    const reencoded = capture.reencoded;
    if (typeof reencoded !== "boolean") fail("INVALID_CAPTURE_INPUT");
    return { captureId, blob, frame, reencoded, advertisedSha256: capture.sha256 };
  }

  function checkRetainBinding(candidate, existing) {
    const { captureId, blob, frame, reencoded, advertisedSha256 } = candidate;
    if (existing) {
      if (existing.state === "EXPIRED") fail("CAPTURE_ID_EXPIRED");
      if (existing.state === "INVALID") fail("CAPTURE_ID_INVALID");
      if (existing.blob !== blob || !sameFrame(existing.frame, frame)
          || existing.reencoded !== reencoded || existing.advertisedSha256 !== advertisedSha256) {
        fail("CAPTURE_ID_ALREADY_BOUND");
      }
    }
  }

  function retainCapture(capture) {
    const candidate = inspectCapture(capture);
    checkRetainBinding(candidate, captures.get(candidate.captureId));
    if (!captures.has(candidate.captureId)) {
      captures.set(candidate.captureId, { state: "RETAINED", blob: candidate.blob, frame: candidate.frame,
        reencoded: candidate.reencoded, advertisedSha256: candidate.advertisedSha256 });
    }
    return candidate.captureId;
  }

  function retainCaptures(items) {
    if (!Array.isArray(items)) fail("INVALID_CAPTURE_LIST");
    const candidates = items.map(inspectCapture);
    const staged = new Map();
    for (const candidate of candidates) {
      const existing = staged.get(candidate.captureId) ?? captures.get(candidate.captureId);
      checkRetainBinding(candidate, existing);
      if (!existing) staged.set(candidate.captureId, { state: "RETAINED", blob: candidate.blob,
        frame: candidate.frame, reencoded: candidate.reencoded, advertisedSha256: candidate.advertisedSha256 });
    }
    for (const [captureId, entry] of staged) captures.set(captureId, entry);
    return candidates.map((candidate) => candidate.captureId);
  }

  async function decodeAndVerifyCapture(captureId, capture, cropEntries, invalidCropIds) {
    const entry = captures.get(captureId);
    if (!entry || entry.state !== "RETAINED") return new Map();
    const statuses = new Map();
    let decoded;
    try {
      const rawBytes = new Uint8Array(await entry.blob.arrayBuffer());
      const imageHash = await sha256Bytes(rawBytes);
      if (!hasPngSignature(rawBytes) || !validHash(imageHash) || imageHash !== capture.imageSha256
          || entry.advertisedSha256 !== null && entry.advertisedSha256 !== capture.imageSha256) {
        entry.state = "INVALID";
        for (const item of cropEntries) statuses.set(item.cropRef.cropRefId, "INVALID");
        return statuses;
      }
      decoded = await decodePngToRgba(entry.blob);
      const rgbaBytes = asBytes(decoded?.rgbaBytes);
      if (!validFrame({ width: decoded?.width, height: decoded?.height })
          || !sameFrame({ width: decoded.width, height: decoded.height }, capture.frame)
          || entry.frame && !sameFrame(entry.frame, capture.frame)
          || entry.reencoded !== undefined && entry.reencoded !== capture.reencoded
          || !rgbaBytes) {
        entry.state = "INVALID";
        for (const item of cropEntries) statuses.set(item.cropRef.cropRefId, "INVALID");
        return statuses;
      }
      let rgbBytes;
      try { rgbBytes = rgbaToRgb(rgbaBytes, decoded.width, decoded.height); }
      catch {
        entry.state = "INVALID";
        for (const item of cropEntries) statuses.set(item.cropRef.cropRefId, "INVALID");
        return statuses;
      }
      const bitmapHash = await sha256Bytes(rgbBytes);
      if (!validHash(bitmapHash) || bitmapHash !== capture.bitmapSha256) {
        entry.state = "INVALID";
        for (const item of cropEntries) statuses.set(item.cropRef.cropRefId, "INVALID");
        return statuses;
      }
      for (const item of cropEntries) {
        const { cropRef } = item;
        if (invalidCropIds.has(cropRef.cropRefId)) {
          statuses.set(cropRef.cropRefId, "INVALID");
          continue;
        }
        const pixels = cropRgb(rgbBytes, capture.frame, cropRef.box);
        const pixelHash = await sha256Bytes(pixels);
        statuses.set(cropRef.cropRefId, validHash(pixelHash) && pixelHash === cropRef.pixelSha256
          ? "IN_MEMORY" : "INVALID");
      }
      return statuses;
    } catch (error) {
      entry.state = "INVALID";
      for (const item of cropEntries) statuses.set(item.cropRef.cropRefId, "INVALID");
      return statuses;
    } finally {
      decoded?.close?.();
      decoded = null;
    }
  }

  async function verifyRawEvidence(rawEvidence) {
    lastRawEvidence = null;
    lastRawEvidenceSignature = null;
    lastStateById = new Map();
    const validated = validateRawEvidence(rawEvidence);
    const byCapture = new Map(validated.captureOrder.map((captureId) => [captureId, []]));
    for (const item of validated.crops.values()) {
      if (byCapture.has(item.capture?.captureId)) byCapture.get(item.capture.captureId).push(item);
    }
    const stateById = new Map();
    for (const [cropRefId, item] of validated.crops) {
      if (validated.invalidCropIds.has(cropRefId)) stateById.set(cropRefId, "INVALID");
      else {
        const entry = captures.get(item.cropRef.captureId);
        if (!entry) stateById.set(cropRefId, "MISSING");
        else if (entry.state === "EXPIRED") stateById.set(cropRefId, "EXPIRED");
        else if (entry.state === "INVALID") stateById.set(cropRefId, "INVALID");
      }
    }
    for (const captureId of validated.captureOrder) {
      const pending = (byCapture.get(captureId) ?? []).filter((item) => !stateById.has(item.cropRef.cropRefId));
      if (!pending.length) continue;
      const entry = captures.get(captureId);
      if (!entry) {
        pending.forEach((item) => stateById.set(item.cropRef.cropRefId, "MISSING"));
        continue;
      }
      if (entry.state === "EXPIRED") {
        pending.forEach((item) => stateById.set(item.cropRef.cropRefId, "EXPIRED"));
        continue;
      }
      if (entry.state === "INVALID") {
        pending.forEach((item) => stateById.set(item.cropRef.cropRefId, "INVALID"));
        continue;
      }
      const verified = await decodeAndVerifyCapture(captureId, validated.captures.get(captureId), pending,
        validated.invalidCropIds);
      for (const [cropRefId, state] of verified) stateById.set(cropRefId, state);
    }
    lastRawEvidence = rawEvidence;
    lastRawEvidenceSignature = JSON.stringify(rawEvidence);
    lastStateById = stateById;
    return [...validated.crops.keys()].map((cropRefId) => ({ cropRefId,
      state: stateById.get(cropRefId) ?? "INVALID" }));
  }

  async function buildPixelAvailability(rawEvidence) {
    return verifyRawEvidence(rawEvidence);
  }

  function requireLastRawEvidence(cropRefId) {
    if (!lastRawEvidence) fail("RAW_EVIDENCE_NOT_VERIFIED");
    const found = locateTradeCropRef(lastRawEvidence, cropRefId);
    const entry = captures.get(found.cropRef.captureId);
    if (!entry) fail("CROP_SOURCE_MISSING");
    if (entry.state === "EXPIRED") fail("CROP_SOURCE_EXPIRED");
    if (entry.state === "INVALID") fail("CROP_SOURCE_INVALID");
    return { found, entry };
  }

  async function getVerifiedCrop(cropRefId) {
    if (!lastRawEvidence || JSON.stringify(lastRawEvidence) !== lastRawEvidenceSignature) {
      fail("RAW_EVIDENCE_CHANGED_REVERIFY_REQUIRED");
    }
    if (lastStateById.get(cropRefId) !== "IN_MEMORY") {
      const state = lastStateById.get(cropRefId);
      fail(state ? `CROP_${state}` : "CROP_NOT_VERIFIED");
    }
    const latest = locateTradeCropRef(lastRawEvidence, cropRefId);
    const capture = latest.capture;
    const { entry } = requireLastRawEvidence(cropRefId);
    let decoded;
    try {
      const rawBytes = new Uint8Array(await entry.blob.arrayBuffer());
      const rawHash = await sha256Bytes(rawBytes);
      if (!hasPngSignature(rawBytes) || rawHash !== capture.imageSha256 || entry.advertisedSha256 !== null
          && entry.advertisedSha256 !== capture.imageSha256) {
        entry.state = "INVALID";
        lastStateById.set(cropRefId, "INVALID");
        fail("CROP_SOURCE_INVALID");
      }
      decoded = await decodePngToRgba(entry.blob);
      const rgbaBytes = asBytes(decoded?.rgbaBytes);
      if (!rgbaBytes || !validFrame({ width: decoded?.width, height: decoded?.height })
          || !sameFrame({ width: decoded.width, height: decoded.height }, capture.frame)
          || entry.frame && !sameFrame(entry.frame, capture.frame)
          || entry.reencoded !== undefined && entry.reencoded !== capture.reencoded) {
        entry.state = "INVALID";
        lastStateById.set(cropRefId, "INVALID");
        fail("CROP_SOURCE_INVALID");
      }
      const rgbBytes = rgbaToRgb(rgbaBytes, decoded.width, decoded.height);
      const bitmapHash = await sha256Bytes(rgbBytes);
      if (bitmapHash !== capture.bitmapSha256) {
        entry.state = "INVALID";
        lastStateById.set(cropRefId, "INVALID");
        fail("CROP_SOURCE_INVALID");
      }
      const pixels = cropRgb(rgbBytes, capture.frame, latest.cropRef.box);
      const pixelHash = await sha256Bytes(pixels);
      if (pixelHash !== latest.cropRef.pixelSha256 || latest.cropRef.bitmapSha256 !== capture.bitmapSha256) {
        lastStateById.set(cropRefId, "INVALID");
        fail("CROP_INVALID");
      }
      return { cropRefId, captureId: capture.captureId, field: latest.field.field,
        width: latest.cropRef.box.width, height: latest.cropRef.box.height,
        pixelSha256: latest.cropRef.pixelSha256, rgbBytes: new Uint8Array(pixels) };
    } catch (error) {
      if (error instanceof TradeSourceEvidenceError && error.code === "CROP_INVALID") {
        lastStateById.set(cropRefId, "INVALID");
        throw error;
      }
      entry.state = "INVALID";
      lastStateById.set(cropRefId, "INVALID");
      if (error instanceof TradeSourceEvidenceError) throw error;
      fail("CROP_SOURCE_INVALID");
    } finally {
      decoded?.close?.();
    }
  }

  async function createDisplayCrop(cropRefId) {
    const verified = await getVerifiedCrop(cropRefId);
    const blob = await encodeDisplayCrop({ width: verified.width, height: verified.height,
      rgbBytes: new Uint8Array(verified.rgbBytes) });
    if (!blob || typeof blob.type !== "string" || blob.type.toLowerCase() !== "image/png"
        || !Number.isSafeInteger(blob.size) || blob.size < 1) fail("PNG_ENCODE_FAILED");
    return { cropRefId: verified.cropRefId, captureId: verified.captureId, field: verified.field,
      width: verified.width, height: verified.height, pixelSha256: verified.pixelSha256,
      displayOnly: true, blob };
  }

  function releaseCapture(captureId) {
    const entry = captures.get(captureId);
    if (!entry) return false;
    if (entry.state !== "EXPIRED") {
      entry.blob = null;
      entry.state = "EXPIRED";
    }
    return true;
  }

  function clear() {
    for (const entry of captures.values()) {
      if (entry.state !== "EXPIRED") {
        entry.blob = null;
        entry.state = "EXPIRED";
      }
    }
  }

  return { retainCapture, retainCaptures, verifyRawEvidence, buildPixelAvailability,
    getVerifiedCrop, createDisplayCrop, releaseCapture, clear };
}
