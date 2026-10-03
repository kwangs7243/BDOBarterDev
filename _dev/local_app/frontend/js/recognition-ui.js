import { state } from "./state.js";
import { CaptureError, CaptureQueue, DEFAULT_TRADE_ROI, PreviewRegistry, ScreenCaptureSession, captureFromFile, captureFromPaste, captureLimits, displayedVideoContentRect, isEditableTarget, moveNormalizedRegion, normalizeRegion, resizeNormalizedRegion } from "./capture.js";
import { getTradeRecognitionRuntime, recognizeTradeLiveList, saveTradeCorrections } from "./trade-recognition-client.js";
import { whenPersistenceIdle } from "./persistence.js";
import { applyLiveTradeRows } from "./trade-ui.js";

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

  const showDiagnostics = (value) => {
    const summary = document.createElement("summary"); summary.textContent = `인식 진단 · ${value.stage} · ${value.code}`;
    const details = document.createElement("pre"); details.textContent = JSON.stringify(value, null, 2);
    recognitionDiagnostics.replaceChildren(summary, details);
    recognitionDiagnostics.hidden = false;
  };
  const resultTable = (section, title, headers, rows) => {
    const heading = document.createElement("h3"); heading.textContent = title;
    const wrap = document.createElement("div"); wrap.className = "trade-recognition-table-wrap";
    const table = document.createElement("table"); table.className = "trade-recognition-table";
    const head = table.createTHead().insertRow();
    headers.forEach((label) => { const cell = document.createElement("th"); cell.textContent = label; head.append(cell); });
    const body = table.createTBody();
    rows.forEach((values) => {
      const row = body.insertRow();
      values.forEach((value) => { const cell = row.insertCell(); cell.textContent = value === null || value === undefined ? "미확인" : String(value); });
    });
    wrap.append(table); section.replaceChildren(heading, wrap);
  };
  const fieldLabels = ["섬", "교환 아이템", "필요 수량", "결과 아이템", "교환 횟수", "결과 수량"];
  const renderLiveList = (result) => {
    for (const row of result.rows) for (const field of Object.values(row.fields)) {
      if (!Object.hasOwn(field, "automaticCorrected")) field.automaticCorrected = field.corrected;
    }
    liveListResult = result;
    liveListSection.hidden = false;
    resultTable(liveListSection, `물교 목록 · ${result.rows.length}행`, ["섬", "요구 아이템", "요구 수량", "결과 아이템", "남은 교환 횟수", "결과 수량"], result.rows.map((row) =>
      ["island", "fromItem", "reqAmount", "toItem", "count", "yield"].map((name) => {
        const field = row.fields[name];
        const numeric = ["reqAmount", "count", "yield"].includes(name);
        const value = field.corrected ?? (numeric ? "?" : field.rawOCR || "?");
        return `${value}${field.reviewRequired ? `\n확인 필요${field.allowedValues ? ` (${field.allowedValues.join("·")})` : ""}` : ""}`;
      })));
    const details = document.createElement("details");
    const summary = document.createElement("summary"); summary.textContent = "인식 원문 보기";
    const raw = document.createElement("section");
    resultTable(raw, "인식 원문", fieldLabels, result.rows.map((row) =>
      ["island", "fromItem", "reqAmount", "toItem", "count", "yield"].map((name) => row.fields[name].rawOCR || "?")));
    details.append(summary, raw); liveListSection.append(details);
    const uncertain = result.rows.flatMap((row, index) => Object.entries(row.fields)
      .filter(([, field]) => field.reviewRequired).map(([name, field]) => ({ row, index, name, field })));
    const applyNew = document.createElement("button"); applyNew.type = "button";
    applyNew.dataset.action = "apply-live-new"; applyNew.textContent = "최종 물교 리스트로 새 회차 시작";
    const applyAppend = document.createElement("button"); applyAppend.type = "button";
    applyAppend.dataset.action = "apply-live-append"; applyAppend.textContent = "현재 회차에 추가";
    applyNew.disabled = applyAppend.disabled = uncertain.length > 0;
    if (uncertain.length) {
      const review = document.createElement("section"); review.dataset.role = "live-list-review";
      const title = document.createElement("h3"); title.textContent = `확인 필요한 값만 수정 · ${uncertain.length}곳`;
      const form = document.createElement("form");
      const inputs = uncertain.map((entry) => {
        const label = document.createElement("label");
        const caption = document.createElement("span"); caption.textContent = `${entry.index + 1}행 · ${entry.row.fields.island.corrected ?? entry.row.fields.island.rawOCR} · ${fieldLabels[["island", "fromItem", "reqAmount", "toItem", "count", "yield"].indexOf(entry.name)]}`;
        const input = document.createElement("input"); input.required = true;
        input.dataset.row = String(entry.index); input.dataset.field = entry.name;
        input.setAttribute("aria-label", caption.textContent);
        const numeric = ["reqAmount", "count", "yield"].includes(entry.name);
        input.type = numeric ? "number" : "text";
        if (numeric) { input.step = "1"; input.min = entry.name === "count" ? "0" : "1"; }
        input.value = entry.field.corrected ?? (numeric ? "" : entry.field.rawOCR);
        label.append(caption, input); form.append(label);
        return { ...entry, input, numeric };
      });
      const confirm = document.createElement("button"); confirm.type = "submit"; confirm.textContent = "수정 내용 확인"; form.append(confirm);
      const error = document.createElement("p"); error.setAttribute("role", "status");
      let feedbackId = null;
      let feedbackValues = null;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = inputs.map((entry) => entry.numeric ? Number(entry.input.value) : entry.input.value.trim());
        const invalid = inputs.findIndex((entry, i) => entry.input.value.trim() === "" || (entry.numeric
          ? !Number.isSafeInteger(values[i]) || values[i] < (entry.name === "count" ? 0 : 1)
            || entry.field.allowedValues && !entry.field.allowedValues.includes(values[i])
          : !values[i]));
        if (invalid !== -1) { error.textContent = "이름과 수량을 확인하세요. 1→2·2→3의 결과 수량은 2 또는 3입니다."; inputs[invalid].input.focus(); return; }
        if (confirm.disabled) return;
        const corrections = inputs.flatMap((entry, i) => entry.field.corrected === values[i]
          || entry.field.automaticCorrected === values[i] ? [] : [{
          captureId: entry.row.captureId, ordinal: entry.row.ordinal, rowBox: entry.row.rowBox,
          field: entry.name, box: entry.field.box, rawOCR: entry.field.rawOCR,
          confidence: entry.field.confidence ?? null, automaticCorrected: entry.field.automaticCorrected,
          finalValue: values[i],
        }]);
        if (corrections.length) {
          const key = JSON.stringify(corrections);
          if (key !== feedbackValues) { feedbackId = crypto.randomUUID(); feedbackValues = key; }
          confirm.disabled = true;
          tradeRecognitionPending = true;
          updateRecognitionControls(); renderTradeQueue();
          try { await saveTradeCorrections(tradeQueue.items, result, corrections, feedbackId); }
          catch (failure) { error.textContent = failure.message; return; }
          finally { confirm.disabled = false; tradeRecognitionPending = false; updateRecognitionControls(); renderTradeQueue(); }
        }
        inputs.forEach((entry, i) => Object.assign(entry.field, { corrected: values[i], reviewRequired: false, valueSource: "USER_REVIEW" }));
        renderLiveList(result);
      });
      review.append(title, form, error); liveListSection.append(review);
    }
    const apply = async (mode, button) => {
      if (mode === "new" && state.session.scannedTrades !== null && !window.confirm("현재 회차를 이 최종 물교 목록으로 바꿀까요?")) return;
      button.disabled = true;
      try {
        const rows = result.rows.map((row) => Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.corrected])));
        const applied = await applyLiveTradeRows(rows, mode);
        await whenPersistenceIdle();
        tradeRecognitionStatus.textContent = `최종 물교 ${applied.trades.length}행을 현재 회차에 적용했습니다. 물교 목록에서 스케줄을 생성할 수 있습니다.`;
      } catch (error) {
        for (const outcome of error.outcomes ?? []) {
          const row = result.rows[outcome.index];
          for (const field of outcome.field ? [outcome.field] : ["island", "fromItem", "toItem"]) {
            if (row?.fields[field]) row.fields[field].reviewRequired = true;
          }
        }
        if (error.outcomes?.length) renderLiveList(result);
        tradeRecognitionStatus.textContent = error.message;
      }
      finally { button.disabled = false; }
    };
    applyNew.addEventListener("click", () => void apply("new", applyNew));
    applyAppend.addEventListener("click", () => void apply("append", applyAppend));
    liveListSection.append(applyNew, applyAppend);
    tradeRecognitionResultRegion.hidden = false;
    tradeRecognitionRegion.style.flex = "0 0 auto";
    recognitionDiagnostics.hidden = true;
    liveListSection.scrollIntoView({ block: "nearest" });
    tradeRecognitionResultRegion.scrollTop = 0;
  };
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
  window.addEventListener("resize", resizeTradeDialog);
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
    liveListSection.replaceChildren(); liveListSection.hidden = true;
    recognitionDiagnostics.hidden = true;
    tradeRecognitionResultRegion.hidden = true;
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
      image.alt = "물교 캡처 이미지 미리보기";
      image.src = tradePreviews.create(capture.blob);
      const details = document.createElement("div");
      details.className = "capture-draft-details";
      const heading = document.createElement("strong");
      const regionLabel = capture.regionEvidence ? "선택 영역" : "캡처 이미지";
      heading.textContent = `${regionLabel} · ${capture.metadata.frame.width}×${capture.metadata.frame.height}`;
      const meta = document.createElement("span");
      const sourceLabel = capture.metadata.sourceType === "clipboard" ? "클립보드" : capture.metadata.sourceType === "browser-stream" ? "화면" : "파일";
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
      const key = capture.metadata.sourceType === "browser-stream" ? "화면" : capture.metadata.sourceType === "clipboard" ? "붙여넣기" : "파일";
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const sourceSummary = Object.entries(sourceCounts).map(([name, count]) => `${name} ${count}`).join(" · ");
    tradeQueueSummary.textContent = `준비된 이미지 ${tradeQueue.length}개${sourceSummary ? ` · ${sourceSummary}` : ""}`;
    tradeClearButton.disabled = tradeRecognitionPending || tradeQueue.length === 0;
    updateRecognitionControls();
  };

  const appendTradeCaptures = (captures) => {
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
      tradeStatus.textContent = `선택 영역 ${capture.metadata.frame.width}×${capture.metadata.frame.height}을 추가했습니다. 인식은 아직 실행되지 않았습니다.`;
    } catch (error) {
      tradeStatus.textContent = explain(error);
      showDiagnostics({ stage: "CAPTURE_DECODE", code: error?.code ?? "capture_failed" });
      if (tradeQueue.items.every((item) => item.metadata.sourceType !== "browser-stream")) tradeBatchId = null;
    } finally { renderScreenState(); }
  });
  tradeClearButton.addEventListener("click", () => {
    if (tradeRecognitionPending) return;
    tradeQueue.clear();
    tradeQueueRevision += 1;
    tradePreviews.clear();
    tradeBatchId = null;
    invalidateRecognitionResult("대기 이미지를 지워 인식 결과도 지웠습니다.");
    renderTradeQueue();
    tradeStatus.textContent = "대기 이미지를 모두 삭제했습니다. 화면 연결과 영역은 유지됩니다.";
  });
  tradeRoiReset.addEventListener("click", () => { tradeRoi = { ...DEFAULT_TRADE_ROI }; roiInitialized = true; renderTradeRoi(); });

  tradeRecognitionButton.addEventListener("click", async () => {
    if (tradeRecognitionButton.disabled) return;
    const requestRevision = tradeQueueRevision;
    const captures = [...tradeQueue.items];
    tradeRecognitionPending = true;
    updateRecognitionControls();
    tradeRecognitionStatus.textContent = "로컬 인식으로 물교 목록을 만드는 중…";
    try {
      const result = await recognizeTradeLiveList(captures);
      if (requestRevision !== tradeQueueRevision) return;
      renderLiveList(result);
      const reviewCount = result.rows.reduce((n, row) => n + Object.values(row.fields).filter(f => f.reviewRequired).length, 0);
      tradeRecognitionStatus.textContent = result.rows.length
        ? `물교 ${result.rows.length}행 · 확인 필요 ${reviewCount}곳. 고정 수량은 교환 규칙으로 반영했습니다.`
        : "물교 행을 찾지 못했습니다. 물교 표 전체가 포함되도록 입력해 주세요.";
    } catch (error) {
      tradeRecognitionStatus.textContent = error.message;
      showDiagnostics({ ...error.diagnostics, stage: error.stage ?? "OCR_RUNTIME", code: error.code ?? "recognition_failed" });
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
    resizeTradeDialog();
    tradeDialog.showModal();
    tradeRecognitionResultRegion.hidden = !liveListResult;
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
  document.addEventListener("paste", onPaste);

  window.addEventListener("beforeunload", (event) => {
    screenSession.disconnectScreen("beforeunload");
    tradePreviews.clear();
    tradeQueue.clear();
  });

  return {
    getTradeDraftCount: () => tradeQueue.length,
    cleanup: () => {
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("resize", resizeTradeDialog);
      screenSession.disconnectScreen("beforeunload");
      previewResizeObserver?.disconnect();
      tradePreviews.clear();
      tradeQueue.clear();
    },
  };
}
