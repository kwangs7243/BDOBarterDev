/* SPEC-005 T005 FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */
function calculateTravelTime(dist, isOverloaded) {
    const speed = APP_CONFIG.SHIP_SPEED || 100;
    const penalty = isOverloaded ? APP_CONFIG.OVERLOAD_PENALTY : 1.0;
    if (speed <= 0) return 0;
    return Math.ceil((dist / speed) * penalty);
}

function getIslandCoords(islandName) {
    let cleanName = String(islandName || "").replace(/ 섬$/, '').replace(/ 제도$/, '').trim();
    // ⭐ [버그 픽스] "제도"가 잘려나가서 좌표를 못 찾는 현상 완벽 방지!
    return islandCoordinates[cleanName] || islandCoordinates[cleanName+" 섬"] || islandCoordinates[cleanName+" 제도"] || {x: -150, y: 0, isOcean: false};
}

function getPermutations(arr) {
    if (arr.length <= 1) return [arr];
    let perms = [];
    for (let i = 0; i < arr.length; i++) {
        let rest = getPermutations(arr.slice(0, i).concat(arr.slice(i + 1)));
        for (let r of rest) perms.push([arr[i]].concat(r));
    }
    return perms;
}

function getRoutePermutationOrders(count) {
    const cache = getRoutePermutationOrders.cache || (getRoutePermutationOrders.cache = new Map());
    if (!cache.has(count)) cache.set(count, getPermutations(Array.from({length:count}, (_, index) => index)));
    return cache.get(count);
}

function getOptimalRoute(tradesArray, normW) {
    if (tradesArray.length <= 1 || tradesArray.length > 7) return optimizeRouteTSP(tradesArray);

    let bestRoute = optimizeRouteTSP(tradesArray), minTime = Infinity;
    const nodes = tradesArray.map(t => ({
        trade:t, required:t.execC*t.reqA, gained:t.execC*t.mult,
        fromWeight:getItemWeight(t.fromTier, t.fromClean),
        toWeight:getItemWeight(t.toTier, t.toClean)
    }));
    const distances = tradesArray.map(a => tradesArray.map(b => legDistance(a.island, b.island)));
    const outbound = tradesArray.map(t => legDistance('일리야 섬', t.island));
    const inbound = tradesArray.map(t => legDistance(t.island, '일리야 섬'));
    const speed = APP_CONFIG.SHIP_SPEED || 100, penalty = APP_CONFIG.OVERLOAD_PENALTY;

    const sourceItems = new Set(tradesArray.map(t => t.fromClean));
    const independent = nodes.every(n => !n.trade.isWaypoint && !n.trade.isChained
        && !sourceItems.has(n.trade.toClean) && Number.isSafeInteger(n.required*n.fromWeight));
    if (independent) {
        const loads = getSortieCargoPlan(tradesArray).reqItems;
        let initialWeight = 0;
        for (const [name, load] of Object.entries(loads)) initialWeight += load.count*getItemWeight(load.tier, name);
        if (Number.isSafeInteger(initialWeight)) {
            const order = [];
            const visit = (mask, previous, weight, time) => {
                if (order.length === nodes.length) {
                    const total = time + (inbound[previous]/speed)*(weight > normW ? penalty : 1.0);
                    if (total < minTime) { minTime = total; bestRoute = order.map(index => tradesArray[index]); }
                    return;
                }
                for (let index = 0; index < nodes.length; index++) {
                    if (mask & (1 << index)) continue;
                    const node = nodes[index], distance = previous < 0 ? outbound[index] : distances[previous][index];
                    const nextTime = time + (distance/speed)*(weight > normW ? penalty : 1.0);
                    const nextWeight = weight - node.required*node.fromWeight + node.gained*node.toWeight;
                    order.push(index);
                    visit(mask | (1 << index), index, nextWeight, nextTime);
                    order.pop();
                }
            };
            // Independent integer loads share each prefix while retaining every original permutation and tie order.
            visit(0, -1, initialWeight, 0);
            return bestRoute;
        }
    }

    // Keep exhaustive order and strict tie handling; reuse distances and weights within this call.
    for (const order of getRoutePermutationOrders(tradesArray.length)) {
        const eligible = {}, generated = {}, loads = {};
        let valid = true;
        for (const index of order) {
            const {trade:t, required, gained, fromWeight} = nodes[index];
            if (t.isChained) {
                if ((eligible[t.fromClean] || 0) < required) { valid = false; break; }
                eligible[t.fromClean] -= required;
            }
            eligible[t.toClean] = (eligible[t.toClean] || 0) + gained;
            if (t.isWaypoint) {
                if (t.consumed?.count > 0) {
                    const c = t.consumed;
                    if (!loads[c.name]) loads[c.name] = {count:0, weight:getItemWeight(c.tier, c.name)};
                    loads[c.name].count += c.count;
                }
                continue;
            }
            if (required > 0 && t.fromTier !== 0 && (generated[t.fromClean] || 0) >= required) generated[t.fromClean] -= required;
            else if (required > 0) {
                if (!loads[t.fromClean]) loads[t.fromClean] = {count:0, weight:fromWeight};
                loads[t.fromClean].count += required;
            }
            generated[t.toClean] = (generated[t.toClean] || 0) + gained;
        }
        if (!valid) continue;
        let weight = 0, time = 0, previous = -1;
        for (const load of Object.values(loads)) weight += load.count * load.weight;
        for (const index of order) {
            const node = nodes[index], t = node.trade;
            const distance = previous < 0 ? outbound[index] : distances[previous][index];
            time += (distance / speed) * (weight > normW ? penalty : 1.0);
            if (t.isWaypoint) weight -= t.consumed ? t.consumed.count*getItemWeight(t.consumed.tier, t.consumed.name) : 0;
            else weight = weight - node.required*node.fromWeight + node.gained*node.toWeight;
            previous = index;
        }
        time += (inbound[previous] / speed) * (weight > normW ? penalty : 1.0);
        if (time < minTime) { minTime = time; bestRoute = order.map(index => tradesArray[index]); }
    }
    return bestRoute;
}

