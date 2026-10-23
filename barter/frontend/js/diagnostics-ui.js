const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
const appendDetails = (root, title, body) => { const details = node("details", "engine-debug-section"); details.append(node("summary", "", title), body); root.append(details); };

function renderEngineEvidence(root, engineDebug, session) {
  root.replaceChildren();
  if (!engineDebug || typeof engineDebug !== "object") { root.append(node("p", "empty", "이 회차에 ENGINE_DEBUG 기록이 없습니다. 스케줄을 생성하면 계산 근거가 기록됩니다.")); return; }
  for (const [mode, label] of [["speed", "쾌속"], ["balance", "균형"]]) {
    const debug = engineDebug[mode];
    const modeDetails = node("details", "engine-debug-mode");
    modeDetails.append(node("summary", "", `⚙️ ${label} 계산 근거`));
    if (!debug) { modeDetails.append(node("p", "hint", "저장된 계산 근거 없음")); root.append(modeDetails); continue; }
    const scores = Array.isArray(debug.initialScores) ? debug.initialScores : [];
    const scoresBody = node("div", "engine-debug-scroll");
    if (!scores.length) scoresBody.append(node("p", "hint", "서류 점수 기록 없음"));
    else {
      const table = document.createElement("table"); const head = document.createElement("thead"); const row = document.createElement("tr");
      for (const title of ["품목", "부족/초과", "점수", "계산 근거"]) row.append(node("th", "", title));
      head.append(row); table.append(head); const body = document.createElement("tbody");
      for (const entry of scores) {
        const tr = document.createElement("tr");
        tr.append(node("td", "", entry.name ?? "(품목명 없음)"), node("td", "", Number(entry.lack) > 0 ? `부족 ${entry.lack}` : `초과 ${Math.abs(Number(entry.lack) || 0)}`), node("td", "", Number.isFinite(entry.score) ? entry.score.toLocaleString() : "기록 없음"), node("td", "engine-debug-math", entry.math || "계산식 기록 없음"));
        body.append(tr);
      }
      table.append(body); scoresBody.append(table);
    }
    appendDetails(modeDetails, `1단계 · 서류 점수 ${scores.length}건`, scoresBody);
    const sorties = session.schedule?.[mode] ?? []; const routeBody = node("div", "engine-debug-scroll"); let totalSteps = 0;
    sorties.forEach((sortie, sortieIndex) => {
      const logs = Array.isArray(sortie.routingLogs) ? sortie.routingLogs : []; totalSteps += logs.length;
      const sortieDetails = node("details", "engine-debug-sortie");
      sortieDetails.append(node("summary", "", `${sortieIndex + 1}차 출항 · ${logs.length}개 경합 단계 · ${sortie.seedIsland ? `시드 ${sortie.seedIsland}` : "고정/자동 경로"}`));
      if (!logs.length) sortieDetails.append(node("p", "hint", "이 출항은 저장된 경합 로그가 없습니다."));
      logs.forEach((log, stepIndex) => {
        const step = node("section", "engine-debug-step");
        step.append(node("strong", "", `Step ${stepIndex + 1}: ${log.fromIsland ?? "현재 위치 미기록"} → ${log.winner ?? "선택 기록 없음"}`));
        const candidates = Array.isArray(log.candidates) ? [...log.candidates].sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0)) : Array.isArray(log.top) ? log.top : [];
        if (!candidates.length) step.append(node("p", "hint", "비교 후보 기록이 없습니다."));
        else {
          const list = document.createElement("ol"); list.className = "engine-candidate-list";
          candidates.forEach((candidate, rank) => {
            const selected = candidate.island === log.winner; const item = node("li", selected ? "engine-candidate selected" : "engine-candidate");
            item.append(node("b", "", `${selected ? "선택" : `${rank + 1}위`} · ${candidate.island ?? "섬 이름 없음"}`), node("span", "", candidate.item ? `품목 ${candidate.item}` : ""), node("span", "", candidate.fitness === 9999999 ? "강제 배정" : `점수 ${Number(candidate.fitness ?? 0).toLocaleString()}`), node("p", "engine-debug-math", candidate.math || "이 후보의 점수 근거가 기록되지 않았습니다."));
            list.append(item);
          });
          step.append(list);
          if (!Array.isArray(log.excluded) || log.excluded.length === 0) step.append(node("p", "hint", "엔진 기록에 탈락 후보별 사유는 없습니다. 표시된 후보 근거만 확인할 수 있습니다."));
          else { const excluded = node("ul", "engine-excluded-list"); for (const candidate of log.excluded) excluded.append(node("li", "", `${candidate.island ?? "이름 없음"}: ${candidate.reason ?? candidate.math ?? "사유 기록 없음"}`)); step.append(excluded); }
        }
        sortieDetails.append(step);
      });
      routeBody.append(sortieDetails);
    });
    if (!sorties.length) routeBody.append(node("p", "hint", "출항 데이터가 없습니다."));
    appendDetails(modeDetails, `2단계 · 출항 경로 ${sorties.length}회 / 경합 ${totalSteps}단계`, routeBody);
    root.append(modeDetails);
  }
}

export function renderScheduleDiagnostics(state) {
  const session = state.session;
  const summarize = (sorties = []) => sorties.map((sortie, index) => ({
    sortie: index + 1,
    islandOrder: sortie.trades.map((trade) => trade.island),
    tradeCount: sortie.trades.filter((trade) => !trade.isWaypoint).length,
    waypointCount: sortie.trades.filter((trade) => trade.isWaypoint).length,
    parley: sortie.parleyUsed,
    estimatedMinutes: sortie.totalTime,
    returnMinutes: sortie.returnTime,
  }));
  const engineDebug = session.diagnostics?.engineDebug ?? window.ENGINE_DEBUG ?? null;
  document.getElementById("schedule-diagnostics").textContent = JSON.stringify({
    generatedAt: session.diagnostics?.generatedAt ?? null,
    mode: session.diagnostics?.mode ?? null,
    activeTrades: (session.scannedTrades || []).filter((trade) => !trade.deleted && !trade.disabled).length,
    speed: summarize(session.schedule?.speed),
    balance: summarize(session.schedule?.balance),
    completionPending: Boolean(window.__bdoScheduleRuntime?.pending),
    engineDebug,
    sourceDiagnostics: session.diagnostics,
  }, null, 2);
  renderEngineEvidence(document.getElementById("engine-debug-content"), engineDebug, session);
  document.getElementById("engine-debug-raw").textContent = JSON.stringify(engineDebug ?? {}, null, 2);
}
