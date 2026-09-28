# SPEC-008 — Current State Map

조사일: 2026-09-28. 이 문서는 현재 파일과 읽기 전용 DB 집계가 정본이다. 과거 보고서 수치는 역사로 구분한다. 최초 설계의 측정 snapshot은 보존하고 이번 최종 보정에서는 같은 SPEC 문서만 수정한다.

## 1. 물리 구조와 실행 경계

| 경로 | 실제 역할 |
|---|---|
| `D:/BDOBarterDev/app/BDO 물교 실행.exe` | 사용자 실행 파일; PyInstaller onedir, console=False |
| `D:/BDOBarterDev/실행하기.cmd` | 배포 실행 진입점 |
| `D:/BDOBarterDev/_dev/local_app/launcher.py` | Win32 관리 창, named mutex, Waitress 시작, 기본 브라우저 열기 |
| `_dev/local_app/backend/app.py` | Flask 동일 origin; `127.0.0.1:18765`, Waitress 4 threads |
| `_dev/local_app/frontend/index.html`, `js/app.js` | 브라우저 UI와 초기 bootstrap |
| `_dev/local_app/backend/{api,services}` | 저장/회차/스캔 API와 scanner adapter |
| `_dev/tools/warehouse_patch`, `_dev/reference` | 보호된 V1 scanner, 수량 NPZ, 70개 icon reference |
| `_dev/specs/000-*`~`007-*`, `100-barter-screenshot` | 기존 spec.md / plan.md / tasks.md / validation-report.md 규칙 |
| `_dev/archive/spec100-original-data` | 과거 물교 실험 원본 PNG 16장과 정답 JSON; 제품에서 제외 |
| `_dev/{tests,fixtures,test_results,reports}` | 원본 회귀, fixture, 역사 검증 자료 |
| `D:/BDOBarterDev/specs/007-feature-restoration/evidence` | 별도 최상위 증거 디렉터리; 새로운 정본 spec 위치로 사용하지 않음 |
| 최상위 `app_*`, `업데이트_검증판` | 기존 배포/보관 자료; 이번 설계의 수정·정리 대상 아님 |

제품은 native webview가 아닌 localhost 웹앱이다. launcher가 native 관리 창을 갖지만 게임 capture bridge는 없다. Native capture는 Python/Win32 모듈을 추가할 기술적 여지가 있으나 브라우저 화면 권한을 대체할 기존 기능은 없다.

## 2. Git 조사

루트와 `_dev` 모두 `git status/log/branch/tag`가 `not a git repository`로 실패했다. 인접 `D:/BDOBarterDev_git_backup_20260926`는 worktree가 아니라 Git 메타데이터 디렉터리다. 전역 설정을 변경하지 않고 `git -c safe.directory=... --git-dir=...`로 읽었다.

| 역사 commit | 내용 |
|---|---|
| `dea73fa` (2026-09-24) | docs: record remote and cleanup outcome; main/origin/main |
| `672f51b` (2026-09-24), tag `v1.0` | release: establish BDO 물교 v1.0 |
| `cf3a537` (2026-09-24) | docs: define v1.0 repository workflow |

현재 localhost 앱을 포함하는 clean baseline은 확인되지 않았다. 옛 Git 디렉터리를 복사해서 현재 코드가 이미 추적되고 있다고 간주하면 안 된다. 실제 변경 보호와 Git 복구 계획은 [release-strategy.md](release-strategy.md)에 있다. 이번 조사에서 init/restore/branch/commit/tag/push를 실행하지 않았다.

## 3. 창고 호출 흐름

`app.js → initWarehouseScanUI → api.warehouseScan(File) → POST /api/warehouse-scan → process_warehouse_upload → warehouse_patch.convert → patch/report → openPatchReview → saveWarehouseInventory → PATCH /api/inventory → Storage.update_inventory → Storage.mutate`.

- 단일 PNG, 20 MiB, 32,000,000 pixels; 확장자와 실제 PNG decode 모두 확인한다. animated PNG는 제외한다.
- `_SCAN_LOCK`으로 동시 scan을 거부한다. 임시 upload는 성공/실패 모두 정리한다.
- report의 임시 input.path를 제거한다. scanner patch와 report의 MATCH rows가 정확히 같은지 adapter가 확인한다.
- 성공한 scan은 `record_warehouse_scan`으로 원본 PNG BLOB, report, provenance를 저장한다. 재고 revision은 증가시키지 않는다. 적용 시에는 재고와 warehouse_feedback이 같은 main DB transaction에 저장된다.
- 현재 review는 MATCH까지 포함한 모든 비EMPTY/비TIER5 슬롯을 보여준다. 품목/수량 각각의 4-way 확인, 수정, 제외를 지원한다. 사용자가 같은 품목으로 수정한 여러 슬롯은 effectivePatch에서 합산한다.
- apply 전에 bootstrap 재조회, revision/대상 stock 비교, 충돌이면 재검토한다. 자동 적용은 없다.

