import { refreshPersistentState, saveWarehouseInventory } from "./persistence.js";
import { state } from "./state.js";
import { inventoryDisplayOrder } from "./inventory-ui.js";

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const knownDecisions = new Set(["MATCH", "EMPTY", "TIER5_IGNORE"]);

const dialog = document.createElement("dialog");
dialog.className = "patch-review-dialog";
dialog.setAttribute("aria-labelledby", "patch-review-title");
document.body.append(dialog);

let context = null;

function currentStocks() {
  return Object.fromEntries(state.inventory.map((item) => [item.programName, item.stock]));
}

function correctionSlots() {
  return (context.report.slots ?? []).filter((slot) => !knownDecisions.has(slot.decision));
}

function ensureCorrection(slot) {
  if (!context.corrections.has(slot.slot)) {
    const candidate = slot.finalItem ?? (slot.decision === "QUANTITY_UNKNOWN" ? slot.bestCandidate : null);
    const item = state.inventory.find((entry) => entry.programName === candidate && entry.tier <= 4);
    context.corrections.set(slot.slot, {
      name: item?.programName ?? "",
      quantity: slot.quantity?.status === "QUANTITY_MATCH" ? String(slot.quantity.value) : "",
      excluded: false,
      itemCheck: "unchecked",
    });
  }
  return context.corrections.get(slot.slot);
}

function effectivePatch() {
  const items = { ...context.patch.items };
  const pending = correctionSlots();
  for (const slot of pending) {
    const value = ensureCorrection(slot);
    if (value.excluded) continue;
    const quantity = value.quantity === "" ? NaN : Number(value.quantity);
    const item = state.inventory.find((entry) => entry.programName === value.name && entry.tier <= 4);
    if (!item || !Number.isSafeInteger(quantity) || quantity < 0) return null;
    if ((value.itemCheck === "match" && value.name !== slot.bestCandidate) || (value.itemCheck === "different" && value.name === slot.bestCandidate)) return null;
    const combined = (items[item.programName] ?? 0) + quantity;
    if (!Number.isSafeInteger(combined)) return null;
    items[item.programName] = combined;
  }
  return items;
}

function updateApplyState() {
  const button = dialog.querySelector('[data-action="apply"]');
  if (!button) return;
  const items = effectivePatch();
  button.disabled = !items || Object.keys(items).length === 0;
  const missing = correctionSlots().filter((slot) => {
    const correction = ensureCorrection(slot);
    if (correction.excluded) return false;
    const quantity = correction.quantity === "" ? NaN : Number(correction.quantity);
    return !state.inventory.some((item) => item.programName === correction.name && item.tier <= 4)
      || !Number.isSafeInteger(quantity) || quantity < 0
      || (correction.itemCheck === "match" && correction.name !== slot.bestCandidate)
      || (correction.itemCheck === "different" && correction.name === slot.bestCandidate);
  }).length;
  const count = dialog.querySelector("[data-role='review-count']");
  if (count) count.textContent = missing
    ? `확정 ${Object.keys(context.patch.items).length}개 · 직접 확인 ${correctionSlots().length}칸 · 입력·추측 확인 남음 ${missing}칸`
    : `확정 ${Object.keys(context.patch.items).length}개와 직접 보정 ${correctionSlots().filter((slot) => !ensureCorrection(slot).excluded).length}칸을 저장합니다. 비대상으로 표시한 칸은 제외합니다.`;
}

