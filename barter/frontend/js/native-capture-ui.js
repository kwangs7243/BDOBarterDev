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
    const current = () => this.generation === generation && this.mode === mode && !adapter.getState().busy;
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
  hotkey_conflict: "F10을 다른 프로그램이 사용 중입니다. 해당 단축키를 해제하고 다시 시도하세요.",
  roi_missing: "게임에서 영역을 먼저 지정하세요.",
  roi_cancelled: "영역 지정을 취소했습니다.",
  roi_size_locked: "영역 크기는 고정되어 있습니다. 테두리를 끌어 위치만 이동하세요.",
  profile_changed: "게임 크기·배율이 바뀌었습니다. 영역을 다시 지정하세요.",
  target_unavailable: "게임 창을 사용할 수 없어 촬영을 중지했습니다.",
  session_changed: "작업 세션이 바뀌어 촬영을 중지하고 미수신 이미지를 폐기했습니다. 캡처를 다시 시작하세요.",
  queue_full: "대기열이 가득 찼습니다. 기존 이미지를 먼저 확인하세요.",
  black_frame: "게임 화면을 읽지 못했습니다. 게임 창 모드를 확인하세요.",
  pixel_capture_failed: "게임 화면 캡처에 실패했습니다. 진단 기록을 확인하세요.",
  native_runtime_failed: "네이티브 캡처가 중단됐습니다. 앱을 다시 실행하세요.",
};

