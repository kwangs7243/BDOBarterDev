import { CaptureError, captureFromNative } from "./capture.js";

export const nativeContext = (context) => ({
  baseRevision: context.baseRevision, sessionId: context.sessionId, sessionRevision: context.sessionRevision,
});

export class NativeCaptureReceiver {
  generation = null;
  mode = null;
  seen = new Set();
  activate(mode, generation) { this.mode = mode; this.generation = generation; this.seen.clear(); }
  deactivate() { this.activate(null, null); }
  async receive(packet, getBlob, adapter, decodeAdapters) {
    const generation = this.generation;
    const mode = this.mode;
    const current = () => this.generation === generation && this.mode === mode && adapter.isActive() && !adapter.getState().busy;
    if (!mode || packet.generation !== generation || packet.metadata?.taskType !== mode || !current()) return false;
    const id = packet.metadata.captureId;
    if (this.seen.has(id)) return true;
    if (this.seen.size >= 10000) throw new CaptureError("receiver_limit", "입력 수가 많습니다. F10 준비를 다시 시작하세요.");
    const capture = await captureFromNative(await getBlob(), packet, adapter.getContext(), decodeAdapters);
    if (!current()) return false;
    const context = nativeContext(adapter.getContext());
    if (JSON.stringify(context) !== JSON.stringify(capture.metadata.context)) return false;
    if (this.seen.has(id)) return true;
    adapter.accept([capture]);
    this.seen.add(id);
    return true;
  }
}

const errorText = {
  foreground_required: "게임 창을 앞에 둔 뒤 영역 지정을 다시 시작하세요.",
  roi_missing: "게임 화면에서 영역을 먼저 지정하세요.",
  roi_cancelled: "영역 지정을 취소했습니다. 이전 저장 영역은 유지됩니다.",
  roi_save_failed: "영역을 저장하지 못했습니다. 게임 창과 저장 경로를 확인하세요.",
  hotkey_conflict: "F10이 다른 프로그램과 충돌합니다. 게임에서 Enter로 캡처하세요.",
  receiver_expired: "브라우저 연결이 만료되었습니다. 다시 준비하세요.",
  session_changed: "현재 세션이 바뀌었습니다. 다시 준비하세요.",
  profile_changed: "창 크기·DPI·모니터 환경이 바뀌었습니다. 영역을 다시 지정하세요.",
  target_unavailable: "게임 창을 찾지 못했습니다. 게임을 열고 다시 준비하세요.",
  target_changed: "캡처 중 게임 창이 바뀌었습니다. 다시 시도하세요.",
  queue_full: "이미지 대기열이 가득 찼습니다. 기존 이미지는 유지됩니다.",
  black_frame: "검은 화면이 캡처되었습니다. 창 모드와 게임 화면을 확인하세요.",
  pixel_capture_failed: "게임 화면을 캡처하지 못했습니다. 다시 준비하세요.",
  capture_exclusion_failed: "조작창을 캡처에서 제외하지 못했습니다. 앱 진단 기록을 확인하세요.",
  native_runtime_failed: "네이티브 캡처가 중단되었습니다. 앱을 다시 실행하세요.",
};

