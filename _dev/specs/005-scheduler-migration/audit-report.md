# SPEC-005 Evidence Audit

감사 범위: 이미 생성된 SPEC-005 코드·manifest·테스트·검증 보고서를 읽기 전용으로 대조했다. 테스트는 재실행하지 않았고, SPEC-006은 시작하지 않았다.

## 1. 42 protected functions

원본은 `BDO_물교_v1.0.html`이며, 위치는 해당 HTML의 1-based 줄 번호다. 확인 결과 42개 전부 원본 정의 수가 1이며 manifest의 선택 줄과 실제 유일 정의 줄이 같다. 따라서 중복 정의에서 첫 정의를 잘못 선택한 경우는 없다. 신규 파일과 함수명은 `migrate-functions.mjs`의 T002–T007 그룹 및 실제 추출 결과를 대조했다. 아래 해시는 현재 원본과 지정된 신규 함수 본문에서 다시 계산했다.

| 원본 함수명 | 원본 HTML 위치 | 중복 정의 | 브라우저 최종 정의 확인 | 신규 파일 | 신규 함수명 | 원본 정규화 SHA-256 | 신규 정규화 SHA-256 | 일치 |
|---|---:|---:|---|---|---|---|---|---|
| calculateTravelTime | 1202 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | calculateTravelTime | 27762a0a98744033f8210cd7d5cbcd9be330243ec924553a7632b4b48d76c3a1 | 27762a0a98744033f8210cd7d5cbcd9be330243ec924553a7632b4b48d76c3a1 | 예 |
| getItemTier | 2641 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/constants.js | getItemTier | f4b7a6aa5a3c83271cd082b042a80caa93c07e64e3639cb08ff4f25f14432202 | f4b7a6aa5a3c83271cd082b042a80caa93c07e64e3639cb08ff4f25f14432202 | 예 |
| getItemWeight | 2653 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/constants.js | getItemWeight | d73e6c65eb61abc5712c320289b7a95defd847826ce6cab65db408aa61fa3695 | d73e6c65eb61abc5712c320289b7a95defd847826ce6cab65db408aa61fa3695 | 예 |
| getIslandCoords | 2665 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | getIslandCoords | 1df08a5132dfb3273718b50f12c5ab3f4e9d78f94e08ac97445b2bebf546f276 | 1df08a5132dfb3273718b50f12c5ab3f4e9d78f94e08ac97445b2bebf546f276 | 예 |
| getPermutations | 2671 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | getPermutations | c4a76c91d075d07fa24172419593611dd45e220500440c0fc24252ea8369a169 | c4a76c91d075d07fa24172419593611dd45e220500440c0fc24252ea8369a169 | 예 |
| getOptimalRoute | 2682 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | getOptimalRoute | 2cf104fbfd9d7580a27f7b30181dc1bc3b7d300e266282c6d045736419ad5088 | 2cf104fbfd9d7580a27f7b30181dc1bc3b7d300e266282c6d045736419ad5088 | 예 |
| optimizeRouteTSP | 2720 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | optimizeRouteTSP | 45d15d8aafaee768ff417417851197320ee441a96ff3cf2a9affd95bb7c395af | 45d15d8aafaee768ff417417851197320ee441a96ff3cf2a9affd95bb7c395af | 예 |
| runAlgorithmAllModes | 2746 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/scheduler.js | runAlgorithmAllModes | 6afdc3baa884413255239d818850daed134433486d95fb437fda3a80bcb5aa5f | 6afdc3baa884413255239d818850daed134433486d95fb437fda3a80bcb5aa5f | 예 |
| sortFixedOcean | 3041 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | sortFixedOcean | ccfdb571b7a29a9a48d2d50c1bb08672c4c2e54a7b84bc9921849b0c17f70ec6 | ccfdb571b7a29a9a48d2d50c1bb08672c4c2e54a7b84bc9921849b0c17f70ec6 | 예 |
| getIslandRegion | 3086 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | getIslandRegion | 69dea3b4bd40dc07139d81a050ec652eaaf3aeef8fc4b9d63372ec9578f67daf | 69dea3b4bd40dc07139d81a050ec652eaaf3aeef8fc4b9d63372ec9578f67daf | 예 |
| getAllowedRegions | 3092 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | getAllowedRegions | 90561fad533315dcf6d42c9b2946d352f86a501f07c0818ea34b9f9db247cfc4 | 90561fad533315dcf6d42c9b2946d352f86a501f07c0818ea34b9f9db247cfc4 | 예 |
| buildSorties | 3102 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/scheduler.js | buildSorties | 27099ca18c62cf33a47365f8963d4503b8786d8fd0e455accbf02ae151b8ffdf | 27099ca18c62cf33a47365f8963d4503b8786d8fd0e455accbf02ae151b8ffdf | 예 |
| buildTier7Sorties | 4266 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/tier7.js | buildTier7Sorties | d0b960ebc6986afd6b08865ea928c78cd69ba59cf1063d13aa7ef55019481f23 | d0b960ebc6986afd6b08865ea928c78cd69ba59cf1063d13aa7ef55019481f23 | 예 |
| applyOceanCurrent | 4909 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | applyOceanCurrent | f96c27c731e6a17b389a42c9fcec72fd70531088129d5adcb80c479406cdb62c | f96c27c731e6a17b389a42c9fcec72fd70531088129d5adcb80c479406cdb62c | 예 |
| legDistance | 4932 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | legDistance | 1e9a98d7664ec49928b3096ad108fd9a1f0ceb87d1aadd8aef94adfa62e9bbb8 | 1e9a98d7664ec49928b3096ad108fd9a1f0ceb87d1aadd8aef94adfa62e9bbb8 | 예 |
| simulateWeightsTemp | 4949 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | simulateWeightsTemp | 70f68b7a73119cbea8834cca0ddb82a61f38da204e2c9e967d49ac631cb738c8 | 70f68b7a73119cbea8834cca0ddb82a61f38da204e2c9e967d49ac631cb738c8 | 예 |
| getDistToSegment | 6201 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | getDistToSegment | 705db8df521dd7722c06add3bce70b8be682ba08edacfaca2bf598191463376a | 705db8df521dd7722c06add3bce70b8be682ba08edacfaca2bf598191463376a | 예 |
| formatTimeExact | 4891 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/routing.js | formatTimeExact | 31c1bb3ab8d560ec0d99b8476de2f947701077bd48f1e60d0f4d872b3ff23137 | 31c1bb3ab8d560ec0d99b8476de2f947701077bd48f1e60d0f4d872b3ff23137 | 예 |
| routeDragStart | 5001 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | routeDragStart | 4aac03e7b638f21e1af64a2221765f67239f793bbd0f61312cb1d0f697f0fbf0 | 4aac03e7b638f21e1af64a2221765f67239f793bbd0f61312cb1d0f697f0fbf0 | 예 |
| routeDragEnd | 5002 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | routeDragEnd | 1f11e9c140cde8ef298d3ab3fdc8c0f107edd4cf825a3da4b20ec528944b6d96 | 1f11e9c140cde8ef298d3ab3fdc8c0f107edd4cf825a3da4b20ec528944b6d96 | 예 |
| routeDragOver | 5003 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | routeDragOver | 5a5892e838ebc63b9446c0e0db9810c850a67f68322b314f7a1ced442ffde687 | 5a5892e838ebc63b9446c0e0db9810c850a67f68322b314f7a1ced442ffde687 | 예 |
| routeDrop | 5006 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | routeDrop | d25415e28fa441c1c0c62b4b1afe263bbf2126e0b186019d598443282026a715 | d25415e28fa441c1c0c62b4b1afe263bbf2126e0b186019d598443282026a715 | 예 |
| adjustTradeCount | 5026 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | adjustTradeCount | e21be46221f0eb24f1fed0da6fd9304bd74af2b31b51d3747ed7030e75652e6b | e21be46221f0eb24f1fed0da6fd9304bd74af2b31b51d3747ed7030e75652e6b | 예 |
| completeTradeAndTimer | 5087 | 없음 (1) | 예, 유일 정의; runtime adapter가 원본을 보존·호출 | local_app/frontend/js/domain/completion.js | completeTradeAndTimer | 4add14e4cfa9e29e93a7a538f6a98d9d7fbbeff9e63d2a72fee19dd5ae1806ac | 4add14e4cfa9e29e93a7a538f6a98d9d7fbbeff9e63d2a72fee19dd5ae1806ac | 예 |
| rebuildSortieReq | 5111 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | rebuildSortieReq | ba3648a6cea9a3efd72e0e1a885e0c0b30a305e850e452143cc8c1fecb9bb213 | ba3648a6cea9a3efd72e0e1a885e0c0b30a305e850e452143cc8c1fecb9bb213 | 예 |
| applySortieRecompute | 5151 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | applySortieRecompute | a64db2bc029770b470ef49683b392cf13b135d4e936ebb5186a0086b6b2e1bac | a64db2bc029770b470ef49683b392cf13b135d4e936ebb5186a0086b6b2e1bac | 예 |
| mergeAdjacentDupTrades | 5168 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | mergeAdjacentDupTrades | 0f0a6df024872a8afda1d4acb94176376867513c340e62b95ede80eca8d5ded9 | 0f0a6df024872a8afda1d4acb94176376867513c340e62b95ede80eca8d5ded9 | 예 |
| toggleTimer | 5049 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/timer-ui.js | toggleTimer | 09552cd4d5802b21e09eb284efc7bf8b9ce5706c0cc05e5eb9f56404dce4e523 | 09552cd4d5802b21e09eb284efc7bf8b9ce5706c0cc05e5eb9f56404dce4e523 | 예 |
| renderWaypointCard | 5203 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/completion.js | renderWaypointCard | f32f391a3bd7b25d89adf3ed3d16d399e064b14230affbd21f422c1a1a28609e | f32f391a3bd7b25d89adf3ed3d16d399e064b14230affbd21f422c1a1a28609e | 예 |
| openWaypointModal | 5241 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/completion.js | openWaypointModal | bdaeb80cceb6b3b49beea417aac98cadf8968f2a39c1c32922e30d4172e74924 | bdaeb80cceb6b3b49beea417aac98cadf8968f2a39c1c32922e30d4172e74924 | 예 |
| closeWaypointModal | 5261 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/completion.js | closeWaypointModal | 3db2f1a638f6beec7b952dbfd791eb22c5a0256d1dbf13124b641836cd60a41c | 3db2f1a638f6beec7b952dbfd791eb22c5a0256d1dbf13124b641836cd60a41c | 예 |
| toggleWaypointMaterial | 5265 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/completion.js | toggleWaypointMaterial | 8f3ecfd62a0e96446bf8da992073cfcd9b1bb830628f252b838cae16e5378b07 | 8f3ecfd62a0e96446bf8da992073cfcd9b1bb830628f252b838cae16e5378b07 | 예 |
| confirmWaypoint | 5272 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/completion.js | confirmWaypoint | 10a47c947a9a5320568dd12f8b7cbef14af13412611651160b2444b1cc163de0 | 10a47c947a9a5320568dd12f8b7cbef14af13412611651160b2444b1cc163de0 | 예 |
| removeWaypoint | 5299 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/completion.js | removeWaypoint | 8ddd43ae6d9c2bbf34577d0be61c2920f53c757fdd7540bc9ded76a79f51b433 | 8ddd43ae6d9c2bbf34577d0be61c2920f53c757fdd7540bc9ded76a79f51b433 | 예 |
| completeWaypoint | 5312 | 없음 (1) | 예, 유일 정의; runtime adapter가 원본을 보존·호출 | local_app/frontend/js/domain/completion.js | completeWaypoint | 76755fa62e5f770e474f15cc755a12aa74a68e3d8e68f61500da6bd686459674 | 76755fa62e5f770e474f15cc755a12aa74a68e3d8e68f61500da6bd686459674 | 예 |
| toggleReturnTimer | 5341 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/timer-ui.js | toggleReturnTimer | ee7cb22ea15d9ab4209cd0328db471dd3193d42746b52deed4e521b6c85c0535 | ee7cb22ea15d9ab4209cd0328db471dd3193d42746b52deed4e521b6c85c0535 | 예 |
| playAlarmSound | 5428 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/completion.js | playAlarmSound | 8a9256a93c021c13b02a89802ff6de081eaa500447b42a99c854b0c319ff8db5 | 8a9256a93c021c13b02a89802ff6de081eaa500447b42a99c854b0c319ff8db5 | 예 |
| completeTrade | 5450 | 없음 (1) | 예, 유일 정의; runtime adapter가 원본을 보존·호출 | local_app/frontend/js/domain/completion.js | completeTrade | 545ad7e7629faac887251a2ac7a82f851146d9f047a6b8ada0b281c3d28d898e | 545ad7e7629faac887251a2ac7a82f851146d9f047a6b8ada0b281c3d28d898e | 예 |
| sortieDragStart | 6235 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | sortieDragStart | 29648fa450e80196c63c96b171bd82ec25968083dfbd77b806a6e671382adc95 | 29648fa450e80196c63c96b171bd82ec25968083dfbd77b806a6e671382adc95 | 예 |
| sortieDragEnd | 6240 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | sortieDragEnd | 4beac81deff23afcf69403219561d38e43939dd197b986d997f0e91f30a4e52f | 4beac81deff23afcf69403219561d38e43939dd197b986d997f0e91f30a4e52f | 예 |
| sortieDragOver | 6244 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | sortieDragOver | 894c24bbd2dd531cc2cdc13ea85683503bc7a4a2629ceb09c859591e621a3804 | 894c24bbd2dd531cc2cdc13ea85683503bc7a4a2629ceb09c859591e621a3804 | 예 |
| sortieDrop | 6247 | 없음 (1) | 예, 유일 정의 | local_app/frontend/js/domain/schedule-edit.js | sortieDrop | a10bca00cba05c7772e0d9eff9d2453893052b49dc4a6a72b52fd7e6029f42d5 | a10bca00cba05c7772e0d9eff9d2453893052b49dc4a6a72b52fd7e6029f42d5 | 예 |

