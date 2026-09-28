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

function getOptimalRoute(tradesArray, normW) {
    // ⭐ [핵심 픽스] 7개까지는 무조건 모든 경우의 수를 시뮬레이션! (기존 6개 제한에서 확장)
    if (tradesArray.length <= 1 || tradesArray.length > 7) {
        return optimizeRouteTSP(tradesArray);
    }

    let bestRoute = optimizeRouteTSP(tradesArray); // 기본값
    let minTime = Infinity;
    const perms = getPermutations(tradesArray);

    for (let perm of perms) {
        let isValidChain = true;
        let vCargo = {}; 
        
        for (let t of perm) {
            if (t.isChained) {
                let required = t.execC * t.reqA;
                // 선행 재료도 안 실었는데 후행 교환부터 하려는 바보 동선 즉시 폐기!
                if ((vCargo[t.fromClean] || 0) < required) {
                    isValidChain = false; break; 
                }
                vCargo[t.fromClean] -= required;
            }
            vCargo[t.toClean] = (vCargo[t.toClean] || 0) + (t.execC * t.mult);
        }

        if (!isValidChain) continue;

        // ⭐ 모든 경우의 수를 돌려보고 '과적 페널티'를 포함하여 시간이 가장 짧은 예술적 동선을 채택!
        let sim = simulateWeightsTemp(perm, normW);
        if (sim.totalTime < minTime) {
            minTime = sim.totalTime;
            bestRoute = perm;
        }
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

function simulateWeightsTemp(arr, norm) {
    let sw = 0; let tt = 0; let steps = []; let cp = getIslandCoords("일리야 섬");
    let cpName = "일리야 섬"; // ⭐ 이전 노드 이름 추적
    const shipSpeed = APP_CONFIG.SHIP_SPEED || 100;

    arr.forEach(t => {
        // 🧭 경유지: 사용 재료는 일리야에서 싣고 출발 → 출발무게에 합산 (0단은 소모무게 0 규칙 유지)
        if (t.isWaypoint) { if (t.consumed && t.consumed.tier !== 0) sw += t.consumed.count * getItemWeight(t.consumed.tier); return; }
        if(!t.isChained) sw += (t.fromTier !== 0 ? t.execC * t.reqA * getItemWeight(t.fromTier) : 0);
    });
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
            let wpMinus = (t.consumed && t.consumed.tier !== 0) ? t.consumed.count * getItemWeight(t.consumed.tier) : 0;
            cw = cw - wpMinus;
        } else {
            let wMinus = t.fromTier !== 0 ? (t.execC * t.reqA * getItemWeight(t.fromTier)) : 0;
            let wPlus = t.execC * t.mult * getItemWeight(t.toTier);
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