function optimizeRouteTSP(tradesArray) {
    if (tradesArray.length <= 1) return tradesArray;
    let unvisited = [...tradesArray]; let currentPos = {x: 0, y: 0}; let optimized = []; let generatedCargo = {}; 
    while (unvisited.length > 0) {
        let nearestIdx = -1; let minDistance = Infinity;
        for (let i = 0; i < unvisited.length; i++) {
            let cand = unvisited[i];
            if (cand.isChained) {
                let required = cand.execC * cand.reqA; let generated = generatedCargo[cand.fromClean] || 0;
                if (generated < required) continue; 
            }
            let coords = getIslandCoords(cand.island);
            let dist = Math.pow((coords.x - currentPos.x) * 1.2, 2) + Math.pow(coords.y - currentPos.y, 2);
            if (cand.isChained) dist -= 1000000; 
            if (dist < minDistance) { minDistance = dist; nearestIdx = i; }
        }
        if (nearestIdx === -1) nearestIdx = 0; 
        let nextNode = unvisited.splice(nearestIdx, 1)[0];
        optimized.push(nextNode);
        currentPos = getIslandCoords(nextNode.island); 
        let gainCount = nextNode.execC * nextNode.mult;
        generatedCargo[nextNode.toClean] = (generatedCargo[nextNode.toClean] || 0) + gainCount;
    }
    return optimized;
}

