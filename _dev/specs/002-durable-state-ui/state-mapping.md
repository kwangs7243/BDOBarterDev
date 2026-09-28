# SPEC-002 영구 상태 매핑

이 문서는 기존 `BDO_물교_v1.0.html`의 저장 의미를 SPEC-001의 허용된 SQLite/API section에 연결한다. 기존 HTML의 localStorage를 자동 읽거나 신규 앱으로 복사하지 않는다.

| 기존 상태·저장 키 | SPEC-001 저장 위치 | 처리 |
|---|---|---|
| `inventory[name].stock`, `bdoInventoryState` | `inventory.stock` | 1~5단; NULL 미입력과 정수 0 보존 |
| `inventory[name].target`, `bdoInventoryState` | `inventory.target` | 품목별 목표 수량 |
| `bdoInventoryOrder` | `settings.inventoryOrder` 및 order API | 단계별 사용자 순서, 없는 이름은 기준 순서로 보충 |
| `tierRules`, `bdoTierRules` | `settings.tierRules` | 1~5단 기본 의미·수치 유지 |
| `bdoNormalWeight`, `bdoMaxWeight`, `bdoShipSpeed`, `bdoAllowOcean` | `settings.ship` | `normalWeight`, `maxWeight`, `speed`, `mode`; 기본 모드 문자열 유지 |
| `bdoShipPresets` | `settings.shipPresets` | 기존 네 슬롯 및 `{mode,nW,mW,speed}` 보존 |
| `bdoMaxParley` | `settings.parley.defaultBudget` | 새 회차 기본값만 저장; 진행 중 잔여 교섭력은 제외 |
| `bdoParleyPerTrade`, `bdoParleyCrow` | `settings.parley.normalCost`, `crowCost` | 일반/까마귀 비용 |
| `bdoTuneSpecPri` → `SPECIAL_MAT_PRIORITY` | `settings.tuning.specialMatPriority` | 숫자 그대로 |
| `bdoTuneCrowPri` → `CROW_COIN_PRIORITY` | `settings.tuning.crowCoinPriority` | 숫자 그대로 |
| `bdoTuneEffBonus` → `PATH_EFFICIENCY_BONUS` | `settings.tuning.pathEfficiencyBonus` | 숫자 그대로 |
| `bdoTuneEffPenalty` → `SMALL_TRADE_PENALTY` | `settings.tuning.smallTradePenalty` | 숫자 그대로 |
| `bdoTuneDist` → `CHAIN_MAX_DISTANCE` | `settings.tuning.chainMaxDistance` | 정수 의미 유지 |
| `bdoTuneScore` → `CHAIN_BONUS_SCORE` | `settings.tuning.chainBonusScore` | 정수 의미 유지 |
| `bdoTunePenWeight` → `DISTANCE_PENALTY_WEIGHT` | `settings.tuning.distancePenaltyWeight` | 실수 허용 |
| `bdoTuneOverload` → `OVERLOAD_PENALTY` | `settings.tuning.overloadPenalty` | 실수 허용 |
| `bdoTuneEffRadius` → `EFFICIENCY_THRESHOLD` | `settings.tuning.efficiencyThreshold` | 정수 의미 유지 |
| `bdoTunePitstop` → `ILIYA_PITSTOP_RADIUS` | `settings.tuning.iliyaPitstopRadius` | 정수 의미 유지 |
| `bdoTuneOverloadTimeWeight` → `OVERLOAD_TIME_WEIGHT` | `settings.tuning.overloadTimeWeight` | 실수 허용 |
| `bdoTuneDeficitBonus` → `DEFICIT_RATIO_BONUS` | `settings.tuning.deficitRatioBonus` | 숫자 그대로 |
| `bdoTuneEmergency` → `EMERGENCY_BONUS` | `settings.tuning.emergencyBonus` | 숫자 그대로 |
| `bdoTunePreservation` → `PRESERVATION_BONUS` | `settings.tuning.preservationBonus` | 숫자 그대로 |
| `bdoWestBias` → `WEST_BIAS` | `settings.tuning.westBias` | 정수 의미 유지 |
| `bdoUseClustering` → `USE_CLUSTERING` | `settings.tuning.useClustering` | **숫자 가중치**로 유지; Boolean 변환 금지 |
| `bdoTierPriority` → `TIER_PRIORITY` | `settings.tuning.tierPriority` | `T1`~`T5` 정수 점수 |
| `bdoExcludeSurplus` → `EXCLUDE_SURPLUS` | `settings.tuning.excludeSurplus` | 단계별 Boolean |
| `bdoCustomCoords` | `settings.navigation.coords` | 현재 적용 중인 사용자 좌표 |
| `window.routeCalibrations`, `bdoRouteCalibrations` | `settings.navigation.routeCalibrations` | 방향별 보정값 |
| `map_memos`, `bdoRouteMemos` | `settings.navigation.memos` | 활성 항로 메모 |
| `bdoMap_slot_1`~`bdoMap_slot_3` | `settings.mapSlots` | 명시적으로 저장한 지도 snapshot |
| `bdoMap_base` | `settings.mapBase` | 명시적으로 저장한 기본 지도; 앱 시작 때 자동 적용 금지 |
| `bdoViewerPanels` | `settings.viewer.panels` | 기존 여섯 panel ID별 위치·크기 |
| `bdoUiZoom` | `settings.viewer.uiZoom` | 화면 배율 |

## 저장하지 않는 상태

`scannedTrades`, 스케줄·완료 카드, 현재 회차 남은 교섭력, 타이머, 드래그/선택/hover, 모달, 지도 측정 중 경로와 입력 초안은 브라우저 메모리 또는 임시 UI 상태이며 API·SQLite로 보내지 않는다. `map_measuredRoutes`는 사용자가 map slot/base를 저장할 때 그 snapshot 안에 들어가는 경우만 영구화한다.

## 값 출처 및 초기화

기본값은 SPEC-001의 읽기 전용 reference catalog/초기 settings와 ARCHITECTURE §2, §4를 사용한다. 이 매핑은 레거시 사용자 저장값의 이전 작업이 아니다. 최초 앱 실행 시 기존 HTML의 수량·설정을 자동 복사하지 않는다.