/* SPEC-005 T007 FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */
window.completeTradeAndTimer = function(btn, mode, sortieIdx, tradeIdx, originalIdx, island, toClean) {
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    let trade = arrRef[sortieIdx].trades[tradeIdx];
    
    trade.timerActive = false;
    let tKey = island + '_' + toClean;
    delete window.ACTIVE_TIMERS[tKey];

    let timerSpan = document.getElementById(`timer_${mode}_${sortieIdx}_${tradeIdx}`);
    if(timerSpan) timerSpan.classList.add('hidden');

    const parent = btn.parentElement;
    if(parent) {
        const timerBtn = parent.children[0]; 
        if(timerBtn && timerBtn !== btn) timerBtn.classList.add('hidden');
    }
    completeTrade(btn, mode, sortieIdx, tradeIdx, originalIdx);
};

window.openWaypointModal = function(mode, sortieIdx) {
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    let sortie = arrRef[sortieIdx];
    if (!sortie || !sortie.trades.length) { showToast('이 출항에 기항지가 없습니다.'); return; }
    document.getElementById('wpMode').value = mode;
    document.getElementById('wpSortieIdx').value = sortieIdx;
    let sel = document.getElementById('wpAnchorSelect');
    sel.innerHTML = sortie.trades.map((t, idx) => {
        let label = t.isWaypoint ? `${idx+1}. 🧭 ${t.island} (경유지)` : `${idx+1}. ${t.island} (${t.fromClean}→${t.toClean})`;
        return `<option value="${idx}">${label}</option>`;
    }).join('');
    document.getElementById('wpIsland').value = '';
    document.getElementById('wpUseMat').checked = false;
    document.getElementById('wpMatName').value = '';
    document.getElementById('wpMatCount').value = 1;
    let box = document.getElementById('wpMatBox'); box.classList.add('hidden'); box.classList.remove('flex');
    let beforeRadio = document.querySelector('input[name="wpPos"][value="before"]'); if(beforeRadio) beforeRadio.checked = true;
    let m = document.getElementById('waypointModal'); m.classList.remove('hidden'); m.classList.add('flex');
};

window.removeWaypoint = function(mode, sortieIdx, tradeIdx) {
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    let sortie = arrRef[sortieIdx];
    if (!sortie || !sortie.trades[tradeIdx] || !sortie.trades[tradeIdx].isWaypoint) return;
    let wp = sortie.trades[tradeIdx];
    if (wp.completed) { showToast('완료된 경유지는 삭제할 수 없습니다.'); return; }
    let tKey = wp.island + '_' + wp.toClean;
    if (window.ACTIVE_TIMERS) delete window.ACTIVE_TIMERS[tKey];
    sortie.trades.splice(tradeIdx, 1);
    window.applySortieRecompute(sortie, mode);
    showToast('🧭 경유지 삭제됨');
};

window.completeWaypoint = function(btn, mode, sortieIdx, tradeIdx) {
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    let wp = arrRef[sortieIdx].trades[tradeIdx];
    if (!wp || wp.completed) return;

    wp.timerActive = false;
    let tKey = wp.island + '_' + wp.toClean;
    if (window.ACTIVE_TIMERS) delete window.ACTIVE_TIMERS[tKey];
    let timerSpan = document.getElementById(`timer_${mode}_${sortieIdx}_${tradeIdx}`);
    if(timerSpan) timerSpan.classList.add('hidden');

    // 사용 재료 인벤 차감 (0단/육지 재료는 완료 차감 제외 — 일반 교환과 동일 규칙)
    if (wp.consumed && wp.consumed.count > 0 && wp.consumed.tier !== 0 && inventory[wp.consumed.name]) {
        inventory[wp.consumed.name].stock = Math.max(0, inventory[wp.consumed.name].stock - wp.consumed.count);
        let inp = document.getElementById(`stock_${wp.consumed.name}`); if(inp) inp.value = inventory[wp.consumed.name].stock;
        saveInventoryState();
    }

    wp.completed = true;
    showToast(`🧭 경유지 완료${(wp.consumed && wp.consumed.count > 0) ? ': 사용 재료 차감됨' : ''}`);

    btn.innerHTML = '완료됨';
    btn.classList.replace('bg-green-700/80', 'bg-gray-700');
    btn.classList.remove('hover:bg-green-600');
    btn.classList.add('cursor-not-allowed'); btn.disabled = true;
    const card = btn.closest('.group'); if(card) card.classList.add('opacity-40', 'grayscale');
};

function playAlarmSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const playTone = (freq, startTime, duration) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, startTime);
            gain.gain.setValueAtTime(1, startTime);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(startTime);
            osc.stop(startTime + duration);
        };
        playTone(880, ctx.currentTime, 0.3);       
        playTone(1108.73, ctx.currentTime + 0.15, 0.5); 
    } catch(e) { console.warn("웹 오디오 에러"); }
}

