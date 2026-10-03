import { buildFinalReviewCompletion } from "./domain/trade-final-evidence.js";

const FIELDS = Object.freeze(["island", "fromItem", "reqAmount", "toItem", "count", "yield"]);
const LABELS = Object.freeze({ island: "교환 장소", fromItem: "주는 품목", reqAmount: "필요 수량",
  toItem: "받는 품목", count: "남은 횟수", yield: "획득 수량" });
const NUMERIC = Object.freeze({ reqAmount: { min: 1, label: "1 이상 정수" },
  count: { min: 0, label: "0 이상 정수" }, yield: { min: 1, label: "1 이상 정수" } });
const STATUS = Object.freeze({ FINAL_READY: "추가 확인 없음", NEEDS_REVIEW: "확인 필요",
  NEEDS_RECAPTURE: "다시 캡처 필요", CONFLICT: "결과 충돌" });
const REASON_LABELS = Object.freeze({ MASTER_UNRESOLVED: "기준 이름을 확인해야 합니다.",
  MASTER_DISAGREEMENT: "기준 이름과 인식 결과가 다릅니다.", NUMERIC_COMPLETENESS_UNVERIFIED: "숫자 전체가 읽혔는지 확인해야 합니다.",
  RECONCILIATION_CONFLICT: "겹친 캡처의 결과가 다릅니다.", FIELD_CLIPPED: "필드가 잘려 다시 캡처해야 합니다.",
  SOURCE_PIXELS_UNAVAILABLE: "원본 픽셀을 확인할 수 없습니다.", MISSING_CROP: "원본 일부가 없습니다." });

function fail(message) { throw new TypeError(message); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function clone(value) { return structuredClone(value); }
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined && text !== null) result.textContent = String(text);
  return result;
}
function button(text, action, className = "") {
  const result = node("button", `trade-final-review-button ${className}`.trim(), text);
  result.type = "button";
  result.dataset.action = action;
  return result;
}
function reasonLabel(value) { return REASON_LABELS[value] ?? "추가 확인이 필요합니다."; }
function prettyValue(value) { return value === null || value === undefined ? "값 없음" : String(value); }
function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function validateMountInput(input) {
  const { root, projection, rawEvidence, sourceEvidence, reviewRevision, getCurrentProjectionHash,
    getCurrentPixelAvailability, getConfirmedAt, onConfirm, onClose } = input;
  if (!(root instanceof Element)) fail("root must be an Element");
  if (!isRecord(projection) || projection.schemaVersion !== 3 || projection.reviewMode !== "FINAL_CORRECTED_RESULT"
      || !nonempty(projection.projectionHash) || !nonempty(projection.recognitionBatchId)
      || !Array.isArray(projection.rows) || !Array.isArray(projection.edgeWorkItems)
      || !Array.isArray(projection.pixelAvailability)) fail("FinalProjection3 is invalid");
  if (!isRecord(rawEvidence) || rawEvidence.schemaVersion !== 2
      || rawEvidence.recognitionBatchId !== projection.recognitionBatchId
      || !Array.isArray(rawEvidence.captures) || !Array.isArray(rawEvidence.sourceRows)
      || !Array.isArray(rawEvidence.edgeSegments)) fail("RawEvidenceSnapshot2 is invalid");
  if (!sourceEvidence || ["buildPixelAvailability", "createDisplayRowCrop", "createDisplayCrop", "createDisplayCapture"]
    .some((method) => typeof sourceEvidence[method] !== "function")) fail("sourceEvidence API is incomplete");
  if (!Number.isSafeInteger(reviewRevision) || reviewRevision < 0) fail("reviewRevision is invalid");
  if (typeof getCurrentProjectionHash !== "function" || typeof getConfirmedAt !== "function" || typeof onConfirm !== "function") {
    fail("confirmation callbacks are required");
  }
  if (getCurrentPixelAvailability !== undefined && typeof getCurrentPixelAvailability !== "function") fail("getCurrentPixelAvailability must be a function");
  if (onClose !== undefined && typeof onClose !== "function") fail("onClose must be a function");
  if (new Set(projection.rows.map((row) => row.projectionRowId)).size !== projection.rows.length
      || projection.rows.some((row) => !Array.isArray(row.fields) || row.fields.length !== 6
        || row.fields.some((field, index) => field.field !== FIELDS[index])
        || !Array.isArray(row.sourceRefs))) fail("FinalProjection3 rows have an invalid shape");
  return input;
}

function makeFieldState(field) { return { value: field.finalValue, unknown: false, editing: false }; }

