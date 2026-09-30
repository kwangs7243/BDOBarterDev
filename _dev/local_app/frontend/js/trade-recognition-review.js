import { adaptLegacyCatalog, registrySnapshotSha256 } from "./domain/trade-master-registry.js";
import { buildTradeBatchReconciliation } from "./domain/trade-batch-reconciliation.js";
import { buildTradeReviewProjection } from "./domain/trade-review-projection.js";

const FIELD_KEYS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const FIELD_LABELS = Object.freeze({ island: "섬", fromItem: "소모품", reqAmount: "필요 수량", toItem: "획득품", count: "남은 교환 횟수", yield: "수율" });
const NUMERIC_MINIMUM = Object.freeze({ reqAmount: 1, count: 0, yield: 1 });
const CORRECTION_POLICY_VERSION = "trade-review-correction-v1";
const RECONCILIATION_POLICY_VERSION = "trade-batch-reconciliation-v1";
const RISK_LABELS = Object.freeze({
  NUMERIC_COMPLETENESS_UNVERIFIED: "숫자가 잘리지 않았는지 확인해 주세요.",
  NUMERIC_MISSING_OR_INVALID: "숫자 후보를 확인할 수 없습니다.",
  FIELD_CLIPPED: "인식 영역이 잘렸을 수 있습니다.",
  GEOMETRY_ABSTAIN: "인식 위치를 확정하지 못했습니다.",
  UNREADABLE: "읽기 어려운 영역입니다.",
  OCR_ERROR: "문자 인식 오류가 보고되었습니다.",
  EMPTY_OCR: "원문이 비어 있습니다.",
  AMBIGUOUS_MATCH: "이름 후보가 여러 개입니다.",
  UNMATCHED_SOURCE_PRESERVED: "기준 목록과 일치하지 않아 원문을 후보로 표시합니다.",
  MASTER_DISAGREEMENT: "화면 후보와 기준 자료 이름을 함께 확인해 주세요.",
  MASTER_IDENTITY_UNVERIFIED: "기준 항목의 식별 정보가 아직 검증되지 않았습니다.",
  TO_ITEM_DEPENDENCY_UNRESOLVED: "획득품 단계를 정하지 못해 연관 후보를 확정하지 않았습니다.",
  TO_ITEM_TIER_UNRESOLVED: "획득품 단계가 정해지지 않았습니다.",
});

let registryPromise = null;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function formatValue(value) {
  return value === null || value === undefined ? "(후보 없음)" : String(value);
}

function riskText(reason) {
  if (typeof reason === "string") return RISK_LABELS[reason] ?? `확인 사유: ${reason}`;
  return reason?.messageKo || RISK_LABELS[reason?.code] || `확인 사유: ${reason?.code ?? "기록된 세부 사유 없음"}`;
}

async function loadRegistry() {
  if (!registryPromise) {
    registryPromise = (async () => {
      const response = await fetch("/assets/data/trade-catalog.json", { credentials: "same-origin", cache: "no-cache" });
      if (!response.ok) throw new Error(`catalog fetch failed: ${response.status}`);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sourceSha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      const catalogText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const catalog = JSON.parse(catalogText);
      return adaptLegacyCatalog(catalog, {
        sourceRevision: `asset-content-sha256:${sourceSha256}`,
        sourceSha256,
        curatedMappings: null,
      });
    })().catch((error) => {
      registryPromise = null;
      throw error;
    });
  }
  return registryPromise;
}

function semanticValue(key, value) {
  if (!Object.hasOwn(NUMERIC_MINIMUM, key)) return value;
  const text = String(value ?? "");
  if (text.trim() === "") return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function sameSemanticValue(key, before, after) {
  if (Object.hasOwn(NUMERIC_MINIMUM, key)) {
    const previous = before === null || before === undefined || before === "" ? null : Number(before);
    return Number.isSafeInteger(previous) && previous === after;
  }
  return String(before ?? "") === after;
}

function freezePayload(payload) {
  return deepFreeze(cloneJson(payload));
}

function cropBox(field) {
  const box = field?.rawEvidence?.readerEvidence?.geometry?.box;
  if (!box || !["x", "y", "width", "height"].every((key) => Number.isFinite(box[key]))) return null;
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0) return null;
  return box;
}

