import { saveSettings } from "./persistence.js";
import { state } from "./state.js";

const SIZE = 10000;
const OFFSET = SIZE / 2;
const originalCoords = structuredClone(window.islandCoordinates || {});
const mapViewers = new WeakMap();
const freeRouteViews = new WeakMap();
const activeFreeRouteViews = new Set();
let freeRouteCleanupObserver;
const styleHref = "/assets/css/map-viewer.css";
if (!document.querySelector(`link[data-map-viewer]`)) {
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = styleHref; link.dataset.mapViewer = ""; document.head.append(link);
}
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const btn = (text, fn, cls = "", disabled = false) => { const b = el("button", `mv-btn ${cls}`, text); b.type = "button"; b.disabled = disabled; b.addEventListener("click", fn); return b; };
const svgEl = (tag, attrs = {}) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
const clone = value => JSON.parse(JSON.stringify(value));
const coordsNow = () => window.islandCoordinates || {};
const navNow = () => state.settings.navigation || { coords: {}, routeCalibrations: {}, memos: [] };
const persistNavigation = async (setStatus, patch = {}) => {
  const current = navNow(); const navigation = { coords: clone(coordsNow()), routeCalibrations: clone(window.routeCalibrations || current.routeCalibrations || {}), memos: clone(current.memos || []), ...patch };
  setStatus("지도 설정 저장 중입니다.", "saving");
  try { await saveSettings({ navigation }); setStatus("지도 설정 저장을 확인했습니다.", "success"); }
  catch (e) { setStatus(e.committed ? e.message : `지도 설정 저장 실패: ${e.message}`, "error"); throw e; }
};
const locate = name => {
  const all = coordsNow();
  if (all[name]) return { name, ...all[name] };
  const clean = String(name || "").replace(/ 섬$/, "").replace(/ 제도$/, "").trim();
  if (!clean) return null;
  const match = Object.keys(all).find(k => k === clean || k === `${clean} 섬` || k === `${clean} 제도` || k.includes(clean) || clean.includes(k));
  return match ? { name: match, ...all[match] } : null;
};
const rawLegDistance = (a,b) => {
  const aa = locate(a), bb = locate(b);
  return aa && bb ? Math.hypot(bb.x-aa.x, bb.y-aa.y) : 0;
};
const legDistance = (a,b) => typeof window.legDistance === "function" ? window.legDistance(a,b) : rawLegDistance(a,b);
const routeTimeSeconds = (route,a,b) => {
  const seconds=Number.isFinite(route.customSeconds)?route.customSeconds:Math.round(legDistance(a,b)/speedNow()*60);
  const overloaded=route.isOverloaded||route.over;
  return Math.round(seconds*(overloaded?(window.APP_CONFIG?.OVERLOAD_PENALTY||1.6):1));
};
const speedNow = () => Number(state.session.config?.ship?.speed || state.settings.ship?.speed || window.APP_CONFIG?.SHIP_SPEED || 170);
const duration = seconds => `${Math.floor(seconds/60)}분 ${String(Math.max(0, Math.round(seconds%60))).padStart(2,"0")}초`;