### 정규화 방식 및 최종 정의

`local_app/tests/equivalence/source-tools.mjs`의 `normalizeFunctionBody` 규칙으로 함수 중괄호 안 본문만 해시했다. CRLF와 CR을 LF로 통일하고, 각 줄 끝의 space/tab을 제거하며, 본문 전체 앞뒤 whitespace를 `trim()`한 뒤 UTF-8 SHA-256을 계산한다. 줄 내부 indentation와 공백, 코드 순서, 문자열·숫자, 내부 주석은 그대로 해시에 포함한다. 함수명·매개변수 목록·선언 wrapper는 본문 범위 밖이라 해시하지 않는다. 따라서 줄바꿈과 바깥 공백 외의 알고리즘 변경을 숨기는 정규화는 아니다. 선언 wrapper/매개변수 변경 자체는 이 해시로 검증되지 않으므로 별도 선언/호출 검토 대상이다.

`capture-baseline.mjs`가 원본 정의 위치·개수와 선택된 마지막 정의를 manifest에 기록하고 `migrate-functions.mjs`가 `.at(-1)`을 선택하며 위치/개수를 재확인한다. 현재 원본에서는 42개 모두 정의 수 1이었다. 브라우저 런타임에서 `completeTrade`, `completeWaypoint`, `completeTradeAndTimer`는 `scheduler-runtime.js`의 adapter가 전역 함수를 감싼다. 이 세 함수의 원본 구현은 저장된 `original*` delegate로 보존되어 실제 호출된다. 전역 callable은 adapter wrapper인 점을 별도로 반영했다.