function captureGeometry(row, field, captures) {
  const capture = captures.find((item) => item?.metadata?.captureId === row.captureId);
  const box = field?.rawEvidence?.readerEvidence?.geometry?.box;
  const rowBox = row.rowBox;
  if (!capture || !box || !rowBox) return null;
  const values = [box.x, box.y, box.width, box.height, rowBox.x, rowBox.y, rowBox.width, rowBox.height];
  if (!values.every(Number.isSafeInteger) || box.x < 0 || box.y < 0 || box.width < 1 || box.height < 1
      || rowBox.x < 0 || rowBox.y < 0 || rowBox.width < 1 || rowBox.height < 1
      || box.x + box.width > rowBox.width || box.y + box.height > rowBox.height) return null;
  const x = rowBox.x + box.x; const y = rowBox.y + box.y;
  const width = box.width; const height = box.height;
  if (width > 1024 || height > 256 || width * height > 262144) return null;
  if (x + width > capture.metadata.frame.width || y + height > capture.metadata.frame.height) return null;
  return { source: "CAPTURE_BITMAP_PIXELS", captureId: row.captureId, x, y, width, height };
}

function makeCropPlan(projection, completion, captures) {
  const entries = [];
  for (const reviewed of completion.rows) {
    const row = projection.rows.find((item) => item.projectionRowId === reviewed.projectionRowId);
    if (!row) continue;
    for (const key of FIELD_KEYS) {
      const projected = row.fields[key];
      const reviewedField = reviewed.fields.find((field) => field.field === key);
      const risky = Boolean(projected.riskReasons?.length) || ["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"].includes(projected.status);
      const reasons = [];
      if (reviewedField?.verificationMethod === "USER_MARKED_UNKNOWN") reasons.push("USER_MARKED_UNKNOWN");
      else if (reviewedField?.verificationMethod === "USER_EDITED") reasons.push("USER_EDITED");
      if (risky) reasons.push("RISKY_FIELD");
      const selected = reasons.length > 0;
      const geometry = captureGeometry(row, projected, captures);
      entries.push({ projectionRowId: row.projectionRowId, field: key, selected, selectionReasons: reasons,
        geometry, readerCropHash: projected.rawEvidence?.readerEvidence?.cropHash ?? null,
        skipReason: !selected ? "NOT_SELECTED" : geometry ? null : "GEOMETRY_UNAVAILABLE" });
    }
  }
  return { policy: "C2_REVIEW_VALUE_SUBSET_V1", entries };
}

function buildStorageSource({ recognitionResult, captures, registrySnapshot, projection }) {
  const sourceCaptures = captures.map((capture) => ({
    captureId: capture.metadata.captureId, metadata: cloneJson(capture.metadata),
    bitmapSha256: capture.sha256 ?? null, sourceSha256: capture.sourceSha256 ?? null,
    bitmapBytes: capture.bytes, sourceBytes: capture.sourceBytes, reencoded: capture.reencoded === true,
  }));
  const runtime = recognitionResult.runtime ?? {};
  return {
    version: 1, authority: "CLIENT_ATTESTED", gameVersion: null,
    registry: { sourceRevision: registrySnapshot.source.revision, sourceSha256: registrySnapshot.source.sha256,
      snapshotSha256: registrySnapshotSha256(registrySnapshot), snapshot: cloneJson(registrySnapshot), hashBasis: "JS_REGISTRY_SORTED_JSON_V1" },
    projection: { snapshot: cloneJson(projection), hashBasis: "JS_REGISTRY_SORTED_JSON_V1" },
    recognition: { resultVersion: 1,
      runtime: { engineId: runtime.engineId ?? null, modelBundleSha256: runtime.modelBundleSha256 ?? null, workerVersion: runtime.workerVersion ?? null },
      boundaryPolicy: recognitionResult.metrics?.boundaryPolicy ?? null,
      captureEvidence: { captures: cloneJson(recognitionResult.captures), edgeSegments: cloneJson(recognitionResult.edgeSegments) },
      geometryProfile: { revision: null, sha256: null, availability: "NOT_EXPOSED_BY_API" } },
    captures: sourceCaptures,
  };
}

