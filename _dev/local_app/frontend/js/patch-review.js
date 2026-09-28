import { refreshPersistentState, saveWarehouseInventory } from "./persistence.js";
import { createAutocomplete } from "./autocomplete.js";
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
  return reviewSlots().filter((slot) => slot.decision !== "MATCH");
}

function reviewSlots() {
  return (context.report.slots ?? []).filter((slot) => !["EMPTY", "TIER5_IGNORE"].includes(slot.decision));
}

const originalName = (slot) => slot.finalItem ?? slot.bestCandidate ?? null;
const originalQuantity = (slot) => Number.isSafeInteger(slot.quantity?.value) ? slot.quantity.value : null;
const agreements = { item_only: [true, false], quantity_only: [false, true], both_match: [true, true], both_different: [false, false] };

function ensureCorrection(slot) {
  if (!context.corrections.has(slot.slot)) {
    const item = state.inventory.find((entry) => entry.programName === originalName(slot) && entry.tier <= 4);
    context.corrections.set(slot.slot, {
      name: item?.programName ?? "",
      quantity: slot.quantity?.status === "QUANTITY_MATCH" ? String(slot.quantity.value) : "",
      excluded: false,
      agreement: "unchecked",
    });
  }
  return context.corrections.get(slot.slot);
}

function validCorrection(slot, value) {
  if (value.excluded) return true;
  const quantity = value.quantity === "" ? NaN : Number(value.quantity);
  if (!state.inventory.some((item) => item.programName === value.name && item.tier <= 4)
      || !Number.isSafeInteger(quantity) || quantity < 0) return false;
  if (value.agreement === "unchecked") return true;
  const expected = agreements[value.agreement];
  return !!expected && expected[0] === (value.name === originalName(slot))
    && expected[1] === (originalQuantity(slot) !== null && quantity === originalQuantity(slot));
}

function effectivePatch() {
  const items = {};
  for (const slot of reviewSlots()) {
    const value = ensureCorrection(slot);
    if (!validCorrection(slot, value)) return null;
    if (value.excluded) continue;
    const combined = (items[value.name] ?? 0) + Number(value.quantity);
    if (!Number.isSafeInteger(combined)) return null;
    items[value.name] = combined;
  }
  return items;
}

function updateApplyState() {
  const button = dialog.querySelector('[data-action="apply"]');
  if (!button) return;
  const items = effectivePatch();
  button.disabled = !items || Object.keys(items).length === 0;
  const slots = reviewSlots();
  const missing = slots.filter((slot) => !validCorrection(slot, ensureCorrection(slot))).length;
  const unchecked = slots.filter((slot) => { const value = ensureCorrection(slot); return !value.excluded && value.agreement === "unchecked"; }).length;
  const count = dialog.querySelector("[data-role='review-count']");
  if (count) count.textContent = `인식 성공 ${slots.length - correctionSlots().length}칸 · 미인식 ${correctionSlots().length}칸 · 입력·일치 선택 오류 ${missing}칸 · 일치 여부 미확인 ${unchecked}칸`;
}

function renderCorrectionRow(slot, index, itemOptions) {
  const correction = ensureCorrection(slot);
  const row = make("tr", "patch-scan-row " + (slot.decision === "MATCH" ? "patch-confirmed-row" : "patch-correction-row"));
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
  const itemPicker = createAutocomplete({
    className: "patch-correction-picker",
    options: itemOptions.map((item) => item.programName),
    value: correction.name,
    ariaLabel: `${slot.slot} 품목 선택`,
    placeholder: "1~4단 품목 검색 또는 선택",
    onInput: (value) => { correction.name = value.trim(); correction.agreement = "unchecked"; updateApplyState(); },
  });
  const itemInput = itemPicker.input;
  itemInput.classList.add("patch-correction-item");
  itemCell.append(itemPicker.element);
  itemCell.append(make("small", "patch-correction-hint", `원본 품목: ${originalName(slot) ?? "없음"} · 원본 수량: ${originalQuantity(slot) ?? "미인식"} · 점수 ${Number.isFinite(slot.bestScore) ? slot.bestScore.toFixed(4) : "없음"} · ${{QUANTITY_UNKNOWN: "수량 확인 필요", ICON_MATCH_UNKNOWN: "품목 추측 확인 필요", DUPLICATE_ITEM_DETECTED: "동일 품목 여러 칸"}[slot.decision] ?? "직접 확인 필요"}`));
  const check = document.createElement("select"); check.className = "patch-item-check"; check.setAttribute("aria-label", `${slot.slot} 원본 품목명·숫자 일치 여부`);
  for (const [value, label] of [["unchecked", "일치 여부 미확인"], ["item_only", "품목명만 일치"], ["quantity_only", "숫자만 일치"], ["both_match", "둘 다 일치"], ["both_different", "둘 다 다름"]]) {
    const option = make("option", "", label); option.value = value; check.append(option);
  }
  check.value = correction.agreement;
  check.addEventListener("change", () => { correction.agreement = check.value; updateApplyState(); });
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

  itemInput.addEventListener("input", () => { check.value = correction.agreement; });
  quantityInput.addEventListener("input", () => { correction.quantity = quantityInput.value; correction.agreement = "unchecked"; check.value = "unchecked"; updateApplyState(); });
  return row;
}