`verify-migration.mjs`는 8개 신규 domain 파일을 합쳐 각 원본 body hash가 존재하는지 확인하는 집계 검증이다. 이는 파일별 1:1·유일성 자체를 보장하는 assertion은 아니지만, 위 표는 매핑된 각 신규 파일 안에서 일치 body를 직접 찾아 다시 해시했다. 모든 42행이 일치한다. manifest의 보호 상수도 6개이며 검증기는 source declaration hash로 대조한다(검증 보고서 6/6).

## 2. Completion single-execution invariant

실제 일반 교환 호출 경로:

사용자 완료 클릭 → `schedule-ui.js`의 완료 버튼 listener → adapter `window.completeTradeAndTimer` → 저장된 원본 `completeTradeAndTimer` 1회 → 원본 함수의 `completeTrade(...)` 호출 → `window.completeTrade` adapter → 완료 대상/pending 검사 → 저장된 원본 `completeTrade` 1회 실행 → before/after 재고 차이로 delta 생성 → `persistPendingCompletion()` → `schedule-ui.js`의 `persistCompletion` → `saveCompletionInventory(payload)` → inventory PATCH.

Waypoint 완료 경로는 버튼 listener → `window.completeWaypoint` adapter → 완료 대상/pending 검사 → 저장된 원본 `completeWaypoint` 1회 → before/after 재고 차이로 delta 생성 → 같은 persistence adapter/API 경로다. `completeWaypoint` 계산은 trade algorithm과 별도의 waypoint 완료 처리다.

