import { createTradeLiveListUI } from "./trade-live-list-ui.js";
import { initCaptureRoiUI } from "./capture-roi-ui.js";
import { initNativeCaptureUI } from "./native-capture-ui.js";
import { state } from "./state.js";
import { CaptureError, CaptureQueue, DEFAULT_TRADE_ROI, PreviewRegistry, ScreenCaptureSession, captureFromFile, captureFromPaste, captureLimits, isEditableTarget } from "./capture.js";
import { getTradeRecognitionRuntime, recognizeTradeLiveList } from "./trade-recognition-client.js";

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
  const events = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: events.signal });
  const tradeDialog = document.querySelector("#trade-capture-dialog");
  const openTradeButton = document.querySelector("#open-trade-capture");
  const tradeInput = tradeDialog.querySelector("#trade-capture-files");
  const tradePasteTarget = tradeDialog.querySelector("[data-capture-paste-target]");
  const tradeList = tradeDialog.querySelector("[data-role='capture-list']");
  const tradeStatus = tradeDialog.querySelector("[data-role='capture-status']");
  const tradeScreenCaptureButton = tradeDialog.querySelector("[data-action='capture-trade-roi']");
  const tradeClearButton = tradeDialog.querySelector("[data-action='clear-trade-queue']");
  const tradePreview = tradeDialog.querySelector("[data-role='trade-preview-video']");
  const tradePreviewStage = tradeDialog.querySelector("[data-role='trade-preview-stage']");
  const tradePreviewStatus = tradeDialog.querySelector("[data-role='trade-preview-status']");
  const tradeRoiBox = tradeDialog.querySelector("[data-role='trade-roi']");
  const tradeRoiReset = tradeDialog.querySelector("[data-action='reset-trade-roi']");
  const tradeRecognitionButton = tradeDialog.querySelector("[data-action='recognize-trade']");
  const tradeRuntimeStatus = tradeDialog.querySelector("[data-role='trade-runtime-status']");
  const tradeQueueSummary = tradeDialog.querySelector("[data-role='trade-queue-summary']");
  const tradeRecognitionStatus = tradeDialog.querySelector("[data-role='trade-recognition-status']");
  const tradeRecognitionRegion = tradeDialog.querySelector("[data-role='trade-recognition']");
  const tradeRecognitionResultRegion = tradeDialog.querySelector("[data-role='trade-recognition-result']");
  const liveListSection = document.createElement("section");
  liveListSection.dataset.role = "trade-live-list";
  liveListSection.hidden = true;
  const recognitionDiagnostics = document.createElement("details");
  recognitionDiagnostics.dataset.role = "trade-recognition-diagnostics";
  recognitionDiagnostics.hidden = true;
  tradeRecognitionStatus.after(recognitionDiagnostics);
  tradeRecognitionResultRegion.append(liveListSection);
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
  let tradeRoi = { ...DEFAULT_TRADE_ROI };
  let roiInitialized = false;
  let tradeBatchId = null;
  let tradeQueueRevision = 0;
  let tradeRuntimeAvailable = false;
  let tradeRecognitionPending = false;
  let liveListResult = null;
  let tradeCatalog;
  const tradeCatalogReady = fetch("/assets/data/trade-catalog.json").then((response) => {
    if (!response.ok) throw new Error("품목 기준 자료를 불러오지 못했습니다.");
    return response.json();
  }).then((value) => { tradeCatalog = value; });
  const roiUI = initCaptureRoiUI({
    video: tradePreview, stage: tradePreviewStage, box: tradeRoiBox,
    getRegion: () => tradeRoi, setRegion: (region) => { tradeRoi = region; },
    isVisible: () => tradeDialog.open,
    canInteract: () => screenSession.state === "CONNECTED",
  });
  const renderTradeRoi = roiUI.render;

  const showDiagnostics = (value) => {
    const summary = document.createElement("summary"); summary.textContent = `인식 진단 · ${value.stage} · ${value.code}`;
    const details = document.createElement("pre"); details.textContent = JSON.stringify(value, null, 2);
    recognitionDiagnostics.replaceChildren(summary, details);
    recognitionDiagnostics.hidden = false;
  };
  const liveListUI = createTradeLiveListUI({
    elements: { liveListSection, tradeRecognitionStatus, tradeRecognitionRegion, tradeRecognitionResultRegion, recognitionDiagnostics },
    getCatalog: () => tradeCatalog,
    getPending: () => tradeRecognitionPending,
    setPending: (pending) => { tradeRecognitionPending = pending; updateRecognitionControls(); renderTradeQueue(); },
    onResult: (result) => { liveListResult = result; },
    onApplied: () => {
      invalidateRecognitionResult(tradeRecognitionStatus.textContent);
      tradeDialog.close();
    },
  });
  const renderLiveList = liveListUI.render;
  const initializeRoi = () => {
    if (!roiInitialized && tradePreview.videoWidth > 0 && tradePreview.videoHeight > 0) {
      tradeRoi = { ...DEFAULT_TRADE_ROI };
      roiInitialized = true;
    }
    renderTradeRoi();
  };

  const updateRecognitionControls = () => {
    tradeRecognitionButton.disabled = tradeRecognitionPending || !tradeRuntimeAvailable || tradeQueue.length === 0;
    tradeRecognitionButton.textContent = tradeRecognitionPending ? "인식 결과 만드는 중…" : "인식 결과 만들기";
    tradeRecognitionButton.setAttribute("aria-busy", String(tradeRecognitionPending));
    tradeRecognitionRegion.setAttribute("aria-busy", String(tradeRecognitionPending));
    tradeScreenCaptureButton.disabled = tradeRecognitionPending || screenSession.state !== "CONNECTED" || !tradeDialog.open;
    tradeInput.disabled = tradeRecognitionPending;
    tradePasteTarget.disabled = tradeRecognitionPending;
    tradeRoiReset.disabled = tradeRecognitionPending;
  };
  const resizeTradeDialog = () => {
    const scale = Number(getComputedStyle(document.body).zoom) || 1;
    tradeDialog.style.width = `${Math.min(1180, (window.innerWidth - 24) / scale)}px`;
  };
  listen(window, "resize", resizeTradeDialog);
  const refreshTradeRuntime = async () => {
    tradeRuntimeAvailable = false;
    tradeRuntimeStatus.textContent = "로컬 인식 엔진 확인 중…";
    updateRecognitionControls();
    try {
      const runtime = await getTradeRecognitionRuntime();
      tradeRuntimeAvailable = runtime.available === true;
      tradeRuntimeStatus.textContent = tradeRuntimeAvailable ? "로컬 인식 사용 가능" : "로컬 인식 엔진을 사용할 수 없습니다.";
    } catch {
      tradeRuntimeStatus.textContent = "로컬 인식 상태를 확인하지 못했습니다.";
    }
    updateRecognitionControls();
  };
  const invalidateRecognitionResult = (message = "대기 이미지가 변경되었습니다. 다시 인식하세요.") => {
    liveListResult = null;
    liveListUI.clear();
    recognitionDiagnostics.hidden = true;
    tradeRecognitionResultRegion.hidden = true;
    tradeRecognitionStatus.textContent = message;
  };
  listen(tradePreview, "loadedmetadata", initializeRoi);
  const renderTradeQueue = () => {
    tradePreviews.clear();
    tradeList.replaceChildren();
    for (const capture of tradeQueue.items) {
      const item = document.createElement("li");
      item.className = "capture-draft-item";
      item.dataset.captureId = capture.metadata.captureId;
      item.dataset.status = "TRADE_DRAFT";
      item.dataset.batchId = capture.metadata.batchId ?? "";
      if (capture.regionEvidence) item.dataset.regionEvidence = JSON.stringify(capture.regionEvidence);
      const image = document.createElement("img");
      image.alt = "물교 캡처 이미지 미리보기";
      image.src = tradePreviews.create(capture.blob);
      const details = document.createElement("div");
      details.className = "capture-draft-details";
      const heading = document.createElement("strong");
      const regionLabel = capture.regionEvidence ? "선택 영역" : "캡처 이미지";
      heading.textContent = `${regionLabel} · ${capture.metadata.frame.width}×${capture.metadata.frame.height}`;
      const meta = document.createElement("span");
      const sourceLabel = ({ clipboard: "클립보드", "browser-stream": "화면", "native-screen": "게임 캡처", file: "파일" }[capture.metadata.sourceType] ?? "이미지");
      meta.textContent = `${sourceLabel} · ${(capture.bytes / 1024 / 1024).toFixed(2)} MiB${capture.reencoded ? " · PNG 변환" : ""}`;
      const status = document.createElement("span");
      status.className = "capture-draft-state";
      status.textContent = "인식 대기";
      details.append(heading, meta, status);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "제거";
      remove.setAttribute("aria-label", "물교 캡처 이미지 제거");
      remove.disabled = tradeRecognitionPending;
      remove.addEventListener("click", () => {
        if (tradeRecognitionPending) return;
        tradeQueue.remove(capture.metadata.captureId);
        if (tradeQueue.items.every((item) => item.metadata.sourceType !== "browser-stream")) tradeBatchId = null;
        tradeQueueRevision += 1;
        invalidateRecognitionResult();
        tradeStatus.textContent = "캡처 이미지를 제거했습니다.";
        renderTradeQueue();
      });
      item.append(image, details, remove);
      tradeList.append(item);
    }
    tradeDialog.dataset.queueLength = String(tradeQueue.length);
    tradeDialog.dataset.queueBytes = String(tradeQueue.bytes);
    const sourceCounts = tradeQueue.items.reduce((counts, capture) => {
      const key = ({ "browser-stream": "화면", clipboard: "붙여넣기", "native-screen": "게임 캡처", file: "파일" }[capture.metadata.sourceType] ?? "이미지");
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const sourceSummary = Object.entries(sourceCounts).map(([name, count]) => `${name} ${count}`).join(" · ");
    tradeQueueSummary.textContent = `준비된 이미지 ${tradeQueue.length}개${sourceSummary ? ` · ${sourceSummary}` : ""}`;
    tradeClearButton.disabled = tradeRecognitionPending || tradeQueue.length === 0;
    updateRecognitionControls();
  };

  const appendTradeCaptures = (captures) => {
    if (events.signal.aborted) return;
    tradeQueue.append(captures);
    tradeQueueRevision += 1;
    invalidateRecognitionResult();
    renderTradeQueue();
    tradeStatus.textContent = `${captures.length}개 이미지를 추가했습니다. 인식은 아직 실행되지 않았습니다.`;
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
    const connected = screenState === "CONNECTED";
    const previewActive = connected || screenState === "CAPTURING";
    tradeScreenCaptureButton.disabled = tradeRecognitionPending || !connected || !tradeDialog.open;
    tradePreviewStatus.textContent = screenState === "CONNECTING" ? "화면 연결 중입니다…" : previewActive ? "화면 미리보기가 연결되었습니다. 영역을 맞춘 뒤 캡처하세요." : "화면이 연결되지 않았습니다. 위의 ‘화면 연결’을 먼저 사용하세요.";
    if (tradeDialog.open && previewActive) screenSession.attachPreview(tradePreview);
    else if (!previewActive) screenSession.detachPreview(tradePreview);
    if (connected) initializeRoi();
    else tradeRoiBox.hidden = true;
    updateRecognitionControls();
  };

  screenSession.subscribe(renderScreenState);
  renderScreenState();
  listen(connectScreenButton, "click", () => {
    // Keep connectScreen invocation directly in the click handler for browser user activation.
    const connection = screenSession.connectScreen();
    void connection.catch(() => {});
  });
  listen(disconnectScreenButton, "click", () => screenSession.disconnectScreen("user"));

  const captureScreenInto = (taskType, button, accept, reportError) => {
    listen(button, "click", async () => {
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
  listen(tradeScreenCaptureButton, "click", async () => {
    if (tradeRecognitionPending || screenSession.state !== "CONNECTED") return;
    if (!tradeBatchId) tradeBatchId = globalThis.crypto?.randomUUID?.() ?? null;
    if (!tradeBatchId) { tradeStatus.textContent = "안전한 캡처 묶음 ID를 만들 수 없습니다."; return; }
    tradeScreenCaptureButton.disabled = true;
    try {
      const capture = await screenSession.captureRegion(captureContext("trade"), tradeRoi, tradeBatchId);
      appendTradeCaptures([capture]);
      tradeStatus.textContent = `선택 영역 ${capture.metadata.frame.width}×${capture.metadata.frame.height}을 추가했습니다. 인식은 아직 실행되지 않았습니다.`;
    } catch (error) {
      tradeStatus.textContent = explain(error);
      showDiagnostics({ stage: "CAPTURE_DECODE", code: error?.code ?? "capture_failed" });
      if (tradeQueue.items.every((item) => item.metadata.sourceType !== "browser-stream")) tradeBatchId = null;
    } finally { renderScreenState(); }
  });
  listen(tradeClearButton, "click", () => {
    if (tradeRecognitionPending) return;
    tradeQueue.clear();
    tradeQueueRevision += 1;
    tradePreviews.clear();
    tradeBatchId = null;
    invalidateRecognitionResult("대기 이미지를 지워 인식 결과도 지웠습니다.");
    renderTradeQueue();
    tradeStatus.textContent = "대기 이미지를 모두 삭제했습니다. 화면 연결과 영역은 유지됩니다.";
  });
  listen(tradeRoiReset, "click", () => { tradeRoi = { ...DEFAULT_TRADE_ROI }; roiInitialized = true; renderTradeRoi(); });

  listen(tradeRecognitionButton, "click", async () => {
    if (tradeRecognitionButton.disabled) return;
    const requestRevision = tradeQueueRevision;
    const captures = [...tradeQueue.items];
    tradeRecognitionPending = true;
    updateRecognitionControls();
    tradeRecognitionStatus.textContent = "로컬 인식으로 물교 목록을 만드는 중…";
    try {
      await tradeCatalogReady;
      const result = await recognizeTradeLiveList(captures);
      if (requestRevision !== tradeQueueRevision) return;
      renderLiveList(result, captures);
      if (result.rows.length) {
        tradeQueue.clear();
        tradeQueueRevision += 1;
        tradeBatchId = null;
        tradeStatus.textContent = "인식한 스크린샷을 모두 비웠습니다.";
      }
      const reviewCount = result.rows.reduce((n, row) => n + Object.values(row.fields).filter(f => f.reviewRequired).length, 0);
      tradeRecognitionStatus.textContent = result.rows.length
        ? `물교 ${result.rows.length}행 · 확인 필요 ${reviewCount}곳. 고정 수량은 교환 규칙으로 반영했습니다.`
        : "물교 행을 찾지 못했습니다. 물교 표 전체가 포함되도록 입력해 주세요.";
    } catch (error) {
      tradeRecognitionStatus.textContent = error.message;
      showDiagnostics({ ...error.diagnostics, stage: error.stage ?? "OCR_RUNTIME", code: error.code ?? "recognition_failed" });
    } finally {
      tradeRecognitionPending = false;
      if (liveListResult) renderLiveList(liveListResult);
      updateRecognitionControls();
      renderTradeQueue();
    }
  });

  listen(openTradeButton, "click", () => {
    tradeStatus.textContent = "파일을 선택하거나 붙여넣기 버튼을 누른 뒤 Ctrl+V를 사용하세요.";
    renderTradeQueue();
    resizeTradeDialog();
    tradeDialog.showModal();
    tradeRecognitionResultRegion.hidden = !liveListResult;
    void refreshTradeRuntime();
    if (screenSession.connected) screenSession.attachPreview(tradePreview);
    initializeRoi();
    renderScreenState();
    tradePasteTarget.focus({ preventScroll: true });
  });
  tradeDialog.querySelectorAll("[data-close-trade-capture]").forEach((button) => listen(button, "click", () => tradeDialog.close()));
  listen(tradeDialog, "close", () => {
    if (tradeDialog.open) return;
    tradePreviews.clear();
    screenSession.detachPreview(tradePreview);
    tradeRoiBox.hidden = true;
  });
  listen(tradeInput, "change", async () => {
    if (tradeRecognitionPending) { tradeInput.value = ""; return; }
    const files = [...(tradeInput.files ?? [])];
    tradeInput.value = "";
    if (tradeQueue.length + files.length > captureLimits.MAX_BATCH_FRAMES) {
      tradeStatus.textContent = `대기 이미지는 최대 ${captureLimits.MAX_BATCH_FRAMES}개입니다. 기존 이미지는 유지했습니다.`;
      return;
    }
    if (tradeQueue.bytes + files.reduce((sum, file) => sum + file.size, 0) > captureLimits.MAX_BATCH_BYTES) {
      tradeStatus.textContent = "대기 이미지의 전체 용량은 20 MiB 이하여야 합니다. 기존 이미지는 유지했습니다.";
      return;
    }
    for (const file of files) {
      try {
        const capture = await captureFromFile(file, captureContext("trade"));
        appendTradeCaptures([capture]);
      } catch (error) {
        tradeStatus.textContent = explain(error);
        showDiagnostics({ stage: "CAPTURE_DECODE", code: error?.code ?? "capture_failed" });
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
      return { taskType: "trade", accept: appendTradeCaptures, reportError: (error) => {
        tradeStatus.textContent = explain(error);
        showDiagnostics({ stage: "CAPTURE_DECODE", code: error?.code ?? "capture_failed" });
      } };
    }
    return null;
  };

  const onPaste = (event) => {
    if (tradeRecognitionPending) return;
    if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return;
    const active = openCaptureContext();
    if (!active) return;
    const hasImage = [...(event.clipboardData?.items ?? [])].some((item) => item.kind === "file" && String(item.type ?? "").toLowerCase().startsWith("image/"));
    if (!hasImage) return;
    void captureFromPaste(event, captureContext(active.taskType)).then((result) => {
      if (result.handled && openCaptureContext()?.taskType === active.taskType) active.accept(result.inputs);
    }).catch(active.reportError);
  };
  listen(document, "paste", onPaste);

  const nativeUI = initNativeCaptureUI({
    trade: { dialog: tradeDialog,
      getContext: () => captureContext("trade"),
      getState: () => ({ count: tradeQueue.length, bytes: tradeQueue.bytes, busy: tradeRecognitionPending }),
      accept: appendTradeCaptures },
    warehouse: { dialog: warehouseCaptureUI.dialog,
      getContext: () => captureContext("warehouse"), getState: warehouseCaptureUI.getNativeQueueState,
      accept: warehouseCaptureUI.acceptCaptures },
  });

  const cleanup = () => {
    if (events.signal.aborted) return;
    events.abort();
    nativeUI.cleanup();
    screenSession.dispose();
    roiUI.dispose();
    tradePreviews.clear();
    liveListUI.dispose();
    tradeQueue.clear();
    liveListResult = null;
    tradeList.replaceChildren();
    recognitionDiagnostics.remove();
    warehouseScreenCaptureButton.remove();
  };
  listen(window, "pagehide", (event) => { if (!event.persisted) cleanup(); });

  return { getTradeDraftCount: () => tradeQueue.length, cleanup };
}