window.completeTrade = function(btn, mode, sortieIdx, tradeIdx, originalIdx) {
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    let trade = arrRef[sortieIdx].trades[tradeIdx];

    if (trade.completed) return; 

    let fromItem = trade.fromClean;
    let toItem = trade.toClean;
    let count = trade.execC;
    let toTier = trade.toTier;
    let isBase = trade.fromTier === 0;
    let reqAmount = trade.reqA;
    let mult = trade.mult;

    let costCount = count * reqAmount; 
    let gainCount = count * mult; 

    if (!isBase && inventory[fromItem]) {
        inventory[fromItem].stock = Math.max(0, inventory[fromItem].stock - costCount);
        let fromInput = document.getElementById(`stock_${fromItem}`); if(fromInput) fromInput.value = inventory[fromItem].stock;
    }
    if (toTier !== 'mat' && toTier !== 'coin' && inventory[toItem]) {
        inventory[toItem].stock += gainCount;
        let toInput = document.getElementById(`stock_${toItem}`); if(toInput) toInput.value = inventory[toItem].stock;
    }

    const parleyInput = document.getElementById('maxParley');
    const costInput = document.getElementById('parleyPerTrade');
    const crowCostInput = document.getElementById('parleyCrow');
    
    if (parleyInput && costInput && crowCostInput) {
        let currentP = parseInt(parleyInput.value) || 0;
        let perTradeP = parseInt(costInput.value) || 0;
        let perTradeCrowP = parseInt(crowCostInput.value) || 0;
        
        let pCost = trade.isCoin ? perTradeCrowP : perTradeP;
        let totalDeduction = pCost * count;
        parleyInput.value = Math.max(0, currentP - totalDeduction);
    }

    if (originalIdx !== undefined && scannedTrades[originalIdx]) {
        scannedTrades[originalIdx].count -= count;
        if (scannedTrades[originalIdx].count <= 0) scannedTrades[originalIdx].deleted = true;
        saveScannedTradesSilent(); renderTrades(); 
    }

    saveInventoryState();
    trade.completed = true; 
    
    showToast(`✅ 교환 완료: 리스트 및 교섭력 차감됨`);

    btn.innerHTML = '✔️ 완료됨';
    btn.classList.replace('bg-green-700/80', 'bg-gray-700'); 
    btn.classList.remove('hover:bg-green-600');
    btn.classList.add('cursor-not-allowed'); btn.disabled = true;
    const card = btn.closest('.group'); if(card) card.classList.add('opacity-40', 'grayscale');
};