| 상황 | completion 계산 실행 수 | 근거 |
|---|---:|---|
| 유효한 일반 교환 완료 클릭 | 1회 (`completeTrade`) | runtime wrapper가 `original.apply(this,args)`를 한 번 호출. 원본 `completeTradeAndTimer`는 `completeTrade`를 한 번 호출함. |
| 유효한 waypoint 완료 클릭 | 1회 (`completeWaypoint`) | wrapper가 `originalWaypoint.call(...)` 한 번 호출. |
| 이미 completed 또는 다른 저장 pending 중 재클릭 | 0회 추가 | wrapper가 원본 호출 전에 반환. |
| 응답 유실 후 저장 재시도 | 0회 추가 | `retryCompletion`은 `persistPendingCompletion`만 호출하고 보관된 payload를 전달. |
| 409 revision conflict | 0회 추가 | 최신 재고를 읽고 `update.stock - before[name]` delta를 더한 재기준화 PATCH만 생성. completion 원본은 재호출하지 않음. |

응답 유실 때는 `pendingCompletion.payload` 객체를 유지하고 동일한 `mutationId`와 같은 JSON body로 다시 보낸다. 409는 다른 상황이다. `saveCompletionInventory`가 409 이후 bootstrap을 다시 읽고, `persistCompletion`이 현재 stock이 최초 목표값과 같은지 확인한다. 이미 반영된 값이면 재전송 없이 완료 처리한다. 값이 다르면 `delta = update.stock - before`로 계산하여 `current + delta`를 새 PATCH body에 넣고 최신 revision과 새 mutation ID를 사용한다. 즉 알고리즘 결과는 재사용하며 persistence가 충돌분을 rebase한다.

