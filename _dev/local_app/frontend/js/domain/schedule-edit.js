function canApplyScheduleChange(sorties, mode) {
    const validation = validateSortieSequence(sorties, getScheduleStartingInventory(sorties));
    if (!validation.valid) {
        const issue = validation.issues[0];
        showToast(`${issue.departure}차 출항의 ${issue.item} 재료가 부족해 변경할 수 없습니다.`);
        return false;
    }
    const normalW = Number(document.getElementById('normalWeight').value);
    const limitW = mode === 'speed' ? normalW : Number(document.getElementById('maxWeight').value);
    for (const sortie of sorties) {
        if (sortie.trades.every(t => t.completed)) continue;
        const sim = simulateWeightsTemp(sortie.trades, normalW);
        if (!Number.isFinite(sim.startW) || sim.startW > normalW || sim.peakW > limitW) {
            showToast('출발 적재량 또는 항해 중 무게 한도를 초과해 변경할 수 없습니다.');
            return false;
        }
    }
    return true;
}

/* SPEC-005 T006 FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */
window.routeDragStart = function(e, sortieIdx, tradeIdx, mode) { draggedRoute = { sortieIdx, tradeIdx, mode }; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };

window.routeDragEnd = function(e) { e.currentTarget.classList.remove('dragging'); document.querySelectorAll('.route-card').forEach(c => c.classList.remove('drag-over')); draggedRoute = null; };

window.routeDragOver = function(e, targetSortieIdx, mode) { e.preventDefault(); if (draggedRoute && draggedRoute.sortieIdx === targetSortieIdx && draggedRoute.mode === mode) { e.currentTarget.classList.add('drag-over'); } };

window.routeDrop = function(e, targetSortieIdx, targetTradeIdx, mode) {
    e.preventDefault(); e.currentTarget.classList.remove('drag-over');
    if (draggedRoute && draggedRoute.sortieIdx === targetSortieIdx && draggedRoute.tradeIdx !== targetTradeIdx && draggedRoute.mode === mode) {
        let sIdx = draggedRoute.sortieIdx; let fromIdx = draggedRoute.tradeIdx; let toIdx = targetTradeIdx;
        let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
        let sortie = arrRef[sIdx];
        if (sortie.trades.slice(Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx) + 1).some(t => t.completed)) { showToast('완료한 교환의 순서는 변경할 수 없습니다.'); return; }
        const candidate = {...sortie, trades:sortie.trades.map(t => ({...t}))};
        const movedItem = candidate.trades.splice(fromIdx, 1)[0];
        candidate.trades.splice(toIdx, 0, movedItem);
        if (!canApplyScheduleChange(arrRef.map((s, i) => i === sIdx ? candidate : s), mode)) return;
        sortie.trades.splice(toIdx, 0, sortie.trades.splice(fromIdx, 1)[0]);
        window.rebuildSortieReq(sortie);

        let normalW = Number(document.getElementById('normalWeight').value) || 14379;
        let finalSim = simulateWeightsTemp(sortie.trades, normalW);
        sortie.startWeight = finalSim.startW; sortie.totalTime = finalSim.totalTime; sortie.returnOver = finalSim.returnOver; sortie.returnTime = finalSim.returnTime;
        sortie.trades.forEach((ct, idx) => { ct.afterW = finalSim.stepData[idx].afterW; ct.estT = finalSim.stepData[idx].estT; ct.over = finalSim.stepData[idx].over; });

        renderModeColumn(`col-${mode}`, arrRef, mode);
        showToast("📍 동선 재정렬 반영됨");
    }
};

window.adjustTradeCount = function(e, mode, sortieIdx, tradeIdx, delta) {
    e.stopPropagation(); // 드래그 앤 드롭 간섭 방지
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    let sortie = arrRef[sortieIdx];
    let trade = sortie.trades[tradeIdx];

    if (trade.completed) return; // 이미 완료된 건 수정 불가

    // 횟수 조정 (0 미만으로 떨어지는 것 방지)
    let newCount = Math.max(0, trade.execC + delta);
    if (newCount === trade.execC) return;
    if (newCount > trade.execC) {
        const remaining = scannedTrades[trade.originalIndex]?.count ?? trade.origC;
        const others = arrRef.flatMap(s => s.trades).filter(t => t !== trade && !t.completed && !t.isWaypoint);
        const allocated = others.filter(t => t.originalIndex === trade.originalIndex).reduce((n, t) => n + t.execC, 0);
        const normalCost = Number(document.getElementById('parleyPerTrade').value);
        const coinCost = Number(document.getElementById('parleyCrow').value);
        const cost = t => t.isCoin ? coinCost : normalCost;
        const total = others.reduce((n, t) => n + t.execC * cost(t), 0) + newCount * cost(trade);
        if (allocated + newCount > remaining || total > Number(document.getElementById('maxParley').value)) {
            showToast("남은 교환 횟수 또는 현재 교섭력을 초과해 늘릴 수 없습니다.");
            return;
        }
    }
    const candidate = {...sortie, trades:sortie.trades.map(t => t === trade ? {...t, execC:newCount} : {...t})};
    if (!canApplyScheduleChange(arrRef.map((s, i) => i === sortieIdx ? candidate : s), mode)) return;
    trade.execC = newCount;

    // 1~4. 적재/교섭력/연쇄/무게/시간 재계산 + 재렌더 (경유지 isWaypoint 인지 — 공용 헬퍼)
    window.applySortieRecompute(sortie, mode);
};