window.__SPEC005_SCRIPT_LOADED = window.__SPEC005_SCRIPT_LOADED || {}; /* SPEC-005 T007_EXTRA FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */
window.renderWaypointCard = function(t, mode, si, ti) {
    let wpOcean = (getIslandCoords(t.island).isOcean) ? `<span class="text-[9px] bg-blue-900 text-blue-200 px-1 rounded ml-1">대해</span>` : '';
    let matTxt = (t.consumed && t.consumed.count > 0)
        ? `<span class="text-orange-300 font-bold">${t.consumed.name} <span class="text-gray-400 font-normal">x${t.consumed.count}</span></span>`
        : `<span class="text-gray-500 italic">재료없음</span>`;
    let isComp = t.completed;
    // 타이머 상태 복구 (일반 카드와 동일 키: island + '_' + toClean(=경유지 고유 id))
    let tKey = t.island + '_' + t.toClean;
    if (window.ACTIVE_TIMERS && window.ACTIVE_TIMERS[tKey]) {
        t.timerActive = true; t.timerEnd = window.ACTIVE_TIMERS[tKey].endTime; t.alarmPlayed = window.ACTIVE_TIMERS[tKey].played;
    } else { t.timerActive = false; }
    let cardCls = isComp ? 'opacity-40 grayscale' : 'border-indigo-600/70 bg-indigo-900/15';
    let timerBtnCls = isComp ? 'hidden' : (t.timerActive ? 'bg-orange-600 hover:bg-orange-500' : 'bg-blue-600 hover:bg-blue-500');
    let timerBtnTxt = t.timerActive ? '⏱️ 취소' : '🚀 출발';
    let timerBtnAttr = isComp ? 'disabled' : `onclick="toggleTimer(this, '${mode}', ${si}, ${ti}, '${t.island}', '${t.toClean}')"`;
    let compBtnCls = isComp ? 'bg-gray-700 cursor-not-allowed' : 'bg-green-700/80 hover:bg-green-600';
    let compBtnTxt = isComp ? '완료됨' : '✔️ 완료';
    let compBtnAttr = isComp ? 'disabled' : `onclick="completeWaypoint(this, '${mode}', ${si}, ${ti})"`;
    return `<div class="relative flex items-center justify-between group route-card cursor-move p-2 rounded border ml-5 ${cardCls}"
             draggable="true" ondragstart="routeDragStart(event,${si},${ti},'${mode}')" ondragend="routeDragEnd(event)" ondragover="routeDragOver(event,${si},'${mode}')" ondragleave="routeDragLeave(event)" ondrop="routeDrop(event,${si},${ti},'${mode}')">
            <div class="absolute -left-6 w-4 h-4 rounded-full bg-indigo-800 border border-indigo-400 flex items-center justify-center text-[9px] text-white z-10">${ti+1}</div>
            <div class="flex-1 min-w-0 pr-2">
                <div class="text-xs font-bold text-white flex items-center flex-wrap gap-1">🧭 ${t.island} ${wpOcean} <span class="text-[9px] bg-indigo-600 text-white px-1 rounded ml-1">경유지</span></div>
                <div class="text-[10px] text-gray-400 mt-1">사용 재료: ${matTxt}</div>
                <div class="text-[9px] mt-1.5 flex gap-2 border-t border-gray-800 pt-1 items-center">
                    <span class="text-cyan-600 font-bold">${(t.afterW||0).toLocaleString()} LT</span><span class="text-gray-600">|</span>
                    <span>+${window.formatTimeExact(t.estT||0)} ${t.over ? '<span class="text-red-400">⚠️과적</span>' : '<span class="text-green-400">💨쾌속</span>'}</span>
                    <span id="timer_${mode}_${si}_${ti}" class="ml-auto font-mono text-[11px] font-bold ${t.timerActive ? (t.alarmPlayed ? 'text-red-400 animate-pulse' : 'text-yellow-300') : 'hidden'}">⏱️ 00:00</span>
                </div>
            </div>
            <div class="flex flex-col gap-1 shrink-0 ml-1 w-[60px]">
                <button ${timerBtnAttr} class="${timerBtnCls} text-white text-[10px] w-full py-1 rounded font-bold transition shadow-md">${timerBtnTxt}</button>
                <button ${compBtnAttr} class="${compBtnCls} text-white text-[10px] w-full py-1 rounded font-bold transition shadow-md">${compBtnTxt}</button>
                <button onclick="removeWaypoint('${mode}', ${si}, ${ti})" class="bg-red-900/50 hover:bg-red-700 text-red-200 text-[9px] w-full py-1 rounded font-bold transition" ${isComp?'disabled':''}>✕ 삭제</button>
            </div>
        </div>`;
};

window.closeWaypointModal = function() {
    let m = document.getElementById('waypointModal'); m.classList.add('hidden'); m.classList.remove('flex');
};

window.toggleWaypointMaterial = function() {
    let on = document.getElementById('wpUseMat').checked;
    let box = document.getElementById('wpMatBox');
    if (on) { box.classList.remove('hidden'); box.classList.add('flex'); }
    else { box.classList.add('hidden'); box.classList.remove('flex'); }
};

window.confirmWaypoint = function() {
    let mode = document.getElementById('wpMode').value;
    let sortieIdx = parseInt(document.getElementById('wpSortieIdx').value);
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    let sortie = arrRef[sortieIdx];
    if (!sortie) return;
    let island = document.getElementById('wpIsland').value.trim();
    if (!island) { showToast('⚠️ 들를 섬을 입력하세요.'); return; }
    if (!isValidIsland(island)) { showToast('⚠️ 존재하지 않는 섬입니다.'); return; }
    let anchorIdx = parseInt(document.getElementById('wpAnchorSelect').value);
    let pos = document.querySelector('input[name="wpPos"]:checked').value;
    let insertIdx = (pos === 'before') ? anchorIdx : anchorIdx + 1;

    let consumed = null;
    if (document.getElementById('wpUseMat').checked) {
        let nm = document.getElementById('wpMatName').value.trim();
        let cnt = parseInt(document.getElementById('wpMatCount').value) || 0;
        if (nm && cnt > 0) consumed = { name: nm, tier: getItemTier(nm), count: cnt };
    }
    let wpId = 'wp' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    let wp = { isWaypoint: true, island: island, consumed: consumed, toClean: wpId, wpId: wpId, completed: false };
    const candidate = {...sortie, trades:[...sortie.trades]};
    candidate.trades.splice(insertIdx, 0, wp);
    if (sortie.trades.slice(insertIdx).some(t => t.completed)) { showToast('완료한 교환 앞에는 경유지를 추가할 수 없습니다.'); return; }
    if (!canApplyScheduleChange(arrRef.map((s, i) => i === sortieIdx ? candidate : s), mode)) return;
    sortie.trades.splice(insertIdx, 0, wp);
    closeWaypointModal();
    window.applySortieRecompute(sortie, mode);
    showToast(`🧭 경유지 [${island}] 삽입됨`);
};

window.__SPEC005_SCRIPT_LOADED["completion.js"] = true;
