# Trade Capture / Recognition Design

## Engine 결정 경계

최종 구조는 local fields + catalog constraint + numeric evidence + existing importer다. 현재 폐기 실험에서 숫자 confidence/coverage를 확보하지 못했으므로 OCR 제품/runtime는 확정하지 않는다. Trade는 기존 Warehouse 개선과 달리 현재 앱에 없는 신규 기능이다. 공통 T001/T002/T003/T005 이후 T010A의 정해진 geometry/숫자 후보 측정은 Warehouse T006과 독립적으로 가능하며 T009 auto apply를 기다리지 않는다. 추가 OCR/runtime 후보 실행 T010B는 concrete experiment-selection이 필요하고 T011 production integration은 Sol engine-selection/holdout 승인 전 착수하지 않는다. 이것은 UI/DTO 설계 미정이 아니라 필요한 실제 데이터/engine 비교 결과의 부재다.

## Batch and field contracts

CaptureBatch는 `{version:1,batchId,taskType:"trade",mode:"new"|"append",startedAt,contextGuard,captureIds,rows,completionState}`. `contextGuard={sessionId,sessionRevision,baseRevision,tradeListHash}`는 시작 시 snapshot이다. batch 자체는 UI 세션 초안이고 working_session/saved slots에 넣지 않는다. 현재 회차 교체는 기존 new-mode 확인 의미를 유지한다. 사용자 명시적 완료 버튼 전에는 trade 목록을 변경하지 않는다.

`recognize_trade(capture,profile,engine_bundle) → TradeReportV2{version,recognitionId,captureId,batchId,rows,validity,automationDecision,layout,quality,timing,engineVersion,engineHash,modelVersion,modelHashes,parameterHash,profileHash,catalogHash,anchorSetHash,policyHash}`.

각 row는 `{rowId,ordinal,box,clipped,fields,automationDecision,reasonCodes}`. fields에는 island/fromItem/toItem/reqAmount/count/yield가 **전부** 있다. 각 field는 `{rawText,candidates,value,status,readerEvidence,cropHash}`. value 없는 field는 null+MISSING/UNREADABLE/AMBIGUOUS/CLIPPED/UNVERIFIED다. icon/tier/crow indicator는 증거 field로 따로 두고 없는 숫자를 대체하지 않는다.

candidate는 value+sourceReader+score+scoreDirection+catalogScope. string 정규화는 원문을 보존한 별도 값이다. `yield`/`reqAmount`는 positive safe integer, count는 nonnegative safe integer만 confirmed. bool/float/음수/부분 숫자/공백을 숫자 regex로 정수화하지 않는다. unreadable count=0, reqAmount=1, yield=1의 defaults는 금지한다.

canonical importer 입력은 `{island:string,fromItem:string,toItem:string,reqAmount:int>=1,count:int>=0,yield:int>=1}`로 정확히 한 번 구성한다. 6필드가 모두 CONFIRMED/HIGH인지 `validateRecognitionTradeRow`로 확인한 행만 importer에 보낸다. partial objects는 importer에 보내지 않는다.

## Geometry and recognition

panel anchor → visible rows/separators → column lane → text/icon/quantity crops. row-relative normalized column geometry를 profile에 저장하고 현재 anchor/scale로 변환한다. 잘린 상/하단 row는 CLIPPED, row count가 oracle와 맞는 것만으로 field recognition 성공으로 세지 않는다.

섬/품목 OCR는 candidates를 만드는 증거다. masterData/specialItems/islands 세 집합을 현재 catalog에서 읽는다. fuzzy 후보는 기존 getSafeUniqueItemMatch의 0.75 단일 후보 규칙을 최소 제한으로 유지한다. 불일치/복수/ellipsis prefix 다중 후보는 REVIEW다. 섬은 tier별 forceMatch 전에 증거 기반 unique canonical을 확정하며 그렇지 않으면 importer 호출을 보류한다. existing getBestMatch가 바꾼 결과가 인식 canonical과 다르면 자동 적용을 취소한다.

icon evidence는 reference에 실제 있는 품목만 사용한다. 마스터 창고 70종으로 6/7단·특수/육지 재료를 모두 판별한다고 가정하지 않는다. 0→1 fromItem은 기존 raw-name contract를 유지하고 closed catalog로 잘못 대체하지 않는다. approved land-item text evidence가 없는 새로운 이름은 REVIEW다.

req/yield는 현재 창고 four-cell reader의 geometry와 별도 subsystem이다. row 숫자 token, fraction/quantity 표현, 주변 x/tier/잔여 count와 lane별 box를 구분한다. 까마귀 주화와 일반 yield를 별도 calibration stratum으로 둔다. 교환 종류로 yield를 추정하지 않는다.

## Merge contract

`mergeRecognitionRows(captures,catalog) → {orderedRows,duplicates,heldConflicts,unresolvedRows}`. sourceImageHash는 동일 PNG 재입력 안내용이며 semantic dedup 대신 쓰지 않는다. identity는 canonical island/toItem/fromItem tuple. 풀 payload는 6필드 tuple이며 정상적인 동일 거래의 숫자값도 같아야 overlap duplicate로 제거한다.

