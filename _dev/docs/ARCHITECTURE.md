# BDO 물물교환 localhost 재구성 최종 상세 설계서

## 2026-09-26 현재 구현 계약 — SPEC-007

사용자 확정 답변으로 종전 회차 비영속·스케줄 슬롯 제거·3-table 계약을 대체한다. [SPEC-007](../specs/007-feature-restoration/spec.md)이 현재 저장 계약이다. 아래 원설계의 회차 제외 관련 문단은 이전 결정의 기록이며 현행 규칙으로 적용하지 않는다. 원설계의 계산 보존, localhost, scanner, 기준 소스 보호 및 타이머 복원 제외는 유지한다.

| 상태 | 현재 정본 | 복원/초기화 |
|---|---|---|
| 재고·순서·설정·선박 프리셋·지도 | inventory/settings | 재실행 복원, 회차 초기화 시 유지 |
| 목록·쾌속/균형·완료·교섭력·당시 설정·ENGINE_DEBUG | working_session 한 행 | 첫 앱 진입 복원, 확인된 회차 초기화 시 삭제 |
| 스케줄 보관 1~5 | saved_schedule_slot | 독립 깊은 복사, 회차 초기화 시 유지, 개별 삭제 |
| 타이머·drag·열린 dialog·입력 초안 | 브라우저 메모리 | 회차 복원 시 초기화 |

SQLite schema 1→2는 기존 값을 유지하며 working_session, saved_schedule_slot, mutation_receipt를 추가한다. 반복 초기화도 기존 값을 덮지 않는다. mutation_receipt는 최근 128개 요청의 id/hash/revision만 보관하며 회차 이력이 아니다. 지원하지 않는 미래 schema는 실패하며 초기화하지 않는다.

bootstrap은 한 read transaction에서 영구 상태와 workingSession/sessionRevision/scheduleSlots를 반환한다. PUT/DELETE /api/working-session 및 PUT/DELETE /api/schedule-slots/<1..5>를 추가한다. POST /api/working-session/completion은 재고 최종값과 완료된 회차를 한 transaction에 저장한다. 원본 계산은 브라우저에서 한 번 실행하며 backend는 재계산하지 않는다. 응답 유실 재시도는 동일 요청으로 중복 커밋을 방지한다. 실제 409 때 저장 회차 revision/id가 동일한 재고 변경만 원본 완료 차이를 합산하고, 다른 회차 변경은 거부한다.

새 회차는 영구 선박/교섭/튜닝 설정의 깊은 복사로 시작한다. 임시 튜닝은 회차 설정에만, 영구 튜닝은 다음 새 회차 기본값에 저장한다. 슬롯 불러오기는 당시 회차 맥락을 복원하되 현재 영구 재고와 설정을 덮지 않는다. 앱 일반 재조회는 작업 중인 회차 사본을 자동 덮지 않는다.

## 원설계 기록 (개정된 제외 결정은 위 계약 우선)

## 1. 권장 최종 아키텍처

### 1.1 최종 구성

```text
사용자: BDO 물교 실행.exe 더블클릭
                 │
                 ▼
Python 로컬 서버 시작
127.0.0.1:18765에만 연결 허용
                 │
                 ▼
기본 브라우저 자동 열기
http://127.0.0.1:18765/
                 │
       ┌─────────┴─────────┐
       ▼                   ▼
Frontend                Python API
HTML/CSS/JS             저장·검증·업로드
       │                   │
기존 JS 알고리즘          ├─ SQLite: 영구 데이터
현재 회차 메모리          └─ warehouse_patch.convert()
```

`18765`는 권장 고정 포트다. 구현 단계에서 실제 점유 여부를 확인한다. 다른 프로그램이 사용 중이면 임의로 종료하거나 조용히 다른 포트로 변경하지 않고, 실행창에서 충돌을 알린다.

| 영역 | 최종 선택 | 역할 |
|---|---|---|
| 서버 | Python + Flask + Waitress | 정적 파일 제공, API, 저장, 창고 스캔 |
| Frontend | 일반 HTML/CSS/JavaScript | 기존 화면과 계산 로직 이관 |
| 영구 저장 | SQLite 단일 파일 | 재고·순서·설정·지도 사용자 데이터 |
| 현재 회차 | 브라우저 메모리 | 물교 목록·스케줄·완료 상태·남은 교섭력 |
| 기준 자료 | 읽기 전용 JSON·아이콘·숫자 템플릿 | 기존 reference와 scanner 그대로 사용 |
| 배포 | Windows 폴더형 패키지 + 실행 파일 하나 | Python 설치나 명령어 입력 없이 실행 |

