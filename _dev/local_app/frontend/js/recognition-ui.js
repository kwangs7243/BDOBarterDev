import { state } from "./state.js";
import { CaptureError, CaptureQueue, DEFAULT_TRADE_ROI, PreviewRegistry, ScreenCaptureSession, captureFromFile, captureFromPaste, captureLimits, displayedVideoContentRect, isEditableTarget, moveNormalizedRegion, normalizeRegion, resizeNormalizedRegion } from "./capture.js";
import { getTradeRecognitionRuntime, recognizeTradeBatch } from "./trade-recognition-client.js";

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
  const tradeScreenCaptureButton = tradeDialog.querySelector("[data-action='capture-trade-roi']");
  const tradeClearButton = tradeDialog.querySelector("[data-action='clear-trade-queue']");
  const tradePreview = tradeDialog.querySelector("[data-role='trade-preview-video']");
  const tradePreviewStage = tradeDialog.querySelector("[data-role='trade-preview-stage']");
  const tradePreviewStatus = tradeDialog.querySelector("[data-role='trade-preview-status']");
  const tradeRoiBox = tradeDialog.querySelector("[data-role='trade-roi']");
  const tradeRoiReset = tradeDialog.querySelector("[data-action='reset-trade-roi']");
  const tradeRecognitionButton = tradeDialog.querySelector("[data-action='recognize-trade']");
  const tradeRuntimeStatus = tradeDialog.querySelector("[data-role='trade-runtime-status']");
  const tradeRecognitionStatus = tradeDialog.querySelector("[data-role='trade-recognition-status']");
  const tradeRecognitionRegion = tradeDialog.querySelector("[data-role='trade-recognition']");
  const tradeRecognitionResultRegion = tradeDialog.querySelector("[data-role='trade-recognition-result']");
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
  let tradeRecognitionResult = null;
  let previewResizeObserver;

  const previewContent = () => displayedVideoContentRect(tradePreview, tradePreviewStage);
  const renderTradeRoi = () => {
    const content = previewContent();
    if (!content || !tradeDialog.open) { tradeRoiBox.hidden = true; return; }
    tradeRoi = normalizeRegion(tradeRoi);
    const stage = tradePreviewStage.getBoundingClientRect();
    tradeRoiBox.hidden = false;
    tradeRoiBox.style.left = `${content.left - stage.left + tradeRoi.x * content.width}px`;
    tradeRoiBox.style.top = `${content.top - stage.top + tradeRoi.y * content.height}px`;
    tradeRoiBox.style.width = `${tradeRoi.width * content.width}px`;
    tradeRoiBox.style.height = `${tradeRoi.height * content.height}px`;
    tradeRoiBox.dataset.normalized = JSON.stringify(tradeRoi);
  };
  const initializeRoi = () => {
    if (!roiInitialized && tradePreview.videoWidth > 0 && tradePreview.videoHeight > 0) {
      tradeRoi = { ...DEFAULT_TRADE_ROI };
      roiInitialized = true;
    }
    renderTradeRoi();
  };

  const fieldLabels = { island: "섬", fromItem: "소모품", reqAmount: "필요 수량", toItem: "획득품", count: "남은 교환 횟수", yield: "수율" };
  const fieldStatusLabels = {
    RAW_OCR_CANDIDATE: "인식 후보", NUMERIC_OCR_CANDIDATE: "숫자 후보", UNREADABLE: "확인 필요",
    EMPTY_OCR: "읽지 못함", FIELD_CLIPPED: "영역 잘림", GEOMETRY_ABSTAIN: "판독 보류", OCR_ERROR: "인식 오류",
  };
  const makeElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const displayFieldValue = (key, field) => {
    if (["reqAmount", "count", "yield"].includes(key)) {
      if (Number.isInteger(field.rawNumericCandidate)) return String(field.rawNumericCandidate);
      return typeof field.rawText === "string" && field.rawText.length ? field.rawText : "읽지 못함";
    }
    if (typeof field.normalizedText === "string" && field.normalizedText.length) return field.normalizedText;
    return typeof field.rawText === "string" && field.rawText.length ? field.rawText : "읽지 못함";
  };
  const renderTradeRecognitionResult = () => {
    tradeRecognitionResultRegion.replaceChildren();
    tradeRecognitionResultRegion.hidden = !tradeRecognitionResult;
    if (!tradeRecognitionResult) return;
    const result = tradeRecognitionResult;
    const edgeSummary = result.edgeSegments.length ? ` · 경계 후보 ${result.edgeSegments.length}행 제외` : "";
    const summary = makeElement("div", "trade-recognition-summary", `로컬 인식 초안 · ${result.draftRows.length}행 · 이미지 ${result.captures.length}장${edgeSummary} · 목록 미적용`);
    const clear = makeElement("button", "trade-recognition-actions", "인식 결과 지우기");
    clear.type = "button";
    clear.dataset.action = "clear-trade-recognition-result";
    clear.addEventListener("click", () => {
      tradeRecognitionResult = null;
      renderTradeRecognitionResult();
      tradeRecognitionStatus.textContent = "인식 결과를 지웠습니다. 대기 이미지와 화면 연결은 유지됩니다.";
    });
    const tableWrap = makeElement("div", "trade-recognition-table-wrap");
    const table = makeElement("table", "trade-recognition-table");
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    ["행", ...Object.values(fieldLabels), "상태"].forEach((label) => headerRow.append(makeElement("th", "", label)));
    head.append(headerRow);
    const body = document.createElement("tbody");
    result.draftRows.forEach((row, index) => {
      const tr = document.createElement("tr");
      tr.dataset.captureId = row.captureId ?? "";
      tr.dataset.ordinal = String(row.ordinal ?? index + 1);
      tr.append(makeElement("th", "", String(index + 1)));
      for (const key of Object.keys(fieldLabels)) {
        const field = row.fields[key];
        const td = makeElement("td");
        const value = makeElement("span", "trade-recognition-value", displayFieldValue(key, field));
        const status = makeElement("span", "trade-recognition-field-status", fieldStatusLabels[field.status] ?? "확인 필요");
        status.title = `${field.status ?? "UNKNOWN"}${Array.isArray(field.reasonCodes) && field.reasonCodes.length ? ` · ${field.reasonCodes.join(", ")}` : ""}`;
        td.append(value, status);
        tr.append(td);
      }
      tr.append(makeElement("td", "", "인식 초안 · 검토 필요"));
      body.append(tr);
      const rawDiffers = Object.values(row.fields).some((field) => typeof field.rawText === "string"
        && typeof field.normalizedText === "string" && field.rawText !== field.normalizedText);
      const hasReasons = Object.values(row.fields).some((field) => Array.isArray(field.reasonCodes) && field.reasonCodes.length);
      if (rawDiffers || hasReasons) {
        const detailRow = document.createElement("tr");
        const detailCell = document.createElement("td");
        detailCell.colSpan = 8;
        const details = document.createElement("details");
        details.className = "trade-recognition-evidence";
        details.append(makeElement("summary", "", `행 ${index + 1} 판독 근거`));
        const list = document.createElement("ul");
        for (const key of Object.keys(fieldLabels)) {
          const field = row.fields[key];
          const evidence = [];
          if (typeof field.rawText === "string" && field.rawText.length) evidence.push(`원문: ${field.rawText}`);
          evidence.push(`상태: ${field.status ?? "UNKNOWN"}`);
          if (Array.isArray(field.reasonCodes) && field.reasonCodes.length) evidence.push(`사유: ${field.reasonCodes.join(", ")}`);
          if (evidence.length > 1 || (typeof field.normalizedText === "string" && field.rawText !== field.normalizedText)) {
            list.append(makeElement("li", "", `${fieldLabels[key]} · ${evidence.join(" · ")}`));
          }
        }
        details.append(list);
        detailCell.append(details);
        detailRow.append(detailCell);
        body.append(detailRow);
      }
    });
    table.append(head, body);
    tableWrap.append(table);
    tradeRecognitionResultRegion.append(summary, clear, tableWrap);
  };
  const updateRecognitionControls = () => {
    tradeRecognitionButton.disabled = tradeRecognitionPending || !tradeRuntimeAvailable || tradeQueue.length === 0;
    tradeRecognitionButton.textContent = tradeRecognitionPending ? "로컬 인식 중…" : "로컬 인식 실행";
    tradeRecognitionButton.setAttribute("aria-busy", String(tradeRecognitionPending));
    tradeRecognitionRegion.setAttribute("aria-busy", String(tradeRecognitionPending));
    tradeScreenCaptureButton.disabled = tradeRecognitionPending || screenSession.state !== "CONNECTED" || !tradeDialog.open;
    tradeInput.disabled = tradeRecognitionPending;
    tradePasteTarget.disabled = tradeRecognitionPending;
    tradeRoiReset.disabled = tradeRecognitionPending;
  };
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
    tradeRecognitionResult = null;
    renderTradeRecognitionResult();
    tradeRecognitionStatus.textContent = message;
  };
  tradePreview.addEventListener("loadedmetadata", initializeRoi);
  tradePreview.addEventListener("resize", renderTradeRoi);
  if (typeof ResizeObserver === "function") {
    previewResizeObserver = new ResizeObserver(renderTradeRoi);
    previewResizeObserver.observe(tradePreviewStage);
  }

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
      image.alt = "물교 이미지 초안 미리보기";
      image.src = tradePreviews.create(capture.blob);
      const details = document.createElement("div");
      details.className = "capture-draft-details";
      const heading = document.createElement("strong");
      const regionLabel = capture.regionEvidence ? "선택 영역" : "이미지 초안";
      heading.textContent = `${regionLabel} · ${capture.metadata.frame.width}×${capture.metadata.frame.height}`;
      const meta = document.createElement("span");
      const sourceLabel = capture.metadata.sourceType === "clipboard" ? "클립보드" : capture.metadata.sourceType === "browser-stream" ? "화면" : "파일";
      meta.textContent = `${sourceLabel} · ${(capture.bytes / 1024 / 1024).toFixed(2)} MiB${capture.reencoded ? " · PNG 변환" : ""}`;
      const status = document.createElement("span");
      status.className = "capture-draft-state";
      status.textContent = "초안 · 인식 미실행";
      details.append(heading, meta, status);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "제거";
      remove.setAttribute("aria-label", "물교 이미지 초안 제거");
      remove.disabled = tradeRecognitionPending;
      remove.addEventListener("click", () => {
        if (tradeRecognitionPending) return;
        tradeQueue.remove(capture.metadata.captureId);
        if (tradeQueue.items.every((item) => item.metadata.sourceType !== "browser-stream")) tradeBatchId = null;
        tradeQueueRevision += 1;
        invalidateRecognitionResult();
        tradeStatus.textContent = "이미지 초안을 제거했습니다.";
        renderTradeQueue();
      });
      item.append(image, details, remove);
      tradeList.append(item);
    }
    tradeDialog.dataset.queueLength = String(tradeQueue.length);
    tradeDialog.dataset.queueBytes = String(tradeQueue.bytes);
    tradeClearButton.disabled = tradeRecognitionPending || tradeQueue.length === 0;
    updateRecognitionControls();
  };

  const appendTradeCaptures = (captures) => {
    tradeQueue.append(captures);
    tradeQueueRevision += 1;
    invalidateRecognitionResult();
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
  tradeScreenCaptureButton.addEventListener("click", async () => {
    if (tradeRecognitionPending || screenSession.state !== "CONNECTED") return;
    if (!tradeBatchId) tradeBatchId = globalThis.crypto?.randomUUID?.() ?? null;
    if (!tradeBatchId) { tradeStatus.textContent = "안전한 캡처 묶음 ID를 만들 수 없습니다."; return; }
    tradeScreenCaptureButton.disabled = true;
    try {
      const capture = await screenSession.captureRegion(captureContext("trade"), tradeRoi, tradeBatchId);
      appendTradeCaptures([capture]);
      tradeStatus.textContent = `선택 영역 ${capture.metadata.frame.width}×${capture.metadata.frame.height}을 초안으로 보관했습니다. 인식은 실행하지 않았습니다.`;
    } catch (error) {
      tradeStatus.textContent = explain(error);
      if (tradeQueue.items.every((item) => item.metadata.sourceType !== "browser-stream")) tradeBatchId = null;
    } finally { renderScreenState(); }
  });
  tradeClearButton.addEventListener("click", () => {
    if (tradeRecognitionPending) return;
    tradeQueue.clear();
    tradeQueueRevision += 1;
    tradePreviews.clear();
    tradeBatchId = null;
    tradeRecognitionResult = null;
    renderTradeRecognitionResult();
    renderTradeQueue();
    tradeStatus.textContent = "대기 이미지를 모두 삭제했습니다. 화면 연결과 영역은 유지됩니다.";
  });
  tradeRoiReset.addEventListener("click", () => { tradeRoi = { ...DEFAULT_TRADE_ROI }; roiInitialized = true; renderTradeRoi(); });

  tradeRecognitionButton.addEventListener("click", async () => {
    if (tradeRecognitionPending || !tradeRuntimeAvailable || tradeQueue.length === 0) return;
    const requestRevision = tradeQueueRevision;
    const captures = [...tradeQueue.items];
    tradeRecognitionPending = true;
    tradeRecognitionStatus.textContent = "로컬 인식 중… 대기 이미지는 유지됩니다.";
    updateRecognitionControls();
    renderTradeQueue();
    try {
      const result = await recognizeTradeBatch(captures);
      if (requestRevision !== tradeQueueRevision) {
        invalidateRecognitionResult("대기 이미지가 변경되어 인식 결과를 사용하지 않았습니다. 다시 인식하세요.");
        return;
      }
      tradeRecognitionResult = result;
      renderTradeRecognitionResult();
      tradeRecognitionStatus.textContent = "인식 초안을 표시했습니다. 목록에는 적용되지 않았습니다.";
    } catch (error) {
      tradeRecognitionStatus.textContent = error?.message || "로컬 인식 요청에 실패했습니다. 대기 이미지는 유지했습니다.";
    } finally {
      tradeRecognitionPending = false;
      updateRecognitionControls();
      renderTradeQueue();
    }
  });

  const roiPointerStart = (event) => {
    if (screenSession.state !== "CONNECTED") return;
    const content = previewContent();
    if (!content) return;
    const handle = event.target.closest("[data-roi-handle]")?.dataset.roiHandle;
    if (!handle && !event.target.closest("[data-roi-move]")) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, region: { ...tradeRoi }, content };
    const minimumWidth = Math.min(0.95, 80 / content.width);
    const minimumHeight = Math.min(0.95, 60 / content.height);
    try { event.target.setPointerCapture?.(event.pointerId); } catch {}
    const move = (next) => {
      const dx = (next.clientX - start.x) / start.content.width;
      const dy = (next.clientY - start.y) / start.content.height;
      tradeRoi = handle ? resizeNormalizedRegion(start.region, handle, dx, dy, minimumWidth, minimumHeight) : moveNormalizedRegion(start.region, dx, dy, minimumWidth, minimumHeight);
      renderTradeRoi();
    };
    const finish = () => {
      tradeRoiBox.removeEventListener("pointermove", move);
      tradeRoiBox.removeEventListener("pointerup", finish);
      tradeRoiBox.removeEventListener("pointercancel", finish);
    };
    tradeRoiBox.addEventListener("pointermove", move);
    tradeRoiBox.addEventListener("pointerup", finish, { once: true });
    tradeRoiBox.addEventListener("pointercancel", finish, { once: true });
  };
  tradeRoiBox.addEventListener("pointerdown", roiPointerStart);

  openTradeButton.addEventListener("click", () => {
    tradeStatus.textContent = "파일을 선택하거나 붙여넣기 버튼을 누른 뒤 Ctrl+V를 사용하세요.";
    renderTradeQueue();
    tradeDialog.showModal();
    renderTradeRecognitionResult();
    void refreshTradeRuntime();
    if (screenSession.connected) screenSession.attachPreview(tradePreview);
    initializeRoi();
    renderScreenState();
    tradePasteTarget.focus({ preventScroll: true });
  });
  tradeDialog.querySelectorAll("[data-close-trade-capture]").forEach((button) => button.addEventListener("click", () => tradeDialog.close()));
  tradeDialog.addEventListener("close", () => {
    if (tradeDialog.open) return;
    tradePreviews.clear();
    screenSession.detachPreview(tradePreview);
    tradeRoiBox.hidden = true;
  });
  tradeInput.addEventListener("change", async () => {
    if (tradeRecognitionPending) { tradeInput.value = ""; return; }
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
      previewResizeObserver?.disconnect();
      tradePreviews.clear();
      tradeQueue.clear();
    },
  };
}