1. 잘린/미확정 row는 제거해서 정상이라고 세지 않고 unresolvedRows에 남긴다.
2. 확인된 각 capture의 row 순서는 그대로 유지한다.
3. 인접 captures의 최대 exact suffix-prefix overlap을 찾는다. 반복되는 동일 identity 때문에 overlap 후보가 여러 개면 order REVIEW다.
4. 공통 row가 없으면 촬영 순서대로 이어붙이되 list completeness는 UNKNOWN이다. 게임 목록 전체를 찍었다고 주장하지 않는다.
5. 같은 identity/같은 6필드 row는 1개로 합치고 모든 source rowId를 보존한다. 같은 identity인데 count/req/yield가 다르면 FRAME_STATE_CONFLICT; 마지막 capture 값으로 덮어쓰지 않는다.
6. 같은 island/to에 다른 from은 기존 conflict candidate. upstream hold와 processParsedTrades conflict를 모두 기록한다.

새 capture 사이에 게임 회차 변경/교환 실행 여부를 자동 추측하지 않는다. 숫자 conflict/목록 header 상태 변경은 batch 재시작 또는 사용자 선택 대상이다. 자동 스크롤은 없다. 기존 회차에 append할 때 같은 identity지만 다른 숫자가 관찰되면 importer의 단순 duplicate 스킵 전에 REVIEW하여 새 값이 사라진 것을 정상 생성이라고 보고하지 않는다.

## Existing importer integration

`prepareRecognizedTradeImport(batch,previous,catalog)`는 위 merge/field gate 후 `processParsedTrades(confirmedDTOs, previous, catalog)`를 직접 호출한다. 결과 outcomes의 accepted/duplicate/conflict/held/ambiguous/unmatched를 원본 rowId에 연결한다. imported accepted DTO 6필드가 recognized DTO와 다른지 비교한다. 이름이 예상치 않게 보정되거나 숫자가 기본값으로 바뀌면 HIGH 취소다.

기존 trade-ui.js의 session 생성·invalidation 로직을 작은 공통 helper로 추출한다. protected processParsedTrades는 수정하지 않는다. 기존 JSON reviewExcludedTrades를 재사용할 수 있도록 row metadata/crop은 UI 외부 map으로 전달하며 DTO에 넣지 않는다.

`commitRecognizedTrades(prepared,{mode,guard}) → Promise<{revision,sessionId,outcomes}>`: persistence idle 대기 → pending completion 없음 확인 → guard/DB revision 재확인 → candidate session 구성 → 기존 PUT working-session queue로 저장 → 성공 응답 후 UI에 반영/렌더. 실패는 기존 작업 회차와 draft를 유지한다. `api.saveWorkingSession`/`saveWorkingSession()`/`whenPersistenceIdle`와 backend PUT `/api/working-session`은 현재 존재함을 code로 재검증했다. `saveWorkingSessionSnapshot(candidate)`는 **T011 신규 helper**로 기존 queue/envelope를 재사용한다. queue 실행 안에서 captured guard를 다시 확인하고 동일 mutationId/body/baseRevision을 pending intent에 고정해 응답 유실 재클릭이 새 mutation을 만들지 않게 한다. 현재 enqueueMutation의 자동 신규 ID 동작이 이 안전성을 이미 제공한다고 가정하지 않는다. committed read-back 실패는 저장 성공과 UI 재조회 실패를 나눠 표시하고, 기존 PUT의 동일 envelope 재전송이 receipt replay 검증 경로이며 별도의 기존 receipt 조회 API가 있다고 가정하지 않는다. response loss 뒤 current revision 재조회만으로 commit 성공을 추정하지 않는다. main receipt가 만료해 동일 요청 replay를 확증할 수 없으면 COMMIT_UNKNOWN으로 보류한다. JSON의 기존 이벤트 저장 동작을 중복 dispatch하지 않는다.

새 회차는 기존 영구 ship/parley/tuning 깊은 복사, remainingParley/defaultBudget, UUID 생성 규칙을 재사용한다. append에서는 schedule/completed/diagnostics를 기존 invalidation 의미대로 처리한다. disabled/deleted·저장 slot·타이머·completion 알고리즘은 바꾸지 않는다. 결과 추가 0이면 기존 회차를 지우지 않는다. review/commit 동안 session/list/revision이 달라지면 STALE_BATCH로 보류하며 importer 재실행/자동 대체를 하지 않는다.

모든 row HIGH이고 importer 결과 accepted 또는 exact duplicate이며 added>0일 때만 완료 클릭 뒤 검토창 없이 목록을 만든다. 일부 REVIEW가 있으면 정상 행은 draft에 보관하고 예외만 보여주되 전체 batch commit은 확인 완료까지 보류한다. 사용자가 unresolved row를 명시적으로 제외하면 그 선택과 불완전 목록 상태를 진단에 남긴다. 이 수동 제외를 touchless/full-capture exact 성공으로 세지 않는다.

## New feature usability / workload

capture → rows → catalog/strict six-field gate → ambiguous/unreadable/partial/conflict 행만 확인 → 사용자 batch 완료 → 기존 importer/session 생성. 첫 목표는 사용자 완료 클릭 후 회차 생성이며 unattended auto apply 권한을 요구하지 않는다. 일부 정상 행은 draft에 유지하고 예외만 수정하되 whole batch commit은 예외 해결/명시 제외 뒤다. file/clipboard와 사용자가 scroll→capture한 stream frame은 같은 batch/row provenance를 유지하며 game input은 하지 않는다. JSON/manual row 편집 fallback은 계속 제공한다.

T010 experiment에 source/profile validity·columns·digit/crow strata·Early Evidence Store를 사용한다. T011은 engine freeze 및 independent holdout 이후 merge→import→DB-first commit만 구현하며 후보를 새로 선택하지 않는다. workload는 batch/confirmed rows/review/rejected/partial/edited fields/fully labeled full-list exact를 보고한다. 숫자0/1default를 끼워 coverage를 올리거나 incomplete 목록을 full-list exact로 세지 않는다.
