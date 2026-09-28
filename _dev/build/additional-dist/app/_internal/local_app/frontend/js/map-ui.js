import { saveSettings } from "./persistence.js";
import { state } from "./state.js";
import { createMapViewer, renderFreeRoute } from "./map-viewer.js";

export { renderFreeRoute };

const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
function jsonEditor(id, label, value, rows = 10) { const wrap = el("div", "field"); const title = el("label", "", label); title.htmlFor = id; const area = document.createElement("textarea"); area.id = id; area.className = "json-editor"; area.rows = rows; area.spellcheck = false; area.value = JSON.stringify(value, null, 2); wrap.append(title, area); return wrap; }
function parseJson(id, expectedType, label) { const value = JSON.parse(document.getElementById(id).value); const valid = expectedType === "array" ? Array.isArray(value) : value !== null && typeof value === "object" && !Array.isArray(value); if (!valid) throw new Error(`${label}은 JSON ${expectedType === "array" ? "배열" : "객체"}여야 합니다.`); return value; }
async function saveSection(settings, setStatus, label, after) { try { setStatus(`${label} 저장 중입니다.`, "saving"); await saveSettings(settings); after?.(); setStatus(`${label} 저장을 확인했습니다.`, "success"); } catch (error) { if (error.status === 409) after?.(); setStatus(error.committed ? error.message : `${label} 저장 실패: ${error.message}`, "error"); } }
function activeNavigationFromEditors() { return { coords: parseJson("nav-coords", "object", "좌표"), routeCalibrations: parseJson("nav-calibrations", "object", "항로 보정"), memos: parseJson("nav-memos", "array", "항로 메모") }; }
function snapshotFromEditors() { const navigation = activeNavigationFromEditors(); return { ...navigation, routes: parseJson("map-routes", "array", "저장 항로") }; }

export function renderMap(root, setStatus, refresh) {
  root.replaceChildren(); const navigation = state.settings.navigation;
  const nav = document.querySelector("#navigation-root"); nav.replaceChildren();
  nav.append(jsonEditor("nav-coords", "사용자 확정 좌표 객체", navigation.coords), jsonEditor("nav-calibrations", "항로 방향별 보정 객체", navigation.routeCalibrations), jsonEditor("nav-memos", "항로 메모 배열", navigation.memos));
  const saveNav = el("button", "primary", "현재 좌표·보정·메모 저장"); saveNav.type = "button"; saveNav.addEventListener("click", () => { try { saveSection({ navigation: activeNavigationFromEditors() }, setStatus, "현재 항법 설정", refresh); } catch (error) { setStatus(error.message, "error"); } });
  const navActions = el("div", "actions"); navActions.append(saveNav); nav.append(navActions);

  createMapViewer(root, setStatus);
  root.append(jsonEditor("map-routes", "지도 스냅샷에 포함할 경로 배열 (현재 편집 중에는 임시 상태)", state.mapRouteDraft ?? [], 7));
  for (let slot = 1; slot <= 3; slot += 1) {
    const key = String(slot); const snapshot = state.settings.mapSlots[key]; const card = el("div", "preset-card");
    card.append(el("strong", "", `지도 슬롯 ${slot}`), el("p", "muted", snapshot ? `${Object.keys(snapshot.coords).length}개 좌표 · ${snapshot.routes.length}개 경로 · ${snapshot.memos.length}개 메모` : "저장된 지도 없음"));
    const save = el("button", "", "현재값을 슬롯에 저장"); save.type = "button"; save.addEventListener("click", () => { try { const value = snapshotFromEditors(); const mapSlots = { ...state.settings.mapSlots, [key]: value }; saveSection({ mapSlots }, setStatus, `지도 슬롯 ${slot}`, refresh); } catch (error) { setStatus(error.message, "error"); } });
    const load = el("button", "", "슬롯 불러오기"); load.type = "button"; load.disabled = !snapshot; load.addEventListener("click", () => { if (!snapshot) return; const navigationValue = { coords: snapshot.coords, routeCalibrations: snapshot.routeCalibrations, memos: snapshot.memos }; saveSection({ navigation: navigationValue }, setStatus, `지도 슬롯 ${slot} 불러오기`, () => { state.mapRouteDraft = snapshot.routes; refresh(); }); });
    const actions = el("div", "actions"); actions.append(save, load); card.append(actions); root.append(card);
  }
  const base = state.settings.mapBase; const baseCard = el("div", "preset-card");
  baseCard.append(el("strong", "", "기본 지도"), el("p", "muted", base ? `${Object.keys(base.coords).length}개 좌표 · ${base.routes.length}개 경로 · ${base.memos.length}개 메모` : "저장된 기본 지도 없음"));
  const saveBase = el("button", "", "현재값을 기본 지도로 저장"); saveBase.type = "button"; saveBase.addEventListener("click", () => { try { saveSection({ mapBase: snapshotFromEditors() }, setStatus, "기본 지도", refresh); } catch (error) { setStatus(error.message, "error"); } });
  const loadBase = el("button", "", "기본 지도 불러오기"); loadBase.type = "button"; loadBase.disabled = !base; loadBase.addEventListener("click", () => { if (!base) return; const navigationValue = { coords: base.coords, routeCalibrations: base.routeCalibrations, memos: base.memos }; saveSection({ navigation: navigationValue }, setStatus, "기본 지도 불러오기", () => { state.mapRouteDraft = base.routes; refresh(); }); });
  const clearBase = el("button", "", "기본 지도 저장값 지우기"); clearBase.type = "button"; clearBase.addEventListener("click", () => saveSection({ mapBase: null }, setStatus, "기본 지도 저장값", refresh));
  const baseActions = el("div", "actions"); baseActions.append(saveBase, loadBase, clearBase); baseCard.append(baseActions); root.append(baseCard);
}