function renderCorrectionRow(slot, index, itemOptions) {
  const correction = ensureCorrection(slot);
  const row = make("tr", "patch-correction-row");
  row.dataset.slot = slot.slot;
  row.dataset.tier = String(slot.tier ?? "");
  const slotCell = document.createElement("td");
  const preview = make("canvas", "patch-slot-preview");
  preview.width = 120; preview.height = 120;
  preview.dataset.slotPreview = slot.slot;
  preview.setAttribute("aria-label", `${slot.slot} 창고 칸 이미지`);
  slotCell.append(preview, make("span", "patch-slot-label", slot.slot));
  row.append(slotCell);

  const itemCell = document.createElement("td");
  const itemInput = document.createElement("input");
  itemInput.type = "text";
  itemInput.className = "patch-correction-item";
  itemInput.setAttribute("list", `patch-correction-options-${index}`);
  itemInput.setAttribute("aria-label", `${slot.slot} 품목 선택`);
  itemInput.placeholder = "1~4단 품목 입력";
  itemInput.autocomplete = "off";
  itemInput.value = correction.name;
  const datalist = document.createElement("datalist");
  datalist.id = `patch-correction-options-${index}`;
  for (const item of itemOptions) datalist.append(make("option", "", item.programName));
  itemCell.append(itemInput, datalist);
  itemCell.append(make("small", "patch-correction-hint", `프로그램 추측: ${slot.bestCandidate ?? "없음"} · 점수 ${Number.isFinite(slot.bestScore) ? slot.bestScore.toFixed(4) : "없음"} · ${{QUANTITY_UNKNOWN: "수량 확인 필요", ICON_MATCH_UNKNOWN: "품목 추측 확인 필요", DUPLICATE_ITEM_DETECTED: "동일 품목 여러 칸"}[slot.decision] ?? "직접 확인 필요"}`));
  const check = document.createElement("select"); check.className = "patch-item-check"; check.setAttribute("aria-label", `${slot.slot} 프로그램 품목 추측 일치 여부`);
  for (const [value, label] of [["unchecked", "추측 일치 여부 미확인"], ["match", "추측과 일치"], ["different", "추측과 다름"]]) {
    const option = make("option", "", label); option.value = value; check.append(option);
  }
  check.value = correction.itemCheck;
  check.addEventListener("change", () => {
    correction.itemCheck = check.value;
    if (check.value === "match" && itemOptions.some(item => item.programName === slot.bestCandidate)) { correction.name = slot.bestCandidate; itemInput.value = correction.name; }
    updateApplyState();
  });
  itemCell.append(check);
  row.append(itemCell);

  const quantityCell = document.createElement("td");
  const quantityInput = document.createElement("input");
  quantityInput.type = "number"; quantityInput.min = "0"; quantityInput.step = "1";
  quantityInput.className = "patch-correction-quantity";
  quantityInput.setAttribute("aria-label", `${slot.slot} 수량`);
  quantityInput.placeholder = "수량";
  quantityInput.value = correction.quantity;
  quantityCell.append(quantityInput);
  row.append(quantityCell);

  const excludeCell = document.createElement("td");
  const excludeLabel = make("label", "patch-correction-exclude-label");
  const excludeInput = document.createElement("input");
  excludeInput.type = "checkbox";
  excludeInput.className = "patch-correction-exclude";
  excludeInput.checked = correction.excluded;
  excludeInput.setAttribute("aria-label", `${slot.slot} 재고 적용 대상 아님으로 제외`);
  excludeLabel.append(excludeInput, make("span", "", "비대상 제외"));
  excludeCell.append(excludeLabel);
  row.append(excludeCell);
  const syncExcluded = () => {
    correction.excluded = excludeInput.checked;
    itemInput.disabled = correction.excluded;
    quantityInput.disabled = correction.excluded;
    check.disabled = correction.excluded;
    row.classList.toggle("patch-correction-excluded", correction.excluded);
    updateApplyState();
  };
  excludeInput.addEventListener("change", syncExcluded);

  itemInput.addEventListener("input", () => { correction.name = itemInput.value.trim(); correction.itemCheck = "unchecked"; check.value = "unchecked"; updateApplyState(); });
  quantityInput.addEventListener("input", () => { correction.quantity = quantityInput.value; updateApplyState(); });
  return row;
}