function sortFixedOcean(tradesArr) {
    const mode = APP_CONFIG.ALLOW_OCEAN;
    
    let FIXED_OCEAN_ROUTE = [
        "할마드 섬", "카슈마 섬", "더코 섬",
        "오킬루아의 눈", "까마귀의 둥지",
        "파키오의 전투 뗏목", "떠돌이 상인의 배", "랑티니아의 전투 뗏목", 
        "떠내려온 미완성 선박", "그믐달 길드의 중범선", "숄라스 치코의 해적 연합", 
        "난파된 하란의 수송선", "까마귀 상단 소유의 선박", "난파된 고대 유적 수송선", 
        "난파된 릭쿤의 배"
    ];

    // ⭐ [아레하자 제외(arehazaX) 추가] 남부가 포함된 동선이므로 해상군 ➔ 콕스 순서로 묶어줍니다.
    if (mode === 'ocean' || mode === 't7_2region_south' || mode === 't7_2region_arehazaX') {
        FIXED_OCEAN_ROUTE.push("난파된 해상군의 배", "난파된 콕스해적선");
    } else if (mode === 't7_2region' || mode === 't7_3region') {
        FIXED_OCEAN_ROUTE.push("난파된 콕스해적선", "난파된 해상군의 배");
    } else {
        FIXED_OCEAN_ROUTE.push("난파된 해상군의 배", "난파된 콕스해적선");
    }
    
    let hasFixed = [];
    let others = [];
    tradesArr.forEach(t => {
        let cleanName = t.island.replace(/ 섬$/, '').replace(/\s/g, '').trim();
        let idx = FIXED_OCEAN_ROUTE.findIndex(x => x.replace(/\s/g, '').includes(cleanName));
        if (idx !== -1) hasFixed.push({t, idx});
        else others.push(t);
    });
    
    hasFixed.sort((a, b) => a.idx - b.idx);
    return [...hasFixed.map(x => x.t), ...optimizeRouteTSP(others)];
}

function getIslandRegion(islandName) {
    let cleanName = String(islandName || "").replace(/ 섬$/, '').replace(/ 제도$/, '').trim();
    for (let r in REGION_MAP) { if (REGION_MAP[r].includes(cleanName)) return r; }
    return "UNKNOWN";
}

function getAllowedRegions(seedRegion) {
    // 박사님 기획: 서해 -> 서해/근서 | 북해 -> 북해/동해/근동 | 동해 -> 동해/북해/근동 | 근서/근동 -> 근서/근동
    if (seedRegion === 'WEST') return ['WEST', 'NEAR_WEST'];
    if (seedRegion === 'NORTH' || seedRegion === 'EAST') return ['NORTH', 'EAST', 'NEAR_EAST'];
    if (seedRegion === 'NEAR_WEST' || seedRegion === 'NEAR_EAST') return ['NEAR_WEST', 'NEAR_EAST'];
    return [seedRegion]; // 안전장치
}

function applyOceanCurrent(nameA, nameB, dist) {
    if (!nameA || !nameB) return dist;
    
    // --- [주석 처리 시작] ---
    /*
    let isDallae = nameA.includes("달래") || nameB.includes("달래");
    let isEastCoast = nameA.includes("성전") || nameA.includes("소산") || nameB.includes("성전") || nameB.includes("소산");
    if (isDallae && isEastCoast) dist *= 1.302; 
    */
    // --- [주석 처리 끝] ---
    
    // 동적 보정 (나중에 리스트가 꽉 차서 이걸 다 반영하고 싶을 때 쓰세요!)
    let routeKey = nameA + '_' + nameB; // ⭐ 방향 구분(정렬 제거) — A→B와 B→A 보정 분리. 해류 비대칭 반영.
    if (window.routeCalibrations[routeKey]) {
        dist *= window.routeCalibrations[routeKey].multiplier;
    }
    
    return dist;
}

function legDistance(nameA, nameB) {
    let a = String(nameA || ""); let b = String(nameB || "");
    const isPivot  = n => n.includes("그란디하") || n.includes("깊은 밤");
    const isSionil = n => n.includes("시오닐");
    function rawDist(n1, n2) {
        let c1 = getIslandCoords(n1), c2 = getIslandCoords(n2);
        return Math.sqrt(Math.pow(c2.x - c1.x, 2) + Math.pow(c2.y - c1.y, 2));
    }
    let aPivot = isPivot(a), bPivot = isPivot(b);
    // 두 심해섬끼리(그란디하↔깊은밤)는 직행, 한쪽이 시오닐이면 직행 → 그 외 본토쪽 leg만 경유
    if ((aPivot || bPivot) && !(aPivot && bPivot) && !isSionil(a) && !isSionil(b)) {
        return applyOceanCurrent(a, "시오닐 섬", rawDist(a, "시오닐 섬"))
             + applyOceanCurrent("시오닐 섬", b, rawDist("시오닐 섬", b));
    }
    return applyOceanCurrent(a, b, rawDist(a, b));
}