## 4. scanner와 판정 의미

`_dev/tools/warehouse_patch/warehouse_patch.py`의 실제 구현:

- grid period 48~54 px, width 42~48 px 후보를 조사하지만 crop_inner_slots는 내부 43×43을 요구한다. 현재 검증 fixture는 period 51, outer width 45다. 임의 UI scale을 지원한다고 볼 수 없다.
- 70개 RGBA icon을 43×43 합성한다. item score는 color RMSE 0.65 + 정규화 grayscale 구조 거리 0.35다. 낮을수록 좋다. top1/top2 gap도 함께 사용한다.
- `ICON_SCORE_MAX=0.35`, `ICON_GAP_MIN=0.045`, digit gap/presence margin 0.03. report에 `prototype_not_final`이라고 명시돼 있다.
- quantity: y=28:40, 오른쪽부터 고정 8px cell 4개, white-core mask, digit/blank nearest templates. 5자리 이상과 clipping의 독립 검증은 없다.
- `quantity_templates.npz`는 calibration.png/manifest에서 만들어진 digit/blank 데이터다. 훈련과 평가에 calibration 원본·파생 이미지를 섞지 않는다.

| decision | 현재 의미/적용 |
|---|---|
| MATCH | item+quantity가 현재 heuristic을 통과; patch에 포함; 사람 review 필요 |
| EMPTY | 밝은 icon pixel이 적음; quantity null; 재고 0으로 변환하지 않음 |
| TIER5_IGNORE | reference.inventoryTarget=false인 5단; 식별하되 창고 patch 대상 아님 |
| ICON_MATCH_UNKNOWN | item score/gap 불충분; bestCandidate는 정답 아님 |
| QUANTITY_UNKNOWN | item은 정해졌지만 숫자 판독 실패; quantity null |
| DUPLICATE_ITEM_DETECTED | 여러 MATCH에 같은 item; 자동 합산하지 않고 모두 patch 제외 |
| SLOT_GRID_DETECTION_FAILED | grid/geometry 실패; endpoint 422; patch 없음 |

1~4단은 56종, 5단은 14종이다. reference.programName이 저장 key다. `롬타스 그물`과 officialName `롭타스 그물` 차이는 기존 정본을 보존한다. 표준 이름을 일괄 교정하지 않는다. seed 3종은 fixture에서 top1이 맞아도 margin 때문에 HOLD하는 사례가 있다. 5단 제외는 scanner inventoryTarget과 warehouse API의 tier 제한으로 구현돼 있다. 사용자 최종 확인에 따라 stack/count 성격 및 판독 조건이 1~4단과 달라 수동 관리하는 business rule로 확정한다. 5단 recognition 확대를 미해결 과제로 두지 않는다.

## 5. DB와 invariant

`storage.py`의 **SCHEMA_VERSION=3**. main DB는 `%LOCALAPPDATA%/BDOBarter/data/bdo.sqlite3`이다.

테이블: inventory, settings, app_meta, working_session, saved_schedule_slot, mutation_receipt, warehouse_scan, warehouse_feedback.

- stock NULL은 미입력/미확정, 0은 명시적인 실제 수량. target은 별도 값이고 scan이 변경하지 않는다.
- master_inventory_patch v1은 `{type,version,items:{programName:nonnegativeSafeInteger}}`; 일부 stock의 절대값 갱신이다. 없는 품목은 보존한다. 5단 입력은 거부한다.
- `Storage.mutate`: BEGIN IMMEDIATE, baseRevision 충돌 409, mutationId/requestHash 재사용 검증, receipt 128개 보존. 동일 mutation의 idempotent replay를 지원한다.
- 현재 회차와 저장 슬롯 5개가 영속화된다. 완료는 inventory+회차를 원자 저장한다. 타이머는 복원하지 않는다.
- 새 recognition 설정을 settings에 임의로 추가할 수 없다. allowed section/keys가 고정돼 있다.

