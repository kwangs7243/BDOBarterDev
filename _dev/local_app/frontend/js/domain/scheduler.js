/* SPEC-005 T003 FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */
function schedulerNumberOrDefault(value, fallback) {
    if (value === null || value === undefined || (typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && value.trim() === '')) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function runAlgorithmAllModes(silent = false) {
    const syncVars = [
        {id: 'crow', val: APP_CONFIG.CROW_COIN_PRIORITY}, {id: 'spec', val: APP_CONFIG.SPECIAL_MAT_PRIORITY},
        {id: 'penalty', val: APP_CONFIG.OVERLOAD_PENALTY}, {id: 'speed', val: APP_CONFIG.SHIP_SPEED},
        {id: 'overTime', val: APP_CONFIG.OVERLOAD_TIME_WEIGHT}, {id: 'distPen', val: APP_CONFIG.DISTANCE_PENALTY_WEIGHT},
        {id: 'effBonus', val: APP_CONFIG.PATH_EFFICIENCY_BONUS}, {id: 'effRad', val: APP_CONFIG.EFFICIENCY_THRESHOLD},
        {id: 'effPen', val: APP_CONFIG.SMALL_TRADE_PENALTY}, {id: 'chainScore', val: APP_CONFIG.CHAIN_BONUS_SCORE},
        {id: 'chainDist', val: APP_CONFIG.CHAIN_MAX_DISTANCE}, {id: 'defBonus', val: APP_CONFIG.DEFICIT_RATIO_BONUS},
        {id: 'emgBonus', val: APP_CONFIG.EMERGENCY_BONUS}, {id: 'pitstop', val: APP_CONFIG.ILIYA_PITSTOP_RADIUS},
        {id: 'westBias', val: APP_CONFIG.WEST_BIAS}, {id: 'cluster', val: APP_CONFIG.USE_CLUSTERING}
    ];
    syncVars.forEach(v => {
        let elR = document.getElementById(`rt_${v.id}`); let elN = document.getElementById(`rt_${v.id}_num`);
        if(elR) elR.value = v.val; if(elN) elN.value = v.val;
    });
    
    for(let i=1; i<=5; i++) {
        let elT = document.getElementById(`rt_t${i}_num`);
        if(elT) elT.value = APP_CONFIG.TIER_PRIORITY[`T${i}`];
    }

    // ⭐ [신규] !t.disabled 조건을 추가하여 OFF된 항목은 스케줄 엔진에 아예 들어가지 못하게 차단!
    const invalidYieldTrades = scannedTrades.filter(t => !t.deleted && !t.disabled && (parseInt(t.count) || 0) > 0 && (!Number.isInteger(t.yield) || t.yield <= 0));
    const activeTrades = scannedTrades.map((t, i) => ({ ...t, originalIndex: i })).filter(t => (parseInt(t.count) || 0) > 0 && !t.deleted && !t.disabled && t.fromItem && t.toItem && t.island && Number.isInteger(t.yield) && t.yield > 0);
    const missingWeights = activeTrades.filter(t => [t.fromItem, t.toItem].some(name => !Number.isFinite(getItemWeight(getItemTier(name), name))));
    const vTrades = activeTrades.filter(t => !missingWeights.includes(t));
    if (missingWeights.length && !silent) alert(`개당 무게가 등록되지 않은 교환 ${missingWeights.length}건은 스케줄에서 보류했습니다.\n${missingWeights.map(t => t.fromItem + ' → ' + t.toItem).join('\n')}`);
    
    // ⭐ [생성 실패 진단 가드] 스케줄이 안 만들어지는 원인을 사용자에게 구체적으로 안내
    if (!silent) {
        const _activeTrades = scannedTrades.filter(t => !t.deleted);
        const _maxP   = parseInt(document.getElementById('maxParley')?.value)     || 0;
        const _normW  = Number(document.getElementById('normalWeight')?.value)  || 0;
        const _maxW   = Number(document.getElementById('maxWeight')?.value)     || 0;
        const _perP = Math.min(...vTrades.map(t => getItemTier(t.toItem) === 'coin' ? APP_CONFIG.CROW_PARLEY : APP_CONFIG.PARLEY_PER_TRADE).filter(cost => cost > 0));

        if (invalidYieldTrades.length > 0) {
            alert(`⚠️ 수율이 없거나 올바른 양의 정수가 아닌 교환 ${invalidYieldTrades.length}건은 계산에서 보류했습니다.\n\n교환 목록의 수율을 확인해 주세요.`);
        }

        // (1) 교환 리스트 자체가 텅 빔 — 가장 흔한 케이스 (창고 스캔과 혼동)
        if (_activeTrades.length === 0) {
            alert("📋 교환 리스트가 비어 있습니다.\n\n스케줄을 만들려면 먼저 '물물교환 리스트'가 있어야 합니다.\n\n  ▸ 인게임 물물교환 목록을 캡처해 [물교 리스트 스캔]으로 인식시키거나\n  ▸ 표에 직접 교환을 추가해 주세요.\n\n※ 주의: '창고 재고 스캔'은 교환 리스트가 아니라 '보유 재고'를 채우는 기능입니다.\n   교환 목록 캡처를 창고 스캔에 넣으면 교환 리스트는 비어 있게 됩니다. 둘은 별개입니다.");
            return false;
        }
        // (2) 교환은 있는데 전부 비활성/0회/정보누락이라 유효 교환이 0
        if (vTrades.length === 0) {
            const _offCnt = _activeTrades.filter(t => t.disabled).length;
            const _zeroCnt = _activeTrades.filter(t => (parseInt(t.count)||0) <= 0).length;
            let _why = "";
            if (_offCnt > 0)  _why += `\n  • 비활성(OFF) 상태: ${_offCnt}건 → 켜 주세요.`;
            if (_zeroCnt > 0) _why += `\n  • 교환 횟수가 0: ${_zeroCnt}건 → 횟수를 1 이상으로.`;
            if (!_why) _why = "\n  • 섬·교환 아이템 정보가 비어 있는 항목이 있습니다.";
            alert("⚠️ 입력된 교환은 있지만, 스케줄에 쓸 수 있는 유효한 교환이 없습니다." + _why);
            return false;
        }
        // (3) 교섭력 미입력/0 — 출항을 한 번도 못 돎
        if (_maxP <= 0) {
            alert("⚖️ 현재 교섭력이 0 입니다.\n\n좌측 상단 '현재 교섭' 칸에 보유 교섭력을 입력해 주세요.\n교섭력이 있어야 교환을 진행할 수 있습니다.");
            return false;
        }
        // (4) 교섭력이 1회 교환 비용 이하 — 사실상 스케줄을 짤 만큼 교환 불가
        if (Number.isFinite(_perP) && _maxP < _perP) {
            alert(`⚖️ 교섭력이 부족합니다.\n\n현재 교섭력(${_maxP.toLocaleString()})이 1회 교환 비용(${_perP.toLocaleString()})보다 적습니다.\n\n교섭력을 더 채우거나, 교환 1회 비용 설정을 확인해 주세요.`);
            return false;
        }
        // (5) 무게 한계 미입력/0 — 짐을 실을 수 없음
        if (_normW <= 0 || _maxW <= 0) {
            alert("⚖️ 적재 무게 한계가 설정되지 않았습니다.\n\n'100%(과적)'과 '170%(한계)' 무게 칸에 본인 배의 적재량을 입력해 주세요.\n0이면 짐을 실을 수 없어 스케줄이 만들어지지 않습니다.");
            return false;
        }
    }
    if (vTrades.length === 0) { return false; } // silent 모드 안전망 (alert 없이 조용히 종료)

    const allowOcean = APP_CONFIG.ALLOW_OCEAN; 

    // ⭐ [V12.40 핵심] 전-티어 캐스케이딩(Cascading) 수요 예측 엔진 (연쇄 목표 상향)
    // 1. 기본 데이터 1차 매핑 (점수 계산 전 단계)
    let baseTrades = vTrades.map(t => {
        let toClean = t.toItem.replace(/\[.*?\]\s*/g, '').replace(/\s*x\s*\d+/gi, '').trim();
        let fromClean = t.fromItem.replace(/\[.*?\]\s*/g, '').replace(/\s*x\s*\d+/gi, '').trim();
        
        let toTier = getItemTier(toClean); let fromTier = getItemTier(fromClean);
        let mult = t.yield; let reqA = 1; 
        
        let effectiveCount = t.count;
        let __isRandomCoin = false; // 화이트리스트 밖 4회 까주(랜덤 발생) 플래그
        if (toTier === 'coin') {
            // 까주 횟수는 섬 기반 분류: 화이트리스트(명시 4섬 + 마고리아/isOcean)=1회, 그 외=4회
            const CROW_1X_ISLANDS = ['까마귀의 둥지','더코 섬','카슈마 섬','할마드 섬'];
            const _isl = (t.island || '').trim();
            let _isOceanIsle = false;
            try {
                const _c = (typeof getIslandCoords === 'function') ? getIslandCoords(_isl) : null;
                _isOceanIsle = !!(_c && _c.isOcean);
            } catch (e) {}
            const _is1x = CROW_1X_ISLANDS.includes(_isl) || _isOceanIsle;
            __isRandomCoin = !_is1x; // 화이트리스트 밖 = 4회 랜덤 까주
        }

        if (toTier === 2) { reqA = APP_CONFIG.TRADE_RULES.T2.req; }
        else if (toTier === 3) { reqA = APP_CONFIG.TRADE_RULES.T3.req; }
        else if (toTier === 4) { reqA = APP_CONFIG.TRADE_RULES.T4.req; }
        else if (toTier === 5 || toTier === 'mat') { reqA = APP_CONFIG.TRADE_RULES.T5.req; }
        else if (toTier === 6 || toTier === 7 || toTier === 'coin') { reqA = 1; }
        
        if (fromTier === 0) { reqA = t.reqAmount || 1; }
        
        let fw = effectiveCount * reqA * getItemWeight(fromTier, fromClean);
        let tw = (effectiveCount * mult * getItemWeight(toTier, toClean));
        let isSpec = (toTier === 'mat'); let isCoin = (toTier === 'coin');

        return { ...t, count: effectiveCount, toClean, fromClean, toTier, fromTier, tt: toTier, ft: fromTier, mult, reqA, origC: effectiveCount, currentC: effectiveCount, fw, tw, isSpec, isCoin, isRandomCoin: __isRandomCoin };
    });

    // 2. 동적 목표치(Target) 및 가상 재고 시뮬레이션
    let dynamicTargets = {};
    let projectedStock = {};
    let projectedProduction = {};
    const projectedExecutions = new Map();
    for (let key in inventory) { 
        dynamicTargets[key] = inventory[key].target || 0; 
        projectedStock[key] = inventory[key].stock || 0; 
        projectedProduction[key] = 0;
    }

    // Check source availability against stock above its reserve plus feasible lower-tier production.
    // This is a projection-only allocation pool; final sorting and supplier ranking remain unchanged.
    const projectedSourceReserve = (trade) => {
        const tier = trade.fromTier;
        let reserve = 0;
        if (tier === 'mat' || tier === 5 || tier === 'coin') reserve = schedulerNumberOrDefault(tierRules[5], 1);
        else if (tier >= 1 && tier <= 4) reserve = schedulerNumberOrDefault(tierRules[tier], 20);
        if (trade.isSpec || trade.isRandomCoin) {
            const sourceStock = Number(inventory[trade.fromClean]?.stock) || 0;
            if (sourceStock >= reserve || (APP_CONFIG.SPECIAL_MAT_PRIORITY || 0) >= 140000) reserve = 0;
            else return null;
        }
        if (trade.isCoin && APP_CONFIG.CROW_COIN_PRIORITY >= 50000) reserve = 0;
        return reserve;
    };
    const projectedSourceQuantity = (itemName, sourceTrade, pool, visited = new Set(), requested = Infinity) => {
        if (sourceTrade.fromTier === 0) return Infinity;
        const reserve = projectedSourceReserve(sourceTrade);
        if (reserve === null) return 0;
        const baseStock = Number(inventory[itemName]?.stock) || 0;
        const startingUsable = Math.max(0, baseStock - reserve);
        const available = () => Math.max(0, startingUsable + (projectedProduction[itemName] || 0)
            + (pool.generated[itemName] || 0) - (pool.consumed[itemName] || 0));
        if (visited.has(itemName)) return available();

        const path = new Set(visited);
        path.add(itemName);
        let total = available();
        if (total >= requested) return total;
        const suppliers = baseTrades.filter(candidate => candidate.toClean === itemName);
        for (const supplier of suppliers) {
            const remainingCount = Math.max(0, supplier.currentC - (projectedExecutions.get(supplier) || 0)
                - (pool.remaining.get(supplier) || 0));
            if (remainingCount <= 0 || supplier.mult <= 0) continue;
            const needed = Math.max(0, requested - total);
            const maxByNeed = Math.ceil(needed / supplier.mult);
            const maxTry = Math.min(remainingCount, maxByNeed);
            const sourceAvailable = projectedSourceQuantity(supplier.fromClean, supplier, pool, path, maxTry * supplier.reqA);
            const executable = Math.min(maxTry, Math.floor(sourceAvailable / supplier.reqA));
            if (executable <= 0) continue;
            if (supplier.fromTier !== 0) {
                pool.consumed[supplier.fromClean] = (pool.consumed[supplier.fromClean] || 0) + executable * supplier.reqA;
            }
            pool.remaining.set(supplier, (pool.remaining.get(supplier) || 0) + executable);
            pool.generated[itemName] = (pool.generated[itemName] || 0) + executable * supplier.mult;
            total = available();
            if (total >= requested) break;
        }
        return total;
    };
    const hasProjectedSource = (trade, executions) => {
        if (trade.fromTier === 0) return true;
        const pool = { generated: {}, consumed: {}, remaining: new Map() };
        const available = projectedSourceQuantity(trade.fromClean, trade, pool, new Set(), executions * trade.reqA);
        return available >= executions * trade.reqA;
    };

    let activeT67Regions = [];
    if (allowOcean === 't7_3region') activeT67Regions = ["하코번 섬", "아레하자 마을", "하코번", "아레하자", "해모 섬", "달래나루", "해모", "그란디하", "깊은 밤의 항구", "깊은 밤"];
    else if (allowOcean === 't7_2region') activeT67Regions = ["하코번 섬", "아레하자 마을", "하코번", "아레하자", "해모 섬", "달래나루", "해모"];
    else if (allowOcean === 't7_2region_south') activeT67Regions = ["하코번 섬", "아레하자 마을", "하코번", "아레하자", "그란디하", "깊은 밤의 항구", "깊은 밤"];
    else if (allowOcean === 't7_2region_arehazaX') activeT67Regions = ["해모 섬", "달래나루", "해모", "그란디하", "깊은 밤의 항구", "깊은 밤"];

    // 최상위 티어부터 역순으로 수요(Consumption)를 전파
    const evaluationOrder = [7, 6, 'coin', 'mat', 5, 4, 3, 2, 1];
    
    evaluationOrder.forEach(tier => {
        let tradesInTier = baseTrades.filter(t => t.toTier === tier);
        tradesInTier.forEach(t => {
            let willExecute = 0;

            if (tier === 6 || tier === 7) {
                if (activeT67Regions.includes(t.island)) willExecute = t.currentC;
            } else if (tier === 'coin' || tier === 'mat') {
                willExecute = t.currentC;
            } else {
                let currentInv = projectedStock[t.toClean] || 0;
                let target = dynamicTargets[t.toClean] || 0;
                let lack = target - currentInv;
                if (lack > 0) {
                    let neededExecutions = Math.ceil(lack / t.mult);
                    willExecute = Math.min(t.currentC, neededExecutions);
                }
            }

            while (willExecute > 0 && !hasProjectedSource(t, willExecute)) willExecute--;
            if (willExecute > 0 && t.toTier !== 6 && t.toTier !== 7 && t.toTier !== 'coin' && t.toTier !== 'mat') {
                const produced = willExecute * t.mult;
                projectedStock[t.toClean] = (projectedStock[t.toClean] || 0) + produced;
                projectedProduction[t.toClean] = (projectedProduction[t.toClean] || 0) + produced;
            }

            if (willExecute > 0 && t.fromTier !== 0) {
                // 상위 티어 생산을 위해 하위 티어가 소모되므로, 하위 티어의 "목표치"를 강제로 펌핑!
                let consumption = willExecute * t.reqA;
                dynamicTargets[t.fromClean] = (dynamicTargets[t.fromClean] || 0) + consumption;
            }
            if (willExecute > 0) projectedExecutions.set(t, (projectedExecutions.get(t) || 0) + willExecute);
        });
    });

    // 3. 예측된 동적 목표치(dynamicTargets)를 바탕으로 최종 점수 계산
    let preparedTrades = baseTrades.map(t => {
        let score = 0; let lack = 0; let isUrgent = false;
        let toInv = inventory[t.toClean];
        let currentStock = toInv ? toInv.stock : 0;
        
        let effectiveTarget = dynamicTargets[t.toClean] || 0; 
        let baseTarget = toInv ? toInv.target : 0;
        let isDemanded = effectiveTarget > baseTarget; 
        
        if (t.toTier === 6 || t.toTier === 7) {
            score = 999999; lack = 99; 
        } else if (t.isSpec || t.isRandomCoin) {
            // ⭐ [신규] 특수 재료 + 4회 랜덤 까주: 집착도 슬라이더 기반 1/2/3순위 고정 우선순위 (결핍 계산 없음)
            let specBase = APP_CONFIG.SPECIAL_MAT_PRIORITY || 80000;
            if (specBase >= 140000) {
                score = 500000 + specBase; // 🥇 1순위 (긴급 보존보다 최우선)
                isUrgent = true;
            } else if (specBase >= 50000) {
                score = 100000 + specBase; // 🥈 2순위 (일반 결핍 재료보다 우선)
                isUrgent = false;
            } else {
                score = 10000 + specBase;  // 🥉 3순위 (잉여 줍줍보다만 우선)
                isUrgent = false;
            }
            lack = 99; 
        } else if (t.isCoin) {
            score = APP_CONFIG.CROW_COIN_PRIORITY + (t.currentC * t.mult * 2); lack = 99;
        } else {
            lack = effectiveTarget - currentStock;
            
            // ⭐ [V12.70 완벽 픽스] 대기실 잉여 파밍 가위질 (5단 완벽 보호)
            // 5단은 여기서 건드리지 않습니다! 잔여 엔진이 나중에 알아서 판단하게 둡니다.
            if (lack <= 0 && t.fromTier >= 1 && t.fromTier <= 3 && t.toTier !== 5) {
                let fromInv = inventory[t.fromClean];
                let fromTarget = fromInv ? fromInv.target : 0;
                let fromStock = fromInv ? fromInv.stock : 0;
                let surplusFrom = fromStock - fromTarget;

                if (surplusFrom <= 0) {
                    t.currentC = 0;
                } else {
                    let allowedCount = Math.floor(surplusFrom / t.reqA);
                    // ⭐ 잉여 줍줍은 3회 미만이면 빌드에서 스킵(자잘한 1~2개 쪼갬 방지). 생성 후 카드 ▼▲ 수동조정은 별개라 그대로 동작.
                    if (allowedCount < 3) t.currentC = 0;
                    else t.currentC = Math.min(t.currentC, allowedCount);
                }
                t.origC = t.currentC; 
                t.count = t.currentC; 
            }

            // 점수 초기 부여 (여기서 5단은 무사히 살아남아 높은 점수를 받습니다)
            if (lack > 0 || t.toTier === 5) {
                let actualLack = lack > 0 ? lack : (effectiveTarget - currentStock); // 5단용 보정
                if (actualLack <= 0) actualLack = 1; // 5단 예비 방어

                score = actualLack * 100; 
                let targetAmt = effectiveTarget > 0 ? effectiveTarget : Math.max(1, actualLack);
                let lackRatio = actualLack / targetAmt;
                score += Math.floor(lackRatio * (APP_CONFIG.DEFICIT_RATIO_BONUS || 3000));

                if (t.toTier === 1) score += APP_CONFIG.TIER_PRIORITY.T1;
                else if (t.toTier === 2) score += APP_CONFIG.TIER_PRIORITY.T2;
                else if (t.toTier === 3) score += APP_CONFIG.TIER_PRIORITY.T3;
                else if (t.toTier === 4) score += APP_CONFIG.TIER_PRIORITY.T4;
                else if (t.toTier === 5) score += APP_CONFIG.TIER_PRIORITY.T5;

                if (t.toTier >= 1 && t.toTier <= 4 && (currentStock <= schedulerNumberOrDefault(tierRules[t.toTier], 20) || isDemanded)) {
                    score += (APP_CONFIG.PRESERVATION_BONUS || 3000) + (isDemanded ? 10000 : 0);
                    isUrgent = true;
                }
                if (t.toTier === 5 && (currentStock < schedulerNumberOrDefault(tierRules[5], 1) || isDemanded)) {
                    score += (APP_CONFIG.EMERGENCY_BONUS || 5000);
                    isUrgent = true;
                }
            } else { 
                score = -999999; 
            }
        }
        
        return { ...t, score, lack, isUrgent, completed: false, dynamicTarget: effectiveTarget, isDemanded };
    });

// 2. 권역 및 점수 기반 1차 필터링
    const validTrades = preparedTrades.filter(t => {
        // ⭐ [V12.50] 스위치 가동을 위해 목표 달성한 잉여 노드(-999999점)도 대기실 통과시킴!
        // (기존의 t.score <= 0 필터 완전 삭제)
        
        // 👇 여기에 t7_2region_south 추가
        let isT7Mode = (APP_CONFIG.ALLOW_OCEAN === 't7_2region' || APP_CONFIG.ALLOW_OCEAN === 't7_3region' || APP_CONFIG.ALLOW_OCEAN === 't7_2region_south' || APP_CONFIG.ALLOW_OCEAN === 't7_2region_arehazaX');
        if (!isT7Mode && (t.toTier >= 6 || t.fromTier >= 6)) return false;

        let islandInfo = getIslandCoords(t.island);
        if (allowOcean === 'none' && t.isCoin) return false;
        
        if (!isT7Mode && allowOcean !== 'ocean') {
            if (islandInfo.isOcean) return false;
        }
        return true;
    });

    if(validTrades.length === 0) { if(!silent) alert("탐색 가능한 노드가 없습니다. (대해 탐색 허용 여부를 확인하세요!)"); return false; }

    // 3. 7단 하이브리드 엔진 분기
    // 👇 여기에도 t7_2region_south 추가
    const previousSpeed = sortiesSpeed;
    const previousBalance = sortiesBalance;
    const previousDebug = window.ENGINE_DEBUG;
    const previousLastGen = window.__lastGen;
    let nextSpeed;
    let nextBalance;
    try {
        // buildSorties records per-mode diagnostics globally; stage them until both modes validate.
        window.ENGINE_DEBUG = { ...(previousDebug || {}) };
        if (allowOcean === 't7_2region' || allowOcean === 't7_3region' || allowOcean === 't7_2region_south' || allowOcean === 't7_2region_arehazaX') {
            nextSpeed = buildTier7Sorties(validTrades, allowOcean, 'speed').sorties;
            nextBalance = buildTier7Sorties(validTrades, allowOcean, 'balance').sorties;
        } else {
            nextSpeed = buildSorties(validTrades, 'speed');
            nextBalance = buildSorties(validTrades, 'balance');
        }

        // 🎴 Display-only merge of adjacent identical trades; engine decisions remain unchanged.
        try {
            let __mNormW = Number(document.getElementById('normalWeight').value) || 14379;
            if (window.mergeAdjacentDupTrades) { window.mergeAdjacentDupTrades(nextSpeed, __mNormW); window.mergeAdjacentDupTrades(nextBalance, __mNormW); }
        } catch(_) {}

        sortiesSpeed = nextSpeed;
        sortiesBalance = nextBalance;
        renderModeColumn('col-speed', sortiesSpeed, 'speed');
        renderModeColumn('col-balance', sortiesBalance, 'balance');
        try { window.__lastGen = { time: new Date().toLocaleString(), speed: (sortiesSpeed || []).length, balance: (sortiesBalance || []).length }; } catch(_) {}
        openModal();
        if (typeof updateGridAndCircles === 'function') updateGridAndCircles();
    } catch (error) {
        sortiesSpeed = previousSpeed;
        sortiesBalance = previousBalance;
        window.ENGINE_DEBUG = previousDebug;
        window.__lastGen = previousLastGen;
        throw error;
    }
    return true;
}

function buildSorties(trades, mode) {
    let remaining = trades.map(t => ({...t})); 
    let sorties = [];
    
    const getSafeVal = (id, def) => { const el = document.getElementById(id); return el ? Number(el.value) : def; };
    let normW = getSafeVal('normalWeight', 14379); 
    let maxW = getSafeVal('maxWeight', 24445); 
    let maxP = getSafeVal('maxParley', 1250000);
    let perTradeP = getSafeVal('parleyPerTrade', 10973); 
    let perTradeCrowP = getSafeVal('parleyCrow', 20000); 

    // ⭐ [수정 2] 대시보드 및 JSON 설정 파일(APP_CONFIG)에서 섬세한 튜닝 변수들을 모두 불러옵니다.
    let t_crow = parseInt(APP_CONFIG.tuneCrow) || 30000;
    let t_spec = parseInt(APP_CONFIG.tuneSpec) || 21000;
    let t_def = parseInt(APP_CONFIG.tuneDeficit) || 10000;
    let t_emg = parseInt(APP_CONFIG.tuneEmergency) || 10000;
    let t_pres = parseInt(APP_CONFIG.tunePreservation) || 10000;
    let t_distPen = schedulerNumberOrDefault(APP_CONFIG.DISTANCE_PENALTY_WEIGHT, 4);
    let t_pathEff = schedulerNumberOrDefault(APP_CONFIG.PATH_EFFICIENCY_BONUS, 15000);

    // 👇 [여기에 이 한 줄을 추가해 줍니다! (전역 스위치 역할)]
    let isT7Mode = (APP_CONFIG.ALLOW_OCEAN === 't7_2region' || APP_CONFIG.ALLOW_OCEAN === 't7_3region' || APP_CONFIG.ALLOW_OCEAN === 't7_2region_south' || APP_CONFIG.ALLOW_OCEAN === 't7_2region_arehazaX');

    const arrangeOceanAndInbounds = (tradesArr) => {
        let oceans = []; let inbounds = []; let jitSuppliers = [];
        
        // 1. 대양 노드와 내해 노드 분리
        tradesArr.forEach(t => {
            let tc = getIslandCoords(t.island) || {x:0, y:0};
            let isRealO = (APP_CONFIG.ALLOW_OCEAN === 'ocean' && tc.isOcean);
            if (isRealO || t.isCoin) oceans.push(t);
            else inbounds.push(t);
        });

       // 2. ⭐ [핵심 픽스] 내해 노드 중에서 대양 노드에 재료를 바치는 'JIT 공급자' 색출!
        let normalInbounds = [];
        inbounds.forEach(t => {
            // ⭐ [과적 버그 완벽 차단] 엔진이 계산한 정확한 분량(isJit 꼬리표)만 앞으로 빼고, 나머지 잉여 파밍은 무조건 귀환길에 줍게 만듭니다!
            if (t.isJit) jitSuppliers.push(t);
            else normalInbounds.push(t);
        });

        // 3. 동선 조립: [JIT 공급자 먼저!] ➔ [대양 본대] 순서로 결합
        let outbounds = [];
        if (jitSuppliers.length > 0) outbounds.push(...optimizeRouteTSP(jitSuppliers));
        if (oceans.length > 0) outbounds.push(...oceans);

        // 4. 나머지 잉여 내해 노드들은 귀환길(TSP)로 정렬
        let lastPos = outbounds.length > 0 ? (getIslandCoords(outbounds[outbounds.length-1].island)||{x:0,y:0}) : {x:0,y:0};
        let sortedIn = []; let unv = [...normalInbounds]; let genCargo = {};

        outbounds.forEach(t => { genCargo[t.toClean] = (genCargo[t.toClean] || 0) + (t.execC * t.mult); });

        while(unv.length > 0) {
            let bestI = -1; let minD = Infinity;
            for(let j=0; j<unv.length; j++) {
                let cand = unv[j];
                if(cand.isChained) {
                    let req = cand.execC * cand.reqA;
                    if((genCargo[cand.fromClean]||0) < req) continue;
                }
                let c = getIslandCoords(cand.island)||{x:0,y:0};
                let d = Math.pow(c.x - lastPos.x, 2) + Math.pow(c.y - lastPos.y, 2);
                if(d < minD) { minD = d; bestI = j; }
            }
            if(bestI === -1) bestI = 0; 
            let picked = unv[bestI];
            sortedIn.push(picked);
            lastPos = getIslandCoords(picked.island)||{x:0,y:0};
            genCargo[picked.toClean] = (genCargo[picked.toClean] || 0) + (picked.execC * picked.mult);
            unv.splice(bestI, 1);
        }
        return [...outbounds, ...sortedIn];
    };
    
    let usedP = 0;
    let allowSurplus = false; 

    while (remaining.length > 0) {
        let globalUsedWarehouseStock = {}, globalGeneratedWarehouseStock = {};
        sorties.forEach(sortie => {
            sortie.trades.forEach(t => {
                if (!t.isChained && t.fromTier !== 0) {
                    globalUsedWarehouseStock[t.fromClean] = (globalUsedWarehouseStock[t.fromClean] || 0) + (t.execC * t.reqA);
                } else if (t.isChained) {
                    globalGeneratedWarehouseStock[t.fromClean] = (globalGeneratedWarehouseStock[t.fromClean] || 0) - t.execC * t.reqA;
                }
                globalGeneratedWarehouseStock[t.toClean] = (globalGeneratedWarehouseStock[t.toClean] || 0) + (t.execC * t.mult);
            });
        });

        remaining.forEach(t => {
            if (t.toTier >= 6 || t.toTier === 'coin' || t.toTier === 'mat') return;

            let toInv = inventory[t.toClean];
            let baseStock = toInv ? toInv.stock : 0;
            let used = globalUsedWarehouseStock[t.toClean] || 0;
            let gained = globalGeneratedWarehouseStock[t.toClean] || 0;

            let currentVirtualStock = baseStock - used + gained;
            
            // ⭐ [버그 픽스 1] dynamicTarget을 쓰면 수요 이중 계산(Double Dipping)이 발생하여 목표치를 초과합니다!
            // 이미 위에서 used(-5)를 빼서 currentVirtualStock(20)을 낮췄으므로, 목표치는 순수하게 toInv.target(25)을 써야 정확히 빈자리(5개)만 채웁니다.
            let effectiveTarget = toInv ? toInv.target : 0; 
            
            let lack = effectiveTarget - currentVirtualStock;
            
            // 대시보드 티어 가중치
            let basePrio = 0;
            if (t.toTier === 1) basePrio = schedulerNumberOrDefault(APP_CONFIG.TIER_PRIORITY.T1, 5000);
            else if (t.toTier === 2) basePrio = schedulerNumberOrDefault(APP_CONFIG.TIER_PRIORITY.T2, 1000);
            else if (t.toTier === 3) basePrio = schedulerNumberOrDefault(APP_CONFIG.TIER_PRIORITY.T3, 1000);
            else if (t.toTier === 4) basePrio = schedulerNumberOrDefault(APP_CONFIG.TIER_PRIORITY.T4, 2000);
            else if (t.toTier === 5) basePrio = schedulerNumberOrDefault(APP_CONFIG.TIER_PRIORITY.T5, 8000);

            let minReserve = schedulerNumberOrDefault(tierRules[t.toTier], t.toTier === 5 ? 1 : 20);

           // [안전장치]
            let p_def = typeof t_def !== 'undefined' ? t_def : 10000;
            let p_pres = typeof t_pres !== 'undefined' ? t_pres : 10000;
            let p_emg = typeof t_emg !== 'undefined' ? t_emg : 10000;

          

            // ⭐ [블랙박스 수집 1] 이 항목의 점수 산출 수식을 기록합니다.
            t.debugMath = "";

            // ⭐ [수정 3] 넘사벽 점수(Tier Wall)로 자릿수를 나눈 '재고량 기반 3단계 규칙' 적용
            if (t.toTier === 5 && isT7Mode) {
                if (lack > 0 || currentVirtualStock <= minReserve) {
                    t.score = 2000000 + basePrio;
                    t.debugMath = `2,000,000(5단 1순위) + ${basePrio}(티어)`;
                    t.isUrgent = true; t.isWeak = false;
                } else {
                    t.score = -999999; 
                    t.debugMath = `-999,999(5단 잉여 락업)`;
                    t.isUrgent = false; t.isWeak = true;
                }
                t.lack = lack > 0 ? lack : 0;
            } else if (currentVirtualStock <= minReserve) {
                t.score = 500000 + p_pres + p_emg + basePrio;
                t.debugMath = `500,000(보존위험) + ${p_pres + p_emg}(긴급) + ${basePrio}(티어)`;
                t.isUrgent = true; t.isWeak = false;
                t.lack = lack > 0 ? lack : 0;
            } else if (lack > 0) {
                t.score = 100000 + (lack * (p_def / 10)) + basePrio;
                t.debugMath = `100,000(결핍) + ${Math.floor(lack * (p_def / 10))}(부족량비례) + ${basePrio}(티어)`;
                t.isUrgent = false; t.isWeak = false;
                t.lack = lack;
            } else {
                if (!isT7Mode && t.toTier === 5 && !allowSurplus) {
                    t.score = -999999; 
                    t.debugMath = `-999,999(5단 잉여 락업)`;
                } else if (APP_CONFIG.EXCLUDE_SURPLUS && APP_CONFIG.EXCLUDE_SURPLUS[`T${t.toTier}`]) {
                    // ⭐ [신규] 대시보드에서 해당 티어 '잉여 제외' 체크 시, 합승 후보(2군) 영구 탈락 처리!
                    t.score = -999999; 
                    t.debugMath = `-999,999(${t.toTier}단 잉여 영구 차단)`;
                } else {
                    let overCount = Math.abs(lack);
                    let islandCoords = getIslandCoords(t.island) || {x:0, y:0};
                    let distFromIliya = Math.sqrt(islandCoords.x**2 + islandCoords.y**2);
                    
                    if (!allowSurplus) {
                        let distScore = Math.floor(Math.max(0, 50 - (distFromIliya * 0.05))); 
                        let overScore = Math.max(0, 50 - (overCount * 5));                    
                        let tierScore = Math.floor(basePrio / 100);                           
                        
                        t.score = 10 + overScore + distScore + tierScore; 
                        t.debugMath = `10(기본) + ${overScore}(재고상쇄) + ${distScore}(거리) + ${tierScore}(티어)`;
                    } else {
                        let distScore = Math.floor(Math.max(0, 500 - (distFromIliya * 0.5)));
                        let tierScore = Math.floor(basePrio / 10);
                        let overScore = 10000 - (overCount * 50);
                        
                        t.score = Math.max(10, overScore + distScore + tierScore); 
                        t.debugMath = `${overScore}(잉여) + ${distScore}(거리) + ${tierScore}(티어)`;
                    }
                }
                t.isUrgent = false; t.isWeak = true; t.lack = 0;
            }
        }); // <-- 이 괄호는 원래 있던 괄호입니다.

        // ⭐ [블랙박스 수집 2] 숨김 처리 풀고, 전체 리스트 및 수식(math)을 스냅샷으로 저장합니다.
        if (!window.ENGINE_DEBUG) window.ENGINE_DEBUG = {};
        if (sorties.length === 0) {
            let initLogs = []; let seen = new Set();
            remaining.sort((a,b) => b.score - a.score).forEach(t => {
                if(!seen.has(t.toClean) && t.toTier !== 'coin' && t.toTier !== 'mat') {
                    seen.add(t.toClean);
                    initLogs.push({
                        name: t.toClean, tier: t.toTier, lack: t.lack, 
                        score: t.score, math: t.debugMath, island: t.island
                    });
                }
            });
            window.ENGINE_DEBUG[mode] = { initialScores: initLogs };
        }

        let currentValidRemaining = remaining.filter(t => t.score > 0 && t.currentC > 0);

        // ⭐ [Step 2] 1군/2군 바운더리 커트라인 긋기 (교섭력 기준)
        let availableParley = maxP - usedP; 
        let accParley = 0;
        
        // ⭐ [까주/5단VIP 보호 픽스] 까주, 특수재료, 5단 VIP를 1순위로 최상단에 올리고, 그 다음 점수순 정렬!
        currentValidRemaining.sort((a, b) => {
            let aIsVIP = a.isCoin || a.isSpec || (a.toTier === 5 && a.isUrgent);
            let bIsVIP = b.isCoin || b.isSpec || (b.toTier === 5 && b.isUrgent);
            if (aIsVIP !== bIsVIP) return bIsVIP ? 1 : -1;
            return b.score - a.score;
        });
        
        currentValidRemaining.forEach(t => {
            let pCostPerTrade = t.isCoin ? perTradeCrowP : perTradeP;
            let totalCost = t.currentC * pCostPerTrade;
            
            // 까주/특수/5단 VIP는 예산 무시하고 무조건 1군(프리패스) 발급!
            let isVIP = t.isCoin || t.isSpec || (t.toTier === 5 && t.isUrgent);
            if (isVIP || accParley + totalCost <= availableParley) {
                t.boundary = 1; 
                if (!isVIP) accParley += totalCost; // 일반 재료일 때만 예산에서 차감
            } else {
                t.boundary = 2; // 예산 밖이면 2군(후보 바운더리)
            }
        });

        // Seed probes and real candidates use the same reserve, cargo, parley and weight rules.
        const materialAvailability = (cand, plannedTrades, cargo) => {
            let reserve = 0; let ft = cand.fromTier;
            if (ft === 'mat' || ft === 5 || ft === 'coin') reserve = schedulerNumberOrDefault(tierRules[5], 1);
            else if (ft >= 1 && ft <= 4) reserve = schedulerNumberOrDefault(tierRules[ft], 20);

            // ⭐ [뭉태기 교환] 특수재료·4회 랜덤까주: 목표선 무시. 교환 전 재고 ≥ reserve면 reserve 무시하고 뭉태기(횟수대로),
            //    재고 < reserve면 이 출항엔 스킵. 집착도 140000↑이면 reserve 무시(무조건 실행). "되는 만큼 부분교환" 없음(물리 재료 한계만 별도).
            if (cand.isSpec || cand.isRandomCoin) {
                let _bulkStock = inventory[cand.fromClean] ? inventory[cand.fromClean].stock : 0;
                if (_bulkStock >= reserve || (APP_CONFIG.SPECIAL_MAT_PRIORITY || 0) >= 140000) { reserve = 0; }
                else return { maxByMat: 0, blocked: true }; // 시작부터 최소선(reserve) 아래 → 스킵 (빈 출항 시 @3649 가드가 종료 처리)
            }

            if (cand.isCoin && APP_CONFIG.CROW_COIN_PRIORITY >= 50000) reserve = 0;
            if (cand.toTier === 5 && (cand.isUrgent || cand.isConsumedByT7)) reserve = 0;

            let baseStock = inventory[cand.fromClean] ? inventory[cand.fromClean].stock : 0;
            let used = globalUsedWarehouseStock[cand.fromClean] || 0;
            let gained = globalGeneratedWarehouseStock[cand.fromClean] || 0;
            // 기존 재고가 보존선 미만이면 새 생산분으로 부족분부터 채운 뒤 남는 수량만 사용합니다.
            let realWStock = Math.max(0, baseStock - used + gained - reserve);
            let currentSortieUsed = plannedTrades.reduce((sum, planned) => {
                if (!planned.isChained && planned.fromClean === cand.fromClean) {
                    return sum + (planned.execC * planned.reqA);
                }
                return sum;
            }, 0);

            let availableMat = (ft === 0) ? Infinity : (Math.max(0, realWStock - currentSortieUsed) + (cargo[cand.fromClean] || 0));

            let maxByMat = (ft === 0) ? cand.currentC : Math.floor(availableMat / cand.reqA);
            return { maxByMat, blocked: false };
        };
        const executableCount = (cand, execCount, plannedTrades, cargo, plannedParley, zone, reservedParley, isJitSupplier = false) => {
            let pCost = cand.isCoin ? perTradeCrowP : perTradeP;
            let isCandVIP = cand.toTier === 5 && (cand.isUrgent || cand.isConsumedByT7);
            let possibleK = 0; let tempSimTime = 0;
            let wLimit = (mode === 'speed') ? normW : maxW;

            for(let k = 1; k <= execCount; k++) {
                if (cand.toTier === 5 && k !== cand.currentC) continue;

                let currentCost = k * pCost;
                if (usedP + plannedParley + currentCost > maxP) break;

                if (!isCandVIP && (maxP - (usedP + plannedParley + currentCost)) < reservedParley) break;

                let tempTrade = { ...cand, execC: k };
                if (cargo[cand.fromClean] >= cand.reqA * k) tempTrade.isChained = true;
                if (isJitSupplier) tempTrade.isJit = true;

                let tempT = [...plannedTrades, tempTrade];

                let optTempT = (zone === 'OCEAN') ? arrangeOceanAndInbounds(tempT) : getOptimalRoute(tempT, normW);
                let tempSim = simulateWeightsTemp(optTempT, normW);

                let validWeight = true;
                if (tempSim.startW > normW) validWeight = false;
                if (tempSim.peakW > wLimit) validWeight = false;

                // ⭐ [근본 픽스] 쾌속 모드는 '귀환길 과적(returnOver)'도 빌드 단계에서 즉시 컷!
                // 무거운 짐이 동선 맨 끝(귀환 직전)에 와서 100%를 넘기는 케이스를 기존 peakW 검사가 놓쳤음.
                if (mode === 'speed' && tempSim.returnOver) validWeight = false;

                for (let sIdx = 0; sIdx < optTempT.length; sIdx++) {
                    let tNode = optTempT[sIdx];
                    let wBefore = (sIdx === 0) ? tempSim.startW : tempSim.stepData[sIdx - 1].afterW;
                    let tCoords = getIslandCoords(tNode.island) || {x:0, y:0};

                    let isOceanStrictNode = (tNode.isCoin || tCoords.isOcean) && tCoords.x < 800 && !tNode.island.includes('파딕스');
                    if (isOceanStrictNode && wBefore > normW) { validWeight = false; break; }

                    let prevCoords = (sIdx === 0) ? {x: 0, y: 0} : (getIslandCoords(optTempT[sIdx - 1].island) || {x: 0, y: 0});

                    if (wBefore > normW) {
                        if (prevCoords.x >= -500 && tCoords.x < -500) { validWeight = false; break; }
                        if (prevCoords.x <= 500 && tCoords.x > 500) { validWeight = false; break; }
                    }
                }

                // ⭐ [최종 검산 핀셋 패치] 연쇄(Chain)로 인한 초반 대량 과적 차단!
                // 일반 줍줍은 건드리지 않고, 오직 '다른 섬에 바쳐야 할 연쇄 재료'를 실었을 때
                // 그 직후 즉시 100%(normW)를 초과해버리면, 무거운 채로 바다를 건너지 않도록 횟수를 쪼갭니다.
                if (validWeight && mode === 'balance') {
                    let isChainSource = currentValidRemaining.some(rt => rt.fromClean === cand.toClean && rt.currentC > 0);
                    if (isChainSource) {
                        let myStepIdx = optTempT.findIndex(t => t.island === cand.island && t.toClean === cand.toClean);
                        if (myStepIdx !== -1 && tempSim.stepData[myStepIdx].afterW > normW) {
                            validWeight = false; // 과적 컷! -> k(횟수)를 줄여서 다시 시뮬레이션 하도록 빠꾸시킴
                        }
                    }
                }

                if (validWeight) { possibleK = k; tempSimTime = tempSim.totalTime; }
                else break;
            }

            return { possibleK, tempSimTime };
        };
        const candidateJit = (cand, plannedTrades, zone) => {
            const candCoords = getIslandCoords(cand.island) || {x:0, y:0};
            let isJitSupplier = false;
            let jitTargetZone = null;
            let jitRequiredExecs = 0;

            let activeZoneForJit = zone;
            if (!activeZoneForJit) {
                let targetOt = currentValidRemaining.find(ot => ot.toTier === 'coin' && ot.score > 0);
                if (targetOt) {
                    let otCoords = getIslandCoords(targetOt.island) || {x:0, y:0};
                    activeZoneForJit = (otCoords.x > 800) ? 'EAST_COIN' : 'OCEAN';
                }
            }

            if (!isT7Mode && (activeZoneForJit === 'OCEAN' || activeZoneForJit === 'EAST_COIN')) {
                let dependentOceanNodes = currentValidRemaining.filter(ot =>
                    ot.toTier === 'coin' && ot.fromClean === cand.toClean &&
                    ((activeZoneForJit === 'OCEAN' && ((getIslandCoords(ot.island) || {x:0}).isOcean || (getIslandCoords(ot.island) || {x:0}).x <= 800)) ||
                     (activeZoneForJit === 'EAST_COIN' && (getIslandCoords(ot.island) || {x:0}).x > 800))
                );

                if (dependentOceanNodes.length > 0) {
                    let totalReqForOcean = dependentOceanNodes.reduce((sum, ot) => sum + (ot.currentC * ot.reqA), 0);
                    let baseStock = inventory[cand.toClean] ? inventory[cand.toClean].stock : 0;
                    let usedG = globalUsedWarehouseStock[cand.toClean] || 0;
                    let gainedG = globalGeneratedWarehouseStock[cand.toClean] || 0;
                    let curSortieGained = 0;
                    plannedTrades.forEach(t => { if (t.toClean === cand.toClean) curSortieGained += (t.execC * t.mult); });

                    let realVirtualStock = baseStock - usedG + gainedG + curSortieGained;

                    let deficit = totalReqForOcean - realVirtualStock;
                    if (deficit > 0) {
                        let candDistToIliya = Math.sqrt(candCoords.x**2 + candCoords.y**2);
                        if (candDistToIliya <= (APP_CONFIG.EFFICIENCY_THRESHOLD || 600)) {
                            isJitSupplier = true; jitTargetZone = activeZoneForJit;
                            jitRequiredExecs = Math.ceil(deficit / cand.mult);
                        }
                    }
                }
            }

            return { isJitSupplier, jitTargetZone, jitRequiredExecs };
        };
        const departureZone = (trade, isJitSupplier, jitTargetZone) => {
            if (isJitSupplier) return jitTargetZone;
            const coords = getIslandCoords(trade.island) || {x:0, y:0};
            const ocean = APP_CONFIG.ALLOW_OCEAN === 'ocean' && coords.isOcean;
            const east = trade.isCoin && !trade.isRandomCoin && coords.x > 800;
            const central = trade.isCoin && !trade.isRandomCoin && coords.x <= 800 && !trade.island.includes('파딕스');
            return ocean || central ? 'OCEAN' : east ? 'EAST_COIN' : coords.x >= 0 ? 'E' : 'W';
        };
        const inTheme = (cand, regions) => {
            const region = getIslandRegion(cand.island);
            return regions.includes(region) || region === 'UNKNOWN';
        };
        let vipParleyNeeded = currentValidRemaining
            .filter(t => t.toTier === 5 && (t.isUrgent || t.isConsumedByT7))
            .reduce((sum, t) => sum + (t.currentC * perTradeP), 0);

        // ⭐ [Step 3] Top 1 씨앗(Seed) 선정 및 허용 권역(Zone) 테마 선포
        let activeThemeRegions = [];
        
        // 🚨 [데드락 완벽 픽스] 까주가 남아있으면 어차피 승선이 거부되는 5단 VIP는 씨앗 자격도 박탈합니다!
        let coinStillExists = (!isT7Mode && (APP_CONFIG.ALLOW_OCEAN === 'inner' || APP_CONFIG.ALLOW_OCEAN === 'ocean')) 
                               ? currentValidRemaining.some(rt => rt.toTier === 'coin') 
                               : false;

        const canSeedExecute = seed => {
            const regions = getAllowedRegions(getIslandRegion(seed.island));
            // Coin/ocean departures apply their own corridor/JIT gates after seed selection.
            const busDeparture = coinStillExists || (APP_CONFIG.ALLOW_OCEAN === 'ocean' &&
                currentValidRemaining.some(t => (getIslandCoords(t.island) || {}).isOcean));
            const initial = { trades: [], cargo: {}, counts: new Map(), parley: 0, vip: vipParleyNeeded, zone: null };
            const copyProbe = probe => ({ ...probe, trades: [...probe.trades], cargo: { ...probe.cargo },
                counts: new Map(probe.counts) });
            const supply = (trade, wanted, probe, visiting) => {
                const left = trade.currentC - (probe.counts.get(trade) || 0);
                if (left <= 0 || visiting.has(trade) || (coinStillExists && trade.toTier === 5)) return null;
                if (!busDeparture && !inTheme(trade, regions)) return null;
                const cand = { ...trade, currentC: left };
                const required = cand.toTier === 5 ? left : 1;
                const path = new Set(visiting).add(trade);
                let next = copyProbe(probe);
                let available = materialAvailability(cand, next.trades, next.cargo);
                if (available.blocked) return null;
                // Probe only reachable production; neither candidates nor projected demand are mutated.
                for (const producer of currentValidRemaining) {
                    if (available.maxByMat >= required) break;
                    if (producer.toClean !== cand.fromClean) continue;
                    while (available.maxByMat < required) {
                        const deficit = (required - available.maxByMat) * cand.reqA;
                        const produced = supply(producer, Math.ceil(deficit / producer.mult), next, path);
                        if (!produced) break;
                        next = produced;
                        available = materialAvailability(cand, next.trades, next.cargo);
                    }
                }
                if (available.maxByMat < required) return null;
                let limit = cand.toTier === 5 ? left : Math.min(left, wanted, available.maxByMat);
                const jit = candidateJit(cand, next.trades, next.zone);
                if (jit.isJitSupplier) limit = Math.min(limit, jit.jitRequiredExecs);
                const { possibleK } = executableCount(cand, limit, next.trades, next.cargo,
                    next.parley, next.zone, next.vip, jit.isJitSupplier);
                if (!possibleK) return null;
                const planned = { ...cand, execC: possibleK };
                if (next.cargo[cand.fromClean] >= possibleK * cand.reqA) planned.isChained = true;
                if (jit.isJitSupplier) planned.isJit = true;
                if (!next.trades.length) next.zone = departureZone(cand, jit.isJitSupplier, jit.jitTargetZone);
                next.trades.push(planned);
                if (planned.isChained) next.cargo[cand.fromClean] -= possibleK * cand.reqA;
                next.cargo[cand.toClean] = (next.cargo[cand.toClean] || 0) + possibleK * cand.mult;
                next.counts.set(trade, (next.counts.get(trade) || 0) + possibleK);
                const cost = possibleK * (cand.isCoin ? perTradeCrowP : perTradeP);
                next.parley += cost;
                if (cand.toTier === 5 && (cand.isUrgent || cand.isConsumedByT7)) next.vip -= cost;
                return next;
            };
            return supply(seed, 1, initial, new Set()) !== null;
        };

        let seedTrade = currentValidRemaining.find(t => {
            if (t.boundary !== 1 || t.isCoin || t.isSpec) return false;
            // 까주 대기 중일 때 5단은 씨앗(권역 설정자) 불가
            if (coinStillExists && t.toTier === 5) return false; 
            return canSeedExecute(t);
        });

        // 만약 일반 재료가 싹 다 털려서 5단이나 까주/특수재료만 남았다면?
        if (!seedTrade && currentValidRemaining.length > 0) {
            // 까주가 있으면 까주를 우선 씨앗으로 삼아 동부/대양 버스를 강제 출차!
            seedTrade = currentValidRemaining.find(t => t.toTier === 'coin' && canSeedExecute(t));
            // 까주마저 없다면 남은 것 중 1등(5단 VIP 등)을 배차
            if (!seedTrade) seedTrade = currentValidRemaining.find(canSeedExecute);
        }
        
        if (seedTrade) {
            let seedRegion = getIslandRegion(seedTrade.island);
            activeThemeRegions = getAllowedRegions(seedRegion);
        }
        
        // ⭐ [4차 출항 융합 픽스] 남은 '필수(score>0)' 항목이 까주, 특수재료, 또는 '5단 VIP'뿐이라면, 
        // 5단만 달랑 싣고 가지 말고 즉시 '잉여 줍줍(Surplus)' 모드를 조기 개방해 남는 무게에 꽉 채워 갑니다!
        if (!allowSurplus && currentValidRemaining.length > 0) {
            let onlySpecialLeft = currentValidRemaining.every(t => t.isCoin || t.isSpec || t.toTier === 5); // ⭐ t.toTier === 5 추가!
            if (onlySpecialLeft) {
                let hasSurplusCands = remaining.some(t => t.toTier >= 1 && t.toTier <= 4 && t.currentC > 0);
                if (hasSurplusCands) { allowSurplus = true; continue; }
            }
        }

        if (currentValidRemaining.length === 0) {
            if (!allowSurplus && usedP < maxP) {
                let hasSurplusCands = remaining.some(t => t.toTier >= 1 && t.toTier <= 4 && t.currentC > 0);
                if (hasSurplusCands) { allowSurplus = true; continue; }
            }
            remaining = []; break;
        }

        let s = { trades: [], reqItems: {}, parleyUsed: 0 };
        // 📑 [뷰어용 메타데이터 — 표시 전용, 판정 로직과 무관] 이 출항의 1위(시드)와 그로 인해 허용된 권역 기록
        s.seedIsland = seedTrade ? seedTrade.island : null;
        s.seedRegion = seedTrade ? getIslandRegion(seedTrade.island) : null;
        s.allowedRegions = activeThemeRegions.slice();
        let curPos = {x: 0, y: 0}; let shipCargo = {}; let canAdd = true;
        let currentTotalTime = 0; let currentLastAfterW = 0; let sortieZone = null;
        let pickedJitSupplier = false; let pickedJitZone = null; // ⭐ [미래시 픽스 1] JIT 선행 픽업 변수

        // ⭐ [까주 버스 강제 배차 시스템 완벽 픽스] 1차 출항에만 국한하지 않고, 까주가 남아있다면 무조건 버스를 띄웁니다!
        let hasOceanOrCentralCoin = currentValidRemaining.some(t => {
            let c = getIslandCoords(t.island) || {x:0, y:0};
            return t.currentC > 0 && ((APP_CONFIG.ALLOW_OCEAN === 'ocean' && c.isOcean) || (t.isCoin && !t.isRandomCoin && c.x <= 800 && !t.island.includes('파딕스')));
        });
        let hasEastCoin = currentValidRemaining.some(t => {
            let c = getIslandCoords(t.island) || {x:0, y:0};
            return t.currentC > 0 && t.isCoin && c.x > 800;
        });

        let forceOceanSortie = false;
        let forceEastCoinSortie = false;

        if (!isT7Mode && (APP_CONFIG.ALLOW_OCEAN === 'inner' || APP_CONFIG.ALLOW_OCEAN === 'ocean')) {
            if (hasOceanOrCentralCoin) forceOceanSortie = true;
            else if (hasEastCoin) forceEastCoinSortie = true; // 중앙/대양 까주 버스 운행이 끝나면, 이어서 동해 까주 버스 강제 배차!
        }


        while (canAdd && currentValidRemaining.length > 0) {
            let bestIdx = -1; let bestFitness = -Infinity; let bestExecCount = 0; let bestSimTime = 0;
            let isCurrentlyOverloaded = currentLastAfterW > normW;

	   // ⭐ [블랙박스 수집 3] 현재 어디서 출발하여 다음 항구를 고르는지 추적
            let curIslandName = s.trades.length > 0 ? s.trades[s.trades.length - 1].island : "일리야 섬";
            let stepLog = { fromIsland: curIslandName, candidates: [] };

            let stillHasOceanStrict = currentValidRemaining.some(t => {
                let c = getIslandCoords(t.island) || {x:0, y:0};
                return t.currentC > 0 && ((t.isCoin && !t.isRandomCoin) || c.isOcean) && c.x < 800 && !t.island.includes('파딕스');
            });

            for (let i = 0; i < currentValidRemaining.length; i++) {
                let cand = currentValidRemaining[i];
                if (cand.currentC <= 0) continue; 
                
                let pCost = cand.isCoin ? perTradeCrowP : perTradeP;
                let isCandVIP = cand.toTier === 5 && (cand.isUrgent || cand.isConsumedByT7);

                if (!isCandVIP) {
                    if (maxP - (usedP + s.parleyUsed + pCost) < vipParleyNeeded) continue; 
                }

                if (usedP + s.parleyUsed + pCost > maxP) continue; 

                // ⭐ [버그 완벽 픽스 1] 내해/대해 모드에서 '까주'가 하나라도 남아있다면 5단 VIP는 무조건 승선 거부!
                // (루프 중간에 상태가 바뀌어 난입하는 것을 막기 위해, 전체 풀에 까주가 있는지 검사합니다)
                if (!isT7Mode && (APP_CONFIG.ALLOW_OCEAN === 'inner' || APP_CONFIG.ALLOW_OCEAN === 'ocean')) {
                    if (cand.toTier === 5) {
                        let coinStillExists = currentValidRemaining.some(rt => rt.toTier === 'coin');
                        if (coinStillExists) continue; 
                    }
                }

                let candCoords = getIslandCoords(cand.island) || {x:0, y:0};
                
                let isRealOceanNode = APP_CONFIG.ALLOW_OCEAN === 'ocean' && candCoords.isOcean;
                let isEastCoinNode = cand.isCoin && !cand.isRandomCoin && candCoords.x > 800;
                let isCentralCoinNode = cand.isCoin && !cand.isRandomCoin && candCoords.x <= 800 && !cand.island.includes('파딕스');

                let candStrict = false;
                if (sortieZone === 'OCEAN') candStrict = (isRealOceanNode || isCentralCoinNode);
                else if (sortieZone === 'EAST_COIN') candStrict = isEastCoinNode;
                else candStrict = (isRealOceanNode || isEastCoinNode || isCentralCoinNode);

                const { isJitSupplier, jitTargetZone, jitRequiredExecs } = candidateJit(cand, s.trades, sortieZone);

                // ⭐ [Step 4-1] 출항 모드 판별 (까주 버스 vs 일반 택배)
                let isOceanSortie = (sortieZone === 'OCEAN' || sortieZone === 'EAST_COIN') || (s.trades.length === 0 && (forceOceanSortie || forceEastCoinSortie));

                // ⭐ [버그 완벽 픽스 2] 합집합(OR)을 위한 화이트리스트 판별 (V13 오리지널 유지)
                let isWhitelisted = false;
                let isWhiteListMode = !isT7Mode && (APP_CONFIG.ALLOW_OCEAN === 'inner' || APP_CONFIG.ALLOW_OCEAN === 'ocean') && s.trades.length > 0;
                
                if (isWhiteListMode) {
                    let baseName = String(cand.island).replace(/ 섬$/, '').replace(/ 제도$/, '').trim();
                    if (baseName.includes('알 수 없는')) baseName = "알 수 없는 고대 벽화"; 

                    if (APP_CONFIG.ALLOW_OCEAN === 'inner' && sortieZone === 'OCEAN') {
                        const innerWhite = ["바레미", "웨이타", "칸베라", "아라킬", "알나하", "라시드", "푸자라", "샤샤", "로즈반", "포르타넨", "틴베라", "레라오"];
                        if (innerWhite.includes(baseName)) isWhitelisted = true;
                    } 
                    else if (APP_CONFIG.ALLOW_OCEAN === 'ocean' && sortieZone === 'OCEAN') {
                        const oceanWhite = ["테스테", "알마이", "파딕스", "쿠이트", "아리타", "리스즈", "나르보", "인버넨", "발베쥬", "툴루", "오르프스", "알나하", "아지르", "바레미", "웨이타", "칸베라", "아라킬"];
                        if (oceanWhite.includes(baseName)) isWhitelisted = true;
                    } 
                    else if (sortieZone === 'EAST_COIN') {
                        const eastWhite = ["푸자라", "샤샤", "로즈반", "포르타넨", "틴베라", "레라오", "리에드", "시르나", "에스파", "티그리스", "보아", "알 수 없는 고대 벽화"];
                        if (eastWhite.includes(baseName)) isWhitelisted = true;
                    }
                }

                let safeIslandName = String(cand.island || "");
                let isNamedCorridor = safeIslandName.includes('오킬루아') || safeIslandName.includes('까마귀의 둥지') || safeIslandName.includes('레마') || safeIslandName.includes('바레미');
                let isBoxCorridor = (candCoords.x >= -377 && candCoords.x <= 384) && (candCoords.y >= -308 && candCoords.y <= 1040);
                
                let isDynamicCorridor = false;
                if (!isT7Mode && isOceanSortie) {
                    let distToReturnPath = getDistToSegment(candCoords.x, candCoords.y, curPos.x, curPos.y, 0, 0);
                    if (distToReturnPath < (APP_CONFIG.EFFICIENCY_THRESHOLD || 600)) isDynamicCorridor = true;
                }
                
                let isCorridor = isNamedCorridor || isBoxCorridor || isDynamicCorridor || isWhitelisted;
                // ⭐ [권역 일치 게이트] 특수재료 OCEAN 동승은 '현재 출항 권역(activeThemeRegions) 안에 그 섬이 있을 때만' 허용.
                //    권역 밖이면 여기서 false → Phase 2(재료쌓기)로 이월. 미등록 섬(UNKNOWN)은 기존 관례대로 허용(어차피 지나가는 해역).
                //    (기존 Phase 2 권역 로직 @3379와 동일 재사용 — 새 하드코딩 목록 없음. isRandomCoin은 이미 OCEAN 제외라 대상 아님.)
                let isAllowedSpecial = false;
                if (!isT7Mode && cand.isSpec) {
                    let __specRegion = getIslandRegion(cand.island);
                    isAllowedSpecial = activeThemeRegions.includes(__specRegion) || __specRegion === 'UNKNOWN';
                }

                let isCrossRegion = false;

                // 🚦 면접 심사 컷오프 (까주 버스 vs 권역 택배 완벽 분리!)
                if (isOceanSortie) {
                    // [Phase 1] 까주 버스 운행 중: V13 오리지널 통제 룰 100% 적용 (권역 룰 무시, 줍줍 허용)
                    if (!isT7Mode) {
                        // ⭐ 동해 까주 버스냐, 중앙/대양 까주 버스냐에 따라 첫 승객을 엄격히 분류
                        if (s.trades.length === 0) {
                            if (forceOceanSortie) {
                                let c = getIslandCoords(cand.island) || {x:0, y:0};
                                let isO_or_C = (APP_CONFIG.ALLOW_OCEAN === 'ocean' && c.isOcean) || (cand.isCoin && !cand.isRandomCoin && c.x <= 800 && !cand.island.includes('파딕스'));
                                if (!isO_or_C && !isCandVIP && !isAllowedSpecial && !isJitSupplier) continue;
                            } else if (forceEastCoinSortie) {
                                let c = getIslandCoords(cand.island) || {x:0, y:0};
                                let isE = cand.isCoin && c.x > 800;
                                if (!isE && !isCandVIP && !isAllowedSpecial && !isJitSupplier) continue;
                            }
                        }
                        if (s.trades.length > 0) {
                            if (sortieZone === 'OCEAN') {
                                if (isEastCoinNode) continue; 
                                if (!candStrict && !isCorridor && !isAllowedSpecial && !cand.isUrgent && !isCandVIP && !isJitSupplier) continue;
                            } else if (sortieZone === 'EAST_COIN') {
                                if (isRealOceanNode || isCentralCoinNode) continue; 
                                if (!candStrict && !isCorridor && !isAllowedSpecial && !cand.isUrgent && !isCandVIP && !isJitSupplier) continue;
                            }
                        }
                    } else {
                        if (forceOceanSortie && s.trades.length === 0 && !candStrict && !isCandVIP) continue; 
                        if (sortieZone === 'OCEAN' && !candStrict && !cand.isUrgent && !isCandVIP) {
                            if(!isCorridor) continue; // 특수재료·랜덤까주는 OCEAN 고정루트에 눌러앉지 않고 Phase 2로 밀림
                        }
                    }

                    // V13 오리지널 권역 이탈 페널티 판정
                    if (s.trades.length > 0 && sortieZone !== 'OCEAN') {
                        let candIsEast = candCoords.x >= 0;
                        if (sortieZone === 'EAST_COIN' && !candIsEast) isCrossRegion = true;
                    }

                } else {
                    // [Phase 2] 일반 재료 출항 중: V14 신규 스마트 권역 룰 적용!
                    if (cand.isCoin && !cand.isRandomCoin) continue; // 1회 까주만 일반 출항 금지 (4회 랜덤까주는 Phase 2 탑승 허용)
                    
                    let isAllowedRegion = inTheme(cand, activeThemeRegions);
                    
                    if (!isAllowedRegion) continue; // 허용 권역이 아니면 가차 없이 탈락!
                    
                    isCrossRegion = false; // 일반 출항은 이미 테마로 묶였으므로 식구끼리 이동 시 페널티 완전 면제!
                }

                const { maxByMat } = materialAvailability(cand, s.trades, shipCargo);
                let execCount = Math.min(cand.currentC, maxByMat);
                
                if (isJitSupplier) {
                    execCount = Math.min(execCount, jitRequiredExecs);
                }

                const { possibleK, tempSimTime } = executableCount(cand, execCount, s.trades,
                    shipCargo, s.parleyUsed, sortieZone, vipParleyNeeded, isJitSupplier);
                let wLimit = (mode === 'speed') ? normW : maxW;

                if (possibleK === 0) continue;

                let tgt = getIslandCoords(cand.island) || {x:0, y:0};
                let addedTime = tempSimTime - currentTotalTime;
                let timeWeight = APP_CONFIG.OVERLOAD_TIME_WEIGHT || 1.0;
                let effectiveDist = addedTime * (APP_CONFIG.SHIP_SPEED || 100) * timeWeight;
                let distPenalty = cand.isCoin ? 0 : (effectiveDist * APP_CONFIG.DISTANCE_PENALTY_WEIGHT);
                
                let clusterPenalty = 0;
                if (isCrossRegion && !cand.isSpec && !cand.isCoin && !isCandVIP) {
                    clusterPenalty = APP_CONFIG.USE_CLUSTERING || 0; 
                }

                let actualDistPenalty = cand.isCoin ? 0 : (effectiveDist * (t_distPen / 10));
                let fitness = (cand.score * (possibleK / cand.origC)) - actualDistPenalty - clusterPenalty;
                
                // ⭐ [Step 4-2] 1군(우선 바운더리) 절대 우대 가점 적용!
                // 단, 까주 버스(isOceanSortie) 운행 중일 때는 500만 점 보너스를 꺼서 V13의 정밀한 화이트리스트 점수 체계를 완벽 보호합니다.
                if (!isOceanSortie && cand.boundary === 1) {
                    fitness += 5000000; // 일반 출항 시 2군보다 무조건 우선 합격
                }

                if (isJitSupplier) fitness += 2000000;
                else if (candStrict) fitness += 800000; 
                
                if (cand.isCoin) fitness += t_crow; 
                if (cand.isSpec) fitness += t_spec;

                if (sortieZone === 'OCEAN' && isCorridor && stillHasOceanStrict) fitness += 80000;

                let crossesIliya = false;
                let pitstopRadius = APP_CONFIG.ILIYA_PITSTOP_RADIUS || 500;
                if (s.trades.length > 0) {
                    let distToPrev = Math.sqrt((tgt.x - curPos.x)**2 + (tgt.y - curPos.y)**2);
                    if (distToPrev > 0) {
                        let t = ((0 - curPos.x) * (tgt.x - curPos.x) + (0 - curPos.y) * (tgt.y - curPos.y)) / (distToPrev**2);
                        if (t > 0.15 && t < 0.85) { 
                            let projX = curPos.x + t * (tgt.x - curPos.x);
                            let projY = curPos.y + t * (tgt.y - curPos.y);
                            if (Math.sqrt(projX**2 + projY**2) < pitstopRadius) { crossesIliya = true; }
                        }
                    }
                }

                if (crossesIliya && isCurrentlyOverloaded) { continue; }

                if (isCurrentlyOverloaded) {
                    if (curPos.x >= -700 && tgt.x < -700) continue; 
                    if (curPos.x <= 700 && tgt.x > 700) continue;   
                }

                let dist = Math.sqrt(Math.pow(tgt.x - curPos.x, 2) + Math.pow(tgt.y - curPos.y, 2));
                const threshold = APP_CONFIG.EFFICIENCY_THRESHOLD || 600;
                let nearPrev = dist < threshold; 
                let nearIliya = Math.sqrt(tgt.x**2 + tgt.y**2) < threshold; 
                let distToPath = getDistToSegment(tgt.x, tgt.y, curPos.x, curPos.y, 0, 0); 
                
                // ⭐ [최종 완벽 픽스: 권역 내 합승 유도] 
                // 같은 서해/동해 권역 안에서 움직일 때는, 길목 기준(threshold)을 1.5배 관대하게 적용하여 
                // 억지로 찢어지는 대참사를 막고 합승(Piggyback)을 유도합니다.
                let relaxedThreshold = (!isCrossRegion) ? threshold * 1.5 : threshold;
                let isEfficient = (nearPrev || nearIliya || (distToPath < relaxedThreshold));

                let actualPathBonus = cand.isWeak ? 0 : t_pathEff;
                let actualChainBonus = cand.isWeak ? 0 : (APP_CONFIG.CHAIN_BONUS_SCORE || 20000);

                let isSeverelyOverloaded = currentLastAfterW > (wLimit * 0.85);
                if (mode === 'speed') isSeverelyOverloaded = isCurrentlyOverloaded;

                if (isSeverelyOverloaded) {
                    if (isEfficient) fitness += actualPathBonus;
                    else { if (!cand.isSpec && !cand.isCoin && !isCandVIP) continue; } 
                } else {
                    if (isEfficient) fitness += actualPathBonus;
                    else {
                        if (!cand.isSpec && !cand.isCoin && !isCandVIP) {
                            fitness -= 5000; 
                            if (cand.toTier >= 2 && cand.toTier <= 4 && possibleK <= 2) fitness -= (APP_CONFIG.SMALL_TRADE_PENALTY || 2000);
                        }
                    }
                }

                if (shipCargo[cand.fromClean] >= cand.reqA) {
                    let chainDistFactor = Math.max(0.1, 1 - (dist / (APP_CONFIG.CHAIN_MAX_DISTANCE || 800)));
                    fitness += actualChainBonus * chainDistFactor;
                }

		        // ⭐ [블랙박스 수집 4] 후보별 점수 계산 영수증 발급 (1군 표기 추가)
                if (possibleK > 0) {
                    let cMath = `${Math.floor(cand.score)}(서류) - ${Math.floor(actualDistPenalty)}(거리감점)`;
                    if (!isOceanSortie && cand.boundary === 1) cMath += ` + 5,000,000(Rank1 Seed)`;
                    if (isJitSupplier) cMath += ` + 2,000,000(JIT)`;
                    else if (candStrict) cMath += ` + 800,000(권역강제)`;
                    if (isEfficient && actualPathBonus > 0) cMath += ` + ${actualPathBonus}(길목)`;
                    if (clusterPenalty > 0) cMath += ` - ${clusterPenalty}(권역이탈)`;

                    stepLog.candidates.push({
                        island: cand.island, item: cand.toClean,
                        fitness: Math.floor(fitness), math: cMath
                    });
                }

                if (fitness > bestFitness) { 
                    bestFitness = fitness; bestIdx = i; bestExecCount = possibleK; bestSimTime = tempSimTime; 
                    pickedJitSupplier = isJitSupplier; pickedJitZone = jitTargetZone;
                }
            }

            if (bestIdx !== -1) {
                let picked = currentValidRemaining[bestIdx];
                let pickedCoords = getIslandCoords(picked.island) || {x:0, y:0};
                
		// ⭐ [블랙박스 수집 5] 1~3등 정리 후 현재 출항편(s)에 영구 보존!
                stepLog.winner = picked.island;
                stepLog.top = stepLog.candidates.sort((a, b) => b.fitness - a.fitness).slice(0, 3);

		// ⭐ [블랙박스 업데이트] 강제 고정 노선(JIT, 6/7단, 까주 등)이라서 경합을 안 하고 바로 탔을 때의 영수증 처리!
                if (stepLog.candidates.length === 0) {
                    let reason = picked.isCoin ? "💰까마귀 주화 지정 노선" : (pickedJitSupplier ? "🚚JIT 긴급 배송" : "🎯특수 목적지 강제 할당");
                    stepLog.top.push({
                        island: picked.island,
                        item: picked.toClean,
                        fitness: 9999999,
                        math: `경합 면제 (${reason})`
                    });
                }

                s.routingLogs = s.routingLogs || [];
                s.routingLogs.push(stepLog);

                if (s.trades.length === 0) {
                    sortieZone = departureZone(picked, pickedJitSupplier, pickedJitZone);
                }

                let pCost = picked.isCoin ? perTradeCrowP : perTradeP;
                let newTrade = { ...picked, execC: bestExecCount };
                if (shipCargo[picked.fromClean] >= (bestExecCount * picked.reqA)) newTrade.isChained = true;
                if (pickedJitSupplier) newTrade.isJit = true; // ⭐ JIT 꼬리표 부착!
                
                // ⭐ [신규] 디버거 꼬리표: 왜 이놈을 태웠는지 최종 합산 적합도를 꼬리표로 붙입니다.
                newTrade.debug = { score: picked.score, lack: picked.lack, fitness: Math.floor(bestFitness) };

                s.trades.push(newTrade);
                
                picked.currentC -= bestExecCount; 

                // ⭐ 탄 만큼 VIP 락업 교섭력 차감
                if (picked.toTier === 5 && (picked.isUrgent || picked.isConsumedByT7)) {
                    vipParleyNeeded -= (bestExecCount * pCost);
                }

                s.parleyUsed += (bestExecCount * pCost); 
                
                let needed = bestExecCount * picked.reqA;
                if (newTrade.isChained) shipCargo[picked.fromClean] -= needed;
                
                shipCargo[picked.toClean] = (shipCargo[picked.toClean] || 0) + (bestExecCount * picked.mult);
                currentTotalTime = bestSimTime;
                
                // ⭐ [대참사 버그 픽스] 배에 짐을 실었으면 현재 무게(currentLastAfterW)를 갱신해 줘야 합니다!
                let syncSim = simulateWeightsTemp(s.trades, normW);
                currentLastAfterW = syncSim.stepData[syncSim.stepData.length - 1].afterW;

                curPos = pickedCoords;
            } else { 
                canAdd = false;
                if (s.trades.length === 0) {
                    // 강제 배차했는데 탈 승객이 없다면, 강제 배차 모드를 끄고 일반 배차로 다시 루프를 돌립니다.
                    if (forceOceanSortie || forceEastCoinSortie) { 
                        forceOceanSortie = false; forceEastCoinSortie = false; canAdd = true; 
                    } 
                    else { currentValidRemaining = []; remaining = []; break; }
                }
            }
        } // 🚨 [원인 픽스] 미래시 픽스를 지우실 때 이 괄호가 같이 날아갔습니다! 이것만 추가해 주십시오!

        if (s.trades.length > 0) {
            if (sortieZone === 'OCEAN' || sortieZone === 'EAST_COIN') {
                let outbounds = []; let inbounds = [];
                s.trades.forEach(t => {
                    let tc = getIslandCoords(t.island) || {x:0, y:0};
                    let isRealO = APP_CONFIG.ALLOW_OCEAN === 'ocean' && tc.isOcean;
                    // ⭐ [까둥/대해까주 고정 픽스 2]
                    if (isRealO || t.isCoin) outbounds.push(t); 
                    else inbounds.push(t); 
                });
                if (outbounds.length > 1) { outbounds = sortFixedOcean(outbounds); }
                s.trades = arrangeOceanAndInbounds([...outbounds, ...inbounds]);
            } else {
                s.trades = getOptimalRoute(s.trades, normW);
            }

            let hasViolations = true;
            let wLimit = (mode === 'speed') ? normW : maxW;
            
            while(hasViolations) {
                hasViolations = false;
                let chainReduced = false; // ⭐ 일반 줍줍이가 억울하게 깎이는 것을 막는 방어 플래그
                
                let vCargo = {}; 
                s.trades.forEach(t => {
                    if (t.execC <= 0) return;
                    let required = t.execC * t.reqA;
                    let currentStock = vCargo[t.fromClean] || 0;
                    if (currentStock >= required && t.fromTier !== 0) {
                        t.isChained = true; vCargo[t.fromClean] -= required;
                    } else {
                        t.isChained = false; 
                    }
                    vCargo[t.toClean] = (vCargo[t.toClean] || 0) + (t.execC * t.mult);
                });

                let finalSim = simulateWeightsTemp(s.trades, normW);
                
                // ⭐ [최종 완벽 픽스] 귀환길(Return) 과적 여부도 엄격하게 심사하도록 판독 조건(returnOver) 추가!
                let isReturnViolated = (mode === 'speed' && finalSim.returnOver); // 쾌속 모드인데 귀환 시 과적이면 위반!
                
                if (finalSim.startW > normW || finalSim.peakW > wLimit || isReturnViolated) {
                    hasViolations = true;
                } else {
                    for (let k = 0; k < s.trades.length; k++) {
                        let tNode = s.trades[k];
                        let wBefore = (k === 0) ? finalSim.startW : finalSim.stepData[k - 1].afterW;
                        let wAfter = finalSim.stepData[k].afterW; 
                        let tCoords = getIslandCoords(tNode.island) || {x:0, y:0};
                        
                        let isOceanStrictNode = (tNode.isCoin || tCoords.isOcean) && tCoords.x < 800 && !tNode.island.includes('파딕스');
                        if (isOceanStrictNode && wBefore > normW) { hasViolations = true; break; }

                        if (wBefore > normW) {
                            let prevCoords = (k === 0) ? {x: 0, y: 0} : (getIslandCoords(s.trades[k - 1].island) || {x: 0, y: 0});
                            if (prevCoords.x >= 500 && tCoords.x <= -500) { hasViolations = true; break; } 
                            if (prevCoords.x <= -500 && tCoords.x >= 500) { hasViolations = true; break; }   
                        }

                        // ⭐ [최종 검산 핀셋 패치 3탄] 연쇄 소스로 인해 과적이 발생하면 해당 노드를 1개씩 삭감, 모자라면 연쇄 파괴!
                        if (wAfter > normW) {
                            let chainTargetIdx = -1;
                            for (let j = k + 1; j < s.trades.length; j++) {
                                if (s.trades[j].isChained && s.trades[j].fromClean === tNode.toClean) {
                                    chainTargetIdx = j; break;
                                }
                            }
                            
                            if (chainTargetIdx !== -1) { 
                                let jNode = s.trades[chainTargetIdx];
                                let requiredOutput = jNode.execC * jNode.reqA;
                                let newOutput = (tNode.execC - 1) * tNode.mult;
                                
                                if (newOutput >= requiredOutput) {
                                    // 1개 빼도 연쇄 대상(5단)의 요구량을 만족함! -> 내 개수만 1개 뺌
                                    let originalRef = remaining.find(rt => rt.island === tNode.island && rt.toClean === tNode.toClean && rt.fromClean === tNode.fromClean);
                                    if (originalRef) originalRef.currentC++;
                                    tNode.execC--; 
                                } else {
                                    // 1개 빼면 연쇄 대상 요구량 미달 -> 5단 분할 교환 안 하고 연쇄 대상 통째로 취소!
                                    let originalRefJ = remaining.find(rt => rt.island === jNode.island && rt.toClean === jNode.toClean && rt.fromClean === jNode.fromClean);
                                    if (originalRefJ) originalRefJ.currentC += jNode.execC;
                                    jNode.execC = 0; 
                                }
                                hasViolations = true; 
                                chainReduced = true; // ⭐ 폭포수 삭감 방지 플래그 ON
                                break; 
                            }
                        }
                    }
                }
                
                if (hasViolations) {
                    let reduced = false;
                    for (let i = s.trades.length - 1; i >= 0; i--) {
                        let t = s.trades[i];
                        if (!t.isChained && t.toTier >= 1 && t.toTier <= 4 && t.execC > 0) {
                            let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                            if (originalRef) originalRef.currentC++;
                            t.execC--; reduced = true; break; 
                        }
                    }
                    if (!reduced) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            if (!t.isChained && t.toTier === 5 && !t.isUrgent && !t.isConsumedByT7 && t.execC > 0) {
                                let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                                if (originalRef) originalRef.currentC += t.execC;
                                t.execC = 0; reduced = true; break; 
                            }
                        }
                    }
                    if (!reduced) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            if (!t.isChained && t.toTier !== 5 && t.toTier !== 6 && t.toTier !== 7 && t.execC > 0) {
                                let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                                if (originalRef) originalRef.currentC++;
                                t.execC--; reduced = true; break; 
                            }
                        }
                    }
                    if (!reduced) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            if (!t.isChained && t.toTier === 5 && (t.isUrgent || t.isConsumedByT7) && t.execC > 0) {
                                let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                                if (originalRef) originalRef.currentC += t.execC;
                                t.execC = 0; reduced = true; break; 
                            }
                        }
                    }
                    if (!reduced) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            if (t.execC > 0) {
                                t.execC--; 
                                let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                                if (originalRef) originalRef.currentC++;
                                reduced = true; break; 
                            }
                        }
                    }
                    if (!reduced) break; 
                }
            }
            s.trades = s.trades.filter(t => t.execC > 0);
            s.parleyUsed = s.trades.reduce((sum, t) => sum + (t.toTier === 'coin' ? perTradeCrowP : perTradeP) * t.execC, 0);
            
            s.reqItems = {};
            let vCargoFinal = {}; 
            s.trades.forEach(t => {
                let required = t.execC * t.reqA;
                let currentStock = vCargoFinal[t.fromClean] || 0;
                if (currentStock >= required && t.fromTier !== 0) {
                    t.isChained = true; vCargoFinal[t.fromClean] -= required;
                } else {
                    t.isChained = false; 
                    if(!s.reqItems[t.fromClean]) s.reqItems[t.fromClean] = { count: 0, isBase: t.fromTier === 0, tier: t.fromTier };
                    s.reqItems[t.fromClean].count += required;
                }
                vCargoFinal[t.toClean] = (vCargoFinal[t.toClean] || 0) + (t.execC * t.mult);
            });
            
            let finalSim = simulateWeightsTemp(s.trades, normW);
            s.startWeight = finalSim.startW; s.totalTime = finalSim.totalTime; s.returnOver = finalSim.returnOver; s.returnTime = finalSim.returnTime;
            s.trades.forEach((t, i) => { t.afterW = finalSim.stepData[i].afterW; t.estT = finalSim.stepData[i].estT; t.over = finalSim.stepData[i].over; });
            
            sorties.push(s); 
            usedP += s.parleyUsed; 
            
            
        } else break;
        
        remaining = remaining.filter(t => t.currentC > 0);
    }

    let madeChanges = true;
    let defragLoops = 0;
    let wLimit = (mode === 'speed') ? normW : maxW;

    // ⭐ [근본픽스] 조각모음 병합 후 연쇄(isChained) 상태를 현재 배 구성에 맞게 재계산.
    // (이걸 안 하면 합쳐진 짐이 옛 연쇄플래그를 유지해 simulateWeightsTemp가 무게를 0으로 착각 → 가짜 통과)
    const syncChainsForMerge = (tradesArr) => {
        let vc = {};
        tradesArr.forEach(t => {
            let required = t.execC * t.reqA;
            let currentStock = vc[t.fromClean] || 0;
            if (currentStock > 0 && currentStock >= required && t.fromTier !== 0) {
                t.isChained = true; vc[t.fromClean] -= required;
            } else {
                t.isChained = false;
            }
            vc[t.toClean] = (vc[t.toClean] || 0) + (t.execC * t.mult);
        });
    };

    // ⭐ [신규 핀셋 패치] 조각모음 시 "연쇄 소스 과적 금지" + "쾌속 귀환길 과적 절대 금지" 철통 방어
    const isMergeValid = (sim, sTrades) => {
        // 🚨 쾌속 모드(speed)일 경우 귀환 시 과적(returnOver)도 절대 허용하지 않도록 판독 조건 추가!
        if (sim.startW > normW || sim.peakW > wLimit || (mode === 'speed' && sim.returnOver)) return false;
        
        for (let k = 0; k < sTrades.length; k++) {
            if (sim.stepData[k].afterW > normW) {
                let isChainSource = sTrades.some((rt, idx) => idx > k && rt.isChained && rt.fromClean === sTrades[k].toClean);
                if (isChainSource) return false; // 연쇄 재료인데 과적이다? 조각모음 결재 거부!
            }
        }
        return true;
    };

    while (madeChanges && defragLoops < 50) {
        madeChanges = false;
        defragLoops++;

        for (let i = 0; i < sorties.length; i++) {
            for (let j = 0; j < sorties.length; j++) {
                if (i === j) continue;
                let sA = sorties[i]; let sB = sorties[j];

                for (let bIdx = 0; bIdx < sB.trades.length; bIdx++) {
                    let tB = sB.trades[bIdx];
                    if (tB.toTier >= 5 || tB.isCoin || tB.execC === 0) continue; 
                    
                    let aIdx = sA.trades.findIndex(t => t.island === tB.island && t.toClean === tB.toClean && t.execC > 0);
                    if (aIdx !== -1) {
                        let tA = sA.trades[aIdx]; let amt = tB.execC;
                        
                        if (amt >= 5) continue; 
                        
                        tB.execC = 0; tA.execC += amt;
                        syncChainsForMerge(sA.trades);
                        let simA = simulateWeightsTemp(sA.trades, normW);
                        
                        // ⭐ 여기서 판독기 가동!
                        if (isMergeValid(simA, sA.trades) && validateSortieSequence(sorties).valid) { madeChanges = true; break; }
                        
                        tB.execC = amt; tA.execC -= amt; 
                    }
                }
                if (madeChanges) break;

                for (let bIdx = 0; bIdx < sB.trades.length; bIdx++) {
                    let tB = sB.trades[bIdx];
                    if (tB.toTier >= 5 || tB.isCoin || tB.execC === 0) continue;
                    
                    let aIdx = sA.trades.findIndex(t => t.island === tB.island && t.toClean === tB.toClean && t.execC > 0);
                    if (aIdx !== -1) {
                        let tA = sA.trades[aIdx]; let amtB = tB.execC;
                        
                        for (let vIdx = 0; vIdx < sA.trades.length; vIdx++) {
                            if (vIdx === aIdx) continue;
                            let vA = sA.trades[vIdx];
                            if (vA.toTier >= 5 || vA.isCoin || vA.execC === 0) continue; 
                            
                            let amtV = vA.execC;
                            if (amtV >= 5) continue;
                            
                            tB.execC = 0; tA.execC += amtB; vA.execC = 0; 
                            
                            let existingV_in_B = sB.trades.find(t => t.island === vA.island && t.toClean === vA.toClean);
                            let added = false;
                            if (existingV_in_B) { existingV_in_B.execC += amtV; } 
                            else { sB.trades.push({...vA, execC: amtV}); added = true; }
                            
                            syncChainsForMerge(sA.trades);
                            syncChainsForMerge(sB.trades);
                            let simA = simulateWeightsTemp(sA.trades, normW);
                            let simB = simulateWeightsTemp(sB.trades, normW);
                            
                            // ⭐ 여기도 판독기 가동!
                            if (isMergeValid(simA, sA.trades) && isMergeValid(simB, sB.trades) && validateSortieSequence(sorties).valid) { madeChanges = true; break; }
                            
                            tB.execC = amtB; tA.execC -= amtB; vA.execC = amtV;
                            if (existingV_in_B) existingV_in_B.execC -= amtV;
                            if (added) sB.trades.pop();
                        }
                    }
                    if (madeChanges) break;
                }
                if (madeChanges) break;
            }
            if (madeChanges) break;
        }
    }

    usedP = 0; 
    sorties.forEach(s => {
        s.trades = s.trades.filter(t => t.execC > 0);
        if (s.trades.length > 0) {
            // ⭐ [마스터 핀셋 패치 1] 시간 최적화 엔진이 순서를 망칠 경우를 대비해 '안전한' 원본 순서 백업
            let safeOriginalOrder = [...s.trades]; 

            let outbounds = []; let inbounds = [];
            s.trades.forEach(t => {
                let tc = getIslandCoords(t.island) || {x:0, y:0};
                
                // ⭐ [까둥/대해까주 고정 픽스 3] 무조건 대양/까주는 앞쪽으로!
                let isRealO = APP_CONFIG.ALLOW_OCEAN === 'ocean' && tc.isOcean;
                if (isRealO || t.isCoin) outbounds.push(t);
                else inbounds.push(t);
            });
            
            if (outbounds.length > 0) {
                if (outbounds.length > 1) outbounds = sortFixedOcean(outbounds);
                s.trades = arrangeOceanAndInbounds([...outbounds, ...inbounds]);
            } else {
                s.trades = getOptimalRoute(s.trades, normW);
            }

            // ⭐ [마스터 핀셋 패치 2] 쾌속 모드인데 getOptimalRoute가 시간을 위해 과적을 발생시켰다면? 가차 없이 원본 복구!
            if (mode === 'speed') {
                let checkSim = simulateWeightsTemp(s.trades, normW);
                if (checkSim.startW > normW || checkSim.peakW > normW || checkSim.returnOver) {
                    s.trades = safeOriginalOrder; 
                }
            }

            // ⭐ [최종 안전망] 쾌속 모드는 그 어떤 경로로 과적이 새어들어와도 여기서 최종 차단.
            // 조각모음/순서섞기/연쇄오판 등 원인과 무관하게, 최종 동선이 과적이면 비연쇄·저티어부터 1개씩 깎는다.
            if (mode === 'speed') {
                let guardLoops = 0;
                while (guardLoops < 200) {
                    guardLoops++;
                    let gvc = {};
                    s.trades.forEach(t => {
                        let req = t.execC * t.reqA;
                        let cur = gvc[t.fromClean] || 0;
                        if (cur > 0 && cur >= req && t.fromTier !== 0) { t.isChained = true; gvc[t.fromClean] -= req; }
                        else { t.isChained = false; }
                        gvc[t.toClean] = (gvc[t.toClean] || 0) + (t.execC * t.mult);
                    });
                    let gSim = simulateWeightsTemp(s.trades, normW);
                    let over = (gSim.startW > normW || gSim.peakW > normW || gSim.returnOver);
                    if (!over) break;

                    let cut = false;
                    for (let i = s.trades.length - 1; i >= 0; i--) {
                        let t = s.trades[i];
                        if (!t.isChained && t.toTier >= 1 && t.toTier <= 4 && t.execC > 0) { t.execC--; cut = true; break; }
                    }
                    if (!cut) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            if (!t.isChained && t.toTier !== 5 && t.toTier !== 6 && t.toTier !== 7 && t.execC > 0) { t.execC--; cut = true; break; }
                        }
                    }
                    if (!cut) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            if (!t.isChained && t.toTier === 5 && !t.isUrgent && !t.isConsumedByT7 && t.execC > 0) { t.execC = 0; cut = true; break; }
                        }
                    }
                    if (!cut) break;
                    s.trades = s.trades.filter(t => t.execC > 0);
                    if (s.trades.length === 0) break;
                }
                s.parleyUsed = s.trades.reduce((sum, t) => sum + (t.toTier === 'coin' ? perTradeCrowP : perTradeP) * t.execC, 0);
            }
            
            s.parleyUsed = s.trades.reduce((sum, t) => sum + (t.toTier === 'coin' ? perTradeCrowP : perTradeP) * t.execC, 0);
            
            s.reqItems = {}; let vCargoFinal = {}; 
            s.trades.forEach(t => {
                let required = t.execC * t.reqA;
                let currentStock = vCargoFinal[t.fromClean] || 0;
                
                // ⭐ [마스터 핀셋 패치 3] currentStock > 0 조건 추가! 배 안에서 직접 캐낸 재고일 때만 연쇄(Chained)로 인정!
                if (currentStock > 0 && currentStock >= required && t.fromTier !== 0) {
                    t.isChained = true; vCargoFinal[t.fromClean] -= required;
                } else {
                    t.isChained = false; 
                    if(!s.reqItems[t.fromClean]) s.reqItems[t.fromClean] = { count: 0, isBase: t.fromTier === 0, tier: t.fromTier };
                    s.reqItems[t.fromClean].count += required;
                }
                vCargoFinal[t.toClean] = (vCargoFinal[t.toClean] || 0) + (t.execC * t.mult);
            });
            
            let finalSim = simulateWeightsTemp(s.trades, normW);
            s.startWeight = finalSim.startW; s.totalTime = finalSim.totalTime; s.returnOver = finalSim.returnOver; s.returnTime = finalSim.returnTime;
            s.trades.forEach((t, i) => { t.afterW = finalSim.stepData[i].afterW; t.estT = finalSim.stepData[i].estT; t.over = finalSim.stepData[i].over; });
            usedP += s.parleyUsed; 
        }
    });
    
    sorties = sorties.filter(s => s.trades.length > 0);
    const validation = validateSortieSequence(sorties);
    if (!validation.valid) throw new Error(`출항별 재고 계산이 맞지 않습니다: ${JSON.stringify(validation.issues[0])}`);
    return sorties;
}

window.__SPEC005_SCRIPT_LOADED = window.__SPEC005_SCRIPT_LOADED || {}; window.__SPEC005_SCRIPT_LOADED["scheduler.js"] = true;