function render() {
  const items = context.patch.items;
  const stock = currentStocks();
  const corrections = correctionSlots();
  const header = make("header", "patch-review-header");
  const titleArea = make("div");
  const title = make("h2", "", "마스터 창고 재고 검토"); title.id = "patch-review-title"; titleArea.append(title);
  titleArea.append(make("p", "patch-review-summary", "자동 확정된 값과 아래에서 직접 보정한 값을 확인한 뒤 한 번에 저장합니다. 이미지에 없거나 5단으로 확인된 품목과 목표 재고는 변경하지 않습니다."));
  const count = make("p", "patch-review-count", ""); count.dataset.role = "review-count";
  titleArea.append(count);
  header.append(titleArea);
  const close = make("button", "icon-button", "닫기"); close.type = "button"; close.dataset.action = "cancel"; close.setAttribute("aria-label", "검토 닫기");
  header.append(close);

  const body = make("main", "patch-review-body");
  const order = inventoryDisplayOrder();
  for (const tier of [4, 3, 2, 1]) {
    const names = order[String(tier)].filter((name) => Object.hasOwn(items, name));
    if (!names.length) continue;
    const section = make("section", "patch-review-tier");
    section.append(make("h3", "", `${tier}단 · 자동 인식`));
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const heading = document.createElement("tr");
    for (const text of ["품목", "기존 재고", "새 재고", "증감"]) heading.append(make("th", "", text));
    head.append(heading); table.append(head);
    const rows = document.createElement("tbody");
    for (const name of names) {
      const before = stock[name];
      const after = items[name];
      const row = make("tr", "patch-confirmed-row"); row.dataset.name = name; row.dataset.tier = String(tier);
      row.append(make("td", "item-name", name));
      row.append(make("td", "", before === null || before === undefined ? "미입력" : before.toLocaleString("ko-KR")));
      row.append(make("td", "", after.toLocaleString("ko-KR")));
      const delta = before === null || before === undefined ? "기존 미입력" : `${after - before >= 0 ? "+" : ""}${(after - before).toLocaleString("ko-KR")}`;
      row.append(make("td", "", delta));
      rows.append(row);
    }
    table.append(rows); section.append(table); body.append(section);
  }

  if (corrections.length) {
    const section = make("section", "patch-review-tier patch-correction-section");
    section.append(make("h3", "", `미인식 슬롯 · 직접 입력 ${corrections.length}칸`));
    section.append(make("p", "patch-correction-description", "각 칸 이미지를 보고 분류하세요. 1~4단이면 품목과 수량을 입력하고, 5단 이상 또는 재고 대상이 아니면 [비대상 제외]를 선택하세요. 확인을 마쳐야 적용 버튼이 활성화됩니다."));
    const table = document.createElement("table");
    const head = document.createElement("thead"); const heading = document.createElement("tr");
    for (const text of ["이미지 칸", "품목 (1~4단)", "수량", "제외"]) heading.append(make("th", "", text));
    head.append(heading); table.append(head);
    const rows = document.createElement("tbody");
    const itemOptions = state.inventory.filter((item) => item.tier >= 1 && item.tier <= 4);
    corrections.forEach((slot, index) => rows.append(renderCorrectionRow(slot, index, itemOptions)));
    table.append(rows); section.append(table); body.append(section);
  }

  const footer = make("footer", "patch-review-footer");
  const cancel = make("button", "", "취소"); cancel.type = "button"; cancel.dataset.action = "cancel";
  const apply = make("button", "primary", "모두 적용"); apply.type = "button"; apply.dataset.action = "apply";
  footer.append(make("small", "", "원본 이미지·판독 결과는 로컬 DB에 보존됩니다. 사용자 확인값은 재고 적용 시 함께 저장됩니다."), cancel, apply);
  dialog.replaceChildren(header, body, footer);
  for (const slot of corrections) {
    const correction = ensureCorrection(slot);
    if (correction.excluded) {
      const row = [...dialog.querySelectorAll(".patch-correction-row")].find((entry) => entry.dataset.slot === slot.slot);
      if (row) {
        row.querySelector(".patch-correction-exclude").checked = true;
        row.querySelector(".patch-correction-item").disabled = true;
        row.querySelector(".patch-correction-quantity").disabled = true;
        row.querySelector(".patch-item-check").disabled = true;
        row.classList.add("patch-correction-excluded");
      }
    }
  }
  apply.addEventListener("click", applyPatch);
  dialog.querySelectorAll('[data-action="cancel"]').forEach((button) => button.addEventListener("click", () => dialog.close()));
  updateApplyState();
}

