/* SPEC-005 T004 FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */
function buildTier7Sorties(trades, oceanMode, weightMode) {
    let sorties = [];
    let remaining = trades.map(t => ({...t, currentC: t.count}));
    
    const normW = Number(document.getElementById('normalWeight').value) || 23000;
    const maxW = Number(document.getElementById('maxWeight').value) || 34996;
    const weightLimit = (weightMode === 'speed') ? normW : maxW;
    const maxP = parseInt(document.getElementById('maxParley').value) || 1009355;
    const perTradeP = parseInt(document.getElementById('parleyPerTrade').value) || 10644;
    const perTradeCrowP = parseInt(document.getElementById('parleyCrow').value) || 20000;
    
    let usedP = 0;
    const regions = { 
        east: ["하코번 섬", "아레하자 마을", "하코번", "아레하자"], 
        west: ["해모 섬", "달래나루", "해모"], 
        south: ["그란디하", "깊은 밤의 항구", "깊은 밤"] 
    };

    let targetRegions = [];
    if (oceanMode === 't7_3region') targetRegions = ['east', 'west', 'south'];
    else if (oceanMode === 't7_2region') targetRegions = ['east', 'west'];
    else if (oceanMode === 't7_2region_south') targetRegions = ['east', 'south'];
    else if (oceanMode === 't7_2region_arehazaX') targetRegions = ['west', 'south'];

    targetRegions.forEach(regKey => {
        if (usedP >= maxP) return;

        const regionalInventory = forecastWarehouseInventory(sorties);
        let s = { trades: [], reqItems: {}, parleyUsed: 0 };
        // 📑 [뷰어용 메타데이터 — 표시 전용] 7단 엔진은 1위 시드 대신 고정 지역(regKey)으로 출항을 가른다
        s.seedIsland = null;
        s.seedRegion = ({ east: '동부 7단', west: '서부 7단', south: '남부 7단' })[regKey] || regKey;
        s.allowedRegions = [s.seedRegion];
        let virtualT6Cargo = {}; let leg1Trades = [];
        let regTrades = remaining.filter(t => regions[regKey].includes(t.island) && t.toTier === 6 && t.currentC > 0);
        
        let maxT6Limit = Math.floor(weightLimit / 2000); 
        if(maxT6Limit < 1) return;

        let execCount = Math.min(maxT6Limit, regTrades.reduce((a, b) => a + b.currentC, 0));
        let needed5T = {}; let tempExec = execCount;
        
        regTrades.forEach(t => {
            if (tempExec <= 0) return;
            let take = Math.min(t.currentC, tempExec);
            needed5T[t.fromClean] = (needed5T[t.fromClean] || 0) + take;
            tempExec -= take;
        });

        let allowedT5 = ["필바라 섬", "푸자라 섬", "바레미 섬", "아지르 섬", "필바라", "푸자라", "바레미", "아지르"];
        if (regKey === 'south') {
            allowedT5.push("오르프스 섬", "발베쥬 섬", "나르보 섬", "파딕스 섬", "오벤 섬", "시오닐 섬", "라메다 섬", "오르프스", "발베쥬", "나르보", "파딕스", "오벤", "시오닐", "라메다");
        }

        let virtualT5Cargo = {};
        let localUsedWarehouseStock = {};

        let chain5TTrades = remaining.filter(t => t.toTier === 5 && allowedT5.includes(t.island) && needed5T[t.toClean] > 0 && t.currentC > 0);
        
        chain5TTrades.forEach(t => {
            let needed = needed5T[t.toClean];
            if (needed <= 0) return;
            
            let fromStock = regionalInventory[t.fromClean] ? regionalInventory[t.fromClean].stock : 0;
            let alreadyUsed = localUsedWarehouseStock[t.fromClean] || 0;
            let maxCanMake = Math.floor((fromStock - alreadyUsed) / t.reqA);
            
            let take = t.currentC; // ⭐ 분할 금지 원칙
            if (maxCanMake < take) return; // ⭐ 창고 재고가 5개 분량이 안 되면 1개 단위로 쪼개지 않고 아예 방문 포기!
            if (take <= 0 || usedP + s.parleyUsed + (take * perTradeP) > maxP) return;

            localUsedWarehouseStock[t.fromClean] = alreadyUsed + (take * t.reqA);

            leg1Trades.push({ ...t, execC: take, isChained: false });
            t.currentC -= take;
            needed5T[t.toClean] -= take;
            s.parleyUsed += (take * perTradeP);
            
            if (!s.reqItems[t.fromClean]) s.reqItems[t.fromClean] = { count: 0, tier: t.fromTier, isBase: t.fromTier === 0 };
            s.reqItems[t.fromClean].count += (take * t.reqA);
            virtualT5Cargo[t.toClean] = (virtualT5Cargo[t.toClean] || 0) + take;
        });

        regTrades.forEach(t => {
            if (execCount <= 0) return;
            let take = Math.min(t.currentC, execCount);
            
            let base5TStock = regionalInventory[t.fromClean] ? regionalInventory[t.fromClean].stock : 0;
            let used5T = localUsedWarehouseStock[t.fromClean] || 0;
            let available5T = (base5TStock - used5T) + (virtualT5Cargo[t.fromClean] || 0);
            
            take = Math.min(take, available5T); 
            if (take <= 0) return;

            let pCost = take * perTradeP;
            if (usedP + s.parleyUsed + pCost > maxP) return;

            let chainedAmount = Math.min(virtualT5Cargo[t.fromClean] || 0, take);
            let loadAtIlya = take - chainedAmount;
            
            leg1Trades.push({ ...t, execC: take, isChained: chainedAmount > 0 });
            if (chainedAmount > 0) virtualT5Cargo[t.fromClean] -= chainedAmount;
            
            if (loadAtIlya > 0) {
                localUsedWarehouseStock[t.fromClean] = used5T + loadAtIlya;
                if (!s.reqItems[t.fromClean]) s.reqItems[t.fromClean] = { count: 0, tier: 5, isBase: false };
                s.reqItems[t.fromClean].count += loadAtIlya;
            }

            t.currentC -= take; execCount -= take;
            s.parleyUsed += pCost;
            virtualT6Cargo[t.toClean] = (virtualT6Cargo[t.toClean] || 0) + take;
        });

        let currentStartW = 0;
        for (let itemName in s.reqItems) {
            let req = s.reqItems[itemName];
            currentStartW += (req.count * getItemWeight(req.tier, itemName));
        }
        let coinSpareWeight = normW - currentStartW; 

        // ⚠️ [7단 본대 보호] 4회 랜덤까주(isRandomCoin)는 본대(leg1) 고정 배차에서 제외 — 본대 예산(무게/교섭력)을 먹어
        //    7단 교환을 밀어내던 문제 차단. 이들은 remaining에 남아 finalRemains → buildSorties(Phase 2 재료쌓기)에서만 태운다.
        //    (일반 1회 까주·isOcean 까주는 그대로 본대 고정 노선 유지.)
        let coinTrades = remaining.filter(t => t.toTier === 'coin' && !t.isRandomCoin && t.currentC > 0);
        coinTrades.forEach(t => {
            let c = getIslandCoords(t.island) || {x:0, y:0};
            let isMatch = false;
            
            let isOceanSpecial = c.isOcean || t.island.includes('까마귀의 둥지') || t.island.includes('오킬루아');
            if (regKey === 'east') {
                if (c.x > 500 && Math.abs(c.y) < 1500) isMatch = true; 
            } else if (regKey === 'west') {
                if (isOceanSpecial || c.x < -500) isMatch = true;
            } else if (regKey === 'south') {
                if (c.y < -1000 || (c.x < -1000 && c.y < 500)) isMatch = true;
            }
            
            if (regKey === 'south') {
                if (allowedT5.includes(t.island)) isMatch = true;
            } else {
                if (t.island.includes('파딕스')) isMatch = false;
            }
            
            if (isMatch) {
                let take = t.currentC;
                
                let baseCoinMatStock = regionalInventory[t.fromClean] ? regionalInventory[t.fromClean].stock : 0;
                let usedCoinMat = localUsedWarehouseStock[t.fromClean] || 0;
                let availableCoinMat = baseCoinMatStock - usedCoinMat;
                let maxByInv = Math.floor(availableCoinMat / t.reqA);
                take = Math.min(take, maxByInv); 
                
                if (take <= 0) return;

                let itemW = getItemWeight(t.fromTier, t.fromClean) * t.reqA;
                if (itemW > 0) {
                    let maxCoinByW = Math.floor(coinSpareWeight / itemW);
                    take = Math.min(take, maxCoinByW);
                }

                while (take > 0 && usedP + s.parleyUsed + (take * perTradeCrowP) > maxP) take--;
                if (take <= 0) return;

                localUsedWarehouseStock[t.fromClean] = usedCoinMat + (take * t.reqA);

                leg1Trades.push({ ...t, execC: take, isChained: false });
                t.currentC -= take;
                s.parleyUsed += (take * perTradeCrowP);
                if (!s.reqItems[t.fromClean]) s.reqItems[t.fromClean] = { count: 0, tier: t.fromTier, isBase: t.fromTier === 0 };
                s.reqItems[t.fromClean].count += (take * t.reqA);
                
                currentStartW += (take * itemW); 
                coinSpareWeight -= (take * itemW);
            }
        });

        if (leg1Trades.length > 0) {
            let FIXED_OCEAN_ROUTE = [
                "할마드 섬", "카슈마 섬", "더코 섬", "오킬루아의 눈", "까마귀의 둥지",
                "파키오의 전투 뗏목", "떠돌이 상인의 배", "랑티니아의 전투 뗏목", 
                "떠내려온 미완성 선박", "그믐달 길드의 중범선", "숄라스 치코의 해적 연합", 
                "난파된 하란의 수송선", "까마귀 상단 소유의 선박", "난파된 고대 유적 수송선", "난파된 릭쿤의 배"
            ];

            if (oceanMode === 'ocean' || oceanMode === 't7_2region_south') FIXED_OCEAN_ROUTE.push("난파된 해상군의 배", "난파된 콕스해적선");
            else FIXED_OCEAN_ROUTE.push("난파된 콕스해적선", "난파된 해상군의 배");

            let t5Arr = []; let coinArr = []; let t6Arr = []; let otherArr = [];

            leg1Trades.forEach(t => {
                if (t.toTier === 5) t5Arr.push(t); 
                else if (t.toTier === 6 || t.toTier === 7) t6Arr.push(t);
                else if (t.toTier === 'coin') {
                    let cleanName = t.island.replace(/ 섬$/, '').replace(/\s/g, '').trim();
                    let idx = FIXED_OCEAN_ROUTE.findIndex(x => x.replace(/\s/g, '').includes(cleanName));
                    
                    if (idx !== -1) {
                        coinArr.push({t, idx: idx});
                    } else {
                        if (regKey === 'south') {
                            t5Arr.push(t);
                        } else {
                            otherArr.push(t);
                        }
                    }
                }
                else otherArr.push(t);
            });

            coinArr.sort((a, b) => a.idx - b.idx);
            leg1Trades = [
                ...optimizeRouteTSP(t5Arr), 
                ...coinArr.map(x => x.t),   
                ...optimizeRouteTSP(t6Arr),
                ...optimizeRouteTSP(otherArr)
            ];
        }

        const t7Nodes = ["올비아 해안", "에페리아 초소", "소산 주둔지 선착장", "성전 해안 정찰지", "일리야 섬", "레마 섬"];
        let pending7T = remaining.filter(t => t7Nodes.includes(t.island) && t.toTier === 7 && t.currentC > 0 && virtualT6Cargo[t.fromClean] > 0);
        let t7Arr = [];
        
        pending7T.forEach(t => {
            let availableT6 = virtualT6Cargo[t.fromClean] || 0;
            let take = Math.min(t.currentC, availableT6);
            while (take > 0 && usedP + s.parleyUsed + (take * perTradeP) > maxP) take--;
            if (take <= 0) return;

            t7Arr.push({ ...t, execC: take, isChained: true }); 
            s.parleyUsed += (take * perTradeP);
            t.currentC -= take;
            virtualT6Cargo[t.fromClean] -= take; 
        });

        if (t7Arr.length > 0) t7Arr = optimizeRouteTSP(t7Arr);

        // ⭐ [특례] 그란디하/깊은밤(남부 심해)에서 진입하는 출항에 한해, 7단 교환처가 올비아·에페리아면 에페리아 → 올비아 순서 강제.
        //    (optimizeRouteTSP는 일리야(0,0) 기준 최근접이라 올비아부터 잡지만, 실제론 서쪽 심해에서 진입 → 에페리아 먼저가 효율적. 체인은 그대로 유지.)
        let __goesDeepSouth = (leg1Trades || []).some(t => { let n = t.island || ''; return n.includes('그란디하') || n.includes('깊은 밤'); });
        if (__goesDeepSouth && t7Arr.length > 1) {
            let __hasEpe = t7Arr.some(t => (t.island || '').includes('에페리아'));
            let __hasOlb = t7Arr.some(t => (t.island || '').includes('올비아'));
            if (__hasEpe && __hasOlb) {
                const __rank = t => { let n = t.island || ''; return n.includes('에페리아') ? 0 : (n.includes('올비아') ? 2 : 1); };
                t7Arr = t7Arr.map((t, i) => ({ t, i })).sort((a, b) => (__rank(a.t) - __rank(b.t)) || (a.i - b.i)).map(x => x.t);
            }
        }

        s.trades = [...leg1Trades, ...t7Arr];

	// ⭐ [블랙박스 수집] 6/7단 메인 버스 승객들 "강제 배정" 영수증 일괄 발급!
        // 진공청소기가 돌기 전에, 본대 승객들이 어떻게 탔는지 먼저 기록해 줍니다.
        s.routingLogs = [];
        s.trades.forEach((t, idx) => {
            let reason = t.toTier === 'coin' ? "💰까주 고정 노선" : "🎯6/7단 특수 노선";
            s.routingLogs.push({
                fromIsland: idx === 0 ? "일리야 섬" : s.trades[idx-1].island,
                winner: t.island,
                top: [{ island: t.island, item: t.toClean, fitness: 9999999, math: `경합 면제 (${reason})` }],
                candidates: []
            });
        });

        if (s.trades.length > 0) {
            let hasViolations = true;
            while(hasViolations) {
                hasViolations = false;
                
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
                
                for (let k = 0; k < s.trades.length; k++) {
                    // ⭐ [박사님 의도 반영] 6/7단 본대 동선은 '쾌속'을 유지해야 하므로, 균형 모드라도 절대 normW(100%)를 넘지 못하게 엄격히 통제합니다!
                    if (finalSim.startW > normW || finalSim.stepData[k].afterW > normW) {
                        hasViolations = true; break;
                    }
                }
                
                if (hasViolations) {
                    let reduced = false;
                    for (let i = s.trades.length - 1; i >= 0; i--) {
                        let t = s.trades[i];
                        if (t.toTier === 7 && t.execC > 0) {
                            let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                            t.execC--; if (originalRef) originalRef.currentC++; reduced = true; break; 
                        }
                    }
                    if (!reduced) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            if (t.toTier === 6 && t.execC > 0) {
                                let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                                t.execC--; if (originalRef) originalRef.currentC++; reduced = true; break; 
                            }
                        }
                    }
                    if (!reduced) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            if (t.toTier === 'coin' && t.execC > 0) {
                                let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                                t.execC--; if (originalRef) originalRef.currentC++; reduced = true; break; 
                            }
                        }
                    }
                    if (!reduced) {
                        for (let i = s.trades.length - 1; i >= 0; i--) {
                            let t = s.trades[i];
                            // ⭐ [버그 픽스] 5단은 1개씩 빼는 게 아니라, 무게 위반 시 통째로(전부) 취소시켜야 분할 교환 참사가 안 일어납니다!
                            if (t.toTier === 5 && t.execC > 0) {
                                let originalRef = remaining.find(rt => rt.island === t.island && rt.toClean === t.toClean && rt.fromClean === t.fromClean);
                                let amt = t.execC;
                                t.execC = 0; 
                                if (originalRef) originalRef.currentC += amt; 
                                reduced = true; break; 
                            }
                        }
                    }
                    if (!reduced) break; 
                }
            }
            s.trades = s.trades.filter(t => t.execC > 0);
            s.parleyUsed = s.trades.reduce((sum, t) => sum + (t.toTier === 'coin' ? perTradeCrowP : perTradeP) * t.execC, 0);

            s.reqItems = {}; let vCargoFinal = {}; 
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
            Object.assign(s, { startWeight: finalSim.startW, totalTime: finalSim.totalTime, returnTime: finalSim.returnTime, returnOver: finalSim.returnOver });
            s.trades.forEach((t, i) => Object.assign(t, finalSim.stepData[i]));

            sorties.push(s); usedP += s.parleyUsed;
        }
    });

    let phase12Delta = {};
    sorties.forEach(s => {
        s.trades.forEach(t => {
            let gain = t.execC * t.mult; let cost = t.execC * t.reqA;
            if (t.fromTier !== 0) phase12Delta[t.fromClean] = (phase12Delta[t.fromClean] || 0) - cost;
            phase12Delta[t.toClean] = (phase12Delta[t.toClean] || 0) + gain;
        });
    });

    let finalRemains = remaining.filter(t => t.currentC > 0 && (t.toTier <= 5 || t.toTier === 'coin' || t.toTier === 'mat'));
    
    finalRemains.forEach(t => {
        if (t.toTier === 'coin') {
            t.score = APP_CONFIG.CROW_COIN_PRIORITY + (t.currentC * t.mult * 2);
            t.lack = 99; t.isUrgent = false;
            return; 
        } else if (t.toTier === 'mat') {
            // ⭐ [신규] 특수 재료 1, 2, 3순위 다이내믹 맵핑 (7단 엔진)
            let specBase = APP_CONFIG.SPECIAL_MAT_PRIORITY || 80000;
            if (specBase >= 140000) {
                t.score = 500000 + specBase;   // 🥇 1순위 (긴급 보존보다 최우선)
                t.isUrgent = true;
            } else if (specBase >= 50000) {
                t.score = 100000 + specBase;   // 🥈 2순위 (일반 결핍 재료보다 우선)
                t.isUrgent = false;
            } else {
                t.score = 10000 + specBase;    // 🥉 3순위 (잉여 줍줍보다만 우선)
                t.isUrgent = false;
            }
            t.lack = 99; 
            return; 
        }

        let toInv = inventory[t.toClean];
        let effectiveTarget = toInv ? toInv.target : 0; 
        let virtualStock = (toInv ? toInv.stock : 0) + (phase12Delta[t.toClean] || 0);
        let lack = effectiveTarget - virtualStock;
        
        if (lack > 0) { 
            let score = lack * 100;
            let targetAmt = effectiveTarget > 0 ? effectiveTarget : Math.max(1, lack);
            score += Math.floor((lack / targetAmt) * (APP_CONFIG.DEFICIT_RATIO_BONUS || 3000));
            
            if (t.toTier === 1) score += APP_CONFIG.TIER_PRIORITY.T1;
            else if (t.toTier === 2) score += APP_CONFIG.TIER_PRIORITY.T2;
            else if (t.toTier === 3) score += APP_CONFIG.TIER_PRIORITY.T3;
            else if (t.toTier === 4) score += APP_CONFIG.TIER_PRIORITY.T4;
            else if (t.toTier === 5) score += APP_CONFIG.TIER_PRIORITY.T5;

            if (t.toTier >= 1 && t.toTier <= 4 && virtualStock <= (parseInt(tierRules[t.toTier])||20)) {
                score += (APP_CONFIG.PRESERVATION_BONUS || 3000); t.isUrgent = true;
            } else if (t.toTier === 5 && virtualStock < (parseInt(tierRules[5])||1)) {
                score += (APP_CONFIG.EMERGENCY_BONUS || 10000); t.isUrgent = true;
            } else { t.isUrgent = false; }
            t.score = score; t.lack = lack;
        } else {
            t.score = -999999; t.lack = 0; t.isUrgent = false;
        }
    });

