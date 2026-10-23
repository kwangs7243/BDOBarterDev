/* SPEC-005 T007_TIMER FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */
window.ACTIVE_TIMERS = window.ACTIVE_TIMERS || {};
window.toggleTimer = function(btn, mode, sortieIdx, tradeIdx, island, toClean) {
    let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
    let trade = arrRef[sortieIdx].trades[tradeIdx];
    if (trade.completed) return;

    let tKey = island + '_' + toClean;

    if (!trade.timerActive) {
        trade.timerActive = true;
        trade.timerEnd = Date.now() + (trade.estT * 60 * 1000); 
        trade.alarmPlayed = false;
        
        window.ACTIVE_TIMERS[tKey] = { endTime: trade.timerEnd, played: false };

        btn.innerHTML = '⏱️ 취소';
        btn.classList.replace('bg-blue-700', 'bg-orange-700');
        btn.classList.replace('hover:bg-blue-600', 'hover:bg-orange-600');
        
        let timerSpan = document.getElementById(`timer_${mode}_${sortieIdx}_${tradeIdx}`);
        if(timerSpan) timerSpan.classList.remove('hidden');
        
        showToast(`🚀 닻을 올렸습니다! [${trade.island}] 카운트다운 시작.`);
    } else {
        trade.timerActive = false;
        delete window.ACTIVE_TIMERS[tKey];
        
        btn.innerHTML = '🚀 출발';
        btn.classList.replace('bg-orange-700', 'bg-blue-700');
        btn.classList.replace('hover:bg-orange-600', 'hover:bg-blue-600');
        
        let timerSpan = document.getElementById(`timer_${mode}_${sortieIdx}_${tradeIdx}`);
        if(timerSpan) timerSpan.classList.add('hidden');
        
        showToast(`🛑 항해 타이머가 취소되었습니다.`);
    }
};

window.toggleReturnTimer = function(btn, mode, sortieIdx, estT) {
    let retKey = 'return_' + mode + '_' + sortieIdx;
    
    if (!window.ACTIVE_TIMERS[retKey]) {
        let endTime = Date.now() + (estT * 60 * 1000); 
        window.ACTIVE_TIMERS[retKey] = { endTime: endTime, played: false };
        
        btn.innerHTML = '⏱️ 취소';
        btn.classList.replace('bg-blue-700', 'bg-orange-700');
        btn.classList.replace('hover:bg-blue-600', 'hover:bg-orange-600');
        
        let timerSpan = document.getElementById(`timer_return_${mode}_${sortieIdx}`);
        if(timerSpan) timerSpan.classList.remove('hidden');
        
        showToast(`🏠 일리야 섬으로 귀환합니다! 카운트다운 시작.`);
    } else {
        delete window.ACTIVE_TIMERS[retKey];
        
        btn.innerHTML = '🚀 출발';
        btn.classList.replace('bg-orange-700', 'bg-blue-700');
        btn.classList.replace('hover:bg-orange-600', 'hover:bg-blue-600');
        
        let timerSpan = document.getElementById(`timer_return_${mode}_${sortieIdx}`);
        if(timerSpan) timerSpan.classList.add('hidden');
        
        showToast(`🛑 귀환 타이머가 취소되었습니다.`);
    }
};
// ⏱️ 전역 타이머 틱 (1초마다 무한 루프)
setInterval(() => {
    if (typeof sortiesSpeed === 'undefined' || typeof sortiesBalance === 'undefined') return;
    const now = Date.now();
    ['speed', 'balance'].forEach(mode => {
        let arrRef = (mode === 'speed') ? sortiesSpeed : sortiesBalance;
        if(!arrRef) return;
        arrRef.forEach((sortie, si) => {
            
            // 일반 교역 타이머
            sortie.trades.forEach((t, ti) => {
                if (t.timerActive && !t.completed) {
                    let remain = Math.max(0, t.timerEnd - now);
                    let timerSpan = document.getElementById(`timer_${mode}_${si}_${ti}`);
                    
                    if (timerSpan) {
                        let m = Math.floor(remain / 60000);
                        let s = Math.floor((remain % 60000) / 1000);
                        timerSpan.innerHTML = `⏱️ ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

                        if (remain === 0 && !t.alarmPlayed) {
                            t.alarmPlayed = true;
                            let tKey = t.island + '_' + t.toClean;
                            if (window.ACTIVE_TIMERS[tKey]) window.ACTIVE_TIMERS[tKey].played = true;
                            
                            playAlarmSound(); 
                            timerSpan.classList.add('animate-pulse', 'text-red-400');
                            timerSpan.classList.remove('text-yellow-300');
                        }
                    }
                }
            });

            // ⭐ 귀환 타이머 틱 처리
            let retKey = 'return_' + mode + '_' + si;
            if (window.ACTIVE_TIMERS && window.ACTIVE_TIMERS[retKey]) {
                let rData = window.ACTIVE_TIMERS[retKey];
                let remain = Math.max(0, rData.endTime - now);
                let timerSpan = document.getElementById(`timer_return_${mode}_${si}`);
                
                if (timerSpan) {
                    let m = Math.floor(remain / 60000);
                    let s = Math.floor((remain % 60000) / 1000);
                    timerSpan.innerHTML = `⏱️ ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

                    if (remain === 0 && !rData.played) {
                        rData.played = true;
                        playAlarmSound(); 
                        timerSpan.classList.add('animate-pulse', 'text-red-400');
                        timerSpan.classList.remove('text-yellow-300');
                    }
                }
            }

        });
    });
}, 1000);

window.__SPEC005_SCRIPT_LOADED = window.__SPEC005_SCRIPT_LOADED || {}; window.__SPEC005_SCRIPT_LOADED["timer-ui.js"] = true;