async function renderSlotPreviews() {
  if (!context.imageFile || !context.report.grid) return;
  let bitmap;
  try { bitmap = await createImageBitmap(context.imageFile); }
  catch (error) {
    for (const canvas of dialog.querySelectorAll("[data-slot-preview]")) canvas.title = `미리보기 생성 실패: ${error.message}`;
    console.warn("창고 슬롯 미리보기 생성 실패", error);
    return;
  }
  try {
    for (const slot of correctionSlots()) {
      if (context !== dialogContext || !dialog.open) return;
      const canvas = [...dialog.querySelectorAll("[data-slot-preview]")].find((node) => node.dataset.slotPreview === slot.slot);
      if (!canvas) continue;
      const width = context.report.grid.slotWidth;
      const imageContext = canvas.getContext("2d");
      imageContext.imageSmoothingEnabled = false;
      imageContext.drawImage(bitmap, slot.x, slot.y, width, width, 0, 0, canvas.width, canvas.height);
    }
  } finally { bitmap.close?.(); }
}
let dialogContext = null;

function updateReviewFromCurrentState(message) {
  context.baseRevision = state.revision;
  context.baseStocks = currentStocks();
  render();
  context.setStatus(message, "info");
  void renderSlotPreviews();
}

async function applyPatch(event) {
  const button = event.currentTarget;
  const items = effectivePatch();
  if (!context || button.disabled || !items) return;
  button.disabled = true;
  try {
    const latest = await refreshPersistentState();
    const stockAtReview = context.baseStocks;
    const current = currentStocks();
    const inventoryChanged = Object.keys(items).some((name) => stockAtReview[name] !== current[name]);
    if (latest.revision !== context.baseRevision || inventoryChanged) {
      updateReviewFromCurrentState("저장 버전이 바뀌어 최신 재고로 검토 내용을 갱신했습니다. 직접 입력한 값과 현재 재고를 확인한 뒤 다시 적용해 주세요.");
      return;
    }
    const feedback = context.report.scanId ? {
      scanId: context.report.scanId,
      rows: correctionSlots().map(slot => {
        const value = ensureCorrection(slot);
        return { slot: slot.slot, name: value.excluded ? null : value.name, quantity: value.excluded ? null : Number(value.quantity), excluded: value.excluded, itemCheck: value.excluded ? "unchecked" : value.itemCheck };
      }),
    } : undefined;
    await saveWarehouseInventory(items, feedback);
    const setStatus = context.setStatus;
    const onApplied = context.onApplied;
    dialog.close();
    setStatus(`${Object.keys(items).length}개 품목의 창고 재고를 한 번에 저장했습니다.`, "success");
    onApplied();
  } catch (error) {
    if (error.status === 409 || error.code === "stale_revision") {
      await refreshPersistentState();
      updateReviewFromCurrentState("검토 중 저장 버전이 바뀌었습니다. 현재값으로 갱신했으니 직접 입력한 값도 다시 확인해 주세요.");
    } else if (error.committed) {
      try {
        await refreshPersistentState();
        const setStatus = context.setStatus;
        const onApplied = context.onApplied;
        dialog.close();
        setStatus("재고 저장은 완료됐고 최신 상태를 다시 불러왔습니다.", "success");
        onApplied();
      } catch {
        context.setStatus("서버 저장은 확인됐지만 최신 재고를 다시 불러오지 못했습니다. 재고 상태를 다시 읽어 확인해 주세요.", "error");
        const applyButton = dialog.querySelector('[data-action="apply"]');
        if (applyButton) applyButton.disabled = true;
      }
    } else {
      context.setStatus(`창고 재고를 저장하지 못했습니다: ${error.message}`, "error");
      const applyButton = dialog.querySelector('[data-action="apply"]');
      if (applyButton) applyButton.disabled = false;
    }
  }
}

export function openPatchReview(patch, report, { setStatus, onApplied, imageFile = null }) {
  if (!patch || patch.type !== "master_inventory_patch" || patch.version !== 1 || !patch.items) return;
  if (!Object.keys(patch.items).length && !(report.slots ?? []).some((slot) => !knownDecisions.has(slot.decision))) return;
  context = { patch, report, setStatus, onApplied, imageFile, corrections: new Map(), baseRevision: state.revision, baseStocks: currentStocks() };
  dialogContext = context;
  render();
  dialog.style.setProperty("--review-zoom", String(Number(getComputedStyle(document.body).zoom) || 1)); dialog.showModal();
  void renderSlotPreviews();
}