## 6. 물교 import

현재 canonical DTO는 `{island,fromItem,toItem,reqAmount,count,yield}`이고 runtime에서 disabled/deleted 등이 추가될 수 있다. `frontend/data/trade-catalog.json`이 masterData 1~7단, specialItems, islands/t6Islands/t7Islands를 제공한다.

- `parseTradeJsonText`: fence 제거, array/nonempty/object shape 확인. 실패하면 기존 회차 유지.
- `getSafeUniqueItemMatch`: exact 또는 similarity ≥0.75인 후보가 정확히 하나인 경우만 보정. 복수는 ambiguous, 없음은 unmatched.
- island `getBestMatch`는 일반 섬 edit distance ≤3, 6/7단 forceMatch를 사용한다. 이는 인식 confidence 검증이 아니다. V2는 호출 전에 섬 후보를 안전하게 확정해야 한다.
- 0→1의 fromItem은 closed catalog 밖의 육지 재료 원문을 보존한다.
- same island+toItem+fromItem은 duplicate, 같은 island+toItem에 다른 fromItem은 conflict. deleted는 중복 검사에서 제외, disabled는 제외하지 않는다.
- yield는 양의 정수 필수. reqAmount는 숫자 parsing 실패/0에 1, count는 실패에 0을 기본 적용한다. 따라서 미검출 숫자를 importer에 넣으면 위험하다. V2 upstream에서 safe integer 검증을 강화하되 importer 본문은 보존한다.
- new/append commit, review 동안 회차 변경 guard, schedule/completed/diagnostics invalidation, bdo:session-changed 저장 이벤트가 기존 trade-ui.js에 있다. V2가 별도 importer/스케줄러를 만들지 않는다.

## 7. capture/외부 의존성

현재 production에는 image paste/getDisplayMedia가 없다. clipboard.writeText는 진단 출력용이다. 원본 HTML에는 paste(텍스트 JSON/이미지), getDisplayMedia stream, drag/resize crop, multi-image preview가 남아 있다(대략 2023~2403행). 원본 captureSnippet은 JPEG 0.9 저장, inventory 모드에서 14등분 중 7개 숫자 영역을 보내는 **별도 방식**이다. 창고 grid scanner에 그대로 복사하면 안 된다.

원본 HTML은 Gemini fetch와 CDN을 사용하지만 보호 비교 원본이며 현재 배포 frontend가 아니다. production의 fetch는 same-origin API/catalog뿐이고 외부 AI API 호출은 발견하지 못했다. 기존 Gemini 제거 계약을 유지한다.

기존 production dependencies: Flask, waitress, NumPy, Pillow. PyInstaller는 package extra. spec datas는 frontend 전체, reference/barter_items.json, icons, 보호 scanner.py와 quantity_templates.npz다. 기존 default build.ps1은 실제 app 폴더를 교체하므로 이번 작업에서 실행하지 않았다.

## 8. 현재 측정과 이전 실험

| 이번 실제 측정 | 결과/한계 |
|---|---|
| 두 warehouse fixture | target 105칸 item top1/quantity 105/105, legacy patch 99품목 발생, 오patch 0; 이미 알려진 작은 regression set |
| selective 사용자 feedback | scan 7회/unique image 6, feedback 5회, unique slot 179; 검증 item 175/175 일치; 수량 163개 중 145 exact, 11 unknown, **7 wrong MATCH** |
| 수량 MATCH subset | 검증 146칸 중 7개 오확정; 전체 사용자 정확도로 일반화 금지 |
| fixture warm benchmark | 각 warmup 1회 후 10회; barter_only mean 422.69ms/p95 452.32ms, mixed mean 435.89ms/p95 504.64ms |
| 실행 환경 | i3-10105F, logical CPU 8, physical RAM 17,089,196,032 bytes; GPU 불사용 |
| scanner peak working set | 두 fixture 확인 프로세스 40,480,768 bytes; 앱 전체/RAM 증가량과 다름 |
| 현재 package | 259 files / 72,246,845 bytes; source와 대응되는 package 자원 108개 hash 일치 |
| 앱 startup | 미측정: 설치 앱이 실행 중이어서 재시작하지 않음 |

피드백에 선택 편향과 이미지 중복이 있다. item 오류 0은 70종 보장도 아니며 quantity mismatch 18개를 전부 wrong-confirmed라고 부르지 않는다. `MATCH` 7개는 사람이 이후 수정한 잘못된 **제안**이다. 실제 자동 적용 건수는 0이며, 7건을 발생한 자동 오적용이라고 보고하지 않는다.