관련 근거: `schedule-ui.js:53,61,77-103,112-113`, `domain/scheduler-runtime.js:76-102,105-148`, `domain/completion.js:2-19,54-80,104-129`, `persistence.js:47-65`, `tests/browser_scheduler.mjs:92-106`. 기존 브라우저 테스트는 첫 PATCH 성공 직후 응답을 버리고 retry의 serialized body 2개가 완전히 같은지, inventory가 한 번만 반영됐는지, 완료 재클릭이 추가 PATCH를 내지 않는지를 assertion한다. **기존 테스트에 원본 completion 함수의 호출 횟수를 직접 계측하는 invocation counter assertion은 없다.** 1회 횟수 결론은 wrapper의 단일 원본 호출과 retry 경로를 코드에서 추적한 결과다. SPEC-005 브라우저 회귀는 response-loss는 실행하지만 completion PATCH의 409 rebase 자체는 직접 실행하지 않는다. 409 판단 역시 이번 감사에서는 코드 경로 확인이다.

## 3. Scheduler equivalence harness

확인 대상은 `local_app/tests/browser_scheduler.mjs:46-75`다. harness는 원본 `BDO_물교_v1.0.html`을 별도 Chrome target으로 열고 원본 페이지의 `runAlgorithmAllModes(true)`를 실행한다. 신규 앱은 별도의 앱 target/server context에서 `window.__bdoScheduleRuntime.generateSchedule(...)`를 실행한다. 양쪽의 알고리즘 구현은 각기 원본 HTML과 새 domain files에서 실행하며, 공통인 것은 테스트 코드의 동일 입력과 출력 projection 문자열뿐이다. 두 결과를 JSON 문자열 그대로 비교한다. 신규 helper 하나를 양쪽에 공유해 자기 비교하는 방식이 아니다.

