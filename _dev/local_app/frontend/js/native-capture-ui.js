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
  profile_changed: "게임 크기·배율이 바뀌었습니다. 영역을 다시 지정하세요.",
  target_unavailable: "게임 창을 사용할 수 없어 촬영을 중지했습니다.",
  session_changed: "작업 세션이 바뀌어 촬영을 중지하고 미수신 이미지를 폐기했습니다. 캡처를 다시 시작하세요.",
  queue_full: "대기열이 가득 찼습니다. 기존 이미지를 먼저 확인하세요.",
  black_frame: "게임 화면을 읽지 못했습니다. 게임 창 모드를 확인하세요.",
  pixel_capture_failed: "게임 화면 캡처에 실패했습니다. 진단 기록을 확인하세요.",
  native_runtime_failed: "네이티브 캡처가 중단됐습니다. 앱을 다시 실행하세요.",
};

export function initNativeCaptureUI(adapters) {
  const receiverId = crypto.randomUUID();
  const receiver = new NativeCaptureReceiver();
  const panels = new Map();
  let disposed = false;
  let polling = false;
  let serial = Promise.resolve();
  const report = (mode, text) => { if (panels.has(mode)) panels.get(mode).status.textContent = text; };
  const command = async data => {
    const response = await fetch("/api/native-capture", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, receiver: receiverId }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new CaptureError(result.error?.code, result.error?.message || "캡처 요청을 처리하지 못했습니다.");
    return result;
  };
  const status = async () => {
    const response = await fetch("/api/native-capture", { cache: "no-store" });
    if (!response.ok) throw new CaptureError("native_unavailable", "캡처 연결을 확인하지 못했습니다.");
    return response.json();
  };
  const attach = async data => {
    const mode = data.mode?.toLowerCase();
    if (!adapters[mode] || receiver.mode || !data.context) return;
    const result = await command({ action: "attach" });
    if (!disposed && result.mode?.toLowerCase() === mode) receiver.activate(mode, result.generation);
  };
  const refresh = async mode => {
    const refs = panels.get(mode);
    try {
      const data = await status();
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
    panel.innerHTML = `<h3>게임 영역 캡처</h3><div class="trade-roi-actions"><button type="button" data-native="prepare" disabled>${label} 캡처 시작</button><button type="button" data-native="stop">캡처 중지</button></div><details><summary>게임 창·영역 설정</summary><div class="trade-roi-actions"><select aria-label="검은사막 창"></select><button type="button" data-native="refresh">창 목록 확인</button><button type="button" data-native="select" disabled>영역 새로 지정</button></div></details><p>게임 목록을 스크롤하고 F10으로 캡처하세요. 테두리 드래그는 이동, 모서리 드래그는 크기 조절입니다. 영역 안쪽은 게임 조작을 그대로 받습니다. 화면 공유나 열린 대화상자는 필요 없습니다. 누적 이미지의 인식·검토·적용은 여기서 실행하세요.</p><p role="status" aria-live="polite"></p>`;
    adapter.dialog.querySelector(".trade-roi-panel").before(panel);
    panels.set(mode, { target: panel.querySelector("select"), start: panel.querySelector('[data-native="prepare"]'),
      select: panel.querySelector('[data-native="select"]'), status: panel.querySelector('[role="status"]'),
      legacy: [...adapter.dialog.querySelectorAll('.trade-preview-stage, .trade-roi-panel:not([data-native-capture])')] });
    panel.querySelector('[data-native="prepare"]').addEventListener("click", () => prepare(mode));
    panel.querySelector('[data-native="select"]').addEventListener("click", () => prepare(mode, true));
    panel.querySelector('[data-native="refresh"]').addEventListener("click", () => void refresh(mode));
    panel.querySelector('[data-native="stop"]').addEventListener("click", () => void stop(mode));
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
      if (!result.owned) { receiver.deactivate(); report(mode, errorText[result.error] || "다른 수신기로 연결됐습니다."); return; }
      report(mode, result.error ? (errorText[result.error] || "캡처 상태를 확인하세요.") : result.state === "SELECTING" ? "게임에서 영역 드래그 → Enter 확정" : `F10 캡처 ${result.captured ?? 0}장 · 수신 대기 ${result.pending ?? 0}장`);
      for (const packet of result.frames ?? []) {
        if (!current() || adapter.getState().busy) break;
        const accepted = await receiver.receive(packet, async () => {
          const query = new URLSearchParams({ receiver: receiverId, generation: String(generation) });
          const response = await fetch(`/api/native-capture/${encodeURIComponent(packet.metadata.captureId)}.png?${query}`, { cache: "no-store" });
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
  void status().then(attach).catch(() => {});
  const cleanup = () => { disposed = true; clearInterval(timer); receiver.deactivate(); for (const remove of listeners) remove(); };
  window.addEventListener("beforeunload", cleanup, { once: true });
  return { cleanup };
}