SPEC-100 보존 문서는 Phase 2/3 80행 exact row 0, Phase 4 validation 32행 중 toItem 1개/yield 1개 오확정, Phase 5 validation 32행 숫자/row 확정 0을 기록한다. prototype/model은 제거돼 현재 재실행할 수 없다. 외부 holdout NOT_RUN. 기존 원본 16장/80행 oracle는 개별 이미지 row 대응과 overlap가 완전히 검증되지 않았고 catalog 부재 2행, ellipsis 정답 문제도 남아 있다. 현재 지시는 **새 SPEC-008 설계 승인**이며 과거 SPEC-100을 완료/재개한 것으로 기록하지 않는다.

## 9. 이번 검증

warehouse API+feedback v2 8 unittest PASS(격리 DB), importer fixture 3개/86행 PASS, protected equivalence 42함수/6상수/2영역/15파일 PASS. 자동 테스트와 브라우저/게임 실사는 별개다. BROWSER_NOT_RUN. 전체 backend suite와 packaged startup은 미실행. `test_warehouse_evidence.py`는 현재 없는 `_dev/마스터창고.png`를 참조한다. 원본 fixture를 복구하거나 별도로 검토한 test 수정이 필요하며 이번에는 기대값/경로를 바꾸지 않았다.

## 10. 지시서 추정과 다른 핵심 사실

회차는 현재 SQLite에 저장된다. feedback/export는 이미 있다. similarity 하나만 쓰지 않고 score+margin+digit gates를 쓴다. 그러나 실사용 wrong MATCH가 있어 HIGH로 승격할 수 없다. browser capture는 원본에만 있다. 과거 trade 숫자 실험은 실용 coverage를 확보하지 못했다. 현 작업 폴더에는 active Git이 없다. 이러한 차이를 후속 설계 전부에 반영한다.

## 11. 최종 보정의 실제 persistence / security 재대조

2026-09-28 code 재확인: backend/storage.py의 SCHEMA_VERSION=3, working_session/saved_schedule_slot 생성·bootstrap 조회·Storage.update_session→mutate를 확인했다. backend/api/session.py의 PUT/DELETE /api/working-session 및 POST /api/working-session/completion은 실제 존재한다. frontend/api.js의 api.saveWorkingSession, persistence.js의 enqueueMutation/whenPersistenceIdle/saveWorkingSession, domain/scheduler-runtime.js의 snapshotWorkingSession/restoreWorkingSession도 실제 구현이다. 따라서 SPEC-007 문서를 앞선 구현처럼 가정한 것이 아니라 현재 source에 이미 persistence가 있는 경우다. 단 packaged compiled Python 모듈까지 최신 source와 같다는 증거는 아니다.

saveWorkingSessionSnapshot(candidate)는 **현재 없는 T011 신규 helper**다. 기존 saveWorkingSession()은 현재 runtime state를 읽으며 후보 snapshot 인자를 받지 않는다. enqueueMutation은 호출마다 새 mutationId를 만들므로 응답 유실 재클릭 안전성을 이미 제공한다고 가정하면 안 된다. T011 신규 helper는 captured guard를 queue 실행 안에서도 확인하고 동일 mutationId/body/baseRevision을 유지하도록 설계한다.

현재 app.py는 loopback bind/Host allowlist, Origin이 있는 경우의 allowlist 거부, CORS 미허용, request byte limit과 shutdown drain을 갖는다. **Origin 없는 mutation은 현재 허용**하며 시험 모드의 host/origin 허용 범위는 production보다 넓다. T002는 기존 guard를 재사용해 V2 및 working-session mutation에 누락/null/다른 Origin 거부·content type·Fetch Metadata 검사를 추가한다. 이를 현재 완료된 보안으로 표현하지 않는다. 정확한 향후 규칙은 [capture-design.md](capture-design.md)의 Security contract에 있다.

V1은 대부분 정상이라는 사용자 관찰과, 선택 편향된 feedback의 quantity wrong MATCH7을 함께 보존한다. seed 3종이 각 fixture에서 정답 top1이어도 HOLD된 것은 unnecessary review의 재현 후보다. 정답 REVIEW 전체 건수는 새 replay가 필요하며 기존 145 exact를 모두 HIGH로 재분류하지 않는다.