export async function mountTradeFinalReview(input) {
  validateMountInput(input);
  const { root, projection, rawEvidence, sourceEvidence, reviewRevision, getCurrentProjectionHash,
    getCurrentPixelAvailability, getConfirmedAt, onConfirm, onClose } = input;
  const rowState = new Map(projection.rows.map((row) => [row.projectionRowId, {
    fields: new Map(row.fields.map((field) => [field.field, makeFieldState(field)])),
    disposition: row.classification === "NEEDS_RECAPTURE" ? "RECAPTURE_REQUIRED" : "INCLUDE",
    reason: "", reasonError: false, editing: false,
  }]));
  const edgeState = new Map(projection.edgeWorkItems.map((work) => [work.workItemId, {
    decision: "RECAPTURE_REQUIRED", reason: work.reason, exclusionReason: "", reasonError: false,
  }]));
  const sourceRows = new Map(rawEvidence.sourceRows.map((row) => [row.sourceRowId, row]));
  const captureMap = new Map(rawEvidence.captures.map((capture) => [capture.captureId, capture]));
  const cropMap = new Map();
  for (const row of rawEvidence.sourceRows) for (const field of row.fields ?? []) {
    for (const crop of field.cropRefs ?? []) cropMap.set(crop.cropRefId, crop);
  }
  let activeTab = "problem";
  let selected = null;
  let selectedSourceIndex = 0;
  let pixelStale = false;
  let projectionStale = false;
  let loadingPixels = true;
  let busy = false;
  let completed = false;
  let destroyed = false;
  let selectionToken = 0;
  let imageRequestToken = 0;
  const objectUrls = new Set();
  const listenerController = new AbortController();

  root.innerHTML = `
    <div class="trade-final-review-shell">
      <header class="trade-final-review-header">
        <div class="trade-final-review-title-row"><div><p class="trade-final-review-eyebrow">물교 최종 검수</p><h2>확인이 필요한 항목부터 검토하세요.</h2><p class="trade-final-review-intro">문제가 없는 결과는 그대로 유지됩니다. 자동 분류는 사람의 정답 확인을 뜻하지 않습니다.</p></div><button type="button" class="trade-final-review-button" data-action="close" aria-label="최종 검수 닫기">닫기</button></div>
        <div class="trade-final-review-summary" data-role="summary" aria-label="검수 요약"></div>
        <div class="trade-final-review-state" data-role="stale" role="status" aria-live="polite" hidden></div>
      </header>
      <nav class="trade-final-review-tabs" role="tablist" aria-label="결과 보기">
        <button type="button" role="tab" data-tab="problem" aria-selected="true" aria-controls="trade-final-review-panel">확인 필요</button>
        <button type="button" role="tab" data-tab="all" aria-selected="false" aria-controls="trade-final-review-panel">전체 결과</button>
        <button type="button" role="tab" data-tab="original" aria-selected="false" aria-controls="trade-final-review-panel">원본·OCR</button>
      </nav>
      <main class="trade-final-review-body" id="trade-final-review-panel">
        <aside class="trade-final-review-list" data-role="list" aria-label="물교 행 목록"></aside>
        <section class="trade-final-review-source" data-role="source" aria-label="원본 행 확인"></section>
        <section class="trade-final-review-fields" data-role="fields" aria-label="최종 6개 항목"></section>
      </main>
      <footer class="trade-final-review-footer">
        <p data-role="message" role="status" aria-live="polite"></p>
        <div class="trade-final-review-confirmation"><p>검수를 완료해도 회차에는 아직 적용되지 않습니다.</p><button type="button" class="trade-final-review-button trade-final-review-primary" data-action="confirm" disabled>검수 완료</button></div>
      </footer>
    </div>`;

  const refs = Object.fromEntries(["summary", "stale", "list", "source", "fields", "message", "confirm"]
    .map((key) => [key, root.querySelector(`[data-role="${key}"]`) ?? root.querySelector(`[data-action="${key}"]`)]));
  refs.confirm = root.querySelector('[data-action="confirm"]');

  function problemItems() {
    return [
      ...projection.rows.filter((row) => row.classification !== "FINAL_READY").map((row) => ({ type: "row", id: row.projectionRowId, row })),
      ...projection.edgeWorkItems.map((work) => ({ type: "edge", id: work.workItemId, work })),
    ];
  }
  function allItems() { return projection.rows.map((row) => ({ type: "row", id: row.projectionRowId, row })); }
  function activeItems() { return activeTab === "problem" ? problemItems() : allItems(); }
  function stateText(item) {
    if (item.type === "edge") return "다시 캡처 필요";
    return STATUS[item.row.classification] ?? "확인 필요";
  }
  function selectedRow() { return selected?.type === "row" ? projection.rows.find((row) => row.projectionRowId === selected.id) : null; }
  function selectedEdge() { return selected?.type === "edge" ? projection.edgeWorkItems.find((item) => item.workItemId === selected.id) : null; }
  function selectedRowState() { return selected ? rowState.get(selected.id) : null; }
  function clearObjectUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  }
  function revokeContainerUrls(container) {
    for (const image of container.querySelectorAll("img")) {
      const url = image.currentSrc || image.src;
      if (!objectUrls.has(url)) continue;
      URL.revokeObjectURL(url); objectUrls.delete(url);
    }
  }
  function createUrl(blob) {
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    return url;
  }
  function setMessage(text, error = false) {
    refs.message.textContent = text ?? "";
    refs.message.classList.toggle("is-error", error);
  }
  function updateStaleView() {
    const messages = [];
    if (projectionStale || pixelStale) messages.push("검수 결과가 변경되었습니다. 다시 결과를 생성해 주세요.");
    else if (loadingPixels) messages.push("원본 확인 상태를 검사하고 있습니다.");
    refs.stale.hidden = messages.length === 0;
    refs.stale.textContent = messages.join(" ");
    refs.confirm.disabled = completed || busy || loadingPixels || projectionStale || pixelStale;
  }
  function updateSummary() {
    const counts = Object.fromEntries(Object.keys(STATUS).map((key) => [key, projection.rows.filter((row) => row.classification === key).length]));
    const primary = [
      ["최종 행", projection.rows.length], ["확인 필요", counts.NEEDS_REVIEW],
      ["다시 캡처 필요", counts.NEEDS_RECAPTURE], ["충돌", counts.CONFLICT],
    ];
    const secondary = [
      ["캡처", rawEvidence.captures.length], ["원본 행", rawEvidence.sourceRows.length],
      ["자동 검증", counts.FINAL_READY], ["잘린 영역", projection.edgeWorkItems.length],
    ];
    const group = (className, label, values) => {
      const section = node("section", className);
      section.setAttribute("aria-label", label);
      for (const [name, value] of values) {
        const cell = node("div", "trade-final-review-summary-item");
        cell.dataset.metric = name;
        cell.append(node("span", "", name), node("strong", "", value));
        section.append(cell);
      }
      return section;
    };
    refs.summary.replaceChildren(group("trade-final-review-summary-primary", "주요 결과", primary),
      group("trade-final-review-summary-details", "세부 정보", secondary));
  }
  function summarizeRow(row) {
    const values = Object.fromEntries(row.fields.map((field) => [field.field, field.finalValue]));
    return `${prettyValue(values.island)} · ${prettyValue(values.fromItem)} → ${prettyValue(values.toItem)} · ${prettyValue(values.count)}/${prettyValue(values.yield)}`;
  }
  function renderList() {
    refs.list.replaceChildren();
    const items = activeItems();
    if (activeTab === "problem" && items.length === 0) {
      refs.list.append(node("p", "trade-final-review-empty", "추가 확인이 필요한 행이 없습니다."));
      return;
    }
    if (items.length === 0) {
      refs.list.append(node("p", "trade-final-review-empty", "표시할 결과가 없습니다."));
      return;
    }
    items.forEach((item, index) => {
      const current = selected?.type === item.type && selected.id === item.id;
      const select = button("", "select-item", "trade-final-review-list-item");
      select.dataset.itemType = item.type;
      select.dataset.itemId = item.id;
      select.setAttribute("aria-current", current ? "true" : "false");
      const title = item.type === "edge" ? "다시 캡처해야 하는 잘린 영역" : `행 ${index + 1}`;
      select.append(node("span", "trade-final-review-list-heading", title),
        node("span", `trade-final-review-badge status-${item.type === "edge" ? "NEEDS_RECAPTURE" : item.row.classification}`, stateText(item)),
        node("span", "trade-final-review-list-summary", item.type === "edge" ? reasonLabel(item.work.reason) : summarizeRow(item.row)));
      refs.list.append(select);
    });
  }

  function showImageError(container, error) {
    revokeContainerUrls(container);
    container.replaceChildren(node("p", "trade-final-review-source-unavailable", "원본 이미지를 확인할 수 없습니다. 다시 캡처가 필요할 수 있습니다."));
    container.dataset.sourceError = error?.code ?? "SOURCE_UNAVAILABLE";
  }
  function appendImage(container, blob, alt, token, overlay = null) {
    revokeContainerUrls(container);
    const image = node("img", "trade-final-review-image", "");
    image.alt = alt;
    const url = createUrl(blob);
    image.src = url;
    image.addEventListener("error", () => {
      if (!objectUrls.has(url)) return;
      URL.revokeObjectURL(url); objectUrls.delete(url);
      if (token === selectionToken && !destroyed) showImageError(container, new Error("IMAGE_DISPLAY_FAILED"));
    }, { once: true });
    container.replaceChildren(image);
    if (overlay) {
      const frame = node("div", "trade-final-review-capture-frame");
      frame.append(image);
      const box = overlay.box;
      if (box && Number.isFinite(box.x) && Number.isFinite(box.y) && Number.isFinite(box.width) && Number.isFinite(box.height)
          && overlay.frame?.width > 0 && overlay.frame?.height > 0) {
        const marker = node("div", "trade-final-review-location");
        marker.style.left = `${box.x / overlay.frame.width * 100}%`;
        marker.style.top = `${box.y / overlay.frame.height * 100}%`;
        marker.style.width = `${box.width / overlay.frame.width * 100}%`;
        marker.style.height = `${box.height / overlay.frame.height * 100}%`;
        marker.setAttribute("aria-label", "원본 행 위치"); frame.append(marker);
      }
      container.replaceChildren(frame);
    }
  }
  function rawField(sourceRowId, fieldName) {
    const source = sourceRows.get(sourceRowId);
    return source?.fields?.find((field) => field.field === fieldName) ?? null;
  }
  function rawCrop(sourceRowId, fieldName, cropRefId = null) {
    const refsForField = rawField(sourceRowId, fieldName)?.cropRefs ?? [];
    return cropRefId ? refsForField.find((crop) => crop.cropRefId === cropRefId) ?? null : refsForField[0] ?? null;
  }
  function renderSourcePanel(token) {
    refs.source.replaceChildren();
    const row = selectedRow();
    const edge = selectedEdge();
    const heading = node("h3", "", row ? "원본 행" : "잘린 영역");
    refs.source.append(heading);
    if (edge) {
      refs.source.append(node("p", "trade-final-review-reason", reasonLabel(edge.reason)));
      const captureId = edge.sourceRefs?.[0]?.captureId ?? rawEvidence.edgeSegments.find((raw) => raw.edgeId === edge.edgeId)?.captureId;
      const rawEdge = rawEvidence.edgeSegments.find((raw) => raw.edgeId === edge.edgeId);
      const show = button("전체 화면에서 위치 보기", "show-edge-capture");
      refs.source.append(show, node("div", "trade-final-review-image-panel", ""));
      show.dataset.captureId = captureId ?? "";
      show.dataset.box = JSON.stringify(rawEdge?.rowBox ?? null);
      return;
    }
    if (!row) {
      refs.source.append(node("p", "trade-final-review-empty", "왼쪽 목록에서 행을 선택하세요."));
      return;
    }
    const sourceRefs = row.sourceRefs;
    if (!sourceRefs.length) {
      refs.source.append(node("p", "trade-final-review-source-unavailable", "원본 이미지를 확인할 수 없습니다. 다시 캡처가 필요할 수 있습니다."));
      return;
    }
    selectedSourceIndex = Math.max(0, Math.min(selectedSourceIndex, sourceRefs.length - 1));
    if (sourceRefs.length > 1) {
      const selector = node("div", "trade-final-review-source-selector");
      sourceRefs.forEach((source, index) => {
        const sourceButton = button(`원본 ${index + 1}`, "select-source");
        sourceButton.dataset.index = String(index);
        sourceButton.setAttribute("aria-pressed", String(index === selectedSourceIndex));
        selector.append(sourceButton);
      });
      refs.source.append(selector);
    }
    const sourceRef = sourceRefs[selectedSourceIndex];
    const source = sourceRows.get(sourceRef.sourceRowId);
    const displayPanel = node("div", "trade-final-review-image-panel");
    const status = node("p", "trade-final-review-source-status", "원본 행을 불러오는 중입니다.");
    const showFull = button("전체 화면에서 위치 보기", "show-capture");
    showFull.dataset.captureId = source?.captureId ?? sourceRef.captureId;
    refs.source.append(node("p", "trade-final-review-source-label", `원본 ${selectedSourceIndex + 1} · 행 ${sourceRef.ordinal + 1}`),
      status, displayPanel, showFull);
    if (!source) { showImageError(displayPanel, new Error("SOURCE_ROW_NOT_FOUND")); return; }
    const requestToken = ++imageRequestToken;
    Promise.resolve().then(() => sourceEvidence.createDisplayRowCrop(source.sourceRowId)).then((display) => {
      if (destroyed || token !== selectionToken || requestToken !== imageRequestToken || selectedRow()?.projectionRowId !== row.projectionRowId
          || selectedSourceIndex !== sourceRefs.indexOf(sourceRef)) {
        return;
      }
      status.textContent = `검증된 원본 행 · ${display.width} × ${display.height}`;
      displayPanel.replaceChildren();
      appendImage(displayPanel, display.blob, "검증된 원본 행", token);
    }).catch((error) => {
      if (token === selectionToken && requestToken === imageRequestToken && !destroyed) { status.textContent = ""; showImageError(displayPanel, error); }
    });
  }

  function renderOcrPanel(token) {
    refs.source.replaceChildren(node("h3", "", "원본·OCR"));
    refs.fields.replaceChildren();
    const row = selectedRow();
    if (!row) {
      refs.source.append(node("p", "trade-final-review-empty", "원본·OCR 정보를 볼 행을 선택하세요."));
      return;
    }
    for (const sourceRef of row.sourceRefs) {
      const source = sourceRows.get(sourceRef.sourceRowId);
      const section = node("section", "trade-final-review-ocr-source");
      section.append(node("h4", "", `원본 ${row.sourceRefs.indexOf(sourceRef) + 1}`));
      for (const fieldName of FIELDS) {
        const observed = rawField(sourceRef.sourceRowId, fieldName);
        const item = node("div", "trade-final-review-ocr-field");
        item.append(node("strong", "", LABELS[fieldName]), node("span", "", `인식 원문: ${prettyValue(observed?.rawText ?? null)}`));
        if (NUMERIC[fieldName]) item.append(node("span", "", `인식 숫자 후보: ${prettyValue(observed?.rawNumeric ?? null)}`));
        item.append(node("span", "", `인식 상태: ${readerStatusLabel(observed?.readerStatus)}`));
        const crop = observed?.cropRefs?.[0];
        if (crop) {
          const view = button("필드 원본 보기", "show-ocr-crop");
          view.dataset.cropRefId = crop.cropRefId;
          view.dataset.field = fieldName;
          view.dataset.sourceRowId = sourceRef.sourceRowId;
          item.append(view);
        }
        section.append(item);
      }
      refs.source.append(section);
    }
    refs.source.append(node("div", "trade-final-review-image-panel", ""));
    refs.source.dataset.selectionToken = String(token);
  }
  function readerStatusLabel(status) {
    const labels = { READ: "읽음", RAW_OCR_CANDIDATE: "인식 후보", EMPTY: "인식된 값 없음", EMPTY_OCR: "인식된 값 없음",
      FIELD_CLIPPED: "일부가 잘림", ERROR: "인식 오류", INVALID: "형식 확인 필요" };
    return labels[status] ?? "추가 확인 필요";
  }
  function renderFieldCrop(fieldName, cropRefId, sourceRowId, container, token) {
    const requestToken = ++imageRequestToken;
    revokeContainerUrls(container);
    container.replaceChildren(node("p", "trade-final-review-source-status", "필드 원본을 불러오는 중입니다."));
    Promise.resolve().then(() => sourceEvidence.createDisplayCrop(cropRefId)).then((display) => {
      if (destroyed || token !== selectionToken || requestToken !== imageRequestToken) return;
      container.replaceChildren(); appendImage(container, display.blob, `${LABELS[fieldName]} 원본`, token);
    }).catch((error) => { if (!destroyed && token === selectionToken && requestToken === imageRequestToken) showImageError(container, error); });
  }
  function renderFieldPanel(token) {
    refs.fields.replaceChildren();
    const row = selectedRow();
    const edge = selectedEdge();
    if (edge) {
      refs.fields.append(node("h3", "", "다시 캡처 필요"), node("p", "trade-final-review-edge-note", "잘린 영역에는 물교 행이나 항목을 만들어 넣지 않습니다."));
      renderEdgeDisposition(edge);
      return;
    }
    if (!row) { refs.fields.append(node("p", "trade-final-review-empty", "최종 항목이 없습니다.")); return; }
    const state = rowState.get(row.projectionRowId);
    const title = node("div", "trade-final-review-fields-heading");
    title.append(node("h3", "", `행 ${projection.rows.indexOf(row) + 1}`), node("span", `trade-final-review-badge status-${row.classification}`, STATUS[row.classification] ?? "확인 필요"));
    if (row.classification !== "NEEDS_RECAPTURE") {
      title.append(button(state.editing ? "수정 마치기" : "수정하기", "toggle-edit"));
    }
    refs.fields.append(title);
    const statusReasons = row.classificationReasons.map(reasonLabel).join(" ");
    if (statusReasons) refs.fields.append(node("p", "trade-final-review-reasons", statusReasons));
    if (row.classification === "FINAL_READY") refs.fields.append(node("p", "trade-final-review-ready-note", "현재 기준에서 추가 확인이 필요하지 않은 상태입니다. 사람 정답으로 독립 검증되었다는 뜻은 아닙니다."));
    for (const field of row.fields) renderField(field, row, state, token);
    renderRowDisposition(row, state);
    const diagnostic = node("details", "trade-final-review-diagnostics");
    diagnostic.append(node("summary", "", "왜 이렇게 보정됐나"));
    diagnostic.append(renderDiagnostics(row));
    refs.fields.append(diagnostic);
  }
  function renderField(field, row, state, token) {
    const fieldState = state.fields.get(field.field);
    const wrapper = node("section", "trade-final-review-field");
    wrapper.dataset.field = field.field;
    const heading = node("div", "trade-final-review-field-heading");
    heading.append(node("h4", "", LABELS[field.field]));
    if (field.valueState === "CONFLICT") heading.append(node("span", "trade-final-review-badge status-CONFLICT", "결과 충돌 · 확인 필요"));
    else if (field.riskReasons.length) heading.append(node("span", "trade-final-review-badge", "확인 사유 있음"));
    wrapper.append(heading);
    const locked = row.classification === "NEEDS_RECAPTURE" || state.disposition === "RECAPTURE_REQUIRED";
    const editable = !locked && state.editing;
    if (NUMERIC[field.field]) {
      const label = node("label", "trade-final-review-input-label", "최종 값");
      const input = node("input", "trade-final-review-input");
      input.type = "number"; input.min = String(NUMERIC[field.field].min); input.step = "1";
      input.value = fieldState.value === null ? "" : String(fieldState.value);
      input.disabled = !editable || fieldState.unknown;
      input.setAttribute("aria-label", `${LABELS[field.field]} 최종 값`);
      input.dataset.action = "field-value"; input.dataset.rowId = row.projectionRowId; input.dataset.field = field.field;
      label.append(input, node("span", "trade-final-review-hint", NUMERIC[field.field].label)); wrapper.append(label);
    } else {
      const label = node("label", "trade-final-review-input-label", "최종 값");
      const input = node("input", "trade-final-review-input");
      input.type = "text"; input.value = fieldState.value === null ? "" : String(fieldState.value);
      input.disabled = !editable || fieldState.unknown;
      input.setAttribute("aria-label", `${LABELS[field.field]} 최종 값`);
      input.dataset.action = "field-value"; input.dataset.rowId = row.projectionRowId; input.dataset.field = field.field;
      label.append(input); wrapper.append(label);
    }
    const actions = node("div", "trade-final-review-field-actions");
    if (editable) {
      actions.append(button(fieldState.unknown ? "원래 값으로 되돌리기" : "모름으로 표시", fieldState.unknown ? "restore-field" : "mark-unknown"));
      if (!fieldState.unknown) actions.append(button("원래 값으로 되돌리기", "restore-field"));
    }
    const crops = field.cropRefs.map((cropRefId) => cropMap.get(cropRefId)).filter(Boolean);
    crops.forEach((crop, index) => {
      const view = button(crops.length > 1 ? `필드 원본 ${index + 1} 보기` : "필드 원본 보기", "show-field-crop");
      view.dataset.cropRefId = crop.cropRefId; view.dataset.field = field.field; view.dataset.sourceRowId = crop.sourceRowId;
      actions.append(view);
    });
    if (field.valueState === "CONFLICT" && Array.isArray(field.alternatives)) {
      const alternatives = node("div", "trade-final-review-alternatives");
      alternatives.append(node("strong", "", "확인된 후보"));
      field.alternatives.forEach((alternative, index) => {
        const item = node("div", "trade-final-review-alternative");
        item.append(node("span", "", prettyValue(alternative.value)));
        const choose = button("이 값 사용", "choose-alternative");
        choose.dataset.rowId = row.projectionRowId; choose.dataset.field = field.field; choose.dataset.index = String(index);
        item.append(choose);
        const refsForAlternative = alternative.sourceRefs ?? [];
        refsForAlternative.forEach((sourceRef) => {
          const sourceId = sourceRef.sourceRowId ?? sourceRef;
          const crop = rawCrop(sourceId, field.field);
          if (crop) {
            const view = button("원본 보기", "show-field-crop");
            view.dataset.cropRefId = crop.cropRefId; view.dataset.field = field.field; view.dataset.sourceRowId = sourceId;
            item.append(view);
          } else item.append(node("span", "trade-final-review-no-source", "원본 없음"));
        });
        alternatives.append(item);
      });
      wrapper.append(alternatives);
    }
    const cropPanel = node("div", "trade-final-review-crop-panel", "");
    cropPanel.dataset.cropPanel = field.field;
    const cropStatus = node("p", "trade-final-review-validation", "");
    wrapper.append(actions, cropStatus, cropPanel, renderRiskList(field.riskReasons));
    refs.fields.append(wrapper);
  }
  function renderRiskList(reasons) {
    const list = node("ul", "trade-final-review-risk-list");
    reasons.forEach((reason) => list.append(node("li", "", reasonLabel(reason))));
    return list;
  }
  function renderDiagnostics(row) {
    const container = node("div", "trade-final-review-diagnostic-content");
    row.fields.forEach((field) => {
      const section = node("section", "trade-final-review-diagnostic-field");
      section.append(node("h5", "", LABELS[field.field]), node("p", "", `보정 이유: ${field.correctionReasons.map(reasonLabel).join(" ") || "기록된 이유 없음"}`),
        node("p", "", `확인 코드: ${[...field.riskReasons, ...field.correctionReasons].join(", ") || "없음"}`));
      for (const candidate of field.candidates) section.append(node("p", "", `후보: ${prettyValue(candidate.value)} · ${candidate.reason}`));
      for (const trace of field.stageTrace) section.append(node("p", "", `단계 ${trace.stage}: ${prettyValue(trace.inputValue)} → ${prettyValue(trace.outputValue)}${trace.reason ? ` · ${trace.reason}` : ""}`));
      container.append(section);
    });
    const refsDetails = node("details", "trade-final-review-technical-details");
    refsDetails.append(node("summary", "", "기술 식별 정보"), node("pre", "", JSON.stringify({
      projectionRowId: row.projectionRowId, sourceRefs: row.sourceRefs, fields: row.fields.map((field) => ({
        field: field.field, identity: field.identity, rawEvidenceRefs: field.rawEvidenceRefs,
        cropRefs: field.cropRefs, alternatives: field.alternatives, stageTrace: field.stageTrace,
      })),
    }, null, 2)));
    container.append(refsDetails);
    return container;
  }
  function renderRowDisposition(row, state) {
    const section = node("section", "trade-final-review-disposition");
    section.append(node("h4", "", "목록 포함 상태"));
    if (state.disposition === "EXCLUDE") {
      section.append(node("p", "", "이 행은 최종 목록에서 제외됩니다."), button("제외 취소", "cancel-exclusion"));
      const label = node("label", "trade-final-review-input-label", "제외 사유");
      const input = node("input", "trade-final-review-input"); input.type = "text"; input.value = state.reason;
      input.dataset.action = "row-exclusion-reason"; input.dataset.rowId = row.projectionRowId; input.setAttribute("aria-label", "제외 사유");
      label.append(input); section.append(label);
      if (state.reasonError) section.append(node("p", "trade-final-review-validation is-error", "제외 사유를 입력해 주세요."));
    } else if (row.classification === "NEEDS_RECAPTURE") {
      section.append(node("p", "", "다시 캡처해야 합니다. 입력만으로 목록에 포함할 수 없습니다."),
        button("목록에서 제외", "exclude-row"));
    } else {
      section.append(node("p", "", state.disposition === "RECAPTURE_REQUIRED" ? "다시 캡처 필요" : "최종 목록에 포함"));
      section.append(button("목록에서 제외", "exclude-row"));
    }
    section.append(node("p", "trade-final-review-reason-hint", "제외를 선택하면 사유가 필요합니다."));
    refs.fields.append(section);
  }
  function renderEdgeDisposition(edge) {
    const state = edgeState.get(edge.workItemId);
    const section = node("section", "trade-final-review-disposition");
    if (state.decision === "EXPLICITLY_EXCLUDED") {
      section.append(node("p", "", "이 잘린 영역은 명시적으로 제외됩니다."), button("제외 취소", "cancel-edge-exclusion"));
      const label = node("label", "trade-final-review-input-label", "제외 사유");
      const input = node("input", "trade-final-review-input"); input.type = "text"; input.value = state.exclusionReason;
      input.dataset.action = "edge-exclusion-reason"; input.dataset.workId = edge.workItemId; input.setAttribute("aria-label", "잘린 영역 제외 사유");
      label.append(input); section.append(label);
      if (state.reasonError) section.append(node("p", "trade-final-review-validation is-error", "제외 사유를 입력해 주세요."));
    } else section.append(node("p", "", "기본 처리: 다시 캡처 필요"), button("목록에서 제외", "exclude-edge"),
      node("p", "trade-final-review-reason-hint", reasonLabel(edge.reason)));
    refs.fields.append(section);
  }
  function renderSelected() {
    const token = ++selectionToken;
    imageRequestToken += 1;
    clearObjectUrls();
    if (activeTab === "original") { renderOcrPanel(token); return; }
    renderSourcePanel(token);
    renderFieldPanel(token);
  }
  function render() {
    updateSummary();
    root.querySelectorAll("[role=tab]").forEach((tab) => {
      const active = tab.dataset.tab === activeTab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    renderList();
    renderSelected();
    updateStaleView();
  }
  function defaultDisposition(row) { return row.classification === "NEEDS_RECAPTURE" ? "RECAPTURE_REQUIRED" : "INCLUDE"; }
  function selectItem(type, id) {
    selected = { type, id };
    selectedSourceIndex = 0;
    renderList(); renderSelected();
  }
  function rowValidationError() {
    for (const row of projection.rows) {
      const state = rowState.get(row.projectionRowId);
      if (state.disposition === "EXCLUDE") {
        if (!nonempty(state.reason)) { state.reasonError = true; selectItem("row", row.projectionRowId); return "제외한 행마다 사유를 입력해 주세요."; }
        state.reasonError = false; continue;
      }
      if (state.disposition === "RECAPTURE_REQUIRED") continue;
      for (const field of row.fields) {
        const fieldState = state.fields.get(field.field);
        if (fieldState.unknown) continue;
        if (fieldState.value === null || fieldState.value === undefined || fieldState.value === "") {
          selectItem("row", row.projectionRowId); return `${LABELS[field.field]} 값을 입력하거나 모름으로 표시해 주세요.`;
        }
        if (NUMERIC[field.field]) {
          const text = String(fieldState.value);
          if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < NUMERIC[field.field].min) {
            selectItem("row", row.projectionRowId); return `${LABELS[field.field]}은(는) ${NUMERIC[field.field].label}이어야 합니다.`;
          }
        } else if (typeof fieldState.value !== "string" || !fieldState.value.trim()) {
          selectItem("row", row.projectionRowId); return `${LABELS[field.field]}을(를) 입력하거나 모름으로 표시해 주세요.`;
        }
      }
    }
    for (const edge of projection.edgeWorkItems) {
      const state = edgeState.get(edge.workItemId);
      if (state.decision === "EXPLICITLY_EXCLUDED" && !nonempty(state.exclusionReason)) {
        state.reasonError = true; selectItem("edge", edge.workItemId); return "제외한 잘린 영역에 사유를 입력해 주세요.";
      }
      state.reasonError = false;
    }
    return null;
  }
  function completionInput() {
    return {
      projection,
      reviewRevision,
      rows: projection.rows.map((row) => {
        const state = rowState.get(row.projectionRowId);
        return { projectionRowId: row.projectionRowId, sourceRefs: clone(row.sourceRefs),
          fields: row.fields.map((field) => {
            const fieldState = state.fields.get(field.field);
            return { field: field.field, finalValue: fieldState.unknown ? null : fieldState.value, unknown: fieldState.unknown };
          }), disposition: state.disposition, dispositionReason: state.disposition === "EXCLUDE" ? state.reason : null };
      }),
      workItems: projection.edgeWorkItems.map((work) => {
        const state = edgeState.get(work.workItemId);
        return { workItemId: work.workItemId, decision: state.decision,
          reason: state.decision === "EXPLICITLY_EXCLUDED" ? state.exclusionReason : work.reason };
      }),
    };
  }
  async function readCurrentPixels() {
    const current = getCurrentPixelAvailability
      ? await getCurrentPixelAvailability()
      : await sourceEvidence.buildPixelAvailability(rawEvidence);
    if (!Array.isArray(current)) fail("pixel availability is unavailable");
    return current;
  }
  async function checkPixels() {
    const current = await readCurrentPixels();
    pixelStale = stableStringify(current) !== stableStringify(projection.pixelAvailability);
    if (pixelStale) setMessage("원본 확인 상태가 바뀌었습니다. 새 결과를 만들어 다시 확인해 주세요.", true);
    updateStaleView();
    return !pixelStale;
  }
  async function confirm() {
    if (completed || busy || projectionStale || pixelStale || loadingPixels) return;
    busy = true; refs.confirm.disabled = true; setMessage("");
    try {
      if (await getCurrentProjectionHash() !== projection.projectionHash) {
        projectionStale = true; setMessage("검수 결과가 변경되었습니다. 다시 결과를 생성해 주세요.", true); return;
      }
      if (!await checkPixels()) return;
      const error = rowValidationError();
      if (error) { renderList(); renderSelected(); setMessage(error, true); return; }
      const confirmedAt = await getConfirmedAt();
      if (!validTimestamp(confirmedAt)) fail("확인 시각은 UTC RFC3339 형식이어야 합니다.");
      const completion = buildFinalReviewCompletion({ ...completionInput(), confirmedAt });
      await onConfirm(completion);
      completed = true;
      setMessage("검수 완료. 다음 단계에서 검수 자료를 저장하고 회차 적용을 선택할 수 있습니다.");
    } catch (error) {
      setMessage(error instanceof Error && error.message === "확인 시각은 UTC RFC3339 형식이어야 합니다."
        ? error.message : "결과를 처리하지 못했습니다. 다시 시도해 주세요.", true);
    } finally {
      busy = false; updateStaleView();
    }
  }

  async function showFullCapture(captureId, box, token) {
    const panel = refs.source.querySelector(".trade-final-review-image-panel");
    if (!panel) return;
    const requestToken = ++imageRequestToken;
    revokeContainerUrls(panel);
    panel.replaceChildren(node("p", "trade-final-review-source-status", "전체 캡처를 불러오는 중입니다."));
    try {
      const capture = await sourceEvidence.createDisplayCapture(captureId);
      if (destroyed || token !== selectionToken || requestToken !== imageRequestToken) return;
      const meta = captureMap.get(captureId);
      appendImage(panel, capture.blob, "원본 전체 캡처", token, { box, frame: capture.frame ?? meta?.frame });
    } catch (error) { if (!destroyed && token === selectionToken && requestToken === imageRequestToken) showImageError(panel, error); }
  }
  function actionTarget(target, selector) { return target instanceof Element ? target.closest(selector) : null; }
  root.addEventListener("click", async (event) => {
    const tab = actionTarget(event.target, "[role=tab][data-tab]");
    if (tab) { activeTab = tab.dataset.tab; render(); return; }
    const itemButton = actionTarget(event.target, '[data-action="select-item"]');
    if (itemButton) { selectItem(itemButton.dataset.itemType, itemButton.dataset.itemId); return; }
    const sourceButton = actionTarget(event.target, '[data-action="select-source"]');
    if (sourceButton) { selectedSourceIndex = Number(sourceButton.dataset.index); renderList(); renderSelected(); return; }
    const actionButton = actionTarget(event.target, "button[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    const row = selectedRow();
    const state = selectedRowState();
    if (action === "close") { onClose?.(); const dialog = root.closest("dialog"); if (dialog?.open) dialog.close(); return; }
    if (action === "confirm") { await confirm(); return; }
    if (action === "toggle-edit" && row && state) { state.editing = !state.editing; renderSelected(); return; }
    if (action === "mark-unknown" && row && state) { const target = actionButton; const field = target.closest("[data-field]")?.dataset.field;
      const fieldState = state.fields.get(field); if (fieldState) { fieldState.value = null; fieldState.unknown = true; renderSelected(); } return; }
    if (action === "restore-field" && row && state) { const field = actionButton.closest("[data-field]")?.dataset.field;
      const target = row.fields.find((item) => item.field === field); const fieldState = state.fields.get(field);
      if (target && fieldState) { fieldState.value = target.finalValue; fieldState.unknown = false; renderSelected(); } return; }
    if (action === "choose-alternative" && row && state) {
      const fieldName = actionButton.dataset.field; const index = Number(actionButton.dataset.index);
      const alternative = row.fields.find((field) => field.field === fieldName)?.alternatives[index];
      const fieldState = state.fields.get(fieldName);
      if (alternative && fieldState && !fieldState.unknown) { fieldState.value = alternative.value; state.editing = true; renderSelected(); }
      return;
    }
    if (action === "exclude-row" && row && state) { state.disposition = "EXCLUDE"; state.reasonError = false; renderSelected(); return; }
    if (action === "cancel-exclusion" && row && state) { state.disposition = defaultDisposition(row); state.reason = ""; state.reasonError = false; renderSelected(); return; }
    if (action === "exclude-edge") { const edge = selectedEdge(); if (edge) { const edgeStatus = edgeState.get(edge.workItemId); edgeStatus.decision = "EXPLICITLY_EXCLUDED"; edgeStatus.exclusionReason = ""; renderSelected(); } return; }
    if (action === "cancel-edge-exclusion") { const edge = selectedEdge(); if (edge) { const edgeStatus = edgeState.get(edge.workItemId); edgeStatus.decision = "RECAPTURE_REQUIRED"; edgeStatus.exclusionReason = ""; edgeStatus.reasonError = false; renderSelected(); } return; }
    if (action === "show-capture" && row) {
      const ref = row.sourceRefs[selectedSourceIndex]; const source = sourceRows.get(ref?.sourceRowId);
      await showFullCapture(actionButton.dataset.captureId, source?.rowBox ?? row.rowBox, selectionToken); return;
    }
    if (action === "show-edge-capture") {
      let box = null; try { box = JSON.parse(actionButton.dataset.box); } catch { /* missing geometry is shown without a marker */ }
      await showFullCapture(actionButton.dataset.captureId, box, selectionToken); return;
    }
    if (action === "show-field-crop" || action === "show-ocr-crop") {
      const panel = actionButton.closest("[data-field]")?.querySelector("[data-crop-panel]")
        ?? refs.source.querySelector(".trade-final-review-image-panel");
      if (panel) renderFieldCrop(actionButton.dataset.field, actionButton.dataset.cropRefId,
        actionButton.dataset.sourceRowId, panel, selectionToken);
    }
  }, { signal: listenerController.signal });
  root.addEventListener("input", (event) => {
    const inputElement = event.target;
    if (!(inputElement instanceof HTMLInputElement)) return;
    if (inputElement.dataset.action === "field-value") {
      const state = rowState.get(inputElement.dataset.rowId)?.fields.get(inputElement.dataset.field);
      if (state) {
        if (inputElement.value === "") state.value = null;
        else if (NUMERIC[inputElement.dataset.field] && /^(0|[1-9][0-9]*)$/.test(inputElement.value)
            && Number.isSafeInteger(Number(inputElement.value))) state.value = Number(inputElement.value);
        else state.value = inputElement.value;
      }
    } else if (inputElement.dataset.action === "row-exclusion-reason") {
      const state = rowState.get(inputElement.dataset.rowId); if (state) state.reason = inputElement.value;
    } else if (inputElement.dataset.action === "edge-exclusion-reason") {
      const state = edgeState.get(inputElement.dataset.workId); if (state) state.exclusionReason = inputElement.value;
    }
  }, { signal: listenerController.signal });

  function chooseInitial() {
    const firstProblem = problemItems()[0];
    const firstAll = allItems()[0];
    selected = firstProblem ?? firstAll ?? null;
  }
  chooseInitial();
  render();
  try {
    const current = await readCurrentPixels();
    pixelStale = stableStringify(current) !== stableStringify(projection.pixelAvailability);
  } catch {
    pixelStale = true;
  } finally {
    loadingPixels = false; updateStaleView();
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true; selectionToken += 1; imageRequestToken += 1;
      listenerController.abort(); clearObjectUrls(); root.replaceChildren();
      const dialog = root.closest("dialog"); if (dialog?.open) dialog.close();
    },
  };
}
