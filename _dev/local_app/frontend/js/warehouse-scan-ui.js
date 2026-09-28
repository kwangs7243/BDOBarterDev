import { api } from "./api.js";

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function initWarehouseScanUI({ setStatus, onPatch }) {
  const openButton = document.querySelector("#open-warehouse-scan");
  const dialog = make("dialog", "warehouse-dialog");
  dialog.setAttribute("aria-labelledby", "warehouse-dialog-title");
  dialog.innerHTML = `
    <section class="warehouse-dialog-shell">
      <header class="warehouse-dialog-header"><div><h2 id="warehouse-dialog-title">마스터 창고 스캔</h2><p>원본 PNG 한 장을 선택하세요. 이미지는 줄이거나 다시 저장하지 않고 전송합니다.</p></div><button type="button" class="icon-button" data-action="close" aria-label="닫기">닫기</button></header>
      <main class="warehouse-dialog-content">
        <label class="warehouse-drop-zone" for="warehouse-image"><strong>PNG를 여기에 놓거나 파일을 선택하세요</strong><span>최대 20 MiB · 32메가픽셀 · PNG만 지원</span><input id="warehouse-image" type="file" accept="image/png,.png"></label>
        <p class="warehouse-file-name" aria-live="polite">선택된 파일이 없습니다.</p>
        <img class="warehouse-preview" alt="선택한 창고 이미지 미리보기" hidden>
        <p>판독한 원본 이미지와 결과가 로컬 DB에 보존됩니다. 재고 적용 시 직접 확인한 값도 함께 저장됩니다.</p><a href="/api/warehouse-dataset" download>인식 기록 내보내기 (ZIP)</a>
        <p class="warehouse-scan-message" role="status" aria-live="polite"></p>
      </main>
      <footer class="warehouse-dialog-footer"><button type="button" data-action="cancel">취소</button><button type="button" class="primary" data-action="scan" disabled>판독</button></footer>
    </section>`;
  document.body.append(dialog);

  const input = dialog.querySelector("#warehouse-image");
  const dropZone = dialog.querySelector(".warehouse-drop-zone");
  const fileName = dialog.querySelector(".warehouse-file-name");
  const preview = dialog.querySelector(".warehouse-preview");
  const message = dialog.querySelector(".warehouse-scan-message");
  const scanButton = dialog.querySelector('[data-action="scan"]');
  let selectedFile = null;
  let previewUrl = null;

  const showFile = (file) => {
    selectedFile = file || null;
    message.textContent = "";
    scanButton.disabled = !selectedFile;
    fileName.textContent = selectedFile ? `${selectedFile.name} · ${(selectedFile.size / 1024 / 1024).toFixed(2)} MiB` : "선택된 파일이 없습니다.";
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = selectedFile ? URL.createObjectURL(selectedFile) : null;
    preview.hidden = !previewUrl;
    if (previewUrl) preview.src = previewUrl;
  };

  openButton.addEventListener("click", () => {
    showFile(null);
    dialog.showModal();
    input.focus();
  });
  input.addEventListener("change", () => showFile(input.files?.[0]));
  for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-active");
  });
  for (const eventName of ["dragleave", "drop"]) dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-active");
  });
  dropZone.addEventListener("drop", (event) => {
    const files = event.dataTransfer?.files;
    if (files?.length === 1) showFile(files[0]);
    else message.textContent = "PNG 파일 한 장만 선택할 수 있습니다.";
  });
  dialog.querySelectorAll('[data-action="close"], [data-action="cancel"]').forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    preview.removeAttribute("src");
  });

  scanButton.addEventListener("click", async () => {
    if (!selectedFile || scanButton.disabled) return;
    scanButton.disabled = true;
    input.disabled = true;
    message.textContent = "이미지를 확인하고 판독하는 중입니다…";
    setStatus("창고 이미지를 판독하는 중입니다.", "saving");
    try {
      const result = await api.warehouseScan(selectedFile);
      const confirmed = Object.keys(result.patch?.items ?? {}).length;
      const uncertain = (result.report?.slots ?? []).filter((slot) => !["MATCH", "EMPTY", "TIER5_IGNORE"].includes(slot.decision)).length;
      const needsReview = (result.report?.slots ?? []).some((slot) => !["MATCH", "EMPTY", "TIER5_IGNORE"].includes(slot.decision));
      if (!confirmed && !needsReview) {
        message.textContent = "적용할 1~4단 품목이 없습니다.";
        setStatus("확정된 창고 품목이 없어 재고를 변경하지 않았습니다.", "info");
        scanButton.disabled = false;
        input.disabled = false;
        return;
      }
      dialog.close();
      setStatus(`확정 ${confirmed}개 품목과 미확정 슬롯 ${uncertain}개를 함께 검토합니다.`, "info");
      onPatch(result.patch, result.report, selectedFile);
    } catch (error) {
      message.textContent = error.message;
      setStatus(`창고 이미지를 판독하지 못했습니다: ${error.message}`, "error");
      scanButton.disabled = false;
      input.disabled = false;
    }
  });
}