Waitress는 Windows를 지원하며 단일 프로세스에서 여러 요청을 처리할 수 있다. 개발용 서버 대신 패키지 내부에서 직접 시작한다. [Flask 공식 Waitress 안내](https://flask.palletsprojects.com/en/stable/deploying/waitress/)

Frontend와 API는 같은 서버에서 제공한다. 별도 Frontend 개발 서버, CORS 설정, Node.js 런타임은 최종 사용자에게 필요하지 않다.

### 1.2 실제 조사 기준

현재 기준 파일은 [BDO_물교_v1.0.html](D:/Codex_물교_v14.1_범위고정_통합수정_회귀검증팩_20260923/BDO_물교_v1.0.html)이며, 약 520KB·8,336줄이다.

| 대상 | 현재 확인 결과 |
|---|---|
| `VERSION` | `1.0` |
| 현재 HTML SHA-256 | `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76` |
| `warehouse_patch.py` SHA-256 | `aa72ed5763c76a030ab4c8ffbc00fb23bf8ed4c391f9d1de8659395d76579fe8` |
| `reference/barter_items.json` SHA-256 | `e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c` |
| reference 품목·아이콘 | 각각 70개 |
| 아이콘 해시 대조 | 70개 모두 일치 |
| HTML 품목 정의 | 1~5단 70종 + 6~7단 48종 |
| 실제 마스터 창고 초기화 | 1~5단 70종 |

기존 기준 문서와 scanner 보고서의 HTML 해시는 PATCH 입력 추가 전 값이다. **새 앱의 비교 기준은 현재 HTML 해시로 고정한다.** 과거 보고서를 수정해 최신 결과처럼 만들지 않는다.

현재 작업 폴더에는 기존 수정 및 미추적 파일이 있다. 다음 구현 작업에서 이를 정리한다는 이유로 삭제하거나 초기화해서는 안 된다.

---

## 2. 영구/회차/UI 임시 상태 전체 분류표

분류 대상은 실제 전역 변수, `window` 상태, localStorage 키, 화면 입력값 및 저장 함수다. 함수 실행 중 잠깐 생기는 지역 변수는 계산 임시값으로 묶는다.

### 2.1 영구 상태

| 기존 상태·저장 키 | 새 분류·저장 위치 | 설계상 처리 |
|---|---|---|
| `inventory[name].stock`, `bdoInventoryState` | 영구 / inventory | 1~5단 재고 보존 |
| `inventory[name].target` | 영구 / inventory | 품목별 목표 재고 보존 |
| `inventory[name].tier` | 기준 데이터에서 파생 | 사용자가 수정하는 값으로 저장하지 않음 |
| `bdoInventoryOrder` | 영구 / settings.inventoryOrder | 단계별 사용자 순서 배열 |
| `tierRules`, `bdoTierRules` | 영구 / settings.tierRules | 1~4단 최소보존, 5단 비상 확보 |
| `shipPresets`, `bdoShipPresets` | 영구 / settings.shipPresets | 기존 4개 슬롯 유지 |
| `bdoNormalWeight`, `bdoMaxWeight` | 영구 / settings.ship | 일반·한계 적재량 |
| `bdoShipSpeed`, `APP_CONFIG.SHIP_SPEED` | 영구 / settings.ship | 속도 설정 |
| `bdoParleyPerTrade` | 영구 / settings.parley | 일반 교환 비용 |
| `bdoParleyCrow` | 영구 / settings.parley | 까마귀주화 교환 비용 |
| `bdoMaxParley` | 의미 분리 | 새 회차 기본 교섭력만 영구 저장 |
| `bdoAllowOcean`, `APP_CONFIG.ALLOW_OCEAN` | 영구 / settings.ship | 기본 교역 모드 |
| `bdoTierPriority` | 영구 / settings.tuning | 단계별 점수 |
| `bdoExcludeSurplus` | 영구 / settings.tuning | 단계별 잉여 제외 설정 |
| 아래 tuning 키 전체 | 영구 / settings.tuning | 값과 의미 유지 |
| `bdoCustomCoords`, 사용자 수정 좌표 | 영구 / settings.navigation | 확정한 좌표 변경 유지 |
| `window.routeCalibrations`, `bdoRouteCalibrations` | 영구 / settings.navigation | 방향별 항로 보정 유지 |
| `map_memos`, `bdoRouteMemos` | 영구 / settings.navigation | 항로 메모 유지 |
| `bdoMap_slot_1`~`3` | 영구 / settings.mapSlots | 지도 저장 슬롯 3개 유지 |
| `bdoMap_base` | 영구 / settings.mapBase | 사용자가 저장한 기본 지도 유지 |
| `bdoViewerPanels` | 영구 / settings.viewer | 저장한 패널 위치·크기 |
| `bdoUiZoom` | 영구 / settings.viewer | 화면 배율 |

tuning 키는 다음을 모두 포함한다.

```text
bdoTuneSpecPri             SPECIAL_MAT_PRIORITY
bdoTuneCrowPri             CROW_COIN_PRIORITY
bdoTuneEffBonus            PATH_EFFICIENCY_BONUS
bdoTuneEffPenalty          SMALL_TRADE_PENALTY
bdoTuneDist                CHAIN_MAX_DISTANCE
bdoTuneScore               CHAIN_BONUS_SCORE
bdoTunePenWeight           DISTANCE_PENALTY_WEIGHT
bdoTuneOverload            OVERLOAD_PENALTY
bdoTuneEffRadius           EFFICIENCY_THRESHOLD
bdoTunePitstop             ILIYA_PITSTOP_RADIUS
bdoTuneOverloadTimeWeight  OVERLOAD_TIME_WEIGHT
bdoTuneDeficitBonus        DEFICIT_RATIO_BONUS
bdoTuneEmergency           EMERGENCY_BONUS
bdoTunePreservation        PRESERVATION_BONUS
bdoWestBias                WEST_BIAS
bdoUseClustering           USE_CLUSTERING
```

`USE_CLUSTERING`은 현재 숫자 가중치로 사용하므로 이름만 보고 Boolean으로 바꾸지 않는다.

현재 선박 프리셋의 `{mode, nW, mW, speed}` 의미와 슬롯 수를 유지한다.

### 2.2 회차 상태

| 기존 상태 | 새 저장 위치 | 폐기 시점·주의사항 |
|---|---|---|
| `scannedTrades`, `bdoScannedTrades` | 브라우저 메모리 | 새 회차·새로고침·앱 재실행 |
| 행별 `count`, `disabled`, `deleted`, `yield` 등 | 현재 물교 목록 내부 | 남은 횟수와 활성 상태 포함 |
| `sortiesSpeed`, `sortiesBalance` | 브라우저 메모리 | 현재 회차의 쾌속·균형 결과 |
| 카드별 `completed` | 현재 스케줄 내부 | 스케줄과 함께 폐기 |
| 카드별 `execC`, `reqA`, `mult`, `originalIndex` 등 | 현재 스케줄 내부 | 기존 계산 구조 유지 |
| `maxParley` 화면의 현재 값 | 현재 회차 | 기본값과 분리, 완료 시 감소 |
| 출항 순서·카드 순서·수동 횟수 조정 | 현재 스케줄 내부 | 사용자 편집도 회차 한정 |
| 수동 경유지와 사용 재료 | 현재 스케줄 내부 | 경유지 완료 계산 보존 |
| `window.ACTIVE_TIMERS` | 회차 메모리 | 새 회차·새로고침 시 취소 |
| 카드·귀환 `timerEnd`, `timerActive`, 알람 여부 | 회차 메모리 | 타이머 복원 기능은 만들지 않음 |
| `window.ENGINE_DEBUG`, `window.__lastGen` | 회차 메모리 | 진단·경로 설명용 |
| 후보 점수, 수요량, 가상 재고·화물, 적재·시간 계산 | 계산 중 메모리 | 계산 종료 또는 재생성 시 대체 |
| `sortiesBulk` | 이관 대상 아님 | 현재 선언 외 사용 없음 |
| `savedSchedules`, `bdoSavedSchedules` | 기능 제거 | 과거 슬롯 저장을 새 저장소로 옮기지 않음 |

**쾌속·균형 두 결과가 있다는 사실은 회차가 두 개라는 의미가 아니다.** 한 회차가 가진 대안 스케줄이다.

### 2.3 UI 임시 상태

| 상태군 | 포함 대상 | 저장 |
|---|---|---|
| 모달·알림 | 열린 모달, 토스트, 오류 표시, 로딩 표시 | 안 함 |
| PATCH 검토 | `scanReviewContext`, 업로드 파일, 미리보기, 적용 전 변경안 | 안 함 |
| 드래그·리사이즈 | `draggedItem`, `draggedRoute`, `draggedSortie`, 각 시작 좌표·크기·방향 | 안 함 |
| 선택 슬롯 | `selectedPresetSlot`, `map_currentSlot` | 안 함 |
| 지도 조작 | 드래그·원호·측정 모드, 선택 노드, 원호 반경, 측정 시작·끝 | 안 함 |
| 지도 화면 | 팬·줌, hover, 이름 표시, 현재 모드, 출항 필터 | 안 함 |
| 지도 실행 객체 | `map_uniqueNodes`의 DOM 참조, `mapInitialized` | 안 함 |
| 지도 되돌리기 | `map_undoStack`, 드래그 시작 좌표 | 안 함 |
| 자유 항로 계산기 | 선택 출발·도착, 계산 시간, `freeTimerInterval`, 경과 시간 | 안 함 |
| 화면 레이아웃 작업값 | 저장 전 패널 위치·접힘·대시보드 배치 | 안 함 |
| 입력 초안 | 일괄 목표 입력칸, 미적용 튜닝·좌표·경유지 입력 | 안 함 |
| 진단 로그 | `bdoErrorLog`의 최근 오류 | 메모리 최대 20건으로 대체 |

지도 측정선 `map_measuredRoutes`는 **편집 중에는 임시 상태**, 사용자가 지도 슬롯이나 기본 지도로 저장했을 때만 해당 스냅샷의 일부로 영구 보존한다.

### 2.4 기준 데이터와 폐기 상태

| 대상 | 처리 |
|---|---|
| `masterData`의 품목명·단계·기본 순서 | 읽기 전용 기준 데이터 |
| `rawData`, 기본 좌표, `defaultRouteCalibrations` | 읽기 전용 기준 데이터 |
| `WEIGHT`, `TRADE_RULES`, `MULTIPLIER`, `REGION_MAP` | 보호할 알고리즘 상수 |
| `tuningGroups`, `VIEWER_PANEL_IDS`, `MAP_SIZE`, `OFFSET` | 프로그램 정의 |
| `originalIslandCoordinates`, `originalMapCoords` | 기준에서 재생성하는 비교용 복제 |
| `bdoInvOrderBaked`, `bdoCalibV2` | 구버전 localStorage 이전 표식이므로 폐기 |
| `geminiApiKey`, `bdoApiModel` | 완전 제거 |
| 캡처 스튜디오 전용 변수 | 완전 제거 |
| 앞부분의 `routeMemos` 및 뒤에서 재정의되는 메모 함수 | 실제 최종 활성 함수 기준으로 정리 |

현재 소스에는 메모 함수와 `setBriefingModeType`의 재정의가 있다. 분리할 때 먼저 나오는 정의를 선택하지 말고, **현재 최종적으로 실행되는 정의와 동작을 기준으로 한다.**

---

## 3. SQLite vs JSON vs 혼합 비교 및 최종 선택

| 기준 | 단일 JSON 파일 | 소규모 SQLite | 영구 상태를 JSON·SQLite로 분산 |
|---|---|---|---|
| 초기 구현량 | 가장 작음 | 작음 | 상대적으로 큼 |
| 안전한 쓰기 | 임시 파일·교체·잠금·복구 처리 필요 | 트랜잭션 활용 | 두 저장소의 일관성 처리 필요 |
| 여러 재고 동시 변경 | 파일 전체 교체로 가능 | 한 트랜잭션으로 처리 | 저장 경계가 갈라지면 어려움 |
| 부분 PATCH | 메모리 수정 후 전체 파일 저장 | 해당 행만 갱신 | 경로별 처리 다름 |
| 데이터 손상 대응 | 잘못된 덮어쓰기 방지 직접 구현 | DB 기본 기능 활용 | 장애 원인 분산 |
| 스키마 변경 | 버전 필드 기반 변환 | 간단한 버전별 변환 | 두 형식 관리 |
| 디버깅 | 텍스트로 즉시 읽기 쉬움 | 조회·진단 화면 필요 | 확인 위치가 여러 곳 |
| 사용자 직접 복구 | 텍스트 수정은 가능하나 실수 위험 | 향후 UI 백업·복원 가능 | 가장 복잡 |
| 현재 규모의 성능 | 충분 | 충분 | 이점 거의 없음 |
| 유지보수 | 안전 저장을 어디까지 구현하느냐에 좌우 | 작은 스키마면 낮음 | 불필요하게 증가 |

**최종 선택: 영구 데이터는 SQLite 하나에 저장한다. 회차는 브라우저 메모리, reference는 읽기 전용 파일로 유지한다.**

선택 이유는 데이터 양이나 조회 성능이 아니다.

현재 완료 함수는 소모품과 획득품 재고를 함께 바꾸고, PATCH 적용은 여러 품목을 동시에 바꾼다. 이 변경과 저장 버전·중복 요청 식별값을 한 번에 확정해야 한다. SQLite의 트랜잭션을 쓰면 이 부분을 별도 파일 교체·복구 체계로 직접 만들 필요가 줄어든다. SQLite는 데스크톱 앱의 저장 형식으로 사용할 수 있고, 원자적 커밋을 제공한다. [SQLite 적용 사례](https://www.sqlite.org/whentouse.html), [원자적 커밋 설명](https://www.sqlite.org/atomiccommit.html)

단일 JSON도 충분히 가능한 대안이다. 그러나 본 프로그램은 단순 설정 저장에 그치지 않고 재고 부분 수정과 완료 저장이 반복되므로 SQLite의 이점이 실제 사용 흐름과 연결된다.

다만 다음은 도입하지 않는다.

- ORM.
- 품목·좌표·메모마다 세분화한 다수의 테이블.
- 스케줄 테이블.
- 모든 reference 데이터를 DB에 복제하는 작업.
- 두 개의 수정 가능한 영구 저장소.

---

## 4. 권장 데이터 스키마

### 4.1 세 개의 작은 테이블

#### `inventory`

| 필드 | 형식 | 의미 |
|---|---|---|
| `program_name` | TEXT PRIMARY KEY | 기존 프로그램의 정확한 품목명 |
| `stock` | INTEGER 또는 NULL | 재고. NULL은 초기 미입력 |
| `target` | INTEGER NOT NULL | 목표 재고 |

대상은 현재 마스터 창고와 동일한 **1~5단 70종**이다.

6·7단 정의가 존재한다는 이유로 해당 재고 행을 추가하지 않는다. 현재 완료 함수도 `inventory`에 실제 존재하는 품목만 변경한다.

이름 키는 기존 `programName`을 유지한다. `롬타스 그물`을 정식명 `롭타스 그물`로 바꾸거나 외부 itemId로 일괄 전환하지 않는다.

제약:

- 수량은 0 이상의 정수.
- 미입력 NULL과 실제 0 구분.
- JavaScript가 정확히 표현할 수 있는 정수 범위만 허용.
- 품목명은 서버 기준 목록으로 검증.
- tier는 기준 목록에서 얻고 중복 저장하지 않음.

새 앱의 초기 재고에 HTML에 박힌 과거 사용자 수량을 자동 복사하지 않는다. 최초 설정에서 스캔·수동 입력으로 확인한다. 사용자가 명시적으로 선택하면 남은 미입력 품목을 0으로 확정할 수 있다.

계산에 필요한 재고가 미확정이면 생성 전 입력 안내를 한다. NULL을 조용히 0으로 바꿔 계산하지 않는다. **이 입력 확인은 생성 전 단계이며, 이미 생성된 정상 카드의 완료 차단으로 사용하지 않는다.**

#### `settings`

| 필드 | 형식 | 의미 |
|---|---|---|
| `section` | TEXT PRIMARY KEY | 허용된 설정 묶음 이름 |
| `payload_json` | TEXT NOT NULL | 검증된 구조화 값 |

허용 section:

```text
inventoryOrder
tierRules
ship
parley
shipPresets
tuning
navigation
mapSlots
mapBase
viewer
```

무제한 임의 key/value 저장소로 사용하지 않는다. 각 section에 고정된 검증 계약을 둔다.

대표 구조:

```text
inventoryOrder
  "1"~"5": programName 배열

ship
  normalWeight, maxWeight, speed, mode

parley
  defaultBudget, normalCost, crowCost

shipPresets
  "1"~"4": null 또는 {mode, nW, mW, speed}

navigation
  coords: 현재 확정된 좌표
  routeCalibrations: 방향별 유효 보정 맵
  memos: 항로 메모 배열

mapSlots
  "1"~"3": null 또는 지도 스냅샷

mapBase
  null 또는 지도 스냅샷

viewer
  uiZoom
  panels: 기존 6개 패널의 left/top/width/height
```

지도 스냅샷:

```text
coords
routes: {id, startNodeName, endNodeName, customSeconds}[]
routeCalibrations
memos: {id, startName, endName, timeStr, text}[]
```

현재 지도 저장 JSON에 포함되는 `REPLACEMENT_CODE`는 소스코드에 붙여넣기 위한 파생 문자열이다. 새 저장소에는 넣지 않는다.

`navigation`을 현재 적용값의 정본으로 삼는다. `mapBase`와 슬롯은 사용자가 저장한 스냅샷이다. 앱 시작마다 base가 최신 좌표·메모를 덮어쓰지 않으며, 사용자의 `[기본 지도 불러오기]` 또는 `[슬롯 불러오기]`에서만 적용한다.

슬롯을 적용할 때 좌표·보정·메모를 하나의 저장 작업으로 반영한다.

#### `app_meta`

단일 행이다.

| 필드 | 의미 |
|---|---|
| `id = 1` | 단일 행 보장 |
| `schema_version` | 저장 구조 버전 |
| `revision` | 영구 데이터 변경 버전 |
| `last_mutation_id` | 마지막 저장 요청 식별자 |
| `last_mutation_hash` | 같은 요청 ID의 내용 변경 방지 |

스케줄 내용이나 완료 이력을 저장하지 않는다. 마지막 요청 식별자는 네트워크 응답 유실에 대응하는 **고정 크기의 저장 메타데이터**다.

### 4.2 기본값

기존 실행 경로에서 실제로 적용되는 값을 기준으로 한다.

- 목표 재고: 현재 초기화 기준 1~4단 80, 5단 5.
- `tierRules`: 현재 기본값 1~4단 20, 5단 2.
- 그 외 설정: 현재 `APP_CONFIG`와 UI 초기화의 실제 결과를 기준으로 고정.
- 서로 다른 함수에 중복된 fallback 값을 임의로 통일하지 않음.
- 수동 입력한 0이 `value || default` 때문에 다른 값으로 변하는 지점은 별도 검증.

### 4.3 저장 규칙

모든 영구 변경은 다음 순서로 처리한다.

```text
요청 형식 검증
→ 현재 revision 확인
→ 중복 mutation 확인
→ 하나의 트랜잭션으로 반영
→ revision 증가
→ COMMIT
→ 성공 응답
```

수량 PATCH는 `+3`, `-5` 같은 증감 명령 대신 **기존 JS가 계산한 최종 수량**을 보낸다. 서버는 교환 비용·수율·최소보존을 다시 계산하지 않는다.

초기 DB 모드는 기본 rollback journal과 안전한 동기화 설정을 사용한다. 소규모 단일 사용자 앱에서 WAL을 기본 도입할 이유는 약하다.

---

## 5. 권장 API 목록

### 5.1 실제로 필요한 API

| Method | 경로 | 역할 |
|---|---|---|
| GET | `/api/health` | launcher의 앱 식별·준비 상태 확인 |
| GET | `/api/bootstrap` | 재고·순서·설정·revision 일괄 로딩 |
| GET | `/api/inventory` | 재고 재조회 |
| PATCH | `/api/inventory` | 수동 수정·창고 PATCH·완료 결과 저장 |
| GET | `/api/inventory/order` | 단계별 순서 조회 |
| PUT | `/api/inventory/order` | 단계별 순서 교체 |
| GET | `/api/settings` | 영구 설정 조회 |
| PATCH | `/api/settings` | 허용된 설정 section 변경 |
| POST | `/api/warehouse-scan` | 이미지에서 PATCH·검토 근거 반환 |
| POST | `/api/app/shutdown` | 저장 중 작업 확인 후 서버 종료 |

백업·복원 API와 UI는 초기 구현에서 제외하고 후속 선택 기능으로 미룬다. 전용 Spec과 구현 승인이 있기 전까지 자동 백업, 최근 백업 보존, 스키마 변경 전 복구 지점, 수동 백업·복원은 구현하지 않는다. 기존 HTML 백업 자동 변환도 초기 범위가 아니다.

다음 API는 만들지 않는다.

```text
/api/current-trades
/api/current-schedule
/api/current-schedule/generate
/api/schedule-history/*
```

현재 목록·스케줄이 브라우저 메모리에 있고 계산도 브라우저 JS에서 수행되므로 서버 CRUD가 필요하지 않다.

후속 `/api/barter-list-scan`은 별도 API 모듈을 추가할 수 있게 디렉터리만 확장 가능한 구조로 둔다. 현재 사용하지 않는 빈 endpoint는 만들지 않는다.

### 5.2 재고 PATCH 계약

공통 envelope:

```json
{
  "mutationId": "요청별 고유 ID",
  "baseRevision": 42,
  "kind": "warehouse",
  "patch": {
    "type": "master_inventory_patch",
    "version": 1,
    "items": {
      "굳어진 용암 액": 31,
      "청동 촛대": 13
    }
  }
}
```

`kind`에 따라 허용 필드가 달라진다.

| kind | 허용 범위 |
|---|---|
| `warehouse` | 정확한 1~4단 이름과 stock만 |
| `manual` | 1~5단 stock·target |
| `completion` | 기존 JS가 실제로 변경한 1~5단 stock만 |

창고 PATCH 검증은 클라이언트와 서버 양쪽에서 수행한다.

- version 숫자 1.
- 비어 있지 않은 items 객체.
- 정확한 이름.
- 0 이상의 정수.
- 하나라도 잘못되면 전체 미적용.
- 입력하지 않은 품목·목표값·순서·설정은 유지.

Python에서는 Boolean이 정수처럼 취급될 수 있으므로 `true`를 수량 1로 받아들이지 않도록 명시적으로 거부한다.

응답 오류는 최소 다음을 구분한다.

| 상태 | 의미 |
|---|---|
| 400/422 | 잘못된 구조·값 |
| 409 | 오래된 revision 또는 잘못 재사용한 mutation ID |
| 413 | 업로드 용량 초과 |
| 415 | 지원하지 않는 파일 형식 |
| 422 + 코드 | 슬롯 검출 실패 등 판독 불가 |
| 503 + 코드 | 저장 불가·잠금·스캔 처리 중 |

저장 실패를 HTTP 성공이나 “적용 완료”로 표시하지 않는다.

---

## 6. Gemini 삭제 대상 전체 목록

현재 HTML의 직접 참조와 호출 경로를 기준으로 한다. 원본 HTML에서는 삭제하지 않고 **신규 앱으로 이관하지 않는다.**

| 구분 | 실제 대상 | 신규 처리 |
|---|---|---|
| API 입력 UI | `apiKeyInput`, `apiModelSelect` | 제거 |
| 모델 선택값 | `gemini-3.5-flash`, `gemini-2.5-flash`, `gemini-1.5-flash` | 제거 |
| 저장 키 | `geminiApiKey`, `bdoApiModel` | 제거 |
| 저장 함수 | `saveApiKey()`, `saveApiModel()` | 제거 |
| 초기화 | `init()`의 키·모델 복원 | 제거 |
| 전체 저장 | `forceSave()`의 API 설정 저장 | 제거 |
| 백업 | `exportData()`의 `ui.apiModel`, API Key 관련 주석 | 제거 |
| 복원 | `importData()`의 신·구 API 모델·Key 처리 | 제거 |
| 스캔 버튼 | `openCaptureModal('trade')`, `openCaptureModal('inventory')` 연결 | 제거·새 업로드 버튼으로 교체 |
| AI 로딩 UI | `loadingIndicator`의 AI 분석 문구·제어 | 제거 |
| 캡처 모달 | `captureModal`, 제목·설명, 영상·크롭·조각 미리보기 | 전체 제거 |
| 캡처 DOM | `screenVideo`, `videoWrapper`, `cropBox`, `previewArea`, `previewAreaWrapper`, 크롭 resize handle | 제거 |
| 캡처 변수 | `screenStream`, `capturedImagesBase64`, `currentCaptureMode` | 제거 |
| 크롭 조작 변수 | `isDraggingBox`, `startBoxX/Y`, `startMouseX/Y`, `isResizing`, `resizeDir`, `startBoxW/H` | 제거 |
| 캡처 함수 | `openCaptureModal`, `closeCaptureModal`, `startScreenShare` | 제거 |
| 조각 함수 | `renderSnippets`, `clearSnippets`, `removeSnippet`, `captureSnippet`, `submitCapturedImages` | 제거 |
| 이벤트 | cropBox·resize handle·관련 mousemove/mouseup | 제거 |
| 화면 공유 | `navigator.mediaDevices.getDisplayMedia` 경로 | 제거 |
| 전처리 | `compressImage()` | 제거 |
| 이미지 변환 | 1400px 축소, JPEG 재인코딩, Base64 변환 | 제거 |
| 창고 숫자 조각 | 14분할 중 7개 숫자 영역 추출 | 제거 |
| 이미지 붙여넣기 | 전역 paste의 이미지→Gemini 분기 | 제거 |
| 호출 함수 | `analyzeMultipleImagesWithGemini()` | 전체 제거 |
| 외부 주소 | `generativelanguage.googleapis.com` | 제거 |
| 요청 구성 | `apiVer`, `generateContent`, `contents`, `parts`, `inlineData`, `safetySettings` | 제거 |
| 프롬프트 | 물교 목록용 prompt·창고 숫자 순서 매핑 prompt | 제거 |
| 순서 추측 상태 | `window.__scanOrderedItems` | 제거 |
| 응답 파싱 | `result.candidates[0].content.parts[0].text` 및 Gemini 응답 JSON 처리 | 제거 |
| 재시도 | 429·503·혼잡 감지, 모델 변경, 재귀 호출 | 제거 |
| 도움말·오류 | API Key 요청, 구글 AI 혼잡, 모델 변경·재캡처 안내 | 제거 |
| 구형 재고 처리 | `processParsedInventory()` | 제거 |
| 구형 검토 | `showScanReview()`의 순서 기반 숫자 검토, 50 미만 의심 판정 | 제거 |
| 구형 적용 분기 | `applyScanReview()`의 `inventory_scan` 경로 | 제거 |
| 모달 미존재 fallback | 확인 없이 `processParsedInventory()` 적용 | 제거 |
| 엔진 안내 문구 | `runAlgorithmAllModes()`의 물교 스캔 이용 안내 | JSON 입력 안내로 교체 |

보존할 공용 기능:

- JSON 텍스트 붙여넣기와 Markdown 코드 펜스 정리.
- `processParsedTrades()`.
- 정확한 품목 매칭·고신뢰 단일 후보 보정.
- `validateMasterInventoryPatch()`의 계약.
- PATCH 검토창의 공용 구조와 이스케이프 처리.
- 지도·스케줄 모달의 드래그·리사이즈.

관련 CSS는 전용 DOM을 제거하면서 사용 여부를 확인한다. 공용 스타일을 “스캔 주변에 있다”는 이유로 일괄 삭제하지 않는다.

신규 배포 파일을 대상으로 금지 문자열·외부 요청 검사를 한다. 보존 원본과 과거 보고서까지 Gemini 문자열이 없어야 하는 것은 아니다.

---

## 7. Frontend/Backend 파일 구조

기존 저장소 아래 `local_app/`에 구축한다. 기존 루트 HTML과 reference·scanner를 그대로 둔다.

```text
현재 저장소/
├─ BDO_물교_v1.0.html                기존 비교 기준
├─ VERSION
├─ inputs/                          기존 보호 원본
├─ reference/                       기존 기준 자료
├─ tools/warehouse_patch/            기존 scanner와 숫자 템플릿
├─ tests/                           기존 회귀
│
└─ local_app/
   ├─ launcher.py
   ├─ pyproject.toml
   ├─ backend/
   │  ├─ app.py                     서버 구성·정적 파일·로컬 접근 제한
   │  ├─ storage.py                 SQLite 연결·트랜잭션
   │  ├─ contracts.py               API 입력 검증
   │  ├─ api/
   │  │  ├─ state.py                bootstrap·재고·순서·설정
   │  │  ├─ scan.py                 창고 업로드
   │  │  └─ maintenance.py          정상 종료
   │  └─ services/
   │     └─ warehouse_scan.py       convert() 호출 어댑터
   ├─ frontend/
   │  ├─ index.html
   │  ├─ css/
   │  │  ├─ utilities.css           로컬로 빌드한 utility CSS
   │  │  └─ app.css
   │  └─ js/
   │     ├─ app.js                  시작·화면 이벤트 연결
   │     ├─ api.js                  HTTP·revision·오류 처리
   │     ├─ state.js                영구값 작업 사본·회차·UI 상태
   │     ├─ persistence.js          저장 큐·완료 저장 경계
   │     ├─ inventory-ui.js
   │     ├─ settings-ui.js          튜닝·선박 프리셋 포함
   │     ├─ trade-ui.js
   │     ├─ warehouse-scan-ui.js
   │     ├─ patch-review.js
   │     ├─ schedule-ui.js
   │     ├─ map-ui.js               좌표·측정·메모·패널
   │     ├─ timer-ui.js
   │     ├─ diagnostics-ui.js
   │     └─ domain/
   │        ├─ constants.js
   │        ├─ trade-import.js
   │        ├─ scheduler.js
   │        ├─ tier7.js
   │        ├─ routing.js
   │        ├─ schedule-edit.js
   │        └─ completion.js
   ├─ tests/
   │  ├─ backend/
   │  ├─ equivalence/
   │  └─ browser/
   └─ packaging/
      └─ bdo-barter.spec
```

`trades.py`や`schedules.py`は作らない。対応するサーバー機能がないためである。

開発中は既存 `reference/`と`tools/warehouse_patch/`を参照する。配布時に必要な資源だけを同じ相対構成で同梱し、ハッシュで検証する。

### JS分離の方式

第1段階は、順序を固定した通常の外部scriptとして分離する。

既存コードは次に依存している。

- グローバル変数。
- `window`に代入された関数。
- inlineイベント。
- DOMの入力値。
- 後方での関数再定義。
- 同期的な保存関数呼び出し。

したがって、最初からすべてを`type="module"`や純粋関数へ変換しない。まず責任別ファイルに分け、既存実行環境を保つ。

新しい保存・APIコードは専用名前空間にまとめる。ES Modulesへの全面移行は初期再構成の必須条件にしない。

### CSS

現行HTMLの `https://cdn.tailwindcss.com` は実行時の外部依存である。配布前に必要なCSSをローカル生成して同梱する。

JS内で組み立てるクラス名も抽出対象に含める。動的クラスの欠落はブラウザー比較で検出する。

---

## 8. 既存JS中、そのまま保존するアルゴリズム一覧

| 責任 | 現在の関数・データ | 移動先 |
|---|---|---|
| 品目分類 | `masterData`, `getItemTier`, `getItemWeight` | constants.js |
| 入力正規化 | `levenshtein`, `getBestMatch`, `getSafeUniqueItemMatch`, `processParsedTrades` | trade-import.js |
| 全モード生成 | `runAlgorithmAllModes` | scheduler.js |
| 通常配車 | `buildSorties` | scheduler.js |
| 7段配車 | `buildTier7Sorties` | tier7.js |
| 固定航路 | `sortFixedOcean` | routing.js |
| 地域条件 | `REGION_MAP`, `getIslandRegion`, `getAllowedRegions` | routing.js |
| 経路最適化 | `getPermutations`, `getOptimalRoute`, `optimizeRouteTSP` | routing.js |
| 距離・航海時間 | `getIslandCoords`, `calculateTravelTime`, `applyOceanCurrent`, `legDistance` | routing.js |
| 積載シミュレーション | `simulateWeightsTemp` | routing.js |
| 手動スケジュール編集 | `routeDrop`, `adjustTradeCount`, `sortieDrop` | schedule-edit.js |
| 編集後再計算 | `rebuildSortieReq`, `applySortieRecompute` | schedule-edit.js |
| 隣接カード統合 | `mergeAdjacentDupTrades` | schedule-edit.js |
| 一般完了 | `completeTrade` | completion.js |
| タイマー連携完了 | `completeTradeAndTimer` | completion.js |
| 経由地完了 | `completeWaypoint` | completion.js |

까마귀주화와 씨앗 선정 로직은 독립 함수 하나로 분리되어 있지 않고 여러 생성 함수 내부에 들어 있다. 보기 좋게 나누기 위해 내부 분기를 새 함수로 재작성하지 않는다.

보존 기준:

- 점수·임계값·지역 허용 조건.
- 대양 및 까마귀주화 방문 순서.
- 행별 `yield`→`mult` 전달.
- 7단의 5→6→7 연결과 수량.
- 적재·과적·교섭력 판단.
- 부족 재고를 0으로 제한하는 완료 처리.
- 6단 중간재가 마스터 창고에 없어도 완료 가능한 동작.
- 최소보존·재고 부족·선행 순서로 완료를 보류하지 않는 원칙.
- 동일 카드의 완료 중복 방지.

### 보호 해시와 예외

현재 확인한 보호 구간:

```text
processParsedTrades → openCaptureModal 직전
683f5b883645208b16712c4f463800ea98367f2e4317f24bad86f1d18e6d8273

runAlgorithmAllModes → completeTradeAndTimer 직전
0c64f7a542a028045a91b4b67b6721103ccfd76a646d74af0a894a9ee4f7be31
```

현재 입력 구간 해시에는 캡처 변수 선언도 들어 있고, 스케줄러 구간에는 구버전 localStorage 초기화와 안내 문구도 들어 있다. **분리 후 전체 구간 해시가 동일하다고 요구하면 Gemini 제거·저장 이관과 충돌한다.**

따라서 다음 두 수준으로 보호한다.

1. 현재 원본 파일 전체 해시와 기존 구간 해시를 고정.
2. 구현 시작 시 보호 함수별 원문 해시를 추출해 이관본과 비교.

허용 변경은 별도 목록으로 한정한다.

- 파일 외부의 연결 코드.
- 저장·초기화·이벤트 어댑터.
- 제거된 Gemini 기능을 안내하던 문자열.
- 폐기되는 저장 슬롯 UI.

함수의 계산식·조건문·정렬·호출 순서가 달라지면 해시 예외로 덮지 않고 실패 처리한다.

---

## 9. 스케줄을 DB에 누적하지 않는 구체적 처리 방식

### 9.1 후보 비교

| 방식 | 새로고침 | 서버 재시작 | 구현 비용 | 평가 |
|---|---|---|---|---|
| 브라우저 메모리 | 현재 회차 소실 | 열린 탭은 남을 수 있으나 복구 계약 없음 | 가장 낮음 | 권장 |
| 서버 메모리 | 회차 복원 가능 | 소실 | 상태 API·동기화 필요 | 초기에는 제외 |
| DB 단일 current-session | 복원 가능 | 복원 가능 | 직렬화·완료 원자성·버전 호환 필요 | 요구 확정 시 후속 |

**권장: 브라우저 메모리만 사용한다.**

현재 요청에는 진행 중인 회차의 재실행 복원이 필수로 지정되어 있지 않다. 따라서 이를 위해 서버 상태·DB 구조를 추가하지 않는다.

### 9.2 새 회차 절차

```text
[새 회차]
→ 진행 중 스케줄 폐기 확인
→ 타이머 정리
→ 현재 목록·스케줄·완료·진단 상태 초기화
→ 기본 교섭력에서 새 회차 시작값 생성
→ 물교 JSON 입력
→ 기존 JS로 스케줄 생성
```

현재 교섭력은 사용자가 실제 남은 값으로 수정할 수 있다. 이 수정은 기본 교섭력 설정을 변경하지 않는다.

JSON 적용은 의미를 구분한다.

- `[새 회차로 적용]`: 기존 회차를 폐기한 후 입력.
- `[현재 목록에 추가]`: 기존 `processParsedTrades()`의 중복·충돌 판단 유지.
- 목록을 실제 변경하면 이전 스케줄은 무효화하고 다시 생성.
- 새 JSON이 파싱 실패하면 기존 회차를 먼저 지우지 않음.

### 9.3 새로고침·재실행

새로고침과 재실행 후에는 다음만 복원한다.

- 영구 재고.
- 목표값.
- 순서.
- 선박·튜닝·지도 설정.

목록·스케줄·완료·남은 교섭력은 복원하지 않는다.

진행 중에는 “이 회차는 새로고침하면 종료됩니다”를 표시하고 페이지 이탈 경고를 사용한다. 브라우저 강제 종료까지 막을 수 있다고 보장하지 않는다.

회차가 소실된 경우 과거 최초 목록을 그대로 재사용하면 이미 수행한 교환을 다시 계획할 수 있다. 재입력 안내는 **현재 게임의 남은 교환 횟수와 교섭력**을 기준으로 한다.

### 9.4 완료 저장과 중복 방지

기존 완료 함수의 계산을 유지하면서 바깥에 저장 경계를 둔다.

1. 완료 직전 상태를 메모리에 보관.
2. 기존 완료 함수 한 번 실행.
3. 함수 내부 저장 요청은 어댑터가 모아 둠.
4. 실제 변경된 재고 최종값을 하나의 PATCH로 전송.
5. 서버 커밋 확인 후 저장 완료 표시.
6. 다음 영구 변경은 앞선 요청 확인 후 처리.

저장 대기 중에는 추가 상태 변경을 직렬화한다. 게임 규칙에 따른 완료 보류는 추가하지 않는다.

응답이 사라졌다면 같은 mutation ID와 같은 본문으로 재전송한다. **완료 함수를 다시 실행하지 않는다.**

서버는 마지막 mutation ID와 본문 해시가 같으면 이미 적용된 결과로 응답한다. 오래된 revision은 덮어쓰지 않는다.

저장 실패가 확정되면 변경 전 상태로 복구하고 다시 시도할 수 있게 한다. 적용 여부가 불명확하면 확인될 때까지 “저장 확인 중”으로 남긴다.

이 설계가 보장하는 것은 영구 재고 저장의 중복 방지다. 브라우저가 갑자기 종료된 뒤 회차까지 복원하는 기능은 포함하지 않는다.

---

## 10. 마스터 창고 스캔 UX

### 10.1 기본 흐름

```text
[마스터 창고 스캔]
→ 큰 업로드 모달
→ PNG 선택 또는 Drag & Drop
→ 원본 미리보기
→ [판독]
→ POST /api/warehouse-scan
→ convert()
→ PATCH 검토 모달
→ [적용]
→ PATCH /api/inventory
→ 저장 확인 후 창고 갱신
```

사용자가 CLI, 경로, 중간 JSON을 다룰 단계는 없다.

초기 버전은 **한 번에 원본 PNG 한 장**을 받는다. JPEG·다른 배율·브라우저에서 축소한 이미지는 검증 범위를 넓힌 뒤 지원한다.

초기 제한 제안:

- 이미지 한 장.
- 파일 최대 20MiB.
- 해독 후 최대 32메가픽셀.
- 실제 PNG 해독 성공 필수.
- 애니메이션·손상 파일 거부.
- 클라이언트 이미지 축소·재압축 없음.

### 10.2 scanner 어댑터

기존 [warehouse_patch.py의 convert()](D:/Codex_물교_v14.1_범위고정_통합수정_회귀검증팩_20260923/tools/warehouse_patch/warehouse_patch.py:277)를 그대로 호출한다.

```text
convert(image_path, reference_json, templates_path)
    → (patch, report)
```

어댑터가 새로 맡는 일:

- 업로드 검증.
- 임시 파일 생성.
- 기존 함수 호출.
- 오류를 API 응답으로 변환.
- report에서 임시 파일 경로 제거.
- 성공·실패 모두 임시 파일 정리.

CLI `main()`을 실행하거나 결과 JSON 파일을 생성하지 않는다. `convert()` 반환값을 메모리에서 응답으로 전달한다.

기존 판정 기준을 유지한다.

```text
MATCH
EMPTY
ICON_MATCH_UNKNOWN
QUANTITY_UNKNOWN
TIER5_IGNORE
DUPLICATE_ITEM_DETECTED
SLOT_GRID_DETECTION_FAILED
```

미확정 품목은 자동 보정하거나 0으로 만들지 않는다. 같은 품목이 여러 슬롯에서 감지된 경우 기존처럼 제외하며 합산하지 않는다.

### 10.3 검증 범위 안내

기존 보고서에서는 전용 화면 50개, 혼합 화면 49개가 안전 기준을 통과했다. 세 가지 씨앗 주머니는 후보차 부족으로 제외됐다. 다른 UI 배율, 실제 3자리 수량, 일부 품목의 양성 표본은 미검증이다. [창고 스캐너 검증 보고서](D:/Codex_물교_v14.1_범위고정_통합수정_회귀검증팩_20260923/reports/v1.0/WAREHOUSE_PATCH_PROTOTYPE.md)

따라서 화면에는 “전체 재고 인식 완료” 대신 다음처럼 표시한다.

```text
확정된 49개 품목을 검토합니다.
미확정 슬롯 3개는 적용에서 제외했습니다.
화면에 없거나 제외된 품목은 기존 재고를 유지합니다.
```

확정 품목이 0개이면 검토·적용 단계로 진행하지 않는다.

---

## 11. PATCH 검토 모달 정렬 방식

### 11.1 화면

권장 크기:

- 너비: 화면의 90~94%, 최대 약 1,100px.
- 높이: 화면의 약 85~90%.
- 고정된 제목·요약·하단 적용 버튼.
- 본문만 스크롤.
- 품목명 14~16px 수준.
- 기존값·새값·차이를 명확히 구분.

```text
마스터 창고 PATCH 검토

[4단계]
굳어진 용암 액       25 → 31    +6
청동 촛대            17 → 13    -4
오색빛 실타래        40 → 44    +4

[3단계]
...

[취소]                         [적용]
```

수치는 화면 예시이며 실제 재고값이 아니다.

### 11.2 정렬 계약

```text
for tier in [4, 3, 2, 1]:
    현재 창고 UI가 사용하는 해당 단계 순서로 순회
    PATCH에 있는 품목만 표시
```

정렬 기준은 단일 `inventoryOrder` 모델로 통일한다. 창고 UI와 PATCH 모달이 각각 다른 정렬 함수를 갖지 않는다.

- 사용자 순서 우선.
- 순서에 없는 새 기준 품목은 기존 masterData 순서로 뒤에 보충.
- 중복 이름·타 단계 이름은 저장 시 거부.
- 순서 저장 중이면 저장 완료 후 검토창 생성.
- 검토 중에는 뒤쪽 창고 순서 편집을 막음.

현재 scanner는 PATCH의 이름 키를 정렬해서 반환한다. 이 순서는 전송 결과의 안정성일 뿐이며 **UI 정렬에 사용하지 않는다.**

스캐너가 출력하지 않은 품목은 변경 표에 나타내지 않는다. 미확정 슬롯은 별도의 진단 요약으로만 표시하며 적용 항목으로 승격하지 않는다.

### 11.3 적용 전 재확인

검토창은 열 때의 revision을 기억한다. 적용 시 재고가 달라졌다면 자동 덮어쓰기하지 않고 현재값으로 차이를 다시 보여준다.

취소·닫기·업로드·판독은 영구 데이터를 변경하지 않는다. 적용 후에도 스케줄을 자동 재계산하거나 교섭력을 바꾸지 않는다.

---

## 12. 실행·종료 후 데이터 보존 방식

### 12.1 저장 위치

기본 데이터 위치는 다음으로 고정한다.

```text
%LOCALAPPDATA%\BDOBarter\data\bdo.sqlite3
```

이것은 내부 위치다. 사용자는 설정하거나 입력할 필요가 없다.

실행 프로그램과 데이터 위치를 분리하므로 프로그램 업데이트·압축 해제 위치 변경이 재고를 초기화하지 않는다.

패키지 내부, 임시 압축 해제 디렉터리, 현재 작업 디렉터리에 DB를 생성하지 않는다.

### 12.2 저장 시점

- 수량·목표값: 입력 확정 시.
- 드래그 순서: 드롭 완료 시.
- 설정: 확정 또는 기존 적용 버튼 시.
- 지도 좌표: 드래그·좌표 변경 확정 시.
- 슬롯·기본 지도·패널: 기존 저장 행동 시.
- 완료: 완료 저장 요청 커밋 시.

키를 누를 때마다 저장하지 않는다. 저장 상태는 `저장 중 / 저장됨 / 저장 실패`로 표시한다.

앱 종료 이벤트에만 의존해 한꺼번에 저장하지 않는다.

### 12.3 실행·종료

launcher는 다음을 수행한다.

1. 데이터 위치와 실행 권한 확인.
2. 단일 인스턴스 확인.
3. DB 열기·스키마 확인.
4. localhost 서버 시작.
5. health 확인 후 브라우저 열기.

작은 실행 관리창에 `[화면 열기]`, `[종료]`를 제공한다. 브라우저 탭을 닫는 것과 서버 종료를 구분한다.

`[종료]`는 진행 중 저장과 스캔 정리를 기다린 뒤 종료한다. 이미 실행 중이면 두 번째 서버를 만들지 않고 기존 앱 화면으로 안내한다.

최종 배포는 Python·NumPy·Pillow·reference·숫자 템플릿을 포함한 **폴더형 패키지**를 우선한다. 실행 파일이 하나라는 UX와 모든 내용이 단일 파일이어야 한다는 요구는 다르다. PyInstaller도 폴더형 패키지가 문제 확인에 유리하고, 단일 파일형은 실행 시 임시 폴더로 압축 해제한다고 설명한다. [PyInstaller 공식 안내](https://pyinstaller.org/en/stable/operating-mode.html)

### 12.4 백업·복원 — 후속 선택 기능

초기 릴리스의 범위에 백업·복원은 포함하지 않는다. 따라서 다음 기능과 `/api/backup`, `/api/restore/preview`, `/api/restore` endpoint는 구현하지 않는다.

- 하루 첫 정상 실행 시 자동 백업 및 최근 3개 보존.
- 스키마 변경 전 복구 지점.
- UI 수동 백업·복원 및 SQLite 백업 API 사용.
- 백업 파일 검증·복원 시험.

이 기능을 추가하려면 별도 Spec에서 보존 정책, 손상 시 동작, 복원 확인 UX와 검증 절차를 정의하고 승인해야 한다. DB 오류 때 빈 DB로 기존 파일을 덮지 않는 보호 규칙은 초기 저장 계층에 그대로 적용한다.

---

## 13. 구현 Phase별 상세 계획

### Phase 0 — 비교 기준 고정

**예정 파일**

- `local_app/tests/equivalence/baseline-manifest.json`
- 기존 harness를 사용하는 비교 도구.
- 허용 변경 목록과 회귀 입력 목록.

**복사 범위**

현재 HTML의 보호 함수·상수, reference와 scanner의 해시 및 테스트 입력.

**새로 작성**

함수 경계 목록, 비교 결과 정규화 규칙, 신규 앱 검증 경로.

**통과 조건**

현재 소스·해시·보고서 관계가 명확하고, 기존 수정이 보존되어야 한다.

**실패 시**

신규 구현 시작 보류. 오래된 Git 태그의 HTML로 기준을 대체하지 않는다.

### Phase 1 — localhost skeleton과 영구 저장

**예정 파일**

`backend/app.py`, `storage.py`, `contracts.py`, `api/state.py`, 최소 `index.html`, `api.js`, `state.js`, `pyproject.toml`.

**복사 범위**

허용 품목명·기본 설정 정의만 사용.

**새로 작성**

정적 제공, bootstrap, DB 초기화·revision·트랜잭션, 로컬 접근 제한.

**통과 조건**

재시작 후 데이터 유지, 부분 PATCH와 전체 원자성, 오입력 거부.

**실패 시**

새 앱만 사용 중단. 기존 HTML은 계속 사용 가능해야 한다.

### Phase 2 — 창고·순서·설정·지도 데이터 이관

**예정 파일**

`inventory-ui.js`, `settings-ui.js`, `map-ui.js`, `persistence.js`, `constants.js`, CSS·화면 구조.

**복사 범위**

창고 렌더링·순서, 선박 프리셋, 튜닝 UI, 지도 편집·메모·슬롯·패널 동작.

**새로 작성**

저장 adapter, 설정 section 매핑, 기본 교섭력과 현재 교섭력 분리.

**통과 조건**

저장·종료·재실행 후 모든 영구 상태 동일. 초기화 코드가 저장값을 삭제하지 않음.

**실패 시**

마지막 정상 개발 DB로 복구. 실제 사용자 DB를 시험 대상으로 사용하지 않는다.

### Phase 3 — 창고 scanner 업로드와 PATCH 모달

**예정 파일**

`api/scan.py`, `services/warehouse_scan.py`, `warehouse-scan-ui.js`, `patch-review.js`, 관련 CSS·테스트.

**복사 범위**

기존 `convert()`는 그대로 호출. PATCH 검증 계약 보존.

**새로 작성**

업로드 처리, 임시 파일 수명, 큰 검토창, 사용자 순서 정렬.

**통과 조건**

직접 convert 결과와 API 결과의 items 동일. 적용 전 무변경. 누락 품목 유지.

**실패 시**

새 스캔 버튼을 릴리스 대상에서 제외. scanner 임계값을 조정해 통과시키지 않는다.

### Phase 4 — 물교 JSON 입력과 회차 관리

**예정 파일**

`trade-ui.js`, `domain/trade-import.js`, `state.js`, 입력 화면·회차 테스트.

**복사 범위**

`processParsedTrades()`와 매칭 함수, 수동 입력·수율·활성화 처리.

**새로 작성**

새 회차·현재 회차 추가 구분, 스케줄 무효화, 입력 오류 표시.

**통과 조건**

기존 fixture의 허용·보류·중복·충돌 결과 동일. 실패 입력이 기존 회차를 지우지 않음.

**실패 시**

새 입력 경로 사용 중단. 매칭 기준을 완화하지 않는다.

### Phase 5 — 스케줄·경로·완료 JS 이관

**예정 파일**

`domain/scheduler.js`, `tier7.js`, `routing.js`, `schedule-edit.js`, `completion.js`, `schedule-ui.js`, `timer-ui.js`, `diagnostics-ui.js`, `persistence.js`.

**복사 범위**

8절의 보호 함수와 내부 알고리즘 전체.

**새로 작성**

파일 로딩 순서, DOM 연결, 저장 요청 집계, 완료 응답 확인 처리.

**통과 조건**

함수 보호 검사, 동일 입력 결과 비교, 완료 재고·횟수·교섭력 일치, 응답 유실 중복 방지.

**실패 시**

해당 이관 묶음을 되돌림. 결과 차이를 고치기 위해 배차·점수 로직을 수정하지 않는다.

### Phase 6 — 전체 대조와 실제 브라우저 회귀

**예정 파일**

`local_app/tests/equivalence/`, `tests/browser/`, 신규 앱 검증 결과·보고서.

**복사 범위**

기존 9개 필수 검증과 PATCH·warehouse 회귀 입력.

**새로 작성**

원본 HTML과 분리 JS를 각각 실행하는 비교 loader, localhost 브라우저 시나리오.

**통과 조건**

14절의 필수 기준 모두 충족.

**실패 시**

정식 사용 전환 보류. 실패가 저장 adapter인지 원본 동작인지 먼저 구분.

### Phase 7 — launcher·패키징

**예정 파일**

`launcher.py`, `packaging/bdo-barter.spec`, 실행·패키지 시험.

**복사 범위**

검증된 앱 코드와 reference·scanner 자원.

**새로 작성**

단일 인스턴스, 브라우저 열기, 실행 관리창, 정상 종료, 패키지 자원 경로.

**통과 조건**

Python 미설치 Windows에서 더블클릭 실행. 외부 네트워크 없이 UI·계산·창고 스캔 동작.

**실패 시**

배포 보류. 사용자가 Python 명령어를 실행하는 것으로 완료 처리하지 않는다.

### 후속 — 물교 리스트 로컬 판독 연구

별도 작업으로 실제 이미지 표본·정답 계약·검토 UI를 먼저 정의한다.

이번 Phase에는 물교 OCR 코드, 모델, 대체 Gemini 기능을 포함하지 않는다.

---

## 14. 각 Phase 회귀 테스트 기준

### 14.1 기존 검증의 현재 확인 상태

기존 저장 결과와 보고서에서 확인한 값이다.

| 검증 | 기존 결과 |
|---|---:|
| 핵심 입력·수율 | 11/11 PASS |
| 후속 입력 | 4/4 PASS |
| 모드 | 7/7 PASS |
| 완료 보류 제거 | 6/6 PASS |
| 7단 완료 | 10/10 PASS |
| 스케줄러 보존 | 3/3 PASS |
| master_inventory_patch | 10/10 PASS |
| 32개 시나리오 | 보고서상 예상 밖 최소보존 위반 0 |
| warehouse prototype | 기존 결과 PASS |
| 실제 브라우저 | BROWSER_NOT_RUN |

근거: [PATCH 입력 검증 보고서](D:/Codex_물교_v14.1_범위고정_통합수정_회귀검증팩_20260923/reports/v1.0/MASTER_INVENTORY_PATCH_INPUT.md), [v1.0 검증 보고서](D:/Codex_물교_v14.1_범위고정_통합수정_회귀검증팩_20260923/reports/v1.0/VERIFICATION.md).

### 14.2 Phase별 추가 기준

| Phase | 필수 검사 |
|---|---|
| 0 | 현재 해시, fixture 목록, 사용자 변경 보호 |
| 1 | 재시작 보존, 트랜잭션 rollback, 잘못된 revision, 중복 요청, DB 쓰기 실패 |
| 2 | 창고 70종, 목표·정렬·튜닝·프리셋·지도·메모·패널 재로딩 |
| 3 | 기존 판독 결과 동일, 확정 0개, 중복 품목, 5단 제외, 원본 무압축, 임시 파일 정리 |
| 4 | 기존 JSON 계약, 특수품, 육지품 원문, 수율, 중복·충돌·모호 후보 |
| 5 | 모든 모드, 7단·까마귀주화·경로·적재·완료 결과, 저장 실패·응답 유실 |
| 6 | 전체 자동 회귀 + 실제 브라우저 업무 흐름 |
| 7 | 패키징·중복 실행·포트 충돌·종료·업데이트 후 데이터 유지 |

기존 필수 9개 검증은 모두 유지한다.

```text
regression_core.js
followup_regression.js
regression_modes.js
inventory_completion_diagnostics.js
tier7_completion_regression.js
completion_no_hold_regression.js
tier7_threshold_diagnostics.js
scenario_matrix.js
scheduler_preservation_regression.js
```

추가로 `master_inventory_patch_regression.js`, `warehouse_patch_regression.py`를 포함한다.

기존 테스트가 localStorage 저장이나 HTML 내부 script 추출을 전제로 하는 부분은 신규 loader·저장 검증으로 대응한다. 테스트 기대값 자체를 낮춰 통과시키지 않는다.

스케줄러 보존 테스트 중 일부는 기존 결과 JSON을 읽는다. 신규 검증에서는 같은 실행에서 생성된 결과와 입력·소스 해시를 연결해 **오래된 결과 파일을 읽고 PASS하는 상황을 방지**한다.

### 14.3 원본 대비 비교 항목

동일 입력으로 다음을 비교한다.

- 유효·보류된 물교 행.
- 쾌속·균형 출항 수와 방문 순서.
- 품목·요구량·실행 횟수·수율.
- 출항 적재와 단계별 적재.
- 교섭력·총시간·귀환시간.
- 7단 결과와 까마귀주화 결과.
- 완료 후 재고·목록 횟수·deleted·남은 교섭력.
- 중복 완료 결과.
- 경유지와 수동 순서 조정 결과.

날짜·임의 ID처럼 실행마다 달라지는 값만 정규화한다. 숫자 계산은 먼저 정확한 일치를 요구하며, 근거 없이 허용 오차를 추가하지 않는다.

### 14.4 실제 브라우저 기준

최소한 다음 흐름을 직접 검증한다.

```text
실행
→ 재고·순서·설정 변경
→ 종료·재실행
→ 업로드·취소
→ 업로드·검토·적용
→ JSON 목록 입력
→ 생성
→ 일반·7단·까주·경유지 완료
→ 저장 실패 표시와 재시도
→ 새 회차
```

브라우저 검증이 실행되지 않으면 `BROWSER_NOT_RUN`으로 남긴다. 신규 앱의 정식 사용 전환은 자동 회귀만으로 승인하지 않는다. 백업·복원은 별도 승인 전까지 이 인수 흐름에 포함하지 않는다.

---

## 15. 과도한 구현으로 판단해 제외한 기능

| 제외 기능 | 이유 |
|---|---|
| Gemini 전체 | 명시된 제거 요구 |
| Python 스케줄러 재작성 | 검증된 JS 보존 |
| 스케줄 이력·저장 슬롯 CRUD | 회차 사용 방식과 불일치 |
| current-session DB 저장 | 재실행 복원이 현재 필수 아님 |
| 초기 릴리스 백업·복원 API/UI 및 자동 보존 | 이번 구현 범위에서 명시적으로 후속 선택 기능으로 이관 |
| 물교 목록 서버 CRUD | JS 메모리로 충분 |
| 기존 localStorage 자동 이전 | 비용 대비 이점 낮음 |
| 과거 HTML 백업 범용 변환기 | 초기 설정·스캔으로 대체 가능 |
| ORM·과도한 DB 정규화 | 소규모 데이터에 불필요 |
| React/Vue 및 별도 SPA 개발 서버 | 기존 DOM·JS 재사용 이점 감소 |
| Electron·내장 브라우저 | 기본 브라우저로 충족 |
| 로그인·계정·OAuth·권한 등급 | 단일 사용자 로컬 도구 |
| 외부 AI·클라우드 저장·분석 전송 | 필요 없음 |
| Redis·Celery·WebSocket | 단일 이미지 요청과 로컬 저장으로 충분 |
| 이미지·판독 이력 DB | 재고 적용에 필요 없음 |
| 자동 임계값 조절 | scanner 검증 범위를 바꿈 |
| 아이템 키의 외부 ID 전환 | 기존 입력·재고 의미 변경 위험 |
| 6·7단 영구 창고 추가 | 기존 완료·재고 모델과 다름 |
| 소스코드 교체 문자열 저장 | 사용자 파일 조작 UX 제거 |
| 배포 시 자동 설치·네트워크 업데이트 | 오프라인 실행 요구와 불필요한 복잡성 |

---

## 16. 예상되는 기술적 위험과 대응

| 위험 | 실제 근거·영향 | 대응 |
|---|---|---|
| 전역 변수·DOM 결합 | 기존 계산 함수가 화면 값을 직접 읽음 | 로딩 순서·DOM ID 유지, 파일 분리부터 진행 |
| ES Modules 전환 | scope·strict mode·window 동작 변화 | 초기 전면 전환 제외 |
| 저장 성공 전 완료 표시 | 기존 저장은 동기식 localStorage | 저장 adapter·대기 표시·확정 응답 |
| 응답 유실 후 중복 차감 | 완료 재호출 시 위험 | 동일 mutation 재전송, 완료 함수 재실행 금지 |
| 두 탭에서 편집 | 서로 다른 회차·재고 작업 사본 | 한 편집 탭만 허용, revision으로 최종 방어 |
| 초기화가 영구값 삭제 | `bdoCustomCoords` 무조건 삭제 및 일회성 reset 코드 존재 | 신규 초기화에서 제거, 재시작 검증 |
| mapBase가 최신값 덮어씀 | 현재 지도 첫 열기에서 base 적용 | 현재 navigation을 정본으로 변경 |
| 기본·현재 교섭력 혼재 | `maxParley`를 설정·잔액으로 같이 사용 | durable default와 session remaining 분리 |
| 함수 재정의 | 메모·브리핑 함수가 뒤에서 덮어써짐 | 최종 활성 정의 기준으로 추출 |
| reference 범위 차이 | scanner 70종, 엔진 118종 | 두 자료의 역할 구분, 6·7단 누락 금지 |
| 정식명·프로그램명 차이 | `롭타스`와 `롬타스` | programName 유지 |
| scanner 일반화 부족 | 일부 표본·배율 미검증 | 원본 PNG·검토 필수·불확실 항목 제외 |
| Tailwind CDN 제거 | 동적 클래스가 로컬 CSS에서 누락 가능 | 클래스 수집과 실제 화면 비교 |
| 디스크 부족·권한 문제 | COMMIT 실패 가능 | 실패 표시, 기존 데이터 유지, 자동 초기화 금지 |
| 앱 업데이트 | 실행 폴더 변경 가능 | 사용자 데이터 위치 분리 |
| 브라우저 새로고침 | 회차는 메모리만 사용 | 명확한 회차 종료 안내 |
| 기존 작업 폴더 변경 | 최신 PATCH가 태그 이후 상태 | 현재 해시 기준 보존, 임의 reset 금지 |
| 기존 릴리스 규칙 | “루트 HTML 하나” 배포 전제 | 새 앱 정식 배포 시 운영 규칙을 별도 갱신 |

두 탭 제한은 로그인 기능으로 구현하지 않는다. 대상 브라우저의 탭 간 잠금 기능으로 편집 소유권을 하나만 유지하고, 다른 탭은 읽기 전용으로 표시한다. 최종 서버 저장은 revision 검사로 보호한다.

### 최소 로컬 보안

- 서버는 `127.0.0.1`에만 bind.
- Host는 지정된 `127.0.0.1:18765`만 허용.
- CORS를 열지 않음.
- 변경 API는 정확한 Origin과 실행 중 발급한 요청 토큰 확인.
- 업로드는 파일 크기뿐 아니라 해독 후 픽셀 수도 제한.
- 업로드 이름을 파일 경로로 사용하지 않음.
- 요청에서 reference·templates의 임의 경로를 받지 않음.
- data 디렉터리를 정적 파일로 공개하지 않음.
- debug·자동 reload 비활성화.
- 메시지·품목명·메모는 안전하게 화면 출력.
- 임시 파일은 성공·실패 후 정리하고, 비정상 종료 잔여물도 앱 전용 임시 위치에서만 정리.

이 정도면 로컬 앱의 예상하지 않은 브라우저 접근과 잘못된 업로드를 다룰 수 있다. 계정 시스템이나 인터넷 공개용 인증 구조는 추가하지 않는다. 요청 크기와 Host 검증은 Flask 공식 보안 지침과도 일치한다. [Flask 보안 지침](https://flask.palletsprojects.com/en/stable/web-security/)

### 주요 결정의 비용 평가

| 결정 | 개발·코드량 | 회귀 위험 | 유지보수 | 사용 편의 |
|---|---|---|---|---|
| 별도 `local_app/` | 중간 | 기존 HTML 영향 낮음 | 명확 | 병행 비교 가능 |
| 기존 JS 파일 분리 | 중간 | 전면 재작성보다 낮음 | 개선 | 기존 동작 유지 |
| SQLite 3개 테이블 | 낮음~중간 | 저장 adapter 집중 | 낮음 | 자동 보존 |
| 회차 메모리 | 낮음 | 새로고침 안내 필요 | 가장 낮음 | 재실행 이어하기는 없음 |
| scanner 직접 호출 | 낮음 | 기존 판독 위험 유지 | 낮음 | 큰 개선 |
| 큰 PATCH 모달 | 낮음 | 정렬·적용 범위 검증 필요 | 낮음 | 검토 용이 |
| 폴더형 실행 패키지 | 중간 | 경로·자원 시험 필요 | 낮음~중간 | 더블클릭 실행 |
| 자동 이전 생략 | 낮음 | 복잡한 변환 위험 없음 | 낮음 | 최초 입력 1회 필요 |

---

## 17. 이 설계로 바로 Codex 구현 단계에 들어가도 되는지 최종 판단

**단계별 구현에 착수할 수 있다. 시작 범위는 Phase 0과 Phase 1이다.**

핵심 결정은 다음과 같이 확정한다.

| 항목 | 최종 결정 |
|---|---|
| 실행 | 더블클릭 실행 파일 → Python → 고정 localhost |
| 화면 | 기존 UI를 책임별 HTML/CSS/JS로 분리 |
| 알고리즘 | 검증된 JS 계산 유지 |
| 영구 저장 | 작은 SQLite, 3개 테이블 |
| 회차 | 브라우저 메모리, 과거 이력 없음 |
| 스캔 | 기존 `convert()` 직접 호출 |
| 적용 | 사용자 검토 후 부분 PATCH |
| Gemini | 신규 배포 코드에서 제거 |
| 기존 데이터 이전 | 자동 localStorage 이전 생략 |
| 기존 HTML | 현재 해시의 비교 기준으로 보존 |

다만 구현 착수와 정식 사용 전환은 다른 판단이다.

정식 전환 전에는 다음이 필요하다.

1. 현재 작업본과 새 앱의 동일 입력 결과 비교.
2. 저장 실패·응답 유실·재시작 보존 검증.
3. 실제 localhost 브라우저 검증.
4. Python 미설치 환경의 더블클릭 실행 검증.
5. scanner의 검증 한계를 유지한 검토형 사용 확인.

이번 산출물은 설계서이며 구현 파일은 생성하지 않았다. 기존 HTML·scanner·reference와 사용자 데이터는 변경하지 않았다.
