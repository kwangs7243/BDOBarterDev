import { api } from "./api.js";
import { state } from "./state.js";
import { CaptureQueue, PreviewRegistry, captureFromFile, ScreenCaptureSession, DEFAULT_TRADE_ROI, normalizeRegion, displayedVideoContentRect, moveNormalizedRegion, resizeNormalizedRegion } from "./capture.js";

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function captureContext() {
  const sessionId = state.session?.id;
  const isUuid = typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId);
  return {
    taskType: "warehouse",
    baseRevision: Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
    sessionId: isUuid ? sessionId : null,
    sessionRevision: Number.isSafeInteger(state.sessionRevision) && state.sessionRevision >= 0 ? state.sessionRevision : null,
    profileId: null,
    profileVersion: 1,
  };
}

function captureErrorText(error) {
  return error?.message || "이미지를 준비하지 못했습니다.";
}

export function initWarehouseScanUI({ setStatus, onPatch }) {
  const openButton = document.querySelector("#open-warehouse-scan");
  const dialog = make("dialog", "warehouse-dialog");
  dialog.id = "warehouse-scan-dialog";
  dialog.dataset.captureContext = "warehouse";
  dialog.setAttribute("aria-labelledby", "warehouse-dialog-title");
  dialog.innerHTML = `
    <section class="warehouse-dialog-shell">
      <header class="warehouse-dialog-header"><div><h2 id="warehouse-dialog-title">마스터 창고 스캔</h2><p>파일, 놓기 또는 붙여넣기로 이미지를 입력합니다. PNG 원본은 다시 저장하지 않습니다.</p></div><button type="button" class="icon-button" data-action="close" aria-label="닫기">닫기</button></header>
      <main class="warehouse-dialog-content">
        <section class="trade-roi-panel" aria-label="창고 캡처 범위">
          <div class="trade-roi-actions"><button type="button" data-action="connect-screen">화면 연결</button><button type="button" data-action="disconnect-screen">연결 종료</button><button type="button" data-action="reset-roi">범위 초기화</button><button type="button" data-action="capture-roi" disabled>선택 영역 캡처</button></div>
          <p>화면을 연결한 뒤 초록색 영역을 이동하고 가장자리를 끌어 창고 범위를 지정하세요.</p>
          <div class="trade-preview-stage"><video muted autoplay playsinline></video><div class="trade-roi-box" hidden><button type="button" class="trade-roi-move" data-roi-move aria-label="창고 영역 이동"></button>${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map(handle => `<button type="button" class="trade-roi-handle ${handle}" data-roi-handle="${handle}" aria-label="창고 영역 ${handle} 크기 조절"></button>`).join("")}</div></div>
        </section>
        <label class="warehouse-drop-zone" for="warehouse-image"><strong>이미지를 여기에 놓거나 파일을 선택하세요</strong><span>PNG/JPEG/WebP/GIF · 최대 20 MiB · 32메가픽셀 · 애니메이션 제외</span><input id="warehouse-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"></label>
        <button type="button" class="capture-paste-target" data-capture-paste-target>붙여넣기 준비 · 이 버튼에 포커스를 두고 Ctrl+V</button>
        <p class="warehouse-file-name" aria-live="polite">대기 이미지가 없습니다.</p>
        <ol class="capture-queue-list" data-role="capture-list"></ol>
        <img class="warehouse-preview" alt="선택한 창고 이미지 미리보기" hidden>
        <p>판독은 기존 V1 창고 스캐너를 사용합니다. 재고에는 직접 확인해 적용하기 전까지 변경이 없습니다.</p><a href="/api/warehouse-dataset" download>인식 기록 내보내기 (ZIP)</a>
        <p class="warehouse-scan-message" role="status" aria-live="polite"></p>
      </main>
      <footer class="warehouse-dialog-footer"><button type="button" data-action="cancel">취소</button><button type="button" class="primary" data-action="scan" disabled>선택 이미지 판독</button></footer>
    </section>`;
  document.body.append(dialog);

  const input = dialog.querySelector("#warehouse-image");
  const dropZone = dialog.querySelector(".warehouse-drop-zone");
  const fileName = dialog.querySelector(".warehouse-file-name");
  const preview = dialog.querySelector(".warehouse-preview");
  const message = dialog.querySelector(".warehouse-scan-message");
  const list = dialog.querySelector("[data-role='capture-list']");
  const pasteTarget = dialog.querySelector("[data-capture-paste-target]");
  const scanButton = dialog.querySelector('[data-action="scan"]');
  const queue = new CaptureQueue();
  let scanPending = false;
  const previews = new PreviewRegistry();
  let selectedCaptureId = null;
  let previewUrl = null;
  let keepQueueOnClose = false;

  const selectedCapture = () => queue.items.find((item) => item.metadata.captureId === selectedCaptureId) ?? queue.items[0] ?? null;
  const updatePreview = () => {
    if (previewUrl) previews.revoke(previewUrl);
    const selected = selectedCapture();
    selectedCaptureId = selected?.metadata.captureId ?? null;
    previewUrl = selected ? previews.create(selected.blob) : null;
    preview.hidden = !previewUrl;
    if (previewUrl) preview.src = previewUrl;
    else preview.removeAttribute("src");
    scanButton.disabled = !selected;
  };
  const renderQueue = () => {
    const captures = queue.items;
    list.replaceChildren();
    for (const capture of captures) {
      const item = make("li", "capture-queue-item");
      item.dataset.captureId = capture.metadata.captureId;
      const choose = make("button", "capture-queue-select", `${({ clipboard: "클립보드", file: "파일", "native-screen": "게임 캡처", "browser-stream": "화면" }[capture.metadata.sourceType] ?? "이미지")} · ${capture.metadata.frame.width}×${capture.metadata.frame.height} · ${(capture.bytes / 1024 / 1024).toFixed(2)} MiB${capture.reencoded ? " · PNG 변환" : ""}`);
      choose.type = "button";
      choose.setAttribute("aria-pressed", String(capture.metadata.captureId === selectedCaptureId));
      choose.addEventListener("click", () => { selectedCaptureId = capture.metadata.captureId; renderQueue(); });
      const remove = make("button", "capture-queue-remove", "제거");
      remove.type = "button";
      remove.setAttribute("aria-label", "창고 대기 이미지 제거");
      remove.addEventListener("click", () => {
        queue.remove(capture.metadata.captureId);
        if (selectedCaptureId === capture.metadata.captureId) selectedCaptureId = queue.items[0]?.metadata.captureId ?? null;
        renderQueue();
      });
      item.append(choose, remove);
      list.append(item);
    }
    fileName.textContent = captures.length
      ? `대기 ${captures.length}장 · ${(queue.bytes / 1024 / 1024).toFixed(2)} MiB / 20 MiB`
      : "대기 이미지가 없습니다.";
    dialog.dataset.queueLength = String(queue.length);
    dialog.dataset.queueBytes = String(queue.bytes);
    updatePreview();
  };

  const acceptCaptures = (captures) => {
    queue.append(captures);
    if (!selectedCaptureId) selectedCaptureId = captures[0]?.metadata.captureId ?? null;
    else if (captures.length) selectedCaptureId = captures[0].metadata.captureId;
    message.textContent = `${captures.length}개 이미지를 순서대로 대기열에 추가했습니다.`;
    renderQueue();
  };
  const reportCaptureError = (error) => { message.textContent = captureErrorText(error); };

  const screenSession = new ScreenCaptureSession();
  const stage = dialog.querySelector(".trade-preview-stage");
  const video = stage.querySelector("video");
  const roiBox = stage.querySelector(".trade-roi-box");
  const captureButton = dialog.querySelector('[data-action="capture-roi"]');
  let region = { ...DEFAULT_TRADE_ROI };
  const renderRoi = () => {
    const content = displayedVideoContentRect(video, stage);
    roiBox.hidden = !content || !screenSession.connected || !dialog.open;
    if (roiBox.hidden) return;
    const bounds = stage.getBoundingClientRect();
    region = normalizeRegion(region);
    Object.assign(roiBox.style, { left: `${content.left - bounds.left + region.x * content.width}px`, top: `${content.top - bounds.top + region.y * content.height}px`, width: `${region.width * content.width}px`, height: `${region.height * content.height}px` });
    roiBox.dataset.normalized = JSON.stringify(region);
  };
  screenSession.attachPreview(video);
  screenSession.subscribe(() => { captureButton.disabled = screenSession.state !== "CONNECTED"; renderRoi(); });
  video.addEventListener("resize", renderRoi);
  const resizeObserver = new ResizeObserver(renderRoi); resizeObserver.observe(stage);
  dialog.querySelector('[data-action="connect-screen"]').addEventListener("click", () => {
    screenSession.connectScreen().then(() => { renderRoi(); message.textContent = "게임 화면에서 영역을 드래그하고 Enter를 누르세요."; }).catch(reportCaptureError);
  });
  dialog.querySelector('[data-action="disconnect-screen"]').addEventListener("click", () => screenSession.disconnectScreen());
  dialog.querySelector('[data-action="reset-roi"]').addEventListener("click", () => { region = { ...DEFAULT_TRADE_ROI }; renderRoi(); });
  captureButton.addEventListener("click", async () => {
    try { acceptCaptures([await screenSession.captureRegion(captureContext(), region)]); }
    catch (error) { reportCaptureError(error); }
  });
  roiBox.addEventListener("pointerdown", event => {
    if (screenSession.state !== "CONNECTED") return;
    const content = displayedVideoContentRect(video, stage);
    const handle = event.target.closest("[data-roi-handle]")?.dataset.roiHandle;
    if (!content || (!handle && !event.target.closest("[data-roi-move]"))) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, region: { ...region } };
    const minimumWidth = Math.min(.95, 80 / content.width), minimumHeight = Math.min(.95, 60 / content.height);
    event.target.setPointerCapture?.(event.pointerId);
    const move = next => {
      const dx = (next.clientX - start.x) / content.width, dy = (next.clientY - start.y) / content.height;
      region = handle ? resizeNormalizedRegion(start.region, handle, dx, dy, minimumWidth, minimumHeight) : moveNormalizedRegion(start.region, dx, dy, minimumWidth, minimumHeight);
      renderRoi();
    };
    const finish = () => { roiBox.removeEventListener("pointermove", move); roiBox.removeEventListener("pointerup", finish); roiBox.removeEventListener("pointercancel", finish); };
    roiBox.addEventListener("pointermove", move); roiBox.addEventListener("pointerup", finish, { once: true }); roiBox.addEventListener("pointercancel", finish, { once: true });
  });

  openButton.addEventListener("click", () => {
    message.textContent = "파일을 선택·놓거나 붙여넣기 버튼에 포커스를 둔 뒤 Ctrl+V를 사용하세요.";
    input.disabled = false;
    renderQueue();
    dialog.showModal();
    pasteTarget.focus();
  });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    message.textContent = "이미지를 확인하는 중입니다…";
    try {
      const capture = await captureFromFile(file, captureContext());
      acceptCaptures([capture]);
    } catch (error) {
      reportCaptureError(error);
    }
  });
  for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-active");
  });
  for (const eventName of ["dragleave", "drop"]) dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-active");
  });
  dropZone.addEventListener("drop", async (event) => {
    const files = event.dataTransfer?.files;
    if (files?.length !== 1) {
      message.textContent = "한 번에 이미지 파일 한 장씩 놓아 주세요.";
      return;
    }
    message.textContent = "이미지를 확인하는 중입니다…";
    try {
      acceptCaptures([await captureFromFile(files[0], captureContext())]);
    } catch (error) {
      reportCaptureError(error);
    }
  });
  dialog.querySelectorAll('[data-action="close"], [data-action="cancel"]').forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => {
    screenSession.disconnectScreen("dialog-close");
    if (previewUrl) previews.revoke(previewUrl);
    previewUrl = null;
    preview.removeAttribute("src");
    preview.hidden = true;
    previews.clear();
    if (!keepQueueOnClose && !queue.items.some(capture => capture.metadata.sourceType === "native-screen")) {
      queue.clear();
      selectedCaptureId = null;
      list.replaceChildren();
      fileName.textContent = "대기 이미지가 없습니다.";
      scanButton.disabled = true;
    }
    keepQueueOnClose = false;
  });

  scanButton.addEventListener("click", async () => {
    const capture = selectedCapture();
    if (!capture || scanButton.disabled) return;
    scanPending = true;
    scanButton.disabled = true;
    input.disabled = true;
    message.textContent = "이미지를 확인하고 V1 창고 스캐너로 판독하는 중입니다…";
    setStatus("창고 이미지를 판독하는 중입니다.", "saving");
    try {
      const result = await api.warehouseScan(capture);
      const confirmed = Object.keys(result.patch?.items ?? {}).length;
      const uncertain = (result.report?.slots ?? []).filter((slot) => !["MATCH", "EMPTY", "TIER5_IGNORE"].includes(slot.decision)).length;
      const needsReview = (result.report?.slots ?? []).some((slot) => !["MATCH", "EMPTY", "TIER5_IGNORE"].includes(slot.decision));
      const imageBlob = capture.blob;
      queue.remove(capture.metadata.captureId);
      selectedCaptureId = queue.items[0]?.metadata.captureId ?? null;
      renderQueue();
      if (!confirmed && !needsReview) {
        message.textContent = "적용할 1~4단 품목이 없습니다.";
        setStatus("확정된 창고 품목이 없어 재고를 변경하지 않았습니다.", "info");
        input.disabled = false;
        return;
      }
      keepQueueOnClose = true;
      dialog.close();
      setStatus(`자동 확정 ${confirmed}개 품목 · 확인 필요한 슬롯 ${uncertain}개만 수정하세요.`, "info");
      onPatch(result.patch, result.report, imageBlob);
    } catch (error) {
      message.textContent = error.message;
      setStatus(`창고 이미지를 판독하지 못했습니다: ${error.message}`, "error");
      scanButton.disabled = false;
      input.disabled = false;
    } finally {
      scanPending = false;
    }
  });

  window.addEventListener("beforeunload", () => {
    previews.clear();
    queue.clear();
  });

  return {
    dialog,
    screenSession,
    isActive: () => dialog.open,
    acceptCaptures,
    reportCaptureError,
    getQueueLength: () => queue.length,
    getNativeQueueState: () => ({ count: queue.length, bytes: queue.bytes, busy: scanPending }),
    cleanup: () => {
      screenSession.disconnectScreen("cleanup");
      resizeObserver.disconnect();
      previews.clear();
      queue.clear();
    },
  };
}