| 항목 | 비교 여부 및 기준 |
|---|---|
| 시나리오 | inner 일반 교환, 까마귀 주화, 7단 연쇄 입력을 각각 같은 데이터로 양쪽 실행 |
| 쾌속/균형 결과 | 둘 다 `speed`, `balance`로 projection 후 비교 |
| sortie 순서 | 배열 순서를 보존하여 비교 |
| trade/route 순서 | 각 sortie의 `trades` 배열 순서를 보존하여 비교 |
| tier 7 chain | 7단 시나리오 입력이 두 단계 연결 교환이며 결과 trade 배열/필드를 비교 |
| weight/parley/time | `startWeight`, 각 trade `afterW`/`over`, `parleyUsed`, `totalTime`, `returnTime`, `returnOver` 포함 |
| route/trade 결과 | island, from/to, exec count, 요구량, 배수, 예상 시간, tier, coin/special/random coin, score/lack 포함 |
| 제거/정규화 | projection에서 위에 열거되지 않은 전체 객체 속성은 비교 대상에서 제외한다. 비교 필드는 반올림·정렬·허용오차 처리 없이 원값과 배열 순서를 유지하고 JSON 문자열을 exact 비교한다. |

판정: 서로 독립된 원본/신규 브라우저 실행을 대조하며 핵심 sortie/trade order, tier7, weight, parley, route 결과가 projection에 포함되어 있어 self-comparison은 아니다. 다만 모든 객체 속성을 비교하는 것은 아니며, 세 대표 시나리오 밖의 전체 입력 공간을 완전 증명하는 harness도 아니다. 보고서에 기재한 “정확 비교”는 projection 대상 필드의 정확 비교로 한정된다.

## 4. Root HTML git status

확인 결과:

| 확인 | 결과 |
|---|---|
| `git status --short -- BDO_물교_v1.0.html` | unstaged modified (`M`), staged 변경 없음 |
| `git diff -- BDO_물교_v1.0.html` | 127 insertions / 4 deletions; 변경 내용 있음 |
| `git diff --cached -- BDO_물교_v1.0.html` | 비어 있음 |
| 현재 파일 SHA-256 | `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76` |
| SPEC-005 equivalence manifest의 source SHA-256 | `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76` |
| 현재 파일 git blob / index 및 HEAD blob | `6c612764fdcf8101e12fa902bf7c0f8ab2399708` / `6bf214f2cdd70d56774d3bb25950c9cbcbf49218` |

현재 파일은 SPEC-005 manifest가 참조하는 원본 HTML과 byte-level SHA-256이 동일하지만 Git index/HEAD blob은 다르다. 따라서 baseline과 같다는 사실은 현재 Git 기준 파일과 같다는 뜻이 아니다. unstaged diff에는 SPEC-004 JSON paste/import 기능(붙여넣기 분기, `master_inventory_patch` 검토/적용 함수)과 스캔 review DOM id/context 변경이 보인다. 이 실제 내용 차이가 modified 상태의 직접 원인이다. Git은 `core.autocrlf=true`와 CRLF→LF 경고도 표시하지만, diff에 기능 코드 변경이 있으므로 개행 또는 파일 mode/metadata만으로 생긴 상태는 아니다. HEAD/index hash가 같고 cached diff가 비어 있어 staged 상태 차이도 아니다. reset/checkout/restore/clean은 수행하지 않았다.

## 5. Final audit verdict

**PASS — 기존 SPEC-005 PASS를 뒷받침함.**

42개 원본 최종 선택 본문과 신규 파일 본문 해시가 모두 일치하며, 원본의 중복 정의 문제는 발견되지 않았다. Completion 코드의 응답 유실 retry와 409 rebase 경로 모두 persistence만 재시도하고 완료 계산을 재호출하지 않는다. 다만 completion invocation counter assertion과 409 rebase 브라우저 실행 증거는 기존 산출물에 없다. 이는 직접 계측·실행 검증의 부재로 보고했으며, 정적 호출 경로는 invariant와 일치한다. 동등성 harness는 독립 원본 실행이며 명시된 projection 범위에서 결과를 정확 비교한다. 루트 HTML은 manifest 기준과 일치하고 Git상 수정 상태인 이유는 HEAD/index가 이전 내용이고 작업 트리에 SPEC-004 실제 변경 내용이 있기 때문이다.