export function initNativeCaptureUI(adapters) {
  const events = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: events.signal });
  const receiverId = crypto.randomUUID();
  const receiver = new NativeCaptureReceiver();
  const panels = new Map();
  let disposed = false;
  let polling = false;
  let serial = Promise.resolve();
  const report = (mode, text) => { if (!disposed && panels.has(mode)) panels.get(mode).status.textContent = text; };
  const command = async data => {
    const response = await fetch("/api/native-capture", { method: "POST", headers: { "Content-Type": "application/json" },
      signal: events.signal, body: JSON.stringify({ ...data, receiver: receiverId }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new CaptureError(result.error?.code, result.error?.message || "캡처 요청을 처리하지 못했습니다.");
    return result;
  };
  const status = async () => {
    const response = await fetch("/api/native-capture", { cache: "no-store", signal: events.signal });
    if (!response.ok) throw new CaptureError("native_unavailable", "캡처 연결을 확인하지 못했습니다.");
    return response.json();
  };
  const showSavedRegion = (mode, data) => {
    const refs = panels.get(mode), roi = data.savedProfiles?.[mode]?.roi;
    refs.save.disabled = !data.available || !roi;
    refs.saved.textContent = roi
      ? `저장된 영역 · 위치 ${roi.x}, ${roi.y} · 크기 ${roi.width}×${roi.height} 고정 · 재시작 후 캡처 시작 시 복원됩니다.`
      : "저장된 영역이 없습니다. 게임에서 영역을 먼저 지정하세요.";
  };
  const saveRegion = mode => {
    serial = serial.catch(() => {}).then(async () => {
      const data = await command({ action: "save-region", mode });
      if (disposed) return;
      showSavedRegion(mode, data);
      report(mode, `${mode === "trade" ? "물교" : "창고"} 영역을 저장했습니다. 앱을 다시 실행해도 이 영역을 사용합니다.`);
    }).catch(error => report(mode, error.message));
    return serial;
  };
  const attach = async data => {
    const mode = data.mode?.toLowerCase();
    if (disposed || !adapters[mode] || receiver.mode || !data.context) return;
    const result = await command({ action: "attach" });
    if (!disposed && result.mode?.toLowerCase() === mode) receiver.activate(mode, result.generation);
  };
  const refresh = async mode => {
    const refs = panels.get(mode);
    try {
      const data = await status();
      if (disposed) return null;
      showSavedRegion(mode, data);
      const selected = refs.target.value;
      refs.target.replaceChildren();
      for (const item of data.targets ?? []) {
        const option = document.createElement("option"); option.value = item.id; option.textContent = item.title;
        refs.target.append(option);
      }
      if ([...refs.target.options].some(option => option.value === selected)) refs.target.value = selected;
      refs.start.disabled = refs.select.disabled = !data.available || !refs.target.options.length;
      for (const node of refs.legacy) node.hidden = !!data.available;
      if (!receiver.mode) await attach(data);
      if (!receiver.mode) report(mode, !data.available ? "Windows 실행기로 앱을 시작하세요." : refs.target.options.length ? "캡처 시작을 누르면 게임 위에 영역이 표시됩니다." : "실행 중인 검은사막 창을 찾지 못했습니다.");
      return data;
    } catch (error) { report(mode, error.message); return null; }
  };
  const prepare = (mode, select = false) => {
    serial = serial.catch(() => {}).then(async () => {
      const data = await refresh(mode);
      if (disposed || !data?.available || adapters[mode].getState().busy) return;
      const queue = adapters[mode].getState();
      const payload = { action: "prepare", mode, count: queue.count, bytes: queue.bytes, target: panels.get(mode).target.value,
        context: nativeContext(adapters[mode].getContext()), select };
      let result;
      try { result = await command(payload); }
      catch (error) {
        if (!select && error.code === "roi_missing") result = await command({ ...payload, select: true });
        else throw error;
      }
      if (!disposed) receiver.activate(mode, result.generation);
      report(mode, result.state === "SELECTING" ? "게임에서 영역 드래그 → Enter 확정. 이후 F10으로 캡처하세요." : "게임에서 스크롤 → F10으로 캡처하세요.");
    }).catch(error => report(mode, error.message));
    return serial;
  };
  const stop = async mode => {
    if (receiver.mode !== mode) return;
    try { await command({ action: "stop", generation: receiver.generation }); }
    catch (error) { report(mode, error.message); }
  };
  const listeners = [];
  for (const [mode, adapter] of Object.entries(adapters)) {
    const panel = document.createElement("section"); panel.className = "trade-roi-panel";
    panel.dataset.nativeCapture = mode;
    const label = mode === "trade" ? "물교" : "창고";
    panel.innerHTML = `<h3>게임 영역 캡처</h3><div class="trade-roi-actions"><button type="button" data-native="prepare" disabled>${label} 캡처 시작</button><button type="button" data-native="stop">캡처 중지</button><button type="button" data-native="save" disabled>영역 저장</button></div><p data-native="saved"></p><details><summary>게임 창·영역 설정</summary><div class="trade-roi-actions"><select aria-label="검은사막 창"></select><button type="button" data-native="refresh">창 목록 확인</button><button type="button" data-native="select" disabled>영역·크기 다시 지정</button></div></details><p>게임에서 목록을 스크롤하고 <kbd>F10</kbd>으로 캡처하세요. 준비된 이미지는 아래에서 인식합니다.</p><details><summary>캡처 영역 조작 안내</summary><p>영역 크기는 고정됩니다. 테두리와 모서리를 끌어 위치만 이동하세요. 크기는 게임 창·영역 설정에서 다시 지정할 수 있습니다. 영역 안쪽에서는 게임을 조작할 수 있습니다. 이 창을 닫아도 캡처를 계속할 수 있습니다.</p></details><p role="status" aria-live="polite"></p>`;
    adapter.dialog.querySelector(".trade-roi-panel").before(panel);
    const legacy = [...adapter.dialog.querySelectorAll('.trade-preview-stage, .trade-roi-panel:not([data-native-capture])')];
    panels.set(mode, { root: panel, target: panel.querySelector("select"), start: panel.querySelector('[data-native="prepare"]'),
      select: panel.querySelector('[data-native="select"]'), status: panel.querySelector('[role="status"]'),
      save: panel.querySelector('[data-native="save"]'), saved: panel.querySelector('[data-native="saved"]'),
      legacy, legacyHidden: legacy.map(node => node.hidden) });
    listen(panel.querySelector('[data-native="prepare"]'), "click", () => prepare(mode));
    listen(panel.querySelector('[data-native="select"]'), "click", () => prepare(mode, true));
    listen(panel.querySelector('[data-native="refresh"]'), "click", () => void refresh(mode));
    listen(panel.querySelector('[data-native="stop"]'), "click", () => void stop(mode));
    listen(panel.querySelector('[data-native="save"]'), "click", () => saveRegion(mode));
    const observer = new MutationObserver(() => { if (adapter.dialog.open) void refresh(mode); });
    observer.observe(adapter.dialog, { attributes: true, attributeFilter: ["open"] });
    listeners.push(() => observer.disconnect());
  }
  const poll = async () => {
    if (disposed || polling || !receiver.mode) return;
    polling = true;
    const mode = receiver.mode, generation = receiver.generation, adapter = adapters[mode];
    const current = () => !disposed && receiver.mode === mode && receiver.generation === generation;
    try {
      const state = adapter.getState();
      const result = await command({ action: "heartbeat", generation, count: state.count, bytes: state.bytes,
        busy: state.busy, context: nativeContext(adapter.getContext()) });
      if (!current()) return;
      showSavedRegion(mode, result);
      if (!result.owned) { receiver.deactivate(); report(mode, errorText[result.error] || "다른 수신기로 연결됐습니다."); return; }
      report(mode, result.error ? (errorText[result.error] || "캡처 상태를 확인하세요.") : result.state === "SELECTING" ? "게임에서 영역 드래그 → Enter 확정" : `F10 캡처 ${result.captured ?? 0}장 · 수신 대기 ${result.pending ?? 0}장`);
      for (const packet of result.frames ?? []) {
        if (!current() || adapter.getState().busy) break;
        const accepted = await receiver.receive(packet, async () => {
          const query = new URLSearchParams({ receiver: receiverId, generation: String(generation) });
          const response = await fetch(`/api/native-capture/${encodeURIComponent(packet.metadata.captureId)}.png?${query}`, { cache: "no-store", signal: events.signal });
          if (!response.ok) throw new CaptureError("stale_capture", "캡처를 수신하지 못했습니다.");
          return response.blob();
        }, adapter);
        if (accepted && current()) await command({ action: "ack", generation, captureId: packet.metadata.captureId });
      }
      if (current() && result.state === "STOPPED" && !result.busy && !(result.frames?.length)) {
        await command({ action: "disarm", generation, reason: "finished" });
        if (current()) receiver.deactivate();
        report(mode, "촬영을 중지했습니다. 누적 이미지를 확인하세요.");
      }
    } catch (error) { if (current()) report(mode, error.message); }
    finally { polling = false; }
  };
  const timer = setInterval(() => void poll(), 500);
  const finish = mode => {
    serial = serial.catch(() => {}).then(async () => {
      if (receiver.mode !== mode) return;
      const generation = receiver.generation;
      await command({ action: "stop", generation });
      const deadline = Date.now() + 10000;
      while (receiver.mode === mode && receiver.generation === generation) {
        if (disposed || Date.now() >= deadline) {
          throw new CaptureError("capture_stop_timeout", "남은 캡처를 받지 못했습니다. 이미지는 유지했습니다. 다시 시도하세요.");
        }
        await poll();
        if (receiver.mode === mode) await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
    return serial;
  };
  void status().then(attach).catch(() => {});
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    events.abort();
    clearInterval(timer);
    receiver.deactivate();
    for (const remove of listeners) remove();
    listeners.length = 0;
    for (const refs of panels.values()) {
      refs.legacy.forEach((node, index) => { node.hidden = refs.legacyHidden[index]; });
      refs.root.remove();
    }
    panels.clear();
  };
  listen(window, "pagehide", (event) => { if (!event.persisted) cleanup(); });
  return { cleanup, finish };
}
