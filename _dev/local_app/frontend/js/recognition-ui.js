import { state } from "./state.js";
import { CaptureError, CaptureQueue, PreviewRegistry, ScreenCaptureSession, captureFromFile, captureFromPaste, captureLimits, isEditableTarget } from "./capture.js";

function captureContext(taskType) {
  const sessionId = state.session?.id;
  const isUuid = typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId);
  return {
    taskType,
    baseRevision: Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
    sessionId: isUuid ? sessionId : null,
    sessionRevision: Number.isSafeInteger(state.sessionRevision) && state.sessionRevision >= 0 ? state.sessionRevision : null,
    profileId: null,
    profileVersion: 1,
  };
}

function explain(error) {
  return error instanceof CaptureError ? error.message : "이미지를 처리하지 못했습니다.";
}

export function initRecognitionUI({ warehouseCaptureUI }) {
  const tradeDialog = document.querySelector("#trade-capture-dialog");
  const openTradeButton = document.querySelector("#open-trade-capture");
  const tradeInput = tradeDialog.querySelector("#trade-capture-files");
  const tradePasteTarget = tradeDialog.querySelector("[data-capture-paste-target]");
  const tradeList = tradeDialog.querySelector("[data-role='capture-list']");
  const tradeStatus = tradeDialog.querySelector("[data-role='capture-status']");
  const tradeScreenCaptureButton = tradeDialog.querySelector("[data-screen-capture='trade']");
  const warehouseScreenCaptureButton = document.createElement("button");
  warehouseScreenCaptureButton.type = "button";
  warehouseScreenCaptureButton.className = "warehouse-screen-capture";
  warehouseScreenCaptureButton.dataset.screenCapture = "warehouse";
  warehouseScreenCaptureButton.textContent = "연결된 화면에서 캡처";
  warehouseScreenCaptureButton.disabled = true;
  warehouseCaptureUI.dialog.querySelector("[data-capture-paste-target]").after(warehouseScreenCaptureButton);
  const screenSessionBar = document.querySelector("#screen-capture-session");
  const screenStatus = document.querySelector("#screen-capture-status");
  const connectScreenButton = document.querySelector("#connect-screen-capture");
  const disconnectScreenButton = document.querySelector("#disconnect-screen-capture");
  const screenSession = new ScreenCaptureSession();
  const tradeQueue = new CaptureQueue();
  const tradePreviews = new PreviewRegistry();

  const renderTradeQueue = () => {
    tradePreviews.clear();
    tradeList.replaceChildren();
    for (const capture of tradeQueue.items) {
      const item = document.createElement("li");
      item.className = "capture-draft-item";
      item.dataset.captureId = capture.metadata.captureId;
      item.dataset.status = "TRADE_DRAFT";
      const image = document.createElement("img");
      image.alt = "물교 이미지 초안 미리보기";
      image.src = tradePreviews.create(capture.blob);
      const details = document.createElement("div");
      details.className = "capture-draft-details";
      const heading = document.createElement("strong");
      heading.textContent = `이미지 초안 · ${capture.metadata.frame.width}×${capture.metadata.frame.height}`;
      const meta = document.createElement("span");
      const sourceLabel = capture.metadata.sourceType === "clipboard" ? "클립보드" : capture.metadata.sourceType === "browser-stream" ? "화면" : "파일";
      meta.textContent = `${sourceLabel} · ${(capture.bytes / 1024 / 1024).toFixed(2)} MiB${capture.reencoded ? " · PNG 변환" : ""}`;
      const status = document.createElement("span");
      status.className = "capture-draft-state";
      status.textContent = "초안 · OCR 미실행";
      details.append(heading, meta, status);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "제거";
      remove.setAttribute("aria-label", "물교 이미지 초안 제거");
      remove.addEventListener("click", () => {
        tradeQueue.remove(capture.metadata.captureId);
        tradeStatus.textContent = "이미지 초안을 제거했습니다.";
        renderTradeQueue();
      });
      item.append(image, details, remove);
      tradeList.append(item);
    }
    tradeDialog.dataset.queueLength = String(tradeQueue.length);
    tradeDialog.dataset.queueBytes = String(tradeQueue.bytes);
  };

  const appendTradeCaptures = (captures) => {
    tradeQueue.append(captures);
    renderTradeQueue();
    tradeStatus.textContent = `${captures.length}개 이미지를 초안으로 보관했습니다. 인식이나 물교 목록 생성은 수행하지 않았습니다.`;
  };

  const renderScreenState = ({ state: screenState = screenSession.state, reason = screenSession.reason } = {}) => {
    const labels = {
      IDLE: "화면 연결 안 됨",
      CONNECTING: "화면 연결 중…",
      CONNECTED: "화면 연결됨",
      CAPTURING: "화면 캡처 중…",
      DISCONNECTED: reason === "track-ended" ? "화면 공유 종료됨" : reason === "permission-denied" ? "화면 공유가 취소되었거나 허용되지 않았습니다" : reason === "unsupported" ? "이 브라우저는 화면 공유를 지원하지 않습니다" : reason === "connect-error" ? "화면 연결 오류" : "화면 연결 안 됨",
    };
    screenStatus.textContent = labels[screenState] ?? "화면 연결 오류";
    screenSessionBar.dataset.state = screenState;
    const active = screenState === "CONNECTED" || screenState === "CAPTURING";
    connectScreenButton.disabled = screenState === "CONNECTING" || active;
    disconnectScreenButton.disabled = screenState === "IDLE" || screenState === "DISCONNECTED";
    warehouseScreenCaptureButton.disabled = screenState !== "CONNECTED";
    tradeScreenCaptureButton.disabled = screenState !== "CONNECTED";
  };

  screenSession.subscribe(renderScreenState);
  renderScreenState();
  connectScreenButton.addEventListener("click", () => {
    // Keep connectScreen invocation directly in the click handler for browser user activation.
    const connection = screenSession.connectScreen();
    void connection.catch(() => {});
  });
  disconnectScreenButton.addEventListener("click", () => screenSession.disconnectScreen("user"));

  const captureScreenInto = (taskType, button, accept, reportError) => {
    button.addEventListener("click", async () => {
      if (screenSession.state !== "CONNECTED") return;
      try {
        const capture = await screenSession.captureFrame(captureContext(taskType));
        accept([capture]);
        if (taskType === "warehouse") {
          warehouseCaptureUI.dialog.querySelector(".warehouse-scan-message").textContent = `연결된 화면 ${capture.metadata.frame.width}×${capture.metadata.frame.height} 프레임을 대기열에 추가했습니다. 판독은 ‘선택 이미지 판독’을 눌렀을 때만 실행됩니다.`;
        }
      } catch (error) {
        reportError(error);
      } finally {
        renderScreenState();
      }
    });
  };
  captureScreenInto("warehouse", warehouseScreenCaptureButton, warehouseCaptureUI.acceptCaptures, warehouseCaptureUI.reportCaptureError);
  captureScreenInto("trade", tradeScreenCaptureButton, appendTradeCaptures, (error) => { tradeStatus.textContent = explain(error); });

  openTradeButton.addEventListener("click", () => {
    tradeStatus.textContent = "파일을 선택하거나 붙여넣기 버튼을 누른 뒤 Ctrl+V를 사용하세요.";
    renderTradeQueue();
    tradeDialog.showModal();
    tradePasteTarget.focus();
  });
  tradeDialog.querySelectorAll("[data-close-trade-capture]").forEach((button) => button.addEventListener("click", () => tradeDialog.close()));
  tradeDialog.addEventListener("close", () => tradePreviews.clear());
  tradeInput.addEventListener("change", async () => {
    const files = [...(tradeInput.files ?? [])];
    tradeInput.value = "";
    if (tradeQueue.length + files.length > captureLimits.MAX_BATCH_FRAMES) {
      tradeStatus.textContent = `대기 이미지는 최대 ${captureLimits.MAX_BATCH_FRAMES}개입니다. 기존 초안은 유지했습니다.`;
      return;
    }
    if (tradeQueue.bytes + files.reduce((sum, file) => sum + file.size, 0) > captureLimits.MAX_BATCH_BYTES) {
      tradeStatus.textContent = "대기 이미지의 전체 용량은 20 MiB 이하여야 합니다. 기존 초안은 유지했습니다.";
      return;
    }
    for (const file of files) {
      try {
        const capture = await captureFromFile(file, captureContext("trade"));
        appendTradeCaptures([capture]);
      } catch (error) {
        tradeStatus.textContent = explain(error);
      }
    }
  });

  const openCaptureContext = () => {
    const openDialogs = [...document.querySelectorAll("dialog[open]")];
    if (openDialogs.length !== 1) return null;
    const dialog = openDialogs[0];
    if (dialog === warehouseCaptureUI.dialog && warehouseCaptureUI.isActive()) {
      return { taskType: "warehouse", accept: warehouseCaptureUI.acceptCaptures, reportError: warehouseCaptureUI.reportCaptureError };
    }
    if (dialog === tradeDialog) {
      return { taskType: "trade", accept: appendTradeCaptures, reportError: (error) => { tradeStatus.textContent = explain(error); } };
    }
    return null;
  };

  const onPaste = (event) => {
    if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return;
    const active = openCaptureContext();
    if (!active) return;
    const hasImage = [...(event.clipboardData?.items ?? [])].some((item) => item.kind === "file" && String(item.type ?? "").toLowerCase().startsWith("image/"));
    if (!hasImage) return;
    void captureFromPaste(event, captureContext(active.taskType)).then((result) => {
      if (result.handled && openCaptureContext()?.taskType === active.taskType) active.accept(result.inputs);
    }).catch(active.reportError);
  };
  document.addEventListener("paste", onPaste);

  window.addEventListener("beforeunload", () => {
    screenSession.disconnectScreen("beforeunload");
    tradePreviews.clear();
    tradeQueue.clear();
  });

  return {
    getTradeDraftCount: () => tradeQueue.length,
    cleanup: () => {
      document.removeEventListener("paste", onPaste);
      screenSession.disconnectScreen("beforeunload");
      tradePreviews.clear();
      tradeQueue.clear();
    },
  };
}