export function renderViewer(root, setStatus, refresh) {
  root.replaceChildren(); const viewer = state.settings.viewer;
  const zoomWrap = el("div", "inline-field"); const zoomLabel = el("label", "", "UI 배율 (%)"); const zoom = document.createElement("input"); zoom.type = "number"; zoom.min = "25"; zoom.max = "250"; zoom.step = "1"; zoom.id = "viewer-zoom"; zoom.value = viewer.uiZoom; zoomLabel.htmlFor = zoom.id; zoomWrap.append(zoomLabel, zoom);
  const panelsWrap = el("div", "viewer-list"); const title = el("p", "hint", "패널 설정은 기존 panel ID별 left/top/width/height 숫자를 보존합니다. 값은 저장되고 재실행 후 다시 표시됩니다."); panelsWrap.append(title);
  const panels = viewer.panels ?? {};
  for (const id of ["mainPanel", "slotPanel", "routeListPanel", "coordChangesPanel", "memoListPanel", "routeCalibrationPanel"]) {
    const row = el("div", "viewer-row"); row.dataset.panel = id; row.append(el("strong", "", id));
    for (const key of ["left", "top", "width", "height"]) { const input = document.createElement("input"); input.type = "number"; input.step = "any"; input.placeholder = key; input.setAttribute("aria-label", `${id} ${key}`); input.value = panels[id]?.[key] ?? ""; input.dataset.key = key; row.append(input); }
    panelsWrap.append(row);
  }
  const save = el("button", "primary", "배율·패널 배치 저장"); save.type = "button"; save.addEventListener("click", () => {
    const zoomValue = Number(zoom.value); if (!Number.isSafeInteger(zoomValue) || zoomValue < 25 || zoomValue > 250) { setStatus("배율은 25~250 사이의 정수여야 합니다.", "error"); return; }
    const nextPanels = structuredClone(panels);
    for (const row of panelsWrap.querySelectorAll(".viewer-row")) {
      const values = Object.fromEntries([...row.querySelectorAll("input")].filter((input) => input.value !== "").map((input) => [input.dataset.key, Number(input.value)]));
      if (Object.keys(values).length && Object.values(values).some((value) => !Number.isFinite(value))) { setStatus(`${row.dataset.panel} 위치·크기를 확인하세요.`, "error"); return; }
      if (Object.keys(values).length) nextPanels[row.dataset.panel] = { ...(nextPanels[row.dataset.panel] ?? {}), ...values };
    }
    saveSection({ viewer: { uiZoom: zoomValue, panels: nextPanels } }, setStatus, "화면 배율·패널 배치", refresh);
  });
  const actions = el("div", "actions"); actions.append(save);
  const openMap = el("button", "primary", "실제 지도 보기 / 좌표 조작"); openMap.type = "button"; openMap.addEventListener("click", () => window.__bdoOpenMapViewer?.("speed"));
  root.append(openMap, zoomWrap, panelsWrap, actions);
}

export function applyViewerState() {
  const zoom = state.settings.viewer?.uiZoom;
  if (Number.isFinite(zoom)) document.documentElement.style.setProperty("--app-zoom", String(zoom / 100));
}