function getSortieCargoPlan(trades) {
    const reqItems = {}, generated = {}, chained = [];
    const load = (name, tier, count) => {
        if (count <= 0) return;
        if (!reqItems[name]) reqItems[name] = {count:0, tier, isBase:tier === 0};
        reqItems[name].count += count;
    };
    trades.forEach((t, index) => {
        if (t.isWaypoint) { if (t.consumed) load(t.consumed.name, t.consumed.tier, t.consumed.count); return; }
        const required = t.execC * t.reqA;
        const available = generated[t.fromClean] || 0;
        const isChained = required > 0 && t.fromTier !== 0 && available >= required;
        chained[index] = isChained;
        if (isChained) generated[t.fromClean] -= required;
        else load(t.fromClean, t.fromTier, required);
        generated[t.toClean] = (generated[t.toClean] || 0) + t.execC * t.mult;
    });
    return {reqItems, chained};
}

function forecastWarehouseInventory(sorties, initialInventory = inventory) {
    const forecast = Object.fromEntries(Object.entries(initialInventory).map(([name, item]) => [name, {...item}]));
    const change = (name, tier, amount) => {
        if (!Number.isInteger(tier) || tier < 1 || tier > 7) return;
        if (!forecast[name]) forecast[name] = {programName:name, tier, stock:0, target:0};
        if (forecast[name].stock !== null) forecast[name].stock += amount;
    };
    sorties.forEach(s => s.trades.forEach(t => {
        if (t.isWaypoint) { if(t.consumed) change(t.consumed.name, t.consumed.tier, -t.consumed.count); return; }
        change(t.fromClean, t.fromTier, -t.execC * t.reqA);
        change(t.toClean, t.toTier, t.execC * t.mult);
    }));
    return forecast;
}

function getScheduleStartingInventory(sorties, currentInventory = inventory) {
    const initial = Object.fromEntries(Object.entries(currentInventory).map(([name, item]) => [name, {...item}]));
    sorties.forEach(s => s.trades.forEach(t => {
        if (!t.completed) return;
        const consumed = t.isWaypoint ? t.consumed : {name:t.fromClean, count:t.execC*t.reqA};
        if (consumed && initial[consumed.name] && initial[consumed.name].stock !== null) initial[consumed.name].stock += consumed.count;
        if (!t.isWaypoint && initial[t.toClean] && initial[t.toClean].stock !== null) initial[t.toClean].stock -= t.execC*t.mult;
    }));
    return initial;
}

function validateSortieSequence(sorties, initialInventory = inventory) {
    const warehouse = Object.fromEntries(Object.entries(initialInventory).map(([name, item]) => [name, item.stock]));
    const issues = [];
    sorties.forEach((s, sortieIndex) => {
        const {reqItems} = getSortieCargoPlan(s.trades), cargo = {}, tiers = {};
        Object.entries(reqItems).forEach(([name, req]) => {
            cargo[name] = req.count; tiers[name] = req.tier;
            if (Number.isInteger(req.tier) && req.tier >= 1 && req.tier <= 7) {
                const available = Object.hasOwn(warehouse, name) ? warehouse[name] : 0;
                if (!Number.isSafeInteger(available) || available < req.count) issues.push({departure:sortieIndex+1, item:name, available, required:req.count, kind:'warehouse'});
                warehouse[name] = available === null ? null : available - req.count;
            }
        });
        s.trades.forEach((t, index) => {
            const consumed = t.isWaypoint ? t.consumed : {name:t.fromClean, tier:t.fromTier, count:t.execC*t.reqA};
            if (consumed) {
                const available = cargo[consumed.name] || 0;
                if (available < consumed.count) issues.push({departure:sortieIndex+1, step:index+1, item:consumed.name, available, required:consumed.count, kind:'cargo'});
                cargo[consumed.name] = available - consumed.count; tiers[consumed.name] = consumed.tier;
            }
            if (!t.isWaypoint) { cargo[t.toClean] = (cargo[t.toClean] || 0) + t.execC*t.mult; tiers[t.toClean] = t.toTier; }
        });
        Object.entries(cargo).forEach(([name, count]) => {
            if (Number.isInteger(tiers[name]) && tiers[name] >= 1 && tiers[name] <= 7 && warehouse[name] !== null) warehouse[name] = (warehouse[name] || 0) + count;
        });
    });
    return {valid:issues.length === 0, issues, warehouse};
}