async function createFieldCrop({ row, field, captures }) {
  const capture = captures.find((item) => item?.metadata?.captureId === row.captureId);
  const box = cropBox(field);
  const rowBox = row.rowBox;
  if (!capture?.blob || !box || !rowBox || !["x", "y", "width", "height"].every((key) => Number.isFinite(rowBox[key]))
      || rowBox.x < 0 || rowBox.y < 0 || rowBox.width <= 0 || rowBox.height <= 0
      || box.x + box.width > rowBox.width || box.y + box.height > rowBox.height) return null;
  const bitmap = await createImageBitmap(capture.blob);
  try {
    const x = rowBox.x + box.x;
    const y = rowBox.y + box.y;
    if (x + box.width > bitmap.width || y + box.height > bitmap.height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(box.width);
    canvas.height = Math.ceil(box.height);
    if (canvas.width < 1 || canvas.height < 1) return null;
    const context = canvas.getContext("2d", { willReadFrequently: false });
    context.drawImage(bitmap, x, y, box.width, box.height, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    bitmap.close?.();
  }
}

export async function mountTradeRecognitionReview({ root, recognitionResult, captures, reviewRevision, getCurrentRevision, onComplete, onClear } = {}) {
  if (!(root instanceof Element) || !recognitionResult || !Array.isArray(captures)) throw new TypeError("review mount requires a root, recognition result, and captures");
  const registrySnapshot = await loadRegistry();
  const preliminary = buildTradeBatchReconciliation({
    captures: recognitionResult.captures,
    draftRows: recognitionResult.draftRows,
    policyVersion: RECONCILIATION_POLICY_VERSION,
  });
  const projection = buildTradeReviewProjection({
    draftRows: recognitionResult.draftRows,
    reconciliation: preliminary,
    registrySnapshot,
    correctionPolicyVersion: CORRECTION_POLICY_VERSION,
  });
  if (projection.reconciliation.sourceRows.length !== recognitionResult.draftRows.length
      || projection.reconciliation.sourceToLogical.length !== recognitionResult.draftRows.length
      || new Set(projection.reconciliation.sourceToLogical.map((entry) => entry.sourceRowId)).size !== recognitionResult.draftRows.length) {
    throw new Error("reconciliation did not account for every complete source row exactly once");
  }

  let destroyed = false;
  let completed = false;
  const objectUrls = new Set();
  const rowStates = projection.rows.map((row) => ({
    row,
    fields: Object.fromEntries(FIELD_KEYS.map((key) => {
      const value = row.fields[key].shownValue ?? "";
      return [key, { value, initial: value, unknown: false, previous: null, invalid: value === "", touched: false }];
    })),
  }));
  root.replaceChildren();
  root.hidden = false;

  const clear = make("button", "trade-review-clear", "인식 결과 지우기");
  clear.type = "button";
  clear.dataset.action = "clear-trade-recognition-result";
  clear.addEventListener("click", () => { if (!destroyed) onClear?.(); });

  const summary = make("div", "trade-recognition-summary trade-review-summary", "");
  summary.setAttribute("aria-live", "polite");
  const edgeSegments = Array.isArray(recognitionResult.edgeSegments) ? cloneJson(recognitionResult.edgeSegments) : [];
  const edges = make("section", "trade-review-edges");
  edges.setAttribute("aria-label", "캡처 경계 경고");
  if (edgeSegments.length) {
    const title = make("strong", "trade-review-edge-title", `캡처 경계에서 잘린 후보 ${edgeSegments.length}행이 있습니다. 추가 캡처가 필요할 수 있습니다.`);
    const list = make("ul", "trade-review-edge-list");
    edgeSegments.forEach((edge, index) => {
      const item = make("li", "", `경계 후보 ${index + 1} · 캡처 ${edge.captureId} · 위치 ${edge.boundarySide} · ${edge.reasonCodes?.length ? edge.reasonCodes.join(", ") : edge.classification}`);
      const details = make("details", "trade-review-edge-details");
      details.append(make("summary", "", "경계 후보 근거"), make("pre", "", JSON.stringify(edge, null, 2)));
      item.append(details);
      list.append(item);
    });
    edges.append(title, list);
  }

  const tableWrap = make("div", "trade-recognition-table-wrap trade-review-table-wrap");
  tableWrap.setAttribute("role", "region");
  tableWrap.setAttribute("aria-label", "전체 인식 행 검수");
  tableWrap.tabIndex = 0;
  const table = make("table", "trade-recognition-table trade-review-table");
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  ["행", ...FIELD_KEYS.map((key) => FIELD_LABELS[key]), "상태"].forEach((label) => header.append(make("th", "", label)));
  head.append(header);
  const body = document.createElement("tbody");

  const editorRefs = [];
  const sourceCount = projection.reconciliation.sourceRows.length;
  const mergedGroupCount = projection.reconciliation.groups.filter((group) => group.memberSourceRowIds.length > 1).length;
  const conflictGroupCount = projection.reconciliation.groups.filter((group) => group.status === "CONFLICT").length;
  const updateSummary = () => {
    const edits = rowStates.flatMap(({ row, fields }) => FIELD_KEYS.filter((key) => fields[key].touched && !fields[key].unknown
      && !sameSemanticValue(key, row.fields[key].shownValue, fields[key].value)));
    const unknowns = rowStates.flatMap(({ fields }) => FIELD_KEYS.filter((key) => fields[key].unknown));
    const risks = rowStates.flatMap(({ row }) => FIELD_KEYS.filter((key) => row.fields[key].riskReasons?.length
      || ["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"].includes(row.fields[key].status)));
    summary.textContent = `로컬 인식 초안 · ${sourceCount}행 · 이미지 ${recognitionResult.captures.length}장${edgeSegments.length ? ` · 경계 후보 ${edgeSegments.length}행 제외` : ""} · 목록 미적용 · 인식 source COMPLETE ${sourceCount}행 · 검수 logical ${rowStates.length}행 · 겹침 통합 ${mergedGroupCount}그룹 · 충돌 ${conflictGroupCount}그룹 · 전체 행 ${rowStates.length} · 전체 필드 ${rowStates.length * 6} · 확인 권장 ${risks.length} · 수정 ${edits.length} · 모름 ${unknowns.length} · 경계 ${edgeSegments.length}`;
    completeButton.disabled = completed || !confirmBox.checked || editorRefs.some((reference) => !reference.state.unknown && reference.state.invalid);
  };

  rowStates.forEach(({ row, fields }, rowIndex) => {
    const tr = document.createElement("tr");
    tr.dataset.captureId = row.captureId ?? "";
    tr.dataset.ordinal = String(row.ordinal ?? rowIndex + 1);
    tr.dataset.reconciliationStatus = row.reconciliationStatus ?? "UNMERGED";
    tr.append(make("th", "trade-review-row-number", String(rowIndex + 1)));
    FIELD_KEYS.forEach((key) => {
      const projected = row.fields[key];
      const state = fields[key];
      const td = make("td", "trade-review-field");
      const reasons = projected.riskReasons ?? [];
      const disagreement = projected.status === "MASTER_DISAGREEMENT" || reasons.some((reason) => reason?.code === "MASTER_DISAGREEMENT");
      const risky = reasons.length > 0 || ["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"].includes(projected.status);
      td.dataset.state = state.unknown ? "unknown" : risky ? (disagreement ? "master-disagreement" : "warning") : "normal";
      const input = make("input", "trade-review-input");
      input.type = Object.hasOwn(NUMERIC_MINIMUM, key) ? "number" : "text";
      input.value = String(state.value);
      input.setAttribute("aria-label", `행 ${rowIndex + 1} ${FIELD_LABELS[key]}`);
      input.dataset.field = key;
      const validation = make("span", "trade-review-validation", "");
      validation.id = `trade-review-validation-${rowIndex + 1}-${key}`;
      input.setAttribute("aria-describedby", validation.id);
      if (Object.hasOwn(NUMERIC_MINIMUM, key)) {
        input.step = "1";
        input.min = String(NUMERIC_MINIMUM[key]);
        input.inputMode = "numeric";
      }
      const unknownLabel = make("label", "trade-review-unknown");
      const unknown = make("input");
      unknown.type = "checkbox";
      unknown.setAttribute("aria-label", `행 ${rowIndex + 1} ${FIELD_LABELS[key]} 모름으로 표시`);
      const unknownText = make("span", "", "모름");
      unknownLabel.append(unknown, unknownText);
      const reconciliationConflict = reasons.some((reason) => reason?.code === "RECONCILIATION_CONFLICT");
      const badgeText = reconciliationConflict ? "겹침 충돌 · 확인 필요" : disagreement ? "이름 비교 필요" : risky ? "확인 권장" : "후보";
      const badge = make("span", `trade-review-badge${risky ? " is-warning" : ""}${reconciliationConflict ? " is-conflict" : ""}`, badgeText);
      const riskSummary = risky ? make("p", "trade-review-risk-summary", reasons.map(riskText).join(" ") || `상태: ${projected.status}`) : null;
      if (state.invalid) validation.textContent = Object.hasOwn(NUMERIC_MINIMUM, key)
        ? `정수 ${NUMERIC_MINIMUM[key]} 이상을 입력하거나 모름을 선택하세요.` : "값을 입력하거나 모름을 선택하세요.";
      const detail = make("details", "trade-review-evidence");
      const detailSummary = make("summary", "", `${FIELD_LABELS[key]} 근거 보기`);
      const evidence = projected.rawEvidence ?? {};
      const list = make("dl", "trade-review-evidence-list");
      const addEvidence = (label, value) => {
        const term = make("dt", "", label);
        const description = make("dd", "", value === null || value === undefined || value === "" ? "기록 없음" : typeof value === "string" ? value : JSON.stringify(value));
        list.append(term, description);
      };
      addEvidence("OCR 원문", evidence.rawText);
      addEvidence("정리된 원문", evidence.normalizedText);
      addEvidence("인식 상태", evidence.status);
      addEvidence("인식 사유", evidence.reasonCodes?.length ? evidence.reasonCodes.join(", ") : null);
      addEvidence("화면 후보", projected.candidate?.value ?? projected.shownValue);
      addEvidence("보정 근거", projected.correctionReason?.map((reason) => reason.messageKo ?? reason.code).join(" · "));
      addEvidence("위험 사유", reasons.map(riskText).join(" · "));
      if (projected.alternatives?.length) {
        const alternatives = make("ul", "trade-review-conflict-alternatives");
        projected.alternatives.forEach((alternative) => {
          const sourceLabels = alternative.sourceRowIds.map((sourceRowId) => {
            const member = row.reconciliationMembers?.find((item) => item.projectionRowId === sourceRowId);
            return member ? `${member.captureId} · 원본 ${member.ordinal}행` : sourceRowId;
          }).join(", ");
          alternatives.append(make("li", "", `${sourceLabels}: ${formatValue(alternative.value)}`));
        });
        detail.append(make("strong", "trade-review-conflict-title", "겹친 캡처의 후보 값"), alternatives);
      }
      if (disagreement) {
        const compare = make("div", "trade-review-master-compare");
        compare.append(make("p", "", `화면/검수 후보: ${formatValue(projected.candidate?.value ?? projected.shownValue)}`));
        compare.append(make("p", "", `프로그램 기준 이름: ${formatValue(projected.candidate?.canonicalName)}`));
        detail.append(compare);
      }
      const cropButton = make("button", "trade-review-crop-button", "원본 보기");
      cropButton.type = "button";
      cropButton.setAttribute("aria-label", `행 ${rowIndex + 1} ${FIELD_LABELS[key]} 원본 영역 보기`);
      const cropStatus = make("span", "trade-review-crop-status", "원본 영역은 요청 시 표시됩니다.");
      const cropImage = make("img", "trade-review-crop");
      cropImage.alt = `행 ${rowIndex + 1} ${FIELD_LABELS[key]} 원본 영역`;
      cropImage.hidden = true;
      cropButton.addEventListener("click", async () => {
        cropButton.disabled = true;
        cropStatus.textContent = "원본 영역을 불러오는 중입니다…";
        try {
          const blob = await createFieldCrop({ row, field: projected, captures });
          if (destroyed) return;
          if (!blob) {
            cropStatus.textContent = "원본 영역 미제공";
          } else {
            const url = URL.createObjectURL(blob);
            objectUrls.add(url);
            cropImage.src = url;
            cropImage.hidden = false;
            cropStatus.textContent = "대기 중인 같은 캡처에서 잘라낸 영역입니다.";
          }
        } catch {
          cropStatus.textContent = "원본 영역 미제공";
        } finally {
          cropButton.disabled = false;
        }
      });
      detail.append(detailSummary, list, cropButton, cropStatus, cropImage);

      input.addEventListener("input", () => {
        state.value = input.value;
        state.touched = true;
        if (Object.hasOwn(NUMERIC_MINIMUM, key)) {
          const value = semanticValue(key, input.value);
          state.invalid = value === null || !Number.isSafeInteger(value) || value < NUMERIC_MINIMUM[key];
        } else {
          state.invalid = input.value.length === 0;
        }
        validation.textContent = state.invalid ? (state.unknown ? "" : Object.hasOwn(NUMERIC_MINIMUM, key) ? `정수 ${NUMERIC_MINIMUM[key]} 이상을 입력하거나 모름을 선택하세요.` : "값을 입력하거나 모름을 선택하세요.") : "";
        td.dataset.state = state.unknown ? "unknown" : state.invalid ? "warning" : !sameSemanticValue(key, projected.shownValue, state.value) ? "edited" : risky ? "warning" : "normal";
        updateSummary();
      });
      unknown.addEventListener("change", () => {
        state.unknown = unknown.checked;
        if (state.unknown) state.previous = input.value;
        else if (state.previous !== null) input.value = state.previous;
        input.disabled = state.unknown;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        td.dataset.state = state.unknown ? "unknown" : state.invalid ? "warning" : !sameSemanticValue(key, projected.shownValue, state.value) ? "edited" : risky ? "warning" : "normal";
        updateSummary();
      });
      td.append(input, unknownLabel, badge);
      if (riskSummary) td.append(riskSummary);
      td.append(validation, detail);
      tr.append(td);
      editorRefs.push({ key, row, state, input, unknown, validation });
    });
    const memberCount = row.reconciliationMembers?.length ?? 1;
    const rowStatus = make("td", "trade-review-row-status", `인식 초안 · 검토 필요 · 검수 대기${memberCount > 1 ? ` · 겹침 ${memberCount}개 출처 통합` : ""}${row.reconciliationStatus === "CONFLICT" ? " · 겹침 충돌" : ""}`);
    rowStatus.setAttribute("aria-label", `행 ${rowIndex + 1} 검수 대기`);
    if (memberCount > 1) rowStatus.append(make("span", "trade-review-source-badge", `겹침 ${memberCount}개 출처 통합`));
    if (row.reconciliationStatus === "CONFLICT") rowStatus.append(make("span", "trade-review-conflict-badge", "겹침 충돌"));
    if (memberCount > 1) {
      const sourceDetails = make("details", "trade-review-source-details");
      sourceDetails.append(make("summary", "", "모든 원본 행과 후보 보기"));
      for (const member of row.reconciliationMembers) {
        const sourceProjection = projection.reconciliation.sourceProjectionEvidence.find((item) => item.projectionRowId === member.projectionRowId)
          ?? (member.projectionRowId === row.projectionRowId ? row : null);
        const section = make("section", "trade-review-source-member");
        section.append(make("h4", "", `캡처 ${member.captureId} · 원본 ${member.ordinal}행`));
        section.append(make("p", "", `원본 위치: ${JSON.stringify(member.rowBox ?? "기록 없음")} · sourceRefs: ${JSON.stringify(member.sourceRefs)}`));
        const sourceFields = make("ul", "trade-review-source-fields");
        for (const key of FIELD_KEYS) {
          const sourceField = sourceProjection?.fields?.[key];
          const candidateText = sourceField?.candidate?.value ?? sourceField?.shownValue;
          const risk = (sourceField?.riskReasons ?? []).map(riskText).join(" · ");
          const rawText = sourceField?.rawEvidence?.rawText;
          const line = make("li", "", `${FIELD_LABELS[key]}: 후보 ${formatValue(candidateText)} · 원문 ${formatValue(rawText)}${risk ? ` · ${risk}` : ""}`);
          if (sourceField && member.rowBox && captures.some((capture) => capture.metadata.captureId === member.captureId)) {
            const cropButton = make("button", "trade-review-member-crop-button", "이 출처 원본 보기");
            cropButton.type = "button";
            const cropImage = make("img", "trade-review-crop trade-review-member-crop");
            cropImage.alt = `캡처 ${member.captureId} 원본 ${member.ordinal}행 ${FIELD_LABELS[key]}`;
            cropImage.hidden = true;
            cropButton.addEventListener("click", async () => {
              cropButton.disabled = true;
              try {
                const blob = await createFieldCrop({ row: sourceProjection, field: sourceField, captures });
                if (!blob || destroyed) return;
                const url = URL.createObjectURL(blob); objectUrls.add(url); cropImage.src = url; cropImage.hidden = false;
              } catch { /* Original capture pixels may no longer be available. */ }
              finally { cropButton.disabled = false; }
            });
            line.append(cropButton, cropImage);
          }
          sourceFields.append(line);
        }
        section.append(sourceFields); sourceDetails.append(section);
      }
      rowStatus.append(sourceDetails);
    }
    tr.append(rowStatus);
    body.append(tr);
  });
  table.append(head, body);
  tableWrap.append(table);

  const footer = make("section", "trade-review-footer");
  footer.setAttribute("aria-label", "전체 검수 완료");
  const footerSummary = make("p", "trade-review-footer-summary", "모든 표시 행과 경계 경고를 확인한 뒤 한 번에 완료할 수 있습니다.");
  const confirmLabel = make("label", "trade-review-confirm");
  const confirmBox = make("input");
  confirmBox.type = "checkbox";
  confirmBox.setAttribute("aria-label", "표시된 모든 행과 경계 경고를 확인했습니다.");
  confirmLabel.append(confirmBox, make("span", "", "표시된 모든 행과 경계 경고를 확인했습니다."));
  const message = make("p", "trade-review-message");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const completeButton = make("button", "trade-review-complete", "검수 완료");
  completeButton.type = "button";
  completeButton.disabled = true;
  confirmBox.addEventListener("change", updateSummary);
  completeButton.addEventListener("click", () => {
    if (destroyed || completed) return;
    if (getCurrentRevision?.() !== reviewRevision) {
      message.textContent = "대기 이미지가 변경되었습니다. 다시 인식한 뒤 검수하세요.";
      completeButton.disabled = true;
      return;
    }
    const invalid = editorRefs.filter(({ state, input, validation }) => {
      if (state.unknown) return false;
      const value = semanticValue(input.dataset.field, input.value);
      const valid = Object.hasOwn(NUMERIC_MINIMUM, input.dataset.field)
        ? Number.isSafeInteger(value) && value >= NUMERIC_MINIMUM[input.dataset.field]
        : input.value.length > 0;
      state.invalid = !valid;
      validation.textContent = valid ? "" : Object.hasOwn(NUMERIC_MINIMUM, input.dataset.field)
        ? `정수 ${NUMERIC_MINIMUM[input.dataset.field]} 이상을 입력하거나 모름을 선택하세요.`
        : "값을 입력하거나 모름을 선택하세요.";
      return !valid;
    });
    if (invalid.length) {
      message.textContent = "비어 있거나 유효하지 않은 값이 있습니다. 값을 입력하거나 모름을 선택해 주세요.";
      invalid[0].input.focus();
      invalid[0].input.scrollIntoView({ block: "center", inline: "nearest" });
      updateSummary();
      return;
    }
    if (!confirmBox.checked) {
      message.textContent = "표시된 모든 행과 경계 경고를 확인했다고 체크해 주세요.";
      return;
    }
    let unchangedFieldCount = 0;
    let editedFieldCount = 0;
    let unknownFieldCount = 0;
    const rows = rowStates.map(({ row, fields }) => ({
      projectionRowId: row.projectionRowId,
      captureId: row.captureId,
      ordinal: row.ordinal,
      ...(row.draftId !== undefined ? { draftId: cloneJson(row.draftId) } : {}),
      sourceRefs: cloneJson(row.sourceRefs),
      ...(row.rowBox !== undefined ? { rowBox: cloneJson(row.rowBox) } : {}),
      ...(row.rowCropHash !== undefined ? { rowCropHash: cloneJson(row.rowCropHash) } : {}),
      fields: FIELD_KEYS.map((key) => {
        const projected = row.fields[key];
        const current = fields[key];
        let verificationMethod;
        let finalValue;
        if (current.unknown) {
          verificationMethod = "USER_MARKED_UNKNOWN";
          finalValue = null;
          unknownFieldCount += 1;
        } else {
          finalValue = semanticValue(key, current.value);
          if (sameSemanticValue(key, projected.shownValue, finalValue)) {
            verificationMethod = "USER_BATCH_CONFIRMED_UNCHANGED";
            unchangedFieldCount += 1;
          } else {
            verificationMethod = "USER_EDITED";
            editedFieldCount += 1;
          }
        }
        return {
          field: key,
          shownValueBefore: cloneJson(projected.shownValue),
          finalValue,
          verificationMethod,
          projectionStatus: projected.status,
          candidate: cloneJson(projected.candidate),
          rawEvidence: cloneJson(projected.rawEvidence),
          correctionReason: cloneJson(projected.correctionReason),
          riskReasons: cloneJson(projected.riskReasons),
          masterVersion: projected.masterVersion,
        };
      }),
    }));
    const riskFieldCount = rowStates.reduce((count, { row }) => count + FIELD_KEYS.filter((key) => row.fields[key].riskReasons?.length
      || ["AMBIGUOUS", "UNMATCHED", "MASTER_DISAGREEMENT"].includes(row.fields[key].status)).length, 0);
    const payload = freezePayload({
      schemaVersion: 1,
      reviewMode: "REVIEW_FIRST",
      recognitionBatchId: recognitionResult.batchId,
      projectionHash: projection.projectionHash,
      registryVersion: registrySnapshot.registryVersion,
      correctionVersion: CORRECTION_POLICY_VERSION,
      reviewRevision,
      rows,
      edgeSegments,
      summary: {
        rowCount: rows.length,
        fieldCount: rows.length * 6,
        unchangedFieldCount,
        editedFieldCount,
        unknownFieldCount,
        riskFieldCount,
        edgeSegmentCount: edgeSegments.length,
      },
    });
    const cropPlan = makeCropPlan(projection, payload, captures);
    const sourceContext = buildStorageSource({ recognitionResult, captures, registrySnapshot, projection });
    const storageEnvelope = freezePayload({ schemaVersion: 1, mutationId: crypto.randomUUID(),
      createdAt: new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1Z"), confirmationRevision: 1,
      supersedesObservationId: null, completion: payload, sourceContext, cropPlan });
    completed = true;
    completeButton.disabled = true;
    confirmBox.disabled = true;
    editorRefs.forEach(({ input, unknown }) => { input.disabled = true; unknown.disabled = true; });
    message.textContent = "검수를 완료했습니다. 아직 현재 회차에는 적용하지 않았습니다.";
    try {
      const createSelectedCrops = async () => {
        const blobs = [];
        for (const entry of cropPlan.entries) {
          if (!entry.selected || !entry.geometry) continue;
          const row = projection.rows.find((candidate) => candidate.projectionRowId === entry.projectionRowId);
          const field = row?.fields[entry.field];
          const blob = row && field ? await createFieldCrop({ row, field, captures }) : null;
          blobs.push({ entry, blob });
        }
        return blobs;
      };
      onComplete?.(payload, { observation: storageEnvelope, createSelectedCrops });
    } catch (error) {
      // Persistence preparation is secondary to the established R005 completion event.
      console.error("trade review persistence preparation failed", error);
    }
    window.dispatchEvent(new CustomEvent("bdo:trade-review-completed", { detail: payload }));
    updateSummary();
  });
  footer.append(footerSummary, confirmLabel, message, completeButton);
  root.append(summary, clear, edges, tableWrap, footer);
  updateSummary();

  return {
    projection,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
      root.replaceChildren();
      root.hidden = true;
    },
  };
}
