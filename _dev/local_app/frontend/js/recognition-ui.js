import { state } from "./state.js";
import { CaptureError, CaptureQueue, DEFAULT_TRADE_ROI, PreviewRegistry, ScreenCaptureSession, captureFromFile, captureFromPaste, captureLimits, displayedVideoContentRect, isEditableTarget, moveNormalizedRegion, normalizeRegion, resizeNormalizedRegion } from "./capture.js";
import { getTradeRecognitionRuntime, recognizeTradeBatch } from "./trade-recognition-client.js";
import { mountTradeRecognitionReview } from "./trade-recognition-review.js";
import { validateReviewedTradeBatch } from "./domain/reviewed-trade-dto.js";
import { buildReviewedTradeSessionStage } from "./domain/trade-session-staging.js";
import { confirmWorkingSessionSnapshot, refreshPersistentState, sendWorkingSessionSnapshot, whenPersistenceIdle } from "./persistence.js";

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
  let tradeRecognitionResultRevision = null;
  let tradeReviewController = null;
  let tradeReviewGeneration = 0;
  let tradeReviewForResult = null;
  let tradeReviewMountPromise = null;
  let tradeObservationJob = null;
  let tradeSavedObservation = null;
  let tradeObservationInFlight = false;
  let reviewedBatch = null;
  let reviewedExclusions = new Map();
  let reviewedBatchRefreshRevision = 0;
  let sessionCommitJob = null;
  let sessionCommitInFlight = false;
  let previewResizeObserver;
  const tradeObservationActions = document.createElement("div");
  tradeObservationActions.className = "trade-review-storage-actions";
  const retryTradeObservation = document.createElement("button");
  retryTradeObservation.type = "button"; retryTradeObservation.textContent = "저장 재시도"; retryTradeObservation.hidden = true;
  const downloadTradeObservation = document.createElement("button");
  downloadTradeObservation.type = "button"; downloadTradeObservation.textContent = "검수 자료 내려받기"; downloadTradeObservation.hidden = true;
  tradeObservationActions.append(retryTradeObservation, downloadTradeObservation);
  tradeRecognitionStatus.after(tradeObservationActions);
  const sessionApplyPanel = document.createElement("section");
  sessionApplyPanel.className = "trade-review-session-apply";
  sessionApplyPanel.hidden = true;
  tradeObservationActions.after(sessionApplyPanel);

  const setTradeStorageStatus = (message, { retry = false, download = false } = {}) => {
    tradeRecognitionStatus.textContent = message;
    retryTradeObservation.hidden = !retry;
    downloadTradeObservation.hidden = !download;
    updateRecognitionControls();
  };
  const cloneFrozen = (value) => {
    const copy = JSON.parse(JSON.stringify(value));
    const freeze = (item) => { if (item && typeof item === "object" && !Object.isFrozen(item)) { Object.freeze(item); Object.values(item).forEach(freeze); } return item; };
    return freeze(copy);
  };
  const renderSessionApplyPanel = () => {
    sessionApplyPanel.replaceChildren();
    const saved = tradeSavedObservation;
    if (!saved) { sessionApplyPanel.hidden = true; return; }
    sessionApplyPanel.hidden = false;
    const title = document.createElement("h3"); title.textContent = "검수한 물교를 회차에 반영";
    const status = document.createElement("p"); status.dataset.role = "session-apply-status";
    const retry = document.createElement("button"); retry.type = "button"; retry.dataset.action = "retry-session-commit";
    const checkAgain = document.createElement("button"); checkAgain.type = "button"; checkAgain.dataset.action = "retry-session-readback";
    const reset = document.createElement("button"); reset.type = "button"; reset.dataset.action = "cancel-session-stage"; reset.textContent = "적용 준비 취소";
    const commit = document.createElement("button"); commit.type = "button"; commit.dataset.action = "commit-session-stage"; commit.textContent = "이 내용으로 회차 저장";
    const controls = document.createElement("div"); controls.className = "trade-review-session-controls";
    const newButton = document.createElement("button"); newButton.type = "button"; newButton.dataset.action = "apply-reviewed-new"; newButton.textContent = "새 회차로 적용";
    const appendButton = document.createElement("button"); appendButton.type = "button"; appendButton.dataset.action = "apply-reviewed-append"; appendButton.textContent = "현재 회차에 추가";
    const batch = reviewedBatch;
    let message = "저장된 검수 자료를 확인하는 중입니다.";
    if (batch) {
      if (batch.batchErrors?.length) message = `최종 DTO를 만들 수 없어 회차 적용을 막았습니다: ${batch.batchErrors.map((item) => typeof item === "string" ? item : (item.code ?? item.detail ?? JSON.stringify(item))).join(", ")}`;
      else if (batch.status === "NOT_READY") message = `보류 ${batch.heldRows.length}행이 남아 있습니다. 해당 행을 직접 제외하거나 검수 자료를 다시 확인하세요.`;
      else if (batch.summary.outputRowCount === 0) message = "적용할 물교 행이 없습니다.";
      else message = `검수 ${batch.summary.reviewedRowCount}행 · 최종 목록 ${batch.summary.outputRowCount}행 · 명시 제외 ${batch.summary.explicitlyExcludedRowCount}행 · 중복 통합 ${batch.coverage.duplicateCollapsedRowCount}행`;
    }
    if (sessionCommitJob?.status === "READY") message = `${sessionCommitJob.mode === "NEW" ? "새 회차" : "현재 회차에 추가"} 준비 완료 · 추가 ${sessionCommitJob.stage.summary.appendedRowCount}행 · 기존 중복 제외 ${sessionCommitJob.stage.summary.existingDuplicateSkippedCount}행`;
    else if (sessionCommitJob) message = `회차 적용 상태: ${sessionCommitJob.status}`;
    status.textContent = message;
    const decisionRows = batch && !batch.batchErrors?.length
      ? [...(batch.heldRows || []).map((row) => ({ ...row, excluded: false })), ...(batch.excludedRows || []).map((row) => ({ ...row, excluded: true }))] : [];
    if (decisionRows.length) {
      const heldTitle = document.createElement("p"); heldTitle.textContent = "보류 행은 직접 선택한 경우에만 최종 목록에서 제외됩니다. 이미 선택한 제외도 여기서 취소할 수 있습니다.";
      sessionApplyPanel.append(title, status, heldTitle);
      for (const row of decisionRows) {
        const label = document.createElement("label"); label.className = "trade-review-held-exclusion";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = reviewedExclusions.has(row.projectionRowId) || row.excluded;
        checkbox.dataset.projectionRowId = row.projectionRowId;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) reviewedExclusions.set(row.projectionRowId, { projectionRowId: row.projectionRowId, action: "EXCLUDE_FROM_FINAL_DTO", reason: "USER_EXPLICIT_EXCLUSION" });
          else reviewedExclusions.delete(row.projectionRowId);
          void refreshReviewedBatch();
        });
        const reasonText = (row.heldReasons || []).map((item) => item.code).join(", ") || "확인 필요";
        const values = row.humanFinalValues || {};
        const summary = [values.island, values.fromItem, values.toItem, values.reqAmount, values.count, values.yield].map((value) => value ?? "모름").join(" · ");
        label.append(checkbox, document.createTextNode(` 최종 회차에서 제외 · ${reasonText} · ${summary}`));
        sessionApplyPanel.append(label);
      }
    } else sessionApplyPanel.append(title, status);
    const ready = batch?.status === "READY" && !(batch.batchErrors?.length) && batch.summary.outputRowCount > 0 && !sessionCommitJob;
    newButton.disabled = !ready || sessionCommitInFlight || window.__bdoScheduleRuntime?.pending;
    appendButton.disabled = !ready || !state.workingSession || sessionCommitInFlight || window.__bdoScheduleRuntime?.pending;
    const actionButtons = [newButton, appendButton];
    controls.append(...actionButtons);
    commit.hidden = sessionCommitJob?.status !== "READY";
    commit.disabled = sessionCommitInFlight || window.__bdoScheduleRuntime?.pending;
    if (sessionCommitJob?.status === "COMMIT_RESPONSE_UNKNOWN") { retry.hidden = false; retry.textContent = "회차 저장 재시도"; }
    else retry.hidden = true;
    if (sessionCommitJob?.status === "COMMIT_CONFIRMED_READBACK_PENDING") { checkAgain.hidden = false; checkAgain.textContent = "저장 상태 다시 확인"; }
    else checkAgain.hidden = true;
    reset.hidden = !sessionCommitJob || !["READY", "STALE", "FAILED", "APPLIED", "NO_CHANGE"].includes(sessionCommitJob.status);
    sessionApplyPanel.append(controls, commit, retry, checkAgain, reset);
  };
  const refreshReviewedBatch = async () => {
    const saved = tradeSavedObservation;
    if (!saved?.observationId || !saved.receipt || !saved.expectedReview) return;
    const refreshRevision = ++reviewedBatchRefreshRevision;
    try {
      const response = await fetch(`/api/recognition/trade-review-observations/${saved.observationId}`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true || !body.observation) throw new Error("저장된 검수 자료를 읽지 못했습니다.");
      const observation = body.observation;
      if (observation.observationId !== saved.observationId || observation.completion?.recognitionBatchId !== saved.batchId) throw new Error("저장된 검수 자료의 식별 정보가 다릅니다.");
      const nextBatch = validateReviewedTradeBatch({ storedObservation: observation, evidenceReceipt: saved.receipt,
        expectedReview: saved.expectedReview, exclusions: [...reviewedExclusions.values()], mappingPolicyVersion: "reviewed-trade-dto-mapping-v1" });
      if (refreshRevision !== reviewedBatchRefreshRevision) return;
      reviewedBatch = nextBatch;
    } catch (error) {
      if (refreshRevision !== reviewedBatchRefreshRevision) return;
      reviewedBatch = { status: "NOT_READY", batchErrors: [{ code: "OBSERVATION_READ_FAILED", detail: error.message }], summary: { reviewedRowCount: 0, outputRowCount: 0, explicitlyExcludedRowCount: 0 }, heldRows: [], rows: [] };
    }
    renderSessionApplyPanel();
  };
  const updateSessionApplyStatus = (message) => {
    const target = sessionApplyPanel.querySelector("[data-role='session-apply-status']");
    if (target) target.textContent = message;
  };
  const restoreCommitAfterReadback = async (job) => {
    job.status = "COMMIT_CONFIRMED_READBACK_PENDING";
    renderSessionApplyPanel();
    try {
      await confirmWorkingSessionSnapshot({ expectedSession: job.stage.stagedSession, expectedSessionRevision: job.expectedSessionRevision });
      job.status = "APPLIED";
      window.__bdoScheduleRuntime?.setExternalSessionMutationPending(false);
      window.__bdoRenderAll?.();
      renderSessionApplyPanel();
      updateSessionApplyStatus("저장된 회차를 다시 읽어 확인하고 화면에 적용했습니다. 검수 evidence는 변경하지 않았습니다.");
    } catch (error) {
      if (error.readbackMismatch) {
        job.status = "FAILED";
        window.__bdoScheduleRuntime?.setExternalSessionMutationPending(false);
        updateSessionApplyStatus("서버 회차가 준비한 내용과 달라 로컬에 적용하지 않았습니다. 최신 회차를 다시 확인하세요.");
      } else {
        job.status = "COMMIT_CONFIRMED_READBACK_PENDING";
        updateSessionApplyStatus("회차 저장은 확인됐지만 다시 읽기가 끝나지 않았습니다. 저장 상태 다시 확인을 누르세요.");
      }
      renderSessionApplyPanel();
    }
  };
  const sendStagedCommit = async (retry = false) => {
    const job = sessionCommitJob;
    if (!job || sessionCommitInFlight || (retry ? job.status !== "COMMIT_RESPONSE_UNKNOWN" : job.status !== "READY")) return;
    if (!retry && window.__bdoScheduleRuntime?.pending) { updateSessionApplyStatus("먼저 대기 중인 완료 저장을 해결하세요."); return; }
    sessionCommitInFlight = true;
    job.status = "COMMIT_PENDING";
    window.__bdoScheduleRuntime?.setExternalSessionMutationPending(true);
    renderSessionApplyPanel();
    try {
      await sendWorkingSessionSnapshot(job.stage.request);
      await restoreCommitAfterReadback(job);
    } catch (error) {
      if (error.status === 409) {
        if (retry) await restoreCommitAfterReadback(job);
        else {
          job.status = "STALE";
          window.__bdoScheduleRuntime?.setExternalSessionMutationPending(false);
          updateSessionApplyStatus("다른 변경으로 저장 기준이 오래되어 적용하지 않았습니다. 최신 상태를 다시 읽고 새로 준비하세요.");
          renderSessionApplyPanel();
        }
      } else {
        job.status = "COMMIT_RESPONSE_UNKNOWN";
        updateSessionApplyStatus("저장 응답을 확인하지 못했습니다. 같은 요청 ID와 내용으로 재시도하세요.");
        renderSessionApplyPanel();
      }
    } finally { sessionCommitInFlight = false; renderSessionApplyPanel(); }
  };
  const createSessionStage = async (mode) => {
    if (sessionCommitInFlight || sessionCommitJob) return;
    if (window.__bdoScheduleRuntime?.pending) { updateSessionApplyStatus("먼저 대기 중인 완료 저장을 해결하세요."); return; }
    if (reviewedBatch?.status !== "READY" || reviewedBatch.summary.outputRowCount === 0) return;
    try {
      await whenPersistenceIdle();
      if (window.__bdoScheduleRuntime?.pending) throw new Error("먼저 대기 중인 완료 저장을 해결하세요.");
      await refreshPersistentState({ restoreSession: false });
      if (mode === "NEW" && state.workingSession && !window.confirm("현재 회차를 검수한 물교 목록으로 교체합니다. 계속할까요?")) return;
      const mutationId = crypto.randomUUID();
      const newSessionId = mode === "NEW" ? crypto.randomUUID() : null;
      const stage = buildReviewedTradeSessionStage({ mode, validatedBatch: reviewedBatch, currentWorkingSession: state.workingSession,
        localSession: state.session, settings: state.settings, baseRevision: state.revision, sessionRevision: state.sessionRevision,
        mutationId, newSessionId });
      if (stage.status === "NO_CHANGE") {
        sessionCommitJob = { status: "NO_CHANGE", stage, mode };
        updateSessionApplyStatus("현재 회차에 이미 같은 물교가 있어 추가할 행이 없습니다.");
      } else if (stage.status !== "READY") {
        sessionCommitJob = { status: "FAILED", stage, mode };
        updateSessionApplyStatus(`회차 적용을 준비하지 않았습니다: ${stage.reasons.join(", ")}`);
      } else sessionCommitJob = { status: "READY", stage, mode, expectedSessionRevision: stage.precondition.baseRevision + 1 };
      renderSessionApplyPanel();
    } catch (error) { updateSessionApplyStatus(error.message || "회차 적용을 준비하지 못했습니다."); }
  };
  sessionApplyPanel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "apply-reviewed-new") void createSessionStage("NEW");
    else if (action === "apply-reviewed-append") void createSessionStage("APPEND");
    else if (action === "commit-session-stage") void sendStagedCommit(false);
    else if (action === "retry-session-commit") void sendStagedCommit(true);
    else if (action === "retry-session-readback" && sessionCommitJob?.status === "COMMIT_CONFIRMED_READBACK_PENDING") void restoreCommitAfterReadback(sessionCommitJob);
    else if (action === "cancel-session-stage" && sessionCommitJob && !sessionCommitInFlight
      && !["COMMIT_PENDING", "COMMIT_RESPONSE_UNKNOWN", "COMMIT_CONFIRMED_READBACK_PENDING"].includes(sessionCommitJob.status)) {
      sessionCommitJob = null; renderSessionApplyPanel();
    }
  });
  const downloadPendingObservation = async () => {
    if (tradeObservationJob?.receipt?.observationId) {
      try {
        const response = await fetch(`/api/recognition/trade-review-observations/${tradeObservationJob.receipt.observationId}/export`, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("export failed");
        const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `trade-review-${tradeObservationJob.receipt.observationId}.json`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch { setTradeStorageStatus("서버 export를 내려받지 못했습니다. 저장된 검수 자료는 보존되어 있습니다.", { download: true }); }
      return;
    }
    if (!tradeObservationJob && tradeSavedObservation) {
      try {
        const response = await fetch(`/api/recognition/trade-review-observations/${tradeSavedObservation.observationId}/export`, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("export failed");
        const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `trade-review-${tradeSavedObservation.observationId}.json`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch { setTradeStorageStatus("저장된 검수 자료 export를 내려받지 못했습니다.", { download: true }); }
      return;
    }
    if (tradeObservationJob) {
      const blob = new Blob([tradeObservationJob.body], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `trade-review-${tradeObservationJob.payload.completion.recognitionBatchId}.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };
  downloadTradeObservation.addEventListener("click", downloadPendingObservation);
  const postTradeObservation = async () => {
    const job = tradeObservationJob;
    if (!job || tradeObservationInFlight || job.receipt) return;
    tradeObservationInFlight = true;
    setTradeStorageStatus("검수 자료를 저장하고 있습니다…");
    try {
      const response = await fetch("/api/recognition/trade-review-observations", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json; charset=utf-8" }, body: job.body });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true || !body.receipt) {
        const retryable = response.status >= 500 && body?.error?.retryable === true;
        const explain = body?.error?.message || `저장 요청이 거부되었습니다 (${response.status}).`;
        setTradeStorageStatus(`${explain} 검수 내용은 현재 화면에 보존되어 있습니다.`, { retry: retryable, download: true });
        return;
      }
      job.receipt = body.receipt;
      const completion = job.payload.completion;
      const expectedReview = { observationId: body.receipt.observationId, mutationId: job.payload.mutationId,
        recognitionBatchId: completion.recognitionBatchId, projectionHash: completion.projectionHash,
        registryVersion: completion.registryVersion, correctionVersion: completion.correctionVersion,
        reviewRevision: completion.reviewRevision, confirmationRevision: job.payload.confirmationRevision };
      tradeSavedObservation = cloneFrozen({ observationId: body.receipt.observationId, batchId: completion.recognitionBatchId,
        receipt: body.receipt, expectedReview });
      reviewedBatch = null;
      reviewedExclusions = new Map();
      renderSessionApplyPanel();
      void refreshReviewedBatch();
      setTradeStorageStatus("검수 내용이 로컬 evidence 저장소에 기록됐습니다. 회차 목록에는 적용되지 않았습니다.", { download: true });
      await postSelectedTradeCrops(job);
    } catch {
      setTradeStorageStatus("저장 응답을 확인하지 못했습니다. 같은 요청 ID와 내용으로 재시도하거나 자료를 내려받으세요.", { retry: true, download: true });
    } finally {
      tradeObservationInFlight = false;
      updateRecognitionControls();
    }
  };
  const postSelectedTradeCrops = async (job) => {
    try {
      if (!job.crops) job.crops = await job.createSelectedCrops();
      else if (job.crops.some((item) => item.entry.selected && item.entry.geometry && !item.blob && !item.receipt)) {
        const regenerated = await job.createSelectedCrops();
        const byKey = new Map(regenerated.map((item) => [`${item.entry.projectionRowId}\0${item.entry.field}`, item]));
        for (const item of job.crops) if (!item.blob && !item.receipt) item.blob = byKey.get(`${item.entry.projectionRowId}\0${item.entry.field}`)?.blob ?? null;
      }
      let failed = false;
      let nonRetryable = false;
      for (const item of job.crops) {
        if (!item.entry.selected || !item.entry.geometry || item.receipt) continue;
        if (!item.blob) { failed = true; continue; }
        if (!item.metadata) item.metadata = { version: 1, cropMutationId: crypto.randomUUID(), projectionRowId: item.entry.projectionRowId,
          field: item.entry.field, sha256: await sha256Blob(item.blob), width: item.entry.geometry.width, height: item.entry.geometry.height };
        const form = new FormData(); form.append("metadata", JSON.stringify(item.metadata)); form.append("image", item.blob, "review-crop.png");
        try {
          const response = await fetch(`/api/recognition/trade-review-observations/${job.receipt.observationId}/crops`, { method: "POST", credentials: "same-origin", cache: "no-store", body: form });
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.ok !== true) { failed = true; nonRetryable ||= [409, 413, 422].includes(response.status); item.error = body?.error?.message || `crop ${response.status}`; }
          else item.receipt = body.receipt;
        } catch { failed = true; }
      }
      if (failed) {
        setTradeStorageStatus(nonRetryable
          ? "검수 내용은 저장됐지만 일부 원본 영역이 거부되었습니다. 같은 검수 자료를 내려받아 오류를 확인하세요."
          : "검수 내용은 저장됐지만 일부 원본 영역은 아직 연결되지 않았습니다. 이미지 저장을 재시도할 수 있습니다.",
        { retry: !nonRetryable, download: true });
      } else {
        tradeObservationJob = null;
        setTradeStorageStatus("검수와 선택된 원본 영역 저장이 완료됐습니다. 회차 목록에는 적용되지 않았습니다.", { download: true });
      }
    } catch {
      setTradeStorageStatus("검수 내용은 저장됐지만 원본 영역을 만들지 못했습니다. 같은 선택 영역 저장을 재시도할 수 있습니다.", { retry: true, download: true });
    }
  };
  retryTradeObservation.addEventListener("click", () => {
    if (!tradeObservationJob) return;
    if (tradeObservationJob.receipt) void postSelectedTradeCrops(tradeObservationJob);
    else void postTradeObservation();
  });
  async function sha256Blob(blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

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

  const renderTradeRecognitionResult = () => {
    if (tradeRecognitionResult && tradeReviewForResult === tradeRecognitionResult) {
      tradeRecognitionResultRegion.hidden = false;
      if (tradeReviewController) return Promise.resolve({ status: "mounted" });
      if (tradeReviewMountPromise) return tradeReviewMountPromise;
    }
    if (tradeReviewController) {
      tradeReviewController.destroy();
      tradeReviewController = null;
    }
    tradeReviewForResult = null;
    const generation = ++tradeReviewGeneration;
    tradeRecognitionResultRegion.replaceChildren();
    tradeRecognitionResultRegion.hidden = !tradeRecognitionResult;
    if (!tradeRecognitionResult) {
      tradeRecognitionRegion.style.flex = "";
      return Promise.resolve({ status: "empty" });
    }
    tradeRecognitionRegion.style.flex = "1 0 min(55vh, 600px)";
    const result = tradeRecognitionResult;
    tradeReviewForResult = result;
    const mountPromise = mountTradeRecognitionReview({
      root: tradeRecognitionResultRegion,
      recognitionResult: result,
      captures: [...tradeQueue.items],
      reviewRevision: tradeRecognitionResultRevision,
      getCurrentRevision: () => tradeQueueRevision,
      onComplete: (completion, storage) => {
        if (tradeObservationJob) {
          setTradeStorageStatus("앞선 검수 자료의 저장/재시도가 끝난 뒤 새 검수를 완료할 수 있습니다.", { retry: true, download: true });
          return;
        }
        try {
          const body = JSON.stringify(storage.observation);
          const byteLength = new TextEncoder().encode(body).byteLength;
          tradeObservationJob = { payload: storage.observation, body, createSelectedCrops: storage.createSelectedCrops, receipt: null, crops: null };
          if (byteLength > 8 * 1024 * 1024) {
            setTradeStorageStatus("검수 JSON이 8 MiB 제한을 넘었습니다. 자동 분할하지 않았습니다. 자료를 내려받으세요.", { download: true });
            return;
          }
          void postTradeObservation();
        } catch {
          setTradeStorageStatus("검수 저장 자료를 준비하지 못했습니다. 화면에서 내용을 확인한 뒤 JSON을 내려받으세요.", { download: true });
        }
      },
      onClear: () => {
        tradeRecognitionResult = null;
        tradeRecognitionResultRevision = null;
        renderTradeRecognitionResult();
        tradeRecognitionStatus.textContent = "인식 결과를 지웠습니다. 대기 이미지와 화면 연결은 유지됩니다.";
      },
    }).then((controller) => {
      if (generation !== tradeReviewGeneration || result !== tradeRecognitionResult) {
        controller.destroy();
        return { status: "stale" };
      }
      const reviewRoot = tradeRecognitionResultRegion;
      const mountedContent = result.draftRows.length === 0
        ? reviewRoot.querySelector(".trade-review-empty")
        : reviewRoot.querySelector(".trade-review-table tbody tr[data-capture-id]");
      if (!reviewRoot.querySelector(".trade-review-summary") || !mountedContent) {
        controller.destroy();
        throw new Error("review DOM mount did not produce visible review content");
      }
      tradeReviewController = controller;
      reviewRoot.querySelector(".trade-review-summary")?.scrollIntoView({ block: "start", inline: "nearest" });
      return { status: "mounted" };
    }).catch((error) => {
      if (generation !== tradeReviewGeneration || result !== tradeRecognitionResult) return { status: "stale" };
      tradeReviewForResult = null;
      tradeRecognitionResultRegion.replaceChildren();
      tradeRecognitionResultRegion.hidden = false;
      const message = document.createElement("p");
      message.className = "trade-review-error";
      message.dataset.diagnosticCode = "REVIEW_MOUNT_FAILED";
      message.setAttribute("role", "alert");
      message.textContent = "인식 결과는 받았지만 검수 화면을 만들지 못했습니다. 인식 원본은 유지했습니다. 진단 코드: REVIEW_MOUNT_FAILED";
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "오류 정보 보기";
      const detailText = document.createElement("pre");
      detailText.textContent = `${error?.name || "Error"}: ${String(error?.message || error || "상세 오류가 없습니다.")}`;
      details.append(summary, detailText);
      const clear = document.createElement("button");
      clear.type = "button";
      clear.dataset.action = "clear-trade-recognition-result";
      clear.textContent = "인식 결과 지우기";
      clear.addEventListener("click", () => {
        tradeRecognitionResult = null;
        tradeRecognitionResultRevision = null;
        renderTradeRecognitionResult();
        tradeRecognitionStatus.textContent = "인식 결과를 지웠습니다. 대기 이미지와 화면 연결은 유지됩니다.";
      });
      tradeRecognitionResultRegion.append(message, details, clear);
      message.scrollIntoView({ block: "nearest", inline: "nearest" });
      tradeRecognitionStatus.textContent = "인식은 완료했지만 검수 화면 표시 중 오류가 발생했습니다. 진단 코드: REVIEW_MOUNT_FAILED";
      return { status: "error", diagnosticCode: "REVIEW_MOUNT_FAILED" };
    }).finally(() => {
      if (generation === tradeReviewGeneration) tradeReviewMountPromise = null;
    });
    tradeReviewMountPromise = mountPromise;
    return mountPromise;
  };
  const updateRecognitionControls = () => {
    tradeRecognitionButton.disabled = tradeRecognitionPending || Boolean(tradeObservationJob) || !tradeRuntimeAvailable || tradeQueue.length === 0;
    tradeRecognitionButton.textContent = tradeRecognitionPending ? "로컬 인식 중…" : "로컬 인식 실행";
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
    tradeRecognitionResult = null;
    tradeRecognitionResultRevision = null;
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
    tradeRecognitionResultRevision = null;
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
      tradeRecognitionResultRevision = requestRevision;
      tradeRecognitionStatus.textContent = "인식 결과를 받았습니다. 검수 화면을 준비하는 중…";
      const mountResult = await renderTradeRecognitionResult();
      if (requestRevision !== tradeQueueRevision || result !== tradeRecognitionResult) return;
      if (mountResult?.status === "mounted") {
        tradeRecognitionStatus.textContent = result.draftRows.length === 0
          ? "인식은 완료했지만 완전한 물교 행이 없습니다. 경계 후보와 원본을 확인해 주세요."
          : "인식 초안을 검수 화면에 표시했습니다. 목록에는 적용되지 않았습니다.";
      }
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
    resizeTradeDialog();
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

  window.addEventListener("beforeunload", (event) => {
    if (tradeObservationJob || tradeObservationInFlight) {
      event.preventDefault();
      event.returnValue = "저장되지 않은 검수 자료가 있습니다.";
    }
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
      tradeReviewController?.destroy();
      tradeReviewController = null;
      tradePreviews.clear();
      tradeQueue.clear();
    },
  };
}