function simulateWeightsTemp(arr, norm) {
    let sw = 0; let tt = 0; let steps = []; let cp = getIslandCoords("일리야 섬");
    let cpName = "일리야 섬"; // ⭐ 이전 노드 이름 추적
    const shipSpeed = APP_CONFIG.SHIP_SPEED || 100;

    const cargoPlan = getSortieCargoPlan(arr);
    for (const [name, req] of Object.entries(cargoPlan.reqItems)) sw += req.count * getItemWeight(req.tier, name);
    let cw = sw; let pw = sw;
    
    arr.forEach(t => {
        let over = (cw > norm); 
        let tgt = getIslandCoords(t.island);

        // ⭐ 해류 보정 + 시오닐 길목 경유 보정 적용!
        let dist = legDistance(cpName, t.island);

        let timeMultiplier = over ? APP_CONFIG.OVERLOAD_PENALTY : 1.0;
        
        // ⭐ 박사님 커스텀: 올림(Math.ceil) 삭제 -> 소수점 그대로 유지 (예: 3.25분)
        let et = (dist / shipSpeed) * timeMultiplier;
        tt += et; 
        
        if (t.isWaypoint) {
            // 🧭 경유지: 이동만, 사용 재료가 있으면 그만큼 소모(감량). 획득 없음.
            let wpMinus = t.consumed ? t.consumed.count * getItemWeight(t.consumed.tier, t.consumed.name) : 0;
            cw = cw - wpMinus;
        } else {
            let wMinus = t.execC * t.reqA * getItemWeight(t.fromTier, t.fromClean);
            let wPlus = t.execC * t.mult * getItemWeight(t.toTier, t.toClean);
            cw = cw - wMinus + wPlus;
        }
        if(cw > pw) pw = cw;
        steps.push({afterW: cw, estT: et, over: over}); 
        cp = tgt;
        cpName = t.island; // ⭐ 현재 노드를 다음번 계산의 출발지로 넘김
    });
    
    // ⭐ 귀환 시에도 해류 + 시오닐 길목 경유 보정 (그란디하/깊은밤발 귀환도 시오닐에서 꺾임)
    let rDist = legDistance(cpName, "일리야 섬");
    let rOver = (cw > norm); 
    
    // ⭐ 박사님 커스텀: 귀환 시간도 올림 삭제
    let retT = (rDist / shipSpeed) * (rOver ? APP_CONFIG.OVERLOAD_PENALTY : 1.0);
    tt += retT;
    
    return { startW: sw, peakW: pw, totalTime: tt, stepData: steps, returnOver: rOver, returnTime: retT };
}

function getDistToSegment(px, py, x1, y1, x2, y2) {
    let l2 = (x1 - x2)**2 + (y1 - y2)**2;
    if (l2 === 0) return Math.sqrt((px - x1)**2 + (py - y1)**2);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((px - (x1 + t * (x2 - x1)))**2 + (py - (y1 + t * (y2 - y1)))**2);
}

window.formatTimeExact = function(mins) {
    if (!mins) return "0초";
    let totalSec = Math.round(mins * 60);
    let m = Math.floor(totalSec / 60);
    let s = totalSec % 60;
    if (m > 0 && s > 0) return `${m}분 ${s}초`;
    if (m > 0) return `${m}분`;
    return `${s}초`;
};

window.__SPEC005_SCRIPT_LOADED = window.__SPEC005_SCRIPT_LOADED || {}; window.__SPEC005_SCRIPT_LOADED["routing.js"] = true;