window.rebuildSortieReq = function(sortie) {
    const perTradeP = parseInt(document.getElementById('parleyPerTrade').value) || 10973;
    const perTradeCrowP = parseInt(document.getElementById('parleyCrow').value) || 20000;
    const parley = sortie.trades.reduce((sum, t) => sum + (t.isWaypoint ? 0 : (t.isCoin ? perTradeCrowP : perTradeP) * t.execC), 0);
    const cargoPlan = getSortieCargoPlan(sortie.trades);
    sortie.reqItems = cargoPlan.reqItems;
    sortie.trades.forEach((t, index) => { if (!t.isWaypoint) t.isChained = cargoPlan.chained[index]; });
    sortie.parleyUsed = parley;
};

window.applySortieRecompute = function(sortie, mode) {
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    window.rebuildSortieReq(sortie);
    let normalW = Number(document.getElementById('normalWeight').value) || 14379;
    let finalSim = simulateWeightsTemp(sortie.trades, normalW);
    sortie.startWeight = finalSim.startW; sortie.totalTime = finalSim.totalTime;
    sortie.returnOver = finalSim.returnOver; sortie.returnTime = finalSim.returnTime;
    sortie.trades.forEach((ct, idx) => { ct.afterW = finalSim.stepData[idx].afterW; ct.estT = finalSim.stepData[idx].estT; ct.over = finalSim.stepData[idx].over; });
    renderModeColumn(`col-${mode}`, arrRef, mode);
};

window.mergeAdjacentDupTrades = function(sorties, normalW) {
    if (!Array.isArray(sorties)) return;
    sorties.forEach(s => {
        if (!s || !Array.isArray(s.trades) || s.trades.length < 2) return;
        let merged = false;
        let out = [s.trades[0]];
        for (let i = 1; i < s.trades.length; i++) {
            let prev = out[out.length - 1];
            let cur = s.trades[i];
            let canMerge = prev && cur
                && !prev.isWaypoint && !cur.isWaypoint
                && !prev.completed && !cur.completed
                && !prev.timerActive && !cur.timerActive
                && prev.island === cur.island
                && prev.toClean === cur.toClean
                && prev.fromClean === cur.fromClean;
            if (canMerge) {
                prev.execC = (prev.execC || 0) + (cur.execC || 0);
                merged = true;
            } else {
                out.push(cur);
            }
        }
        if (!merged) return;
        s.trades = out;
        // 적재/교섭력/reqItems 재계산(총 execC 불변이라 값은 동일하나 정합성 유지) + 무게/시간 재시뮬해 afterW 정정
        if (typeof window.rebuildSortieReq === 'function') window.rebuildSortieReq(s);
        let fs = simulateWeightsTemp(s.trades, normalW);
        s.startWeight = fs.startW; s.totalTime = fs.totalTime;
        s.returnOver = fs.returnOver; s.returnTime = fs.returnTime;
        s.trades.forEach((ct, idx) => { if (fs.stepData[idx]) { ct.afterW = fs.stepData[idx].afterW; ct.estT = fs.stepData[idx].estT; ct.over = fs.stepData[idx].over; } });
    });
};

window.sortieDragStart = function(e, sortieIdx, mode) { 
    draggedSortie = { sortieIdx, mode }; 
    e.currentTarget.classList.add('opacity-50', 'scale-[0.98]'); 
    e.dataTransfer.effectAllowed = 'move';
};

window.sortieDragEnd = function(e) { 
    e.currentTarget.classList.remove('opacity-50', 'scale-[0.98]'); 
    draggedSortie = null; 
};

window.sortieDragOver = function(e, targetIdx, mode) { 
    e.preventDefault(); 
};

window.sortieDrop = function(e, targetIdx, mode) {
    e.preventDefault();
    if (draggedSortie && draggedSortie.mode === mode && draggedSortie.sortieIdx !== targetIdx) {
        let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
        const fromIdx = draggedSortie.sortieIdx;
        if (arrRef[fromIdx].trades.some(t => t.completed) || arrRef[targetIdx].trades.some(t => t.completed)) { showToast('진행한 출항의 순서는 변경할 수 없습니다.'); return; }
        const candidate = [...arrRef];
        candidate.splice(targetIdx, 0, candidate.splice(fromIdx, 1)[0]);
        if (!canApplyScheduleChange(candidate, mode)) return;
        arrRef.splice(targetIdx, 0, arrRef.splice(fromIdx, 1)[0]);
        renderModeColumn(`col-${mode}`, arrRef, mode);
        showToast("📍 출항 순서가 변경되었습니다.");
    }
};

window.__SPEC005_SCRIPT_LOADED = window.__SPEC005_SCRIPT_LOADED || {}; window.__SPEC005_SCRIPT_LOADED["schedule-edit.js"] = true;