export function createMapViewer(root, setStatus) {
  const existing = mapViewers.get(root);
  if (existing) {
    existing.setStatus(setStatus);
    if (!root.querySelector(".mv-open-button")) root.append(existing.trigger);
    existing.refresh();
    return existing;
  }
  const app = { root, setStatus, open: false, mode: "speed", nodes: [], routes: [], undo: [], pan: {x:0,y:0}, zoom: .15, dragging: null, modeTool: "", step: 0, first: null, second: null, selected: "", showLabels: true, activeSlot: null, selectedScheduleSlot: "working", circles: false };
  const mapMutationAllowed = () => {
    if (!window.__bdoScheduleRuntime?.pending) return true;
    setStatus("완료 저장을 먼저 확인하거나 재시도하세요. 지도 변경은 대기합니다.", "error");
    return false;
  };
  const trigger = btn("🗺 지도 / 자유항로", () => openMapViewer("speed"), "mv-open-button");
  app.trigger = trigger;
  root.append(trigger);
  window.__bdoOpenMapViewer = mode => openMapViewer(mode);
  window.__bdoRenderMapViewer = () => { if (app.open) refresh(); };
  const nodesList = () => Object.entries(coordsNow()).map(([name,c]) => ({name,x:Number(c.x)||0,y:Number(c.y)||0,isOcean:!!c.isOcean}));
  function activeSnapshot() { return { coords: clone(coordsNow()), routes: clone(app.routes), routeCalibrations: clone(window.routeCalibrations || navNow().routeCalibrations || {}), memos: clone(navNow().memos || []) }; }
  function allRoutes() { return (app.routes || []).map(r=>({...r,start:r.start||r.startNode?.name,end:r.end||r.endNode?.name})).filter(r=>r.start&&r.end); }
  function redraw() {
    if (!app.svg) return;
    app.world.style.transform = `translate(${app.pan.x}px,${app.pan.y}px) scale(${app.zoom})`;
    app.world.replaceChildren();
    const grid = svgEl("g", {class:"mv-grid"});
    for (let i=0;i<=OFFSET;i+=500) { const st=i===0?"rgba(248,113,113,.42)":"rgba(203,213,225,.12)"; const sw=i===0?2:1;
      grid.append(svgEl("line",{x1:0,y1:OFFSET+i,x2:SIZE,y2:OFFSET+i,stroke:st,"stroke-width":sw}),svgEl("line",{x1:0,y1:OFFSET-i,x2:SIZE,y2:OFFSET-i,stroke:st,"stroke-width":sw}),svgEl("line",{x1:OFFSET+i,y1:0,x2:OFFSET+i,y2:SIZE,stroke:st,"stroke-width":sw}),svgEl("line",{x1:OFFSET-i,y1:0,x2:OFFSET-i,y2:SIZE,stroke:st,"stroke-width":sw})); }
    app.world.append(grid);
    for (const route of allRoutes()) { const a=locate(route.start),b=locate(route.end); if(!a||!b)continue;
      app.world.append(svgEl("path",{d:`M ${OFFSET+a.x} ${OFFSET-a.y} Q ${OFFSET+(a.x+b.x)/2} ${OFFSET-(a.y+b.y)/2} ${OFFSET+b.x} ${OFFSET-b.y}`,class:"mv-route",stroke:route.isOverloaded?"#ef4444":"#38bdf8"}));
      const seconds=Math.max(0,routeTimeSeconds(route,a.name,b.name)); const label=svgEl("text",{x:OFFSET+(a.x+b.x)/2,y:OFFSET-(a.y+b.y)/2,class:"mv-route-label"}); label.textContent=duration(seconds); app.world.append(label);
    }
    if (app.first && app.second && app.modeTool === "measure") app.world.append(svgEl("line",{x1:OFFSET+app.first.x,y1:OFFSET-app.first.y,x2:OFFSET+app.second.x,y2:OFFSET-app.second.y,class:"mv-measure"}));
    for (const node of app.nodes) {
      const g=svgEl("g",{class:`mv-node${node.name===app.selected?" selected":""}`,transform:`translate(${OFFSET+node.x},${OFFSET-node.y})`,tabindex:0});
      const c=svgEl("circle",{r:node.name.includes("일리야")?18:node.isOcean?9:12,fill:node.name.includes("일리야")?"#ef4444":node.isOcean?"#3b82f6":"#22c55e"}); g.append(c);
      if(app.showLabels){const t=svgEl("text",{x:13,y:-10,class:"mv-node-label"}); t.textContent=node.name; g.append(t); const xy=svgEl("text",{x:13,y:5,class:"mv-node-coord"}); xy.textContent=`${node.x}, ${node.y}`; g.append(xy);}
      g.addEventListener("click",ev=>{ev.stopPropagation(); if(app.modeTool==="arc"){ if(app.step===1){app.first=node;app.step=2;} else if(app.step===2&&app.first!==node){app.second=node;app.radius=Math.hypot(node.x-app.first.x,node.y-app.first.y);app.step=3;} refreshMode(); return; } if(app.modeTool==="measure"){ if(app.step===1){app.first=node;app.step=2;} else if(app.first!==node){toggleRoute(app.first,node);app.first=null;app.step=1;} refreshMode(); return; } app.selected=node.name; renderPanels(); redraw(); });
      g.addEventListener("pointerdown",ev=>{ if(app.modeTool!=="drag"&&!(app.modeTool==="arc"&&app.step===3&&node===app.second))return; if(!mapMutationAllowed())return; ev.preventDefault();ev.stopPropagation();g.setPointerCapture?.(ev.pointerId);app.dragging={node,startX:node.x,startY:node.y}; });
      g.addEventListener("pointermove",ev=>{if(!app.dragging||app.dragging.node!==node)return; const p=screenMapPoint(ev); let x=p.x,y=p.y;if(app.modeTool==="arc"&&app.first){const a=Math.atan2(y-app.first.y,x-app.first.x);x=Math.round(app.first.x+app.radius*Math.cos(a));y=Math.round(app.first.y+app.radius*Math.sin(a));} node.x=Math.round(x);node.y=Math.round(y);const key=node.name; if(coordsNow()[key]){coordsNow()[key].x=node.x;coordsNow()[key].y=node.y;}g.setAttribute("transform",`translate(${OFFSET+node.x},${OFFSET-node.y})`);const coord=g.querySelector(".mv-node-coord");if(coord)coord.textContent=`${node.x}, ${node.y}`; });
      g.addEventListener("pointerup",async()=>{if(!app.dragging||app.dragging.node!==node)return;const d=app.dragging;app.dragging=null;if(d.startX!==node.x||d.startY!==node.y){app.undo.push({type:"move",name:node.name,x:d.startX,y:d.startY});renderPanels();redraw();try{await persistNavigation(setStatus);}catch{}}});
      app.world.append(g);
    }
    app.zoomLabel.textContent=`${Math.round(app.zoom*100)}%`;
    if(app.circles&&app.selected){const n=locate(app.selected);if(n)app.world.append(svgEl("circle",{cx:OFFSET+n.x,cy:OFFSET-n.y,r:600,fill:"none",stroke:"rgba(96,165,250,.45)","stroke-dasharray":"8 6"}));}
  }
  function screenMapPoint(ev){const r=app.viewport.getBoundingClientRect();const z=Number(getComputedStyle(document.body).zoom)||1;const x=(ev.clientX-r.left)/z,y=(ev.clientY-r.top)/z;return{x:Math.round((x-app.pan.x)/app.zoom-OFFSET),y:Math.round(OFFSET-(y-app.pan.y)/app.zoom)};}
  function toggleRoute(a,b){const i=app.routes.findIndex(r=>(r.start||r.startNode?.name)===a.name&&(r.end||r.endNode?.name)===b.name);if(i>=0)app.routes.splice(i,1);else {const route={id:Date.now(),start:a.name,end:b.name};app.routes.push(route);app.undo.push({type:"route",id:route.id});}state.mapRouteDraft=clone(app.routes);refreshMode();renderPanels();redraw();}
  function refreshMode(){ if(!app.modeInfo)return; app.modeInfo.textContent=app.modeTool==="drag"?"노드를 끌어 좌표를 저장합니다.":app.modeTool==="arc"?`같은 거리 이동 · ${app.step===1?"기준 노드 선택":app.step===2?"이동할 노드 선택":"선택 노드를 끌기"}`:app.modeTool==="measure"?`거리 측정 · ${app.step===1?"출발 노드 선택":"도착 노드 선택"}`:"지도 이동 · 휠로 확대/축소"; redraw(); }
  function panel(title,id){
    const p=el("section","mv-panel");p.dataset.panel=({nodes:"coordChangesPanel",slots:"slotPanel",routes:"routeListPanel",memos:"memoListPanel",calibration:"routeCalibrationPanel",overview:"mainPanel"})[id];p.id=`mv-${id}-panel`;
    const h=el("header","mv-panel-head");h.append(el("strong","",title));
    const fold=btn("−",()=>{if(p.classList.contains("collapsed")){p.classList.remove("collapsed");const expanded=Number(p.dataset.expandedHeight);if(Number.isFinite(expanded)&&expanded>0)p.style.height=`${expanded}px`;}else{p.dataset.expandedHeight=String(p.offsetHeight);p.classList.add("collapsed");}});h.append(fold);
    let drag=null;h.addEventListener("pointerdown",ev=>{if(ev.target.closest("button"))return;drag={x:ev.clientX,y:ev.clientY,left:p.offsetLeft,top:p.offsetTop};h.setPointerCapture(ev.pointerId);});
    h.addEventListener("pointermove",ev=>{if(!drag)return;const z=Number(getComputedStyle(document.body).zoom)||1;const maxX=Math.max(0,p.parentElement.clientWidth-p.offsetWidth),maxY=Math.max(0,p.parentElement.clientHeight-p.offsetHeight);p.style.left=`${Math.max(0,Math.min(maxX,drag.left+(ev.clientX-drag.x)/z))}px`;p.style.top=`${Math.max(0,Math.min(maxY,drag.top+(ev.clientY-drag.y)/z))}px`;});h.addEventListener("pointerup",()=>drag=null);
    p.append(h);const body=el("div","mv-panel-body");p.append(body);
    const resize=el("div","mv-resize-handle");resize.setAttribute("role","separator");resize.setAttribute("aria-label",`${title} 패널 크기 조절`);let resizing=null;
    resize.addEventListener("pointerdown",ev=>{if(p.classList.contains("collapsed"))return;ev.preventDefault();ev.stopPropagation();resize.setPointerCapture(ev.pointerId);resizing={x:ev.clientX,y:ev.clientY,width:p.offsetWidth,height:p.offsetHeight};});
    resize.addEventListener("pointermove",ev=>{if(!resizing)return;const z=Number(getComputedStyle(document.body).zoom)||1,host=p.parentElement,maxWidth=Math.max(180,host.clientWidth-p.offsetLeft),maxHeight=Math.max(48,host.clientHeight-p.offsetTop);const width=Math.max(180,Math.min(maxWidth,resizing.width+(ev.clientX-resizing.x)/z)),height=Math.max(48,Math.min(maxHeight,resizing.height+(ev.clientY-resizing.y)/z));p.style.width=`${width}px`;p.style.height=`${height}px`;p.dataset.expandedHeight=String(height);});
    resize.addEventListener("pointerup",()=>resizing=null);p.append(resize);return{panel:p,body};
  }
  function renderPanels(){ if(!app.panels)return;
    app.panels.overview.replaceChildren();app.panels.overview.append(el("h3","",`현재 맵 · 지도 슬롯 ${app.activeSlot||"미선택"}`),el("p","mv-muted",`출항 맥락 ${app.selectedScheduleSlot==="working"?"현재 회차":`저장 슬롯 ${app.selectedScheduleSlot}`} · 속도 ${speedNow()}`),el("p","mv-muted",`${app.routes.length}개 항로 · ${navNow().memos?.length||0}개 메모`));
    app.panels.nodes.replaceChildren(); app.panels.nodes.append(el("h3","","선택 좌표"));
    if(app.selected){const n=locate(app.selected);if(n){const row=el("div","mv-row");row.append(el("strong","",n.name));row.append(btn("편집",()=>editCoord(n.name)));row.append(btn("원좌표",()=>resetCoord(n.name)));app.panels.nodes.append(row);}}
    for(const n of app.nodes){const original=originalCoords[n.name]||originalCoords[`${n.name} 섬`];if(!original||(n.x===original.x&&n.y===original.y))continue;const changed=el("div","mv-row");changed.append(el("span","",`${n.name} · ${original.x},${original.y} → ${n.x},${n.y}`),btn("원복",()=>resetCoord(n.name)));app.panels.nodes.append(changed);}
    const save=btn("좌표 저장",()=>persistNavigation(setStatus).catch(()=>{}),"primary");const undo=btn("되돌리기",()=>undoLast());const reset=btn("모든 좌표 원복",()=>resetAll());app.panels.nodes.append(save,undo,reset);
    app.panels.routes.replaceChildren();app.panels.routes.append(el("h3","","저장 항로"),btn("모두 지우기",()=>{if(confirm("현재 지도 항로를 모두 지울까요?")){app.routes=[];state.mapRouteDraft=[];renderPanels();redraw();}}));
    if(!app.routes.length)app.panels.routes.append(el("p","mv-muted","측정된 항로가 없습니다."));
    for(const r of allRoutes()){const a=locate(r.start),b=locate(r.end);const item=el("div","mv-route-item");const sec=a&&b?routeTimeSeconds(r,a.name,b.name):0;item.append(el("span","",`${r.start} → ${r.end} · ${duration(sec)}`),btn("시간",()=>editRouteTime(r)),btn("삭제",()=>{app.routes=app.routes.filter(x=>x.id!==r.id);state.mapRouteDraft=clone(app.routes);renderPanels();redraw();}));app.panels.routes.append(item);}
    app.panels.memos.replaceChildren();app.panels.memos.append(el("h3","","항로 메모"),btn("메모 추가",()=>editMemo(null)),btn("모두 삭제",()=>{if(confirm("항로 메모를 모두 지울까요?"))saveMemos([]);}));
    const memos=navNow().memos||[]; if(!memos.length)app.panels.memos.append(el("p","mv-muted","등록된 메모가 없습니다."));
    for(const m of memos){const row=el("div","mv-memo-item");row.append(el("strong","",`${m.startName||""} → ${m.endName||""}`),el("p","",m.text||""),btn("수정",()=>editMemo(m)),btn("삭제",()=>saveMemos(memos.filter(x=>x.id!==m.id))));app.panels.memos.append(row);}
    app.panels.calibration.replaceChildren();app.panels.calibration.append(el("h3","","방향별 항로 보정"));for(const[k,v]of Object.entries(window.routeCalibrations||{})){const row=el("div","mv-route-item");row.append(el("span","",`${k} ×${Number(v.multiplier).toFixed(3)}`),btn("삭제",async()=>{if(!mapMutationAllowed())return;delete window.routeCalibrations[k];await persistNavigation(setStatus);renderPanels();}));app.panels.calibration.append(row);}
    renderSlots();
  }
  async function saveMemos(memos){if(!mapMutationAllowed())return;try{await persistNavigation(setStatus,{memos});renderPanels();}catch{}}
  function editMemo(existing){if(!mapMutationAllowed())return;const start=prompt("출발 섬",existing?.startName||""),end=prompt("도착 섬",existing?.endName||"");if(start===null||end===null)return;const text=prompt("메모",existing?.text||"");if(text===null)return;const all=clone(navNow().memos||[]);if(existing){const m=all.find(x=>x.id===existing.id);if(m)Object.assign(m,{startName:start,endName:end,text:text.trim()});}else all.push({id:Date.now(),startName:start.trim(),endName:end.trim(),timeStr:"수동 입력",text:text.trim()});saveMemos(all);}
  function editCoord(name){if(!mapMutationAllowed())return;const c=locate(name);const x=prompt(`${name} X 좌표`,c.x);if(x===null)return;const y=prompt(`${name} Y 좌표`,c.y);if(y===null||!Number.isFinite(+x)||!Number.isFinite(+y))return;coordsNow()[name].x=+x;coordsNow()[name].y=+y;app.nodes=nodesList();persistNavigation(setStatus).then(()=>{renderPanels();redraw();}).catch(()=>{});}
  function resetCoord(name){if(!mapMutationAllowed())return;const original=originalCoords[name];if(!original)return;app.undo.push({type:"move",name,x:coordsNow()[name].x,y:coordsNow()[name].y});Object.assign(coordsNow()[name],{x:original.x,y:original.y});app.nodes=nodesList();persistNavigation(setStatus).then(()=>{renderPanels();redraw();}).catch(()=>{});}
  function resetAll(){if(!mapMutationAllowed())return;if(!confirm("모든 사용자 좌표를 원본 좌표로 되돌릴까요?"))return;for(const[k,v]of Object.entries(originalCoords))if(coordsNow()[k]){if(coordsNow()[k].x!==v.x||coordsNow()[k].y!==v.y)app.undo.push({type:"move",name:k,x:coordsNow()[k].x,y:coordsNow()[k].y});Object.assign(coordsNow()[k],{x:v.x,y:v.y});}app.nodes=nodesList();persistNavigation(setStatus).then(()=>{renderPanels();redraw();}).catch(()=>{});}
  function undoLast(){if(!mapMutationAllowed())return;const x=app.undo.pop();if(!x)return;if(x.type==="route")app.routes=app.routes.filter(r=>r.id!==x.id);else if(x.type==="move"&&coordsNow()[x.name]){coordsNow()[x.name].x=x.x;coordsNow()[x.name].y=x.y;app.nodes=nodesList();persistNavigation(setStatus).catch(()=>{});}state.mapRouteDraft=clone(app.routes);renderPanels();redraw();}
  async function editRouteTime(route){if(!mapMutationAllowed())return;const a=locate(route.start),b=locate(route.end);if(!a||!b)return;const current=Number.isFinite(route.customSeconds)?route.customSeconds:Math.round(legDistance(a.name,b.name)/speedNow()*60);const value=prompt(`${route.start} → ${route.end}\n새 소요 시간을 초 단위로 입력`,current);if(value===null||!Number.isFinite(+value)||+value<=0)return;const originalSecs=Math.round(rawLegDistance(a.name,b.name)/speedNow()*60);if(originalSecs>0){const modelRoute=app.routes.find(item=>item.id===route.id)||route;modelRoute.customSeconds=+value;route.customSeconds=+value;state.mapRouteDraft=clone(app.routes);window.routeCalibrations=window.routeCalibrations||{};window.routeCalibrations[`${a.name}_${b.name}`]={multiplier:+value/originalSecs};await persistNavigation(setStatus,{routeCalibrations:window.routeCalibrations});redraw();renderPanels();}}
  function snapshotFromState(snapshot){if(!mapMutationAllowed())return Promise.reject(new Error("완료 저장 중 지도 설정을 불러올 수 없습니다."));const routes=clone(snapshot.routes||[]);const navigation={coords:clone(snapshot.coords||{}),routeCalibrations:clone(snapshot.routeCalibrations||{}),memos:clone(snapshot.memos||[])};return saveSettings({navigation}).then(()=>{app.routes=routes;state.mapRouteDraft=clone(routes);Object.assign(window.islandCoordinates,navigation.coords);window.routeCalibrations=navigation.routeCalibrations;app.nodes=nodesList();redraw();renderPanels();});}
  function renderSlots(){if(!app.panels.slots)return;const box=app.panels.slots;box.replaceChildren();box.append(el("h3","","지도 저장 슬롯"));for(let i=1;i<=3;i++){const key=String(i),snap=state.settings.mapSlots?.[key],row=el("div","mv-row");row.append(el("strong","",`슬롯 ${i}`),btn("저장",async()=>{const mapSlots={...(state.settings.mapSlots||{"1":null,"2":null,"3":null}),[key]:activeSnapshot()};try{await saveSettings({mapSlots});app.activeSlot=key;setStatus(`지도 슬롯 ${i} 저장을 확인했습니다.`,"success");renderPanels();}catch(e){setStatus(`지도 슬롯 저장 실패: ${e.message}`,"error");}}),btn("불러오기",async()=>{if(!snap)return;if(!confirm(`슬롯 ${i}의 지도 설정을 불러올까요?`))return;try{await snapshotFromState(snap);app.activeSlot=key;setStatus(`지도 슬롯 ${i} 불러오기를 확인했습니다. 타이머는 초기화됩니다.`,"success");}catch(e){setStatus(`지도 슬롯 불러오기 실패: ${e.message}`,"error");}},"",!snap),btn("삭제",async()=>{if(!snap||!confirm(`슬롯 ${i}를 삭제할까요?`))return;try{await saveSettings({mapSlots:{...(state.settings.mapSlots||{}),[key]:null}});renderPanels();}catch(e){setStatus(e.message,"error");}}));box.append(row);}
    const base=state.settings.mapBase;box.append(el("h3","","기본 지도"),btn("기본 지도 저장",async()=>{try{await saveSettings({mapBase:activeSnapshot()});setStatus("기본 지도 저장을 확인했습니다.","success");renderPanels();}catch(e){setStatus(e.message,"error");}}),btn("기본 지도 불러오기",async()=>{if(!base)return;try{await snapshotFromState(base);setStatus("기본 지도를 불러왔습니다.","success");}catch(e){setStatus(e.message,"error");}},"",!base),btn("기본 지도 지우기",async()=>{if(!base||!confirm("기본 지도를 지울까요?"))return;try{await saveSettings({mapBase:null});renderPanels();}catch(e){setStatus(e.message,"error");}}));
  }
  function mount(){
    app.open=true;app.nodes=nodesList();app.routes=clone(state.mapRouteDraft||[]);
    const overlay=el("dialog","mv-window");app.overlay=overlay;app.window=overlay;
    const parentDialog=root.closest("dialog")||document.querySelector("#map-tools-dialog");
    if(parentDialog) parentDialog.append(overlay); else document.body.append(overlay);
    const head=el("header","mv-header");app.modeLabel=el("span","mv-mode-label",app.mode==="briefing"?"스케줄 항로":"지도 튜닝");head.append(el("strong","","대양 지도 · 좌표 · 항로"),app.modeLabel,btn("닫기",()=>overlay.close()));
    overlay.addEventListener("close",()=>{app.open=false;});
    const toolbar=el("div","mv-toolbar");const modeInfo=el("span","mv-mode-info");app.modeInfo=modeInfo;
    const scheduleSlotSelect=document.createElement("select");scheduleSlotSelect.className="mv-select";scheduleSlotSelect.setAttribute("aria-label","항로 스케줄 슬롯");scheduleSlotSelect.append(new Option("현재 회차","working"));for(let i=1;i<=5;i++){const option=new Option(`저장 슬롯 ${i}`,String(i));option.disabled=!(state.scheduleSlots?.[String(i)]||state.scheduleSlots?.[i]);scheduleSlotSelect.append(option);}scheduleSlotSelect.value=app.selectedScheduleSlot;scheduleSlotSelect.addEventListener("change",()=>{app.selectedScheduleSlot=scheduleSlotSelect.value;fillTrips();renderPanels();});app.scheduleSlotSelect=scheduleSlotSelect;
    const modeSelect=document.createElement("select");modeSelect.className="mv-select";modeSelect.innerHTML='<option value="speed">쾌속</option><option value="balance">균형</option>';modeSelect.value=app.mode==="balance"?"balance":"speed";modeSelect.addEventListener("change",()=>{app.mode=modeSelect.value;app.modeLabel.textContent=`${modeSelect.options[modeSelect.selectedIndex].text} 출항 항로`;fillTrips();if(selectedSchedule()[app.mode]?.length)loadSelectedSchedule();});app.modeSelect=modeSelect;
    const tripSelect=document.createElement("select");tripSelect.className="mv-select";app.tripSelect=tripSelect;
    const loadBrief=btn("선택 출항 보기",loadSelectedSchedule);
    const saveLayout=btn("패널 저장",savePanelLayout);
    const exportButton=btn("JSON 내보내기",exportMapJson);const importInput=document.createElement("input");importInput.type="file";importInput.accept="application/json,.json";importInput.hidden=true;importInput.addEventListener("change",importMapJson);const importButton=btn("JSON 불러오기",()=>importInput.click());
    toolbar.append(btn("지도 이동",()=>setTool("")),btn("노드 이동",()=>setTool("drag")),btn("같은 거리 이동",()=>setTool("arc")),btn("거리 측정",()=>setTool("measure")),btn("되돌리기",undoLast),btn("이름",()=>{app.showLabels=!app.showLabels;redraw();}),btn("원 표시",()=>{app.circles=!app.circles;redraw();}),btn("초기 보기",resetView),btn("−",()=>zoomAt(.8)),el("span","mv-zoom","") ,btn("+",()=>zoomAt(1.25)),scheduleSlotSelect,modeSelect,tripSelect,loadBrief,saveLayout,exportButton,importButton,importInput,modeInfo);app.zoomLabel=toolbar.querySelector(".mv-zoom");
    const workspace=el("div","mv-workspace");app.viewport=el("div","mv-viewport");const svg=svgEl("svg",{viewBox:`0 0 ${SIZE} ${SIZE}`,width:SIZE,height:SIZE,class:"mv-svg"});app.svg=svg;const world=svgEl("g");app.world=world;svg.append(world);app.viewport.append(svg);workspace.append(app.viewport);
    const panels=el("aside","mv-panels");app.panelsRoot=panels;app.panels={};for(const[id,title]of [["overview","선택 컨텍스트"],["slots","저장 상태"],["routes","항로 목록"],["nodes","좌표 변경"],["memos","메모"],["calibration","보정"]]){const p=panel(title,id);app.panels[id]=p.body;panels.append(p.panel);}workspace.append(panels);
    overlay.append(head,toolbar,workspace);setDialogViewportSize();overlay.showModal();
    app.viewport.addEventListener("pointerdown",ev=>{if(ev.target.closest(".mv-node"))return;app.panning={x:ev.clientX,y:ev.clientY,pan:{...app.pan}};app.viewport.setPointerCapture?.(ev.pointerId);});app.viewport.addEventListener("pointermove",ev=>{if(!app.panning)return;const z=Number(getComputedStyle(document.body).zoom)||1;app.pan.x=app.panning.pan.x+(ev.clientX-app.panning.x)/z;app.pan.y=app.panning.pan.y+(ev.clientY-app.panning.y)/z;redraw();});app.viewport.addEventListener("pointerup",()=>app.panning=null);
    app.viewport.addEventListener("wheel",ev=>{ev.preventDefault();zoomAt(ev.deltaY<0?1.1:.9,ev);},{passive:false});
    fillTrips();setTool("");restorePanelLayout();renderPanels();resetView();if(selectedSchedule()[app.mode]?.length)loadSelectedSchedule();
  }
  function setTool(name){app.modeTool=name;app.step=name==="arc"||name==="measure"?1:0;app.first=null;app.second=null;refreshMode();}
  function zoomAt(factor,ev){const old=app.zoom;const next=Math.max(.02,Math.min(3,old*factor));if(ev&&app.viewport){const r=app.viewport.getBoundingClientRect(),z=Number(getComputedStyle(document.body).zoom)||1,x=(ev.clientX-r.left)/z,y=(ev.clientY-r.top)/z;app.pan.x=x-(x-app.pan.x)*(next/old);app.pan.y=y-(y-app.pan.y)*(next/old);}app.zoom=next;redraw();}
  function resetView(){if(!app.viewport)return;app.zoom=.15;app.pan.x=app.viewport.clientWidth/2-OFFSET*app.zoom;app.pan.y=app.viewport.clientHeight/2-OFFSET*app.zoom;redraw();}
  function restorePanelLayout(){const saved=state.settings.viewer?.panels||{};for(const p of app.overlay.querySelectorAll(".mv-panel")){const value=saved[p.dataset.panel];if(value){for(const key of ["left","top","width"])if(Number.isFinite(value[key]))p.style[key]=`${value[key]}px`;if(Number.isFinite(value.height)){p.dataset.expandedHeight=String(value.height);p.style.height=`${value.height}px`;}if(value.collapsed)p.classList.add("collapsed");}}}
  async function savePanelLayout(){const panels={};for(const p of app.overlay.querySelectorAll(".mv-panel")){const collapsed=p.classList.contains("collapsed"),expandedHeight=Number(p.dataset.expandedHeight);panels[p.dataset.panel]={left:p.offsetLeft,top:p.offsetTop,width:p.offsetWidth,height:collapsed&&Number.isFinite(expandedHeight)&&expandedHeight>0?expandedHeight:p.offsetHeight,collapsed};}try{await saveSettings({viewer:{...(state.settings.viewer||{}),panels}});setStatus("지도 패널 배치를 저장했습니다.","success");}catch(e){setStatus(`패널 배치 저장 실패: ${e.message}`,"error");}}
  function selectedSchedule(){if(app.selectedScheduleSlot==="working")return state.session.schedule||{};const stored=state.scheduleSlots?.[app.selectedScheduleSlot];return stored?.session?.schedule||stored?.schedule||{};}
  function fillTrips(){if(!app.tripSelect)return;const data=selectedSchedule();const sorties=app.mode==="balance"?data.balance:data.speed;app.tripSelect.replaceChildren();(sorties||[]).forEach((_,i)=>{const o=document.createElement("option");o.value=String(i);o.textContent=`${i+1}차 출항`;app.tripSelect.append(o);});if(!sorties?.length){const o=document.createElement("option");o.textContent="스케줄 없음";app.tripSelect.append(o);}}
  function loadSelectedSchedule(){const data=selectedSchedule();const sorties=app.mode==="balance"?data.balance:data.speed;const sortie=sorties?.[Number(app.tripSelect.value)];if(!sortie){setStatus("선택 슬롯에 해당 모드의 스케줄이 없습니다.","error");return;}let prev="일리야";app.routes=[];for(const trade of sortie.trades||[]){app.routes.push({id:Date.now()+app.routes.length,start:prev,end:trade.island,isOverloaded:!!trade.over});prev=trade.island;}app.routes.push({id:Date.now()+app.routes.length,start:prev,end:"일리야",isOverloaded:!!sortie.returnOver});state.mapRouteDraft=clone(app.routes);app.modeLabel.textContent=`${app.mode==="balance"?"균형":"쾌속"} · ${Number(app.tripSelect.value)+1}차 · ${app.selectedScheduleSlot==="working"?"현재 회차":`저장 슬롯 ${app.selectedScheduleSlot}`} · 지도 슬롯 ${app.activeSlot||"미선택"}`;renderPanels();redraw();}
  function exportMapJson(){const snapshot=activeSnapshot();const payload={kind:"bdo-map",version:1,snapshot};const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="bdo-map.json";a.click();URL.revokeObjectURL(a.href);}
  async function importMapJson(ev){const file=ev.target.files?.[0];ev.target.value="";if(!file)return;try{const parsed=JSON.parse(await file.text());const snap=parsed.snapshot||parsed;if(!snap||!snap.coords||typeof snap.coords!=="object"||Array.isArray(snap.coords)||!Array.isArray(snap.routes)||!snap.routeCalibrations||typeof snap.routeCalibrations!=="object"||!Array.isArray(snap.memos))throw new Error("지도 전용 JSON 형식이 아닙니다.");const strip=(v)=>Array.isArray(v)?v.map(strip):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).filter(([k])=>k!=="REPLACEMENT_CODE").map(([k,x])=>[k,strip(x)])):v;await snapshotFromState(strip(snap));setStatus("지도 전용 JSON을 불러왔습니다.","success");}catch(e){setStatus(`지도 JSON 불러오기 실패: ${e.message}`,"error");}}
  function openMapViewer(mode){app.mode=mode==="balance"?"balance":"speed";app.selectedScheduleSlot="working";if(app.scheduleSlotSelect)app.scheduleSlotSelect.value="working";if(app.modeSelect)app.modeSelect.value=app.mode;if(app.tripSelect)fillTrips();if(!app.open&&app.overlay?.isConnected){app.open=true;app.modeLabel.textContent=app.mode;setDialogViewportSize();app.overlay.showModal();refresh();if(selectedSchedule()[app.mode]?.length)loadSelectedSchedule();return;}if(!app.open)mount();else {app.modeLabel.textContent=app.mode;fillTrips();if(selectedSchedule()[app.mode]?.length)loadSelectedSchedule();}}
  function refresh(){if(app.open){app.nodes=nodesList();renderPanels();redraw();}}
  function setDialogViewportSize(){const zoom=Number(getComputedStyle(document.body).zoom)||1;app.overlay.style.width=`${Math.min(window.innerWidth*.96,1500)/zoom}px`;app.overlay.style.height=`${Math.min(window.innerHeight*.92,1000)/zoom}px`;app.overlay.style.minWidth=window.innerWidth<900?"0":`${680/zoom}px`;app.overlay.style.minHeight=window.innerHeight<600?"0":`${460/zoom}px`;}
  window.addEventListener("resize",()=>{if(app.open){setDialogViewportSize();resetView();}});
  const parentDialog=root.closest("dialog")||document.querySelector("#map-tools-dialog");
  if(parentDialog)parentDialog.addEventListener("close",()=>{if(app.overlay?.open)app.overlay.close();});
  const controller={openMapViewer,refresh,setStatus:(next)=>{app.setStatus=next;setStatus=next;},trigger};
  mapViewers.set(root,controller);
  return controller;
}