export function initNativeCaptureUI(adapters) {
  const receiverId = crypto.randomUUID();
  const receiver = new NativeCaptureReceiver();
  const panels = new Map();
  let epoch = 0;
  let pendingMode = null;
  let serial = Promise.resolve();
  let polling = false;
  let disposed = false;
  const command = async (data, keepalive = false) => {
    const response = await fetch("/api/native-capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, receiver: receiverId }), keepalive,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new CaptureError(result.error?.code, result.error?.message || "네이티브 캡처 요청을 처리하지 못했습니다.");
    return result;
  };
  const report = (mode, text) => { if (panels.has(mode)) panels.get(mode).status.textContent = text; };
  const stop = (reason = "user_stop") => {
    epoch += 1;
    pendingMode = null;
    const generation = receiver.generation;
    const mode = receiver.mode;
    receiver.deactivate();
    if (generation != null) serial = serial.catch(() => {}).then(() => command({ action: "disarm", generation, reason })).catch(() => {});
    if (mode) report(mode, "F10 입력 준비를 종료했습니다.");
  };
  const refresh = async (mode) => {
    const panel = panels.get(mode);
    try {
      const response = await fetch("/api/native-capture", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      const selected = panel.target.value;
      panel.target.replaceChildren();
      for (const item of data.targets ?? []) {
        const option = document.createElement("option"); option.value = item.id; option.textContent = item.title;
        panel.target.append(option);
      }
      if ([...panel.target.options].some(option => option.value === selected)) panel.target.value = selected;
      const available = data.available && panel.target.options.length > 0;
      panel.select.disabled = panel.prepare.disabled = !available;
      if (!receiver.mode) report(mode, !data.available ? "Windows 실행기에서 네이티브 캡처를 사용할 수 있습니다." : available ? "게임 창을 선택하고 영역을 지정하거나 저장 영역으로 F10을 준비하세요." : "실행 중인 검은사막 창을 찾지 못했습니다. 게임 실행 후 창 목록을 새로 확인하세요.");
      return data;
    } catch { report(mode, "네이티브 캡처 연결을 확인하지 못했습니다."); return null; }
  };
  const prepare = (mode, select, gameSession = false) => {
    stop("prepare");
    const ticket = epoch;
    pendingMode = mode;
    const adapter = adapters[mode];
    const target = panels.get(mode).target.value;
    serial = serial.catch(() => {}).then(async () => {
      if (disposed || epoch !== ticket || !adapter.isActive() || adapter.getState().busy) return;
      report(mode, select ? "게임 창을 앞에 두세요 → 영역 드래그 → Enter 확정 / Esc 취소" : "저장 영역으로 F10을 준비합니다…");
      const result = await command({ action: "prepare", mode, target, context: nativeContext(adapter.getContext()), select, gameSession });
      if (disposed || epoch !== ticket || !adapter.isActive()) {
        await command({ action: "disarm", generation: result.generation }); return;
      }
      receiver.activate(mode, result.generation);
      pendingMode = null;
    }).catch(error => { if (ticket === epoch) { pendingMode = null; report(mode, error.message); } });
    return serial;
  };
  const subscriptions = [];
  for (const [mode, adapter] of Object.entries(adapters)) {
    const panel = document.createElement("section"); panel.className = "trade-roi-panel";
    panel.dataset.nativeCapture = mode;
    panel.innerHTML = `<h3>게임 위 캡처 조작창</h3><details><summary>영역 재설정·연결 확인</summary><div class="trade-roi-actions"><select aria-label="검은사막 창"></select><button type="button" data-native="refresh">창 목록 확인</button><button type="button" data-native="select" disabled>게임에서 영역 지정</button><button type="button" data-native="prepare" disabled>저장 영역으로 F10 준비</button><button type="button" data-native="stop">F10 준비 종료</button></div></details><p>화면 공유 → 게임에서 영역 드래그 → Enter로 첫 캡처. 선택한 테두리는 게임 위에 유지됩니다. 테두리를 드래그하면 이동하고 모서리를 드래그하면 크기가 바뀝니다. 영역 안쪽의 클릭·스크롤은 게임으로 전달됩니다. 이후 게임에서 Enter 또는 F10으로 계속 캡처하세요. 게임 위의 작은 조작창 버튼도 사용할 수 있습니다. F8은 영역 변경, Esc는 캡처 종료입니다. 누적 이미지는 마지막에 여기에서 인식·검토·적용하세요.</p><p role="status" aria-live="polite">아래 화면 연결을 눌러 게임 창을 공유하세요.</p>`;
    adapter.dialog.querySelector(".trade-roi-panel").before(panel);
    const refs = { target: panel.querySelector("select"), status: panel.querySelector('[role="status"]'), select: panel.querySelector('[data-native="select"]'), prepare: panel.querySelector('[data-native="prepare"]') };
    panels.set(mode, refs);
    panel.querySelector('[data-native="refresh"]').addEventListener("click", () => void refresh(mode));
    refs.select.addEventListener("click", () => prepare(mode, true));
    refs.prepare.addEventListener("click", () => prepare(mode, false));
    panel.querySelector('[data-native="stop"]').addEventListener("click", () => { if (receiver.mode === mode || pendingMode === mode) stop(); });
    adapter.dialog.addEventListener("close", () => { if (receiver.mode === mode || pendingMode === mode) stop("dialog_closed"); });
    let sharing = false;
    const legacy = adapter.dialog.querySelector('.trade-preview-stage');
    const legacyActions = [...adapter.dialog.querySelectorAll('[data-action="capture-trade-roi"], [data-action="reset-trade-roi"], [data-action="capture-roi"], [data-action="reset-roi"]')];
    const legacyHints = [...adapter.dialog.querySelectorAll('.trade-roi-panel:not([data-native-capture]) > p')];
    const showBrowserRegion = (show) => { if (legacy) legacy.hidden = !show; for (const node of [...legacyActions, ...legacyHints]) node.hidden = !show; };
    if (adapter.screenSession) subscriptions.push(adapter.screenSession.subscribe(({state}) => {
      if (state === "CONNECTED" && !sharing) {
        sharing = true;
        void refresh(mode).then(data => {
          if (disposed || !sharing || !adapter.isActive() || !data?.available) return;
          if (data.targets?.length !== 1) { report(mode, "검은사막 창이 여러 개이거나 없습니다. 연결 확인에서 대상 창을 선택하세요."); return; }
          refs.target.value = data.targets[0].id;
          showBrowserRegion(false);
          return prepare(mode, true, true);
        });
      } else if (["DISCONNECTED", "IDLE"].includes(state)) {
        sharing = false;
        if (receiver.mode === mode || pendingMode === mode) stop("stream_disconnected");
        showBrowserRegion(true);
      }
    }));
  }
  const poll = async () => {
    if (disposed || polling || !receiver.mode) return;
    polling = true;
    const ticket = epoch;
    const mode = receiver.mode;
    const generation = receiver.generation;
    const adapter = adapters[mode];
    try {
      if (!adapter.isActive()) { stop("adapter_closed"); return; }
      const state = adapter.getState();
      const result = await command({ action: "heartbeat", generation, count: state.count, bytes: state.bytes, busy: state.busy, context: nativeContext(adapter.getContext()) });
      if (ticket !== epoch) return;
      if (!result.owned) { stop("ownership_lost"); report(mode, errorText[result.error] || "입력 준비가 만료되었습니다. 다시 준비하세요."); return; }
      report(mode, result.error ? (errorText[result.error] || "캡처를 확인하지 못했습니다. 다시 준비하세요.") : result.state === "SELECTING" ? "게임 창을 앞에 두세요 → 영역 드래그 → Enter 확정 / Esc 취소" : state.busy ? "인식·검토 처리 중에는 F10 입력이 잠시 중지됩니다." : (result.hotkeyRegistered || result.enterRegistered) ? `게임에서 Enter / F10 또는 조작창 버튼 · ${result.captured ?? 0}장 촬영` : "F10 준비 중…");
      for (const packet of result.frames ?? []) {
        if (ticket !== epoch || adapter.getState().busy) break;
        const accepted = await receiver.receive(packet, async () => {
          const query = new URLSearchParams({ receiver: receiverId, generation: String(generation) });
          const response = await fetch(`/api/native-capture/${encodeURIComponent(packet.metadata.captureId)}.png?${query}`, { cache: "no-store" });
          if (!response.ok) throw new CaptureError("stale_capture", "이미 만료된 캡처입니다.");
          return response.blob();
        }, adapter);
        if (accepted && ticket === epoch) await command({ action: "ack", generation, captureId: packet.metadata.captureId });
      }
      if (result.state === "STOPPED" && !result.busy) {
        if (!(result.frames?.length)) { stop("finished"); report(mode, "게임 캡처를 종료했습니다. 누적 이미지를 확인하세요."); }
      }
    } catch (error) {
      if (ticket === epoch) { stop("receiver_error"); report(mode, error.message); }
    } finally { polling = false; }
  };
  const timer = setInterval(() => void poll(), 500);
  const unload = () => {
    disposed = true; clearInterval(timer); epoch += 1;
    if (receiver.generation != null) void command({ action: "disarm", generation: receiver.generation, reason: "unload" }, true).catch(() => {});
    receiver.deactivate();
  };
  window.addEventListener("beforeunload", unload);
  return { cleanup() { stop(); for (const unsubscribe of subscriptions) unsubscribe(); disposed = true; clearInterval(timer); window.removeEventListener("beforeunload", unload); } };
}