// =========================================================================================
    // ⭐ [V12.100+ 궁극의 6/7단 전용 진공청소기 귀환 모듈 (Vacuum Return)] ⭐
    // 6/7단 메인 동선을 100% 보호한 상태에서, 돌아오는 빈 배에 하위 잉여 재료를 TSP로 정렬해 꽉꽉 채워 넣습니다!
    // =========================================================================================
    // ⭐ [구두쇠 메타 완벽 적용] 5단은 줍줍 명단에서 아예 제외! 1~4단 하위 재료 중에서도 목표량을 못 채운(10만 점 이상, 1/2순위) 알짜배기만 귀환길에 줍습니다!
    // ⚠️ [줍줍 제외 결정] 특수재료·4회 랜덤까주는 귀환 진공청소기에 넣지 않는다. 이유: vacuum은 1개씩 줍고(addAmt=1)
    //    【5】의 reserve/뭉태기 게이트를 우회하며(7단에선 Phase 2보다 먼저 돌아 규칙을 완전히 건너뜀), 코인 parley를
    //    perTradeP로 오계산한다. → 이 둘은 Phase 2 재료쌓기 국면(【4】+【5】)에서만 태운다. (Node 시뮬 근거)
    let validRemainsForVacuum = finalRemains.filter(t => t.currentC > 0 && t.toTier >= 1 && t.toTier <= 4 && t.score >= 100000);
    
    sorties.forEach(s => {
        if (s.trades.length === 0 || usedP >= maxP) return;

        let originalTrades = [...s.trades]; 
        let tailTrades = []; 
        let lastHostTrade = originalTrades[originalTrades.length - 1];
        
        // ⭐ [칼퇴근 보장 픽스] 마지막 교환처가 '일리야 섬'이면 퇴근길(귀환) 자체가 없으므로 줍줍을 아예 포기합니다!
        let isLastIslandIliya = lastHostTrade.island.includes('일리야');
        if (isLastIslandIliya) return; 

        let lastPos = getIslandCoords(lastHostTrade.island) || {x: 0, y: 0};
        let addedSomething = true;

        while (addedSomething && usedP < maxP) {
            addedSomething = false;
            validRemainsForVacuum.sort((a,b) => b.score - a.score);

            // ⭐ [블랙박스 수집] 귀환길 줍줍(진공청소기) 경합 과정 추적 영수증 발급!
            let curTailIsland = tailTrades.length > 0 ? tailTrades[tailTrades.length - 1].island : lastHostTrade.island;
            let stepLog = { fromIsland: `${curTailIsland} ➔ 🏠귀환길`, candidates: [] };

            for (let i = 0; i < validRemainsForVacuum.length; i++) {
                let cand = validRemainsForVacuum[i];
                if (cand.currentC <= 0) continue;
                
                let candCoords = getIslandCoords(cand.island) || {x: 0, y: 0};
                let vacuumRadius = APP_CONFIG.EFFICIENCY_THRESHOLD || 400;
                let distToReturnPath = getDistToSegment(candCoords.x, candCoords.y, lastPos.x, lastPos.y, 0, 0);
                
                // ⭐ [역주행 방지 픽스]
                let isSameHemisphere = false;
                if (lastPos.x >= 0 && candCoords.x >= -150) isSameHemisphere = true; 
                if (lastPos.x < 0 && candCoords.x <= 150) isSameHemisphere = true;   
                
                // 영수증용 기록 객체 생성
                let candLog = { island: cand.island, item: cand.toClean, fitness: cand.score, math: "" };

                if (distToReturnPath <= vacuumRadius && isSameHemisphere) {
                    let addAmt = (cand.toTier === 5) ? cand.currentC : 1;
                    let pCost = perTradeP * addAmt; 
                    if (usedP + pCost > maxP) {
                        candLog.fitness = -9999; candLog.math = `탈락 (교섭력 부족)`;
                        stepLog.candidates.push(candLog);
                        continue;
                    }

                    let existing = tailTrades.find(t => t.island === cand.island && t.toClean === cand.toClean);
                    if (existing) existing.execC += addAmt; 
                    else tailTrades.push({ ...cand, execC: addAmt, isChained: false });
                    
                    let optimizedTail = optimizeRouteTSP(tailTrades); 
                    let testTrades = [...originalTrades, ...optimizedTail];
                    
                    let vCargo = {};
                    let tempReqItems = {};
                    testTrades.forEach(t => {
                        let required = t.execC * t.reqA;
                        let currentStock = vCargo[t.fromClean] || 0;
                        if (currentStock >= required && t.fromTier !== 0) {
                            t.isChained = true; vCargo[t.fromClean] -= required;
                        } else { 
                            t.isChained = false; 
                            if (t.fromTier !== 0) tempReqItems[t.fromClean] = (tempReqItems[t.fromClean] || 0) + required;
                        }
                        vCargo[t.toClean] = (vCargo[t.toClean] || 0) + (t.execC * t.mult);
                    });

                    let sim = simulateWeightsTemp(testTrades, normW);
                    let isValid = true;
                    if (sim.startW > normW) isValid = false; 

                    let origLen = originalTrades.length;
                    for (let k = 0; k < testTrades.length; k++) {
                        if (k < origLen) {
                            if (sim.stepData[k].afterW > normW) { isValid = false; break; }
                        } else {
                            if (sim.stepData[k].afterW > wLimit) { isValid = false; break; }
                        }
                    }

                    const candidateSorties = sorties.map(host => host === s ? {...host, trades:testTrades} : host);
                    if (!validateSortieSequence(candidateSorties).valid) isValid = false;

                    if (isValid) {
                        // ⭐ 최종 합격! 영수증 철하기
                        candLog.math = `🧲합승 성공 (길목:${Math.floor(distToReturnPath)}px, 무게통과)`;
                        stepLog.winner = cand.island;
                        stepLog.candidates.push(candLog);

                        tailTrades = optimizedTail; 
                        cand.currentC -= addAmt; cand.lack -= addAmt; 
                        usedP += pCost; s.parleyUsed += pCost;

                        for (let key in tempReqItems) {
                            if(!s.reqItems[key]) s.reqItems[key] = { count: 0 };
                            s.reqItems[key].count = tempReqItems[key];
                        }
                        addedSomething = true; break; 
                    } else {
                        // ⭐ 무게 초과/재고 부족 탈락 영수증 철하기
                        candLog.fitness = -9999; candLog.math = `탈락 (마감무게 초과 or 재고부족)`;
                        stepLog.candidates.push(candLog);

                        if (existing) existing.execC -= addAmt;
                        else tailTrades.pop();
                    }
                } else {
                    // ⭐ 거리/방향 탈락 영수증 철하기 (너무 많으면 도배되니까 상위 3개만 기록)
                    if (stepLog.candidates.length < 3) {
                        candLog.fitness = -9999;
                        let failReason = !isSameHemisphere ? "반대편 바다" : `반경 이탈(${Math.floor(distToReturnPath)}px)`;
                        candLog.math = `탈락 (${failReason})`;
                        stepLog.candidates.push(candLog);
                    }
                }
            }

            // ⭐ 스텝 로그 최종 푸시
            if (stepLog.candidates.length > 0) {
                stepLog.top = stepLog.candidates.slice(0, 4); // 화면에 보여줄 개수
                s.routingLogs = s.routingLogs || [];
                s.routingLogs.push(stepLog);
            }
        }

        if (tailTrades.length > 0) {
            s.trades = [...originalTrades, ...tailTrades];
            s.reqItems = {}; let vCargoFinal = {}; 
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
            s.startWeight = finalSim.startW; s.totalTime = finalSim.totalTime;
            s.returnTime = finalSim.returnTime; s.returnOver = finalSim.returnOver; 
            s.trades.forEach((t, idx) => Object.assign(t, finalSim.stepData[idx]));
        }
    });
    
    finalRemains = finalRemains.filter(t => t.currentC > 0);
    // =========================================================================================
    // =========================================================================================

    if (finalRemains.length > 0 && usedP < maxP) {
        let maxPEl = document.getElementById('maxParley');
        let originalMaxP = maxPEl.value;
        const originalInventory = inventory;
        inventory = forecastWarehouseInventory(sorties, originalInventory);
        try {
            maxPEl.value = Math.max(0, maxP - usedP); 
            let leftoverSorties = buildSorties(finalRemains, weightMode);
            sorties.push(...leftoverSorties);
        } finally {
            maxPEl.value = originalMaxP; 
            inventory = originalInventory;
        }
    }

    const validation = validateSortieSequence(sorties);
    if (!validation.valid) throw new Error(`출항별 재고 계산이 맞지 않습니다: ${JSON.stringify(validation.issues[0])}`);
    return { sorties: sorties };
}

window.__SPEC005_SCRIPT_LOADED = window.__SPEC005_SCRIPT_LOADED || {}; window.__SPEC005_SCRIPT_LOADED["tier7.js"] = true;
