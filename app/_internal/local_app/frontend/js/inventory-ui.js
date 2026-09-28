import { saveInventory, saveInventoryOrder } from "./persistence.js";
import { state } from "./state.js";

const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const numberInput = (value, label, integer = true) => { const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.step = integer ? "1" : "any"; input.value = value ?? ""; input.setAttribute("aria-label", label); return input; };
const tierNames = (tier) => state.inventory.filter((item) => item.tier === tier).map((item) => item.programName);
export const inventoryDisplayOrder = () => Object.fromEntries([1,2,3,4,5].map((tier) => {
  const canonical = tierNames(tier);
  const saved = state.order[String(tier)] ?? [];
  return [String(tier), [...saved.filter((name) => canonical.includes(name)), ...canonical.filter((name) => !saved.includes(name))]];
}));

export function renderInventory(root, setStatus) {
  root.replaceChildren();
  const order = inventoryDisplayOrder();
  for (let tier = 1; tier <= 5; tier += 1) {
    const section = el("section", "tier-section"); section.dataset.tier = String(tier);
    section.append(el("h3", "", `${tier}단 (${order[String(tier)].length}종)`));
    const bulk = el("div", "inline-field");
    const bulkLabel = el("label", "", "이 단계 목표 일괄 적용");
    const bulkInput = numberInput("", `${tier}단 일괄 목표`);
    const bulkButton = el("button", "", "전체에 적용"); bulkButton.type = "button";
    bulkButton.addEventListener("click", async () => {
      if (bulkInput.value === "" || !Number.isSafeInteger(Number(bulkInput.value)) || Number(bulkInput.value) < 0) { setStatus("목표값은 0 이상의 정수여야 합니다.", "error"); return; }
      const items = Object.fromEntries(order[String(tier)].map((name) => [name, { target: Number(bulkInput.value) }]));
      await saveAndRefresh(items, root, setStatus, `${tier}단 목표 재고`);
    });
    bulk.append(bulkLabel, bulkInput, bulkButton); section.append(bulk);

    const wrap = el("div", "table-wrap"); const table = document.createElement("table");
    const head = document.createElement("thead"); const headRow = document.createElement("tr");
    for (const label of ["프로그램 아이템명", "현재 재고", "목표 재고"]) headRow.append(el("th", "", label));
    head.append(headRow); table.append(head); const body = document.createElement("tbody");
    for (const name of order[String(tier)]) {
      const item = state.inventory.find((candidate) => candidate.programName === name);
      if (!item) continue;
      const row = el("tr", "inventory-row"); row.draggable = true; row.dataset.name = name; row.dataset.tier = String(tier);
      const nameCell = el("td", "item-name"); const nameLabel = el("span", "inventory-item-label", name); nameCell.append(nameLabel); nameCell.title = "같은 단계 안에서 드래그하여 순서를 변경";
      const stockCell = document.createElement("td");
      const stockControls = el("div", "inventory-quantity-controls");
      const stockMinus = el("button", "quantity-step", "−"); stockMinus.type = "button"; stockMinus.title = "재고 1 감소"; stockMinus.setAttribute("aria-label", `${name} 재고 1 감소`);
      const stockInput = numberInput(item.stock, `${name} 현재 재고`); stockInput.dataset.value = "stock";
      const stockPlus = el("button", "quantity-step", "+"); stockPlus.type = "button"; stockPlus.title = "재고 1 증가"; stockPlus.setAttribute("aria-label", `${name} 재고 1 증가`);
      const adjust = async (delta) => {
        if (item.stock === null && delta < 0) { setStatus(`${name}은 미확인 재고입니다. 먼저 수량을 입력하세요.`, "info"); return; }
        const next = Math.max(0, (item.stock ?? 0) + delta);
        await saveAndRefresh({ [name]: { stock: next } }, root, setStatus, `${name} 재고`);
      };
      stockMinus.addEventListener("click", () => adjust(-1)); stockPlus.addEventListener("click", () => adjust(1));
      stockControls.append(stockMinus, stockInput, stockPlus); stockCell.append(stockControls);
      const targetCell = document.createElement("td"); const targetInput = numberInput(item.target, `${name} 목표 재고`); targetInput.dataset.value = "target"; targetCell.append(targetInput);
      row.append(nameCell, stockCell, targetCell); body.append(row);
      for (const [field, input] of [["stock", stockInput], ["target", targetInput]]) {
        input.addEventListener("change", async () => {
          if (input.value === "") {
            // The API intentionally has no NULL mutation; a blank means leave the last confirmed value unchanged.
            input.value = item[field] ?? "";
            setStatus(item[field] === null && field === "stock" ? "미입력(NULL) 상태를 유지했습니다. 0개 확정은 숫자 0을 입력하세요." : "빈칸은 재고를 지우지 않습니다.", "info");
            return;
          }
          const value = Number(input.value);
          if (!Number.isSafeInteger(value) || value < 0) { input.value = item[field] ?? ""; setStatus("수량은 0 이상의 정수여야 합니다.", "error"); return; }
          await saveAndRefresh({ [name]: { [field]: value } }, root, setStatus, `${name} ${field === "stock" ? "재고" : "목표"}`);
        });
      }
      row.addEventListener("dragstart", (event) => { event.dataTransfer.setData("text/plain", name); event.dataTransfer.effectAllowed = "move"; row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (event) => { if (row.dataset.tier === String(tier)) { event.preventDefault(); row.classList.add("drag-over"); } });
      row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
      row.addEventListener("drop", async (event) => {
        event.preventDefault(); row.classList.remove("drag-over");
        const dragged = event.dataTransfer.getData("text/plain");
        if (!dragged || dragged === name) return;
        const candidate = inventoryDisplayOrder(); const names = candidate[String(tier)];
        const from = names.indexOf(dragged); const to = names.indexOf(name);
        if (from < 0 || to < 0) return;
        names.splice(from, 1); const insertAt = from < to ? to - 1 : to; names.splice(insertAt, 0, dragged);
        try { setStatus("단계별 표시 순서를 저장하는 중입니다.", "saving"); await saveInventoryOrder(candidate); setStatus("단계별 표시 순서를 저장했습니다.", "success"); renderInventory(root, setStatus); }
        catch (error) { setStatus(`순서를 저장하지 못했습니다: ${error.message}`, "error"); renderInventory(root, setStatus); }
      });
    }
    table.append(body); wrap.append(table); section.append(wrap); root.append(section);
  }
}

async function saveAndRefresh(items, root, setStatus, label) {
  try { setStatus(`${label}을 저장하는 중입니다.`, "saving"); await saveInventory(items); setStatus(`${label} 저장을 확인했습니다.`, "success"); renderInventory(root, setStatus); }
  catch (error) { setStatus(`${label}을 저장하지 못했습니다: ${error.message}`, "error"); renderInventory(root, setStatus); }
}