function render() {
  const slots = reviewSlots();
  const header = make("header", "patch-review-header");
  const titleArea = make("div");
  const title = make("h2", "", "마스터 창고 재고 검토"); title.id = "patch-review-title"; titleArea.append(title);
  titleArea.append(make("p", "patch-review-summary", "성공·미인식 결과 모두 품목과 수량을 수정할 수 있습니다. 일치 여부는 원본 판독값과 비교해 선택하세요. 미확인 상태는 학습 정답으로 취급하지 않습니다."));
  const count = make("p", "patch-review-count", ""); count.dataset.role = "review-count"; titleArea.append(count); header.append(titleArea);
  const close = make("button", "icon-button", "닫기"); close.type = "button"; close.dataset.action = "cancel"; close.setAttribute("aria-label", "검토 닫기"); header.append(close);
  const body = make("main", "patch-review-body");
  const itemOptions = state.inventory.filter((item) => item.tier >= 1 && item.tier <= 4);
  const order = inventoryDisplayOrder();
  const groups = [4, 3, 2, 1].map((tier) => ({ title: `${tier}단 · 인식 성공`, slots: slots.filter((slot) => slot.decision === "MATCH" && itemOptions.find((item) => item.programName === originalName(slot))?.tier === tier).sort((a, b) => order[String(tier)].indexOf(originalName(a)) - order[String(tier)].indexOf(originalName(b))) }));
  groups.push({ title: `미인식 슬롯 · 직접 확인 ${correctionSlots().length}칸`, slots: correctionSlots() });
  for (const group of groups) {
    if (!group.slots.length) continue;
    const section = make("section", "patch-review-tier patch-correction-section");
    section.append(make("h3", "", group.title));
    const table = document.createElement("table");
    const head = document.createElement("thead"); const heading = document.createElement("tr");
    for (const text of ["이미지 칸", "최종 품목·원본 일치 여부", "최종 수량", "제외"]) heading.append(make("th", "", text));
    head.append(heading); table.append(head);
    const rows = document.createElement("tbody");
    group.slots.forEach((slot, index) => rows.append(renderCorrectionRow(slot, index, itemOptions)));
    table.append(rows); section.append(table); body.append(section);
  }
  body.prepend(make("p", "patch-correction-description", "원본 품목·수량은 변경되지 않습니다. 잘못 읽힌 값은 최종 입력란에서 고친 뒤 네 가지 일치 여부를 선택하세요. 선택과 최종값이 모순되면 적용할 수 없습니다. 5단 이상·비대상 칸은 제외하세요."));

  const footer = make("footer", "patch-review-footer");
  const cancel = make("button", "", "취소"); cancel.type = "button"; cancel.dataset.action = "cancel";
  const apply = make("button", "primary", "모두 적용"); apply.type = "button"; apply.dataset.action = "apply";
  footer.append(make("small", "", "원본 이미지·판독 결과는 로컬 DB에 보존됩니다. 사용자 확인값은 재고 적용 시 함께 저장됩니다."), cancel, apply);
  dialog.replaceChildren(header, body, footer);
  for (const slot of slots) {
    const correction = ensureCorrection(slot);
    if (correction.excluded) {
      const row = [...dialog.querySelectorAll(".patch-scan-row")].find((entry) => entry.dataset.slot === slot.slot);
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
    for (const slot of reviewSlots()) {
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
      version: 2,
      scanId: context.report.scanId,
      rows: reviewSlots().map(slot => {
        const value = ensureCorrection(slot);
        return { slot: slot.slot, name: value.excluded ? null : value.name, quantity: value.excluded ? null : Number(value.quantity), excluded: value.excluded, agreement: value.excluded ? "unchecked" : value.agreement };
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