export function renderFreeRoute(root,setStatus){
  const existing=freeRouteViews.get(root);
  if(existing){existing.setStatus(setStatus);existing.refresh();return existing;}
  root.replaceChildren();const box=el("section","mv-free-route");box.append(el("h3","","자유 항로"));
  const exactIsland=name=>{const value=String(name||"").trim();if(!value)return null;const all=coordsNow(),key=all[value]?value:all[`${value} 섬`]?`${value} 섬`:null;return key?{name:key,...all[key]}:null;};
  document.getElementById("free-route-islands")?.remove();const options=Object.keys(coordsNow()).sort();const list=document.createElement("datalist");list.id="free-route-islands";for(const name of options){const o=document.createElement("option");o.value=name;list.append(o);}document.body.append(list);
  const start=document.createElement("input");start.placeholder="출발 섬";start.setAttribute("list",list.id);const end=document.createElement("input");end.placeholder="도착 섬";end.setAttribute("list",list.id);
  const result=el("output","mv-free-result","00:00 / 00:00");const actions=el("div","mv-free-actions");let timer=null,elapsed=0,total=0,depart;const display=()=>`${duration(elapsed)} / ${duration(total)}`;const cancel=()=>{if(timer)clearInterval(timer);timer=null;elapsed=0;if(depart)depart.textContent="출항";};const calc=()=>{if(timer)cancel();const a=exactIsland(start.value),b=exactIsland(end.value);total=a&&b&&a.name!==b.name?Math.round(legDistance(a.name,b.name)/speedNow()*60):0;result.textContent=total?`${Math.round(legDistance(a.name,b.name)).toLocaleString()} 거리 · ${display()}`:"섬 이름을 선택하세요.";};start.addEventListener("input",calc);end.addEventListener("input",calc);
  depart=btn("출항",()=>{if(timer){cancel();result.textContent=display();setStatus("자유 항로 타이머를 취소했습니다.","info");return;}if(total<=0){setStatus("올바른 출발지와 도착지를 먼저 선택하세요.","error");return;}elapsed=0;depart.textContent="취소";timer=setInterval(()=>{elapsed++;result.textContent=display();if(elapsed>=total){clearInterval(timer);timer=null;depart.textContent="출항";elapsed=total;result.textContent=`도착 · ${display()}`;window.playAlarmSound?.();setStatus("자유 항로 목적지에 도착했습니다.","success");}},1000);setStatus("자유 항로 출항 타이머를 시작했습니다.","success");});
  const reset=btn("초기화",()=>{cancel();start.value="";end.value="";elapsed=0;total=0;result.textContent="00:00 / 00:00";setStatus("자유 항로를 초기화했습니다.","info");});actions.append(depart,reset);box.append(start,end,result,actions);root.append(box);
  const controller={root,sessionId:state.session.id,setStatus:(next)=>{setStatus=next;},refresh:()=>{if(controller.sessionId!==state.session.id){controller.sessionId=state.session.id;controller.resetTimer();}else if(!timer)calc();},resetTimer:()=>{cancel();calc();},destroy:()=>{cancel();window.removeEventListener("bdo:timers-reset",controller.onTimersReset);freeRouteViews.delete(root);activeFreeRouteViews.delete(controller);}};
  controller.onTimersReset=()=>controller.resetTimer();window.addEventListener("bdo:timers-reset",controller.onTimersReset);
  freeRouteViews.set(root,controller);activeFreeRouteViews.add(controller);
  if(!freeRouteCleanupObserver&&document.body){freeRouteCleanupObserver=new MutationObserver(()=>{for(const view of activeFreeRouteViews)if(!view.root.isConnected)view.destroy();});freeRouteCleanupObserver.observe(document.body,{childList:true,subtree:true});}
  return controller;
}




