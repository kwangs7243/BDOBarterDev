## Active Roadmap Authority

현재 작업 순서는 [CURRENT-ROADMAP.md](CURRENT-ROADMAP.md)를 따릅니다. 아래 T000~T014는 historical implementation plan + preserved invariants이며 번호와 이력을 보존합니다. old T010P3E2는 SUPERSEDED_PENDING_PRODUCT_REALIGNMENT, T010P3D4-S1은 ON_HOLD입니다. 현재 목표 계약은 [CURRENT-PRODUCT-CONTRACT.md](CURRENT-PRODUCT-CONTRACT.md)를 참조하세요.

---

# Luna High Implementation Tasks

작업 디렉터리: `D:/BDOBarterDev/_dev`. 아래 파일은 이 root 기준 정확한 상대 경로이며 `{a,b}`는 각각의 명시된 파일이다. production 코드 변경은 후속 구현 요청에서만 수행한다. `<PY>`는 T000에서 검증한 실제 Python3.11+ executable이다. 모든 DB/오류/동시성 테스트는 copy/mock 또는 isolated LOCALAPPDATA에서 수행한다. 현재 사용자 앱을 BDO_TEST_URL로 지정하지 않는다.

작업 graph 정본(기존 T000~T014 유지, A/B는 각 Task 내부 stage):

| Phase | Task / 착수 경계 |
|---|---|
| 0 | T000A 읽기 전용 조사·Git 해결안 지금 가능; T000B 승인된 authoritative baseline 해결 → T001 dataset/R0 false-match·correct REVIEW baseline |
| 1 | T002 contract/sidecar/security/Early Evidence Store → T003 file/clipboard → T004 stream 및 T005A profile 독립; T005B profile scope 승인 |
| 2A | 공통 T001/T002/T003/T005A 후 T006A replay → T006B warehouse 후보 bench |
| 2B | 같은 공통 기반 후 T010A trade geometry/numeric → T010B 승인 OCR experiment; T006/T009 의존 없음 |
| 3 | T006/T005B → T007A deterministic derivation → T007B Sol usable policy/audit → T008 exception review/feedback/사용자 전체 patch 적용 |
| 4 | T008+G0~G3/auto 정책 승인 → T009 fullauto integration, auto 기본 OFF |
| 5 | T010B engine freeze/holdout 승인 → T011A merge/adapter → T011B existing session queue integration |
| 6 | T002 + T008 또는 T011 실사용 feedback → T012 active learning/retention refinements |
| 7 | T013A staging → T013B 해당 scope live/CPU/rollback → T014 scope별 release; usable 검증은 T009/T011/T012 없어도 가능 |

생산 구현 공통 gate는 T000 ready=true다. 현재 바로 가능한 것은 T000A 조사/해결안·실제 persistence 재확인과 기존 R0 자료의 읽기 전용 분석뿐이며, T001 신규 CLI/fixtures/.gitignore와 T002~005 구현은 Git 해결 후 후속 구현 요청에서 시작한다. 이 문서의 READY는 설계가 확정됐다는 뜻과 실제 prerequisite 충족을 구별한다. 같은 harness 파일을 수정하는 T006/T010의 integration은 순서대로 병합하고 자동 병렬 agent 작업을 지시하지 않는다. A/B stage의 실험 완료를 Sol 결정이나 production 채택 완료로 대신하지 않는다.

## Luna → Sol 재검토 규칙

기존 DTO 변경, 예상보다 큰 scanner API 변경, main DB migration, capture/backend 구조 변경, benchmark 지속 미달, 신규ML packaging 실패, inventory persistence 회귀, importer 의미 변경 필요, 동일 오류2회 반복, 설계 밖 대량파일 변경이면 즉시 구현중단한다. 현재diff/test/log/재현입력/변경이유를 정리하고 Sol에 재검토를 요청한다. 원인을 숨기는threshold완화,기대값수정,unknown→default,임의라이브러리교체는 하지 않는다. T005B/T007B/T010B 선택 및 T011 채택은 실제 artifact로만 결정하며 Luna가 임계값/engine을 추측하지 않는다. 지정된 A 실험 단계는 결정 gate 이전에 측정 가능하다.

## 완료 보고 공통

각Task마다 수정파일/신규파일,git diff요약(저장소미확인시불가명시),실행command와PASS/FAIL,benchmark전후/분모/hash,actual browser/게임/packaged여부,knownlimits,남은gate를 보고한다. dispatch/빌드/mock만으로 downstream완료를 선언하지 않는다. 권장commit message는 제안이며 사용자요청없으면commit하지않는다.

## T000 / Git authoritative baseline 해결과 실제 구현 대조

착수 상태: T000A 읽기 전용 조사·해결안은 지금 READY; T000B Git 작업은 별도 승인 후; 미해결 동안 생산 구현 BLOCKED

### 목적

옛 이력과 현재 source 일치 여부를 검증하고 Case A/B 중 authoritative Git baseline을 실제 해결하여 후속 구현 근거를 잠근다.

### 현재 동작

현재 폴더에는 active .git이 없고 분리된 옛 metadata만 있다.

### 목표 동작

현재 파일/기존 변경을 보존한 source↔commit/tree/hash 기준점과 실제 persistence 계약을 확정한다. 단순 repo 발견으로 완료하지 않는다.

### 선행 Task

없음

### 수정 파일

T000A 없음(읽기 전용). T000B는 release-strategy.md의 승인된 별도 Git destination만; 원래 source/분리 metadata 덮어쓰기 없음.

### 신규 파일

test_results/recognition-v2/repository-access.json; test_results/recognition-v2/git-baseline-proposal.json (비밀/사용자 DB 내용 제외, Git 해결안 산출물). 실제 Git baseline은 별도 승인된 destination/범위만.

### 수정 금지 파일/범위

기존 source/protected files/사용자 DB/옛 Git metadata 이동·덮어쓰기; 승인 없는 init/stage/commit/branch/push.

### 유지할 invariant

이전 Git tag를 현재 exe baseline으로 간주하지 않는다.

### 데이터 흐름

현재 tree+manifest/protected hashes → 옛 commit/tree 완전 비교 → Case A 검증 이력 또는 Case B 새 기준점 제안 → 별도 Git 승인·해결 → hash 재검증 → ready

### 함수/API 인터페이스

repository-access.json {version,sourceRoot,gitRoot,case,resolutionStatus,baselineCommit,baselineTreeHash,sourceManifestHash,protectedHashes,branch,cleanStatus,existingChanges,approvedChanges,excludedFiles,python,fixtureGaps,persistenceVerification,ready}. persistenceVerification은 schema/API/function 파일·line/hash evidence와 existing/proposed 구분. ready=false unless RESOLVED.

### 구현 순서

T000A(읽기 전용 / 현재 착수 가능):
1. 현재 190 source hash·protected files·package/resource snapshot과 기존 변경을 재확인한다.
2. 분리 metadata의 commit/tree를 현재 source의 경로·hash와 비교한다. 정확한 matching tree가 있으면 Case A; 없으면 Case B 제안 작성.
3. storage.py schema3/working_session/update_session/mutate, api/session.py PUT working-session, frontend api.saveWorkingSession/persistence queue/runtime snapshot·restore를 code로 확인한다. saveWorkingSessionSnapshot(candidate)는 미구현 신규 helper라고 기록한다.
4. Python dependencies/fixture gaps와 file-level include/exclude manifest를 검증한다. 해결안 artifact와 필요한 Git 승인 범위를 보고한다.
T000B(별도 명시적 Git 승인 후):
5. Case A는 검증 history의 별도 checkout/worktree와 현 source를 hash로 재검증한다.
6. Case B는 release-strategy.md의 새 destination 복사→재해시→init→명시 stage→staged diff/scope/secret 검사→승인 baseline commit→commit tree 재검증을 수행한다. 기존 tree·metadata 강제 연결 금지.
7. source/protected/manifest와 baselineCommit/tree가 일치하고 기존 변경이 보존된 뒤 resolutionStatus=RESOLVED/ready=true를 기록한다. 미승인/불일치면 AWAITING_GIT_AUTHORIZATION/ready=false.

### 오류 처리

dubious ownership은 명령별 safe.directory만 사용; 전역 config 변경 금지. test_warehouse_evidence의 누락 PNG를 임의 다른 이미지로 대체하지 않는다.

### Logging / diagnostics

repo/branch/status/fixture 누락만 기록; remote 인증값/환경비밀은 출력하지 않는다.

### 테스트

```powershell
git -C '<verified-repo>' status --short --branch
& '<PY>' -B -c "import PIL,numpy,flask,waitress; print(PIL.__version__,numpy.__version__)"
node local_app/tests/equivalence/verify-migration.mjs
```

### 완료 조건

T000A 조사/해결안 완료는 별도 boolean으로 보고한다. **T000 전체 true**는 Case A/B authoritative commit/tree 확정, 현재 source/protected hash 일치, 기존 변경 보존, 실제 persistence code 검증, Python import PASS일 때만. 미승인 Git 결정을 임의 완료 처리하지 않으며 생산 구현은 false 동안 시작 금지.

### Git commit

권장: `chore: record recognition v2 implementation baseline` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T001 / Golden 정리와 baseline harness

착수 상태: T000 완료 후 READY; holdout 확보는 별도 gate

### 목적

provenance/grouped dataset과 frozen R0의 false acceptance·unnecessary review baseline을 재현한다.

### 현재 동작

fixture2장, live feedback6unique images, trade16장/80행 oracle에 정답·대응 누락이 있다.

### 목표 동작

R0 known fixture/실사용 evidence에서 wrong MATCH/unknown/correct-but-REVIEW와 실제 전체 검수 workload를 구분해 V2 paired 비교 근거를 만든다.

### 선행 Task

T000

### 수정 파일

.gitignore (로컬 dataset/DB/experiment 산출물 제외만); 기존 테스트 기대값은 유지

### 신규 파일

tools/recognition_dataset.py; tools/recognition_benchmark.py; tests/fixtures/recognition-v2/manifest.json; tests/fixtures/recognition-v2/warehouse-barter-only.expected.json; tests/fixtures/recognition-v2/warehouse-mixed.expected.json; local_app/tests/backend/test_recognition_benchmark.py

### 수정 금지 파일/범위

기존 fixtures/reference/calibration/oracle와 production

### 유지할 invariant

unknown label과 true0 분리, recognizer에 oracle 금지, 파생image group split 유지.

### 데이터 흐름

ro copied SQLite/기존 fixture → field labels/grouped manifest → current engine metrics

### 함수/API 인터페이스

benchmark-plan.md manifest/output/workload/risk schema. export_legacy_feedback(readonly_db)->RecognitionSample iterable; run_benchmark(engine,manifest,policy,runs)->MetricsV1. R0는 HIGH가 아닌 기존 decisions/proposals로 보고한다. early replay exporter는 crop/evidence/hash를 local dataset에 함께 저장하고 threshold를 설정하지 않는다.

### 구현 순서

1. unchanged DEDICATED/MIXED truth와 NPZ calibration hash를 추출한다.
2. legacy item-only/four-way field truth·source/hash group을 검증한다.
3. 7 wrong MATCH/11 unknown과 정답 REVIEW 후보(seed 포함)를 original decision/candidate/final truth별 replay 목록으로 나눈다. 145 exact를 모두 HIGH로 간주하지 않는다.
4. item/quantity/crop/layout/margin 원인을 evidence crop에 연결하고 field/slot/capture/stratum metrics, 실제 V1VisibleReviewSlots, 분모를 출력한다.
5. Trade row mapping/ellipsis/catalog부재는 unresolved, split/leakage/label disputes는 명시하고 immutable replay evidence를 local output에 저장한다.

### 오류 처리

oracle 부재는 UNVERIFIED; 같은image contradictory label은 DISPUTED. source 없는 fixture는 skip이 아니라 명시적으로 BLOCKED. current data를 blind holdout이라고 부르지 않는다.

### Logging / diagnostics

fixture/capture/group/split/verified field counts, original decision·correct REVIEW reason, source/model/crop hashes, latency, scope warnings.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_recognition_benchmark -v
& '<PY>' -B tools/recognition_benchmark.py --manifest tests/fixtures/recognition-v2/manifest.json --engine warehouse-current --runs 10 --mode shadow --out '<local-results>/baseline.json'
```

### 완료 조건

한 명령으로 fixture2 R0 재현, wrong/unknown/correct REVIEW와 UI workload·capture/stratum 분모 분리, early replay crops/hash 재현, leaked split 차단, ground-truth missing=null, main-write0 모두 true. 독립 holdout 완성은 별도 gate.

### Git commit

권장: `test: add provenance aware recognition benchmark` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T002 / V2 계약·sidecar·localhost security·Early Evidence Store

착수 상태: T000/T001 후 READY

### 목적

main schema를 바꾸지 않는 contract/sidecar, 기존 localhost guard 보강과 실험 전 증거 저장을 구현한다.

### 현재 동작

main schema3/settings keys/feedback는 고정되어 V2 flags/profile/report를 담을 자리가 없다.

### 목표 동작

모든 실험/인식 run이 제한 budget 내 원래 prediction·crop·hash·reason을 보존하고 서버 validation/security 전에 mutation하지 않는다.

### 선행 Task

T001

### 수정 파일

local_app/backend/app.py (기존 Origin/Host guard 보강·blueprint·종료 drain); local_app/tests/backend/test_working_session.py (정상 요청 Origin 명시·기존 body/result 보존만)

### 신규 파일

local_app/backend/recognition_contracts.py; local_app/backend/recognition_store.py; local_app/backend/api/recognition.py; local_app/tests/backend/test_recognition_contracts.py; local_app/tests/backend/test_recognition_store.py; local_app/tests/backend/test_recognition_security.py; local_app/tests/backend/test_recognition_artifacts.py; local_app/tests/browser_recognition_security.mjs

### 수정 금지 파일/범위

main storage.py/contracts.py/session_contracts.py와 기존 API response

### 유지할 invariant

main revision/70stock/NULL/0/target/session/slots 불변; 기존 V1 feedback 원자 계약 유지.

### 데이터 흐름

CaptureInput → contract reject 또는 immutable run → sidecar / main DB write0

### 함수/API 인터페이스

capture-design.md Input/Config/validity/Security, warehouse-design.md ReportV2, feedback-dataset.md sidecar/sample/Early Evidence Store. policy parameters={},allowedStrata=[],usableReviewApproved=false,releaseApproved=false. store_evidence(run,crops)->{artifactRefs,evidenceIncomplete,artifactMissingReasons}; hash-idempotent writer, budget200MiB, unlabelled30day explicit cleanup. native/remote 요청 unsupported_feature.

### 구현 순서

1. type/size/content-type/actual bitmap limits와 capture validity contract를 구현한다.
2. sidecar schema1/idempotent init/config CAS/profile snapshot/immutable run/label receipt를 구현한다.
3. Early Evidence Store에 run/profile/engine/model/parameter/policy/input/crop hashes·prediction/reason/timing을 저장한다. exception/audit/invalid panel crop 및 예산/디스크 오류를 재현한다.
4. app.py 기존 guard 재사용: V2 및 working-session mutation의 exact Origin 필수, missing/null/foreign 거부, present Sec-Fetch-Site same-origin만, production Host/loopback/CORS deny 및 content-type/limits 검증. 테스트모드 allowlist를 생산 완화에 사용하지 않는다.
5. recognition 작업을 shutdown drain에 연결하고 V1 동작·session body/response를 보존한다. T002는 엔진/threshold/autoapply를 구현하지 않는다.

### 오류 처리

계약/security 실패 전 main·sidecar write0. future sidecar schema 거부; sidecar/disk/budget 오류는 evidenceIncomplete 또는 run 실패이고 V1 유지. 누락된 필수 crop으로 HIGH 상세 생략/auto 허가 금지. raw path/client filename을 저장 경로로 사용하지 않는다.

### Logging / diagnostics

IDs/hashes/task/reasons/elapsed만 기록, raw image/user path는 일반 로그 제외.

### 테스트

자동(모두 copy/mock):
```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_recognition_contracts local_app.tests.backend.test_recognition_store local_app.tests.backend.test_recognition_security local_app.tests.backend.test_recognition_artifacts local_app.tests.backend.test_working_session local_app.tests.backend.test_storage_api -v
node local_app/tests/browser_recognition_security.mjs
```
security negatives는 testing=False 및 명시된 production Host/Origin을 사용한다. 검증 cases: foreign/missing/null Origin, Host spoof, cross-site Sec-Fetch-Site, foreign OPTIONS, wrong JSON/simple content type, duplicate multipart/위조PNG/animation/bytes/pixels/metadata초과, normal same-origin session save, no path/secret logging. 실제 Chrome 정상 저장·외부 페이지 mutation 차단은 별도 live evidence; live 미실행이면 BROWSER_NOT_RUN.

### 완료 조건

contract/sidecar CAS·idempotent labels/budget·retention·replay/security negatives PASS, recognition-only main semantic hash+revision 불변, V1/working-session 정상 계약 PASS, unknown flag authority0. code/unit 완료와 Chrome live 완료를 각각 기록; shadow 활성화 전 보안 live 확인 필요.

### Git commit

권장: `feat: add isolated recognition evidence contracts` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T003 / 파일과 Clipboard 입력 통합

착수 상태: T002 후 READY

### 목적

명시적 창고/물교 context의 Ctrl+V를 공통 PNG capture로 연결한다.

### 현재 동작

창고 File/Drag&Drop만 있고 image paste는 없다.

### 목표 동작

명시적 창고/물교 context의 Ctrl+V를 공통 PNG capture로 연결한다.

### 선행 Task

T002

### 수정 파일

local_app/frontend/js/app.js; local_app/frontend/js/api.js; local_app/frontend/js/warehouse-scan-ui.js; local_app/frontend/index.html; local_app/frontend/css/warehouse-scan.css

### 신규 파일

local_app/frontend/js/capture.js; local_app/frontend/js/recognition-ui.js; local_app/tests/capture_input_regression.mjs; local_app/tests/browser_capture_input.mjs

### 수정 금지 파일/범위

원본 HTML와 기존 text paste/JSON importer/warehouse V1 UI 의미

### 유지할 invariant

파일원본PNG 유지, 기존 입력란 paste 보존, Blob cleanup, main mutation0.

### 데이터 흐름

image paste/File → decoded PNG CaptureInput → V1 adapter 또는 V2 shadow

### 함수/API 인터페이스

captureFromFile/captureFromPaste의 capture-design.md 인터페이스; context별 sourceType/size/hash 표준화. api.warehouseScan은 기존 결과 contract를 유지한다.

### 구현 순서

1. capture context와 reusable file handler를 연결한다.
2. image MIME routing/PNG normalization/limits를 구현한다.
3. serial batch queue/preview cleanup을 구현한다.
4. warehouse V1판독과 trade image draft에 연결한다.

### 오류 처리

empty/text clipboard는 default 유지; invalid/oversize/multi-image-limit이면 draft 보존. trade engine 없을 때 입력은 draft이고 목록 생성 성공으로 보고하지 않는다.

### Logging / diagnostics

sourceType/bytes/dimensions/reencoded/task만 기록.

### 테스트

```powershell
node local_app/tests/capture_input_regression.mjs
node local_app/tests/browser_capture_input.mjs
node local_app/tests/browser_warehouse_scan.mjs
```

### 완료 조건

실제 Chrome image paste/File 동일 normalized bitmap, text input paste 보존, PNG fallback PASS, 취소/오류 main-write 0.

### Git commit

권장: `feat: support contextual clipboard image capture` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T004 / Browser screen stream 세션

착수 상태: T003 후 READY, 실제 BDO capture 검증 필요

### 목적

연결1회 후 warehouse/trade capture만 누르고 사용 종료 시 stream을 해제한다.

### 현재 동작

원본 HTML에는 stream/crop이 있지만 현재 앱에는 없다.

### 목표 동작

연결1회 후 warehouse/trade capture만 누르고 사용 종료 시 stream을 해제한다.

### 선행 Task

T003

### 수정 파일

local_app/frontend/js/capture.js; local_app/frontend/js/recognition-ui.js; local_app/frontend/index.html; local_app/frontend/css/warehouse-scan.css

### 신규 파일

local_app/tests/screen_capture_regression.mjs; local_app/tests/browser_screen_capture.mjs

### 수정 금지 파일/범위

원본 capture 구현과 launcher/mainDB

### 유지할 invariant

getDisplayMedia는 user activation, 선택권/권한 우회 금지, 오디오OFF, 자동녹화/scroll 없음.

### 데이터 흐름

user connect → stream/browser video → frame PNG → CaptureInput

### 함수/API 인터페이스

connectScreen/captureFrame/disconnectScreen; 상태/종료/resize/freshness는 capture-design.md. browser flags로 permission picker를 없애는 테스트를 실사PASS로 부르지 않는다.

### 구현 순서

1. stream state와 connect/disconnect UI를 구현한다.
2. frame pixel 좌표/PNG을 생성한다.
3. ended/pagehide/shutdown/resize cleanup을 구현한다.
4. 실제 BDO 창 연결·최소화·복원·다중monitor를 확인한다.

### 오류 처리

NotAllowedError/black/minimized/stale frame은 재캡처 상태; 자동 retry 권한요청 없음.

### Logging / diagnostics

track 상태/frame dimension/timing/reason만 기록; window title 제외.

### 테스트

```powershell
node local_app/tests/screen_capture_regression.mjs
node local_app/tests/browser_screen_capture.mjs
실사: BDO window 선택→3회 capture→종료→재연결 권한 확인
```

### 완료 조건

mock lifecycle PASS와 actual permission/게임 capture PASS를 분리. 실제 frame/권한/끊김 cleanup이 확인되어야 이 Task의 실사 완료=true.

### Git commit

권장: `feat: capture browser screen frames per session` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T005 / Capture Profile과 geometry 표준화

착수 상태: T001/T002/T003 후 normalization 개발 READY; T004 stream 실사와 독립; 허용 scale/anchor 승인 stage는 BLOCKED

### 목적

normalized region과 검증 anchor/scale로 원본 픽셀과 canonical crop을 함께 만든다.

### 현재 동작

V1은 inner43/fixed-scale grid이고 profile/anchor asset이 없다.

### 목표 동작

normalized region과 검증 anchor/scale로 원본 픽셀과 canonical crop을 함께 만든다.

### 선행 Task

T001 + T002 + T003; stream-specific 실사만 T004 이후

### 수정 파일

local_app/frontend/js/capture.js; local_app/frontend/js/recognition-ui.js; local_app/backend/api/recognition.py

### 신규 파일

local_app/backend/services/capture_normalization.py; local_app/recognition_data/profiles.json; local_app/recognition_data/anchors.npz; local_app/tests/backend/test_capture_normalization.py

### 수정 금지 파일/범위

기존 reference/icons/scanner/grid thresholds

### 유지할 invariant

CSS zoom과 game scale 분리, unknown DPI=null, anchor 실패 HIGH금지, raw crops 보존

### 데이터 흐름

frame+profile → anchor search → scale/translation → validated crops+transform

### 함수/API 인터페이스

warehouse-design.md normalize_capture validity contract, capture-design.md region/anchor/transform/fidelity/invalid 이유. T005A curated profile/좌표/validity 구현·측정, T005B Sol이 실제 scale/kernel/quality cutoff artifact 승인 후 scope freeze. 미승인 stratum은 구조-valid이면 REVIEW, 심각한 구조불일치 CAPTURE_INVALID.

### 구현 순서

T005A: 1. file/clipboard로 content rect/letterbox/frame rescale 관측·좌표 변환을 구현한다. 2. curated panel/grid/row anchor sourcehash와 raw/normalized crops/transform/validity를 Early Store에 남긴다. 3. wrong UI/crop/완전 grid/숫자 clipping negative replay를 측정한다.
T005B: 4. 측정된 scale/kernel/validity cutoff 후보와 지원 scope를 Sol에 제출해 승인 artifact로 고정한다. stream-specific BDO validation은 T004 뒤 별도 수행한다.

### 오류 처리

wrong UI/wrong region/grid없음/nonuniform/심각한 profile mismatch/warehouse digit clipping은 capture CAPTURE_INVALID→한 번 재캡처. 정상 구조의 새 stratum 정확도 미검증만 REVIEW. tier5 존재 invalid 금지, fixed pixel silent fallback 금지.

### Logging / diagnostics

profileVersion/stratum/anchor scores/transform/quality reasons, 선택적 debug overlay.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_capture_normalization -v
node local_app/tests/capture_input_regression.mjs
```

### 완료 조건

T005A 좌표/letterbox/frame rescale/validity negatives·crop 보존 PASS; T005B 승인 profile/hash/scope가 명시돼야 scope 완료. 미승인 HIGH0; invalid 화면 수십 REVIEW 생성0. T004 stream live 미완료는 따로 보고.

### Git commit

권장: `feat: normalize capture regions with validated profiles` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T006 / 창고 item/quantity 후보와 오류 재현

착수 상태: T001/T002/T003/T005A 후 replay·실험 READY; HIGH 채택은 Sol 결정 전 BLOCKED; T010A와 독립

### 목적

원인별 crop replay와 item R0/R1/보조pHash, quantity Q0/Q1 후보를 동일 dataset에서 비교한다.

### 현재 동작

known fixture는 맞지만 실사용 quantity wrong MATCH7가 있다.

### 목표 동작

원인별 crop replay와 item R0/R1/보조pHash, quantity Q0/Q1 후보를 동일 dataset에서 비교한다.

### 선행 Task

T001/T002/T003 + T005A validity/profile 실험 기반; supported scope freeze는 T005B

### 수정 파일

local_app/backend/api/recognition.py (shadow만)

### 신규 파일

local_app/backend/services/warehouse_recognition.py; tools/recognition_experiments.py; local_app/tests/backend/test_warehouse_recognition_v2.py; local_app/recognition_data/model-manifest.json

### 수정 금지 파일/범위

보호 scanner.py/quantity_templates/reference/기존 fixture

### 유지할 invariant

현재 stock을 숫자추론에 사용하지 않음, 5단/EMPTY/unknown 분리, duplicate auto-sum금지.

### 데이터 흐름

raw/normalized crops → R0/R1/Q0/Q1 → immutable ReportV2 → dry benchmark

### 함수/API 인터페이스

warehouse-design.md functions/ReportV2. T006A frozen R0 replay와 원인분류, T006B R1 normalized NCC/color·보조 pHash 및 Q1 component/full-token 비교. 후보 parameter/model hash 전부 보고; policy 없음은 REVIEW, frozen R0/protected resources 유지.

### 구현 순서

T006A: 1. correct/wrong MATCH/unknown/correct REVIEW 원본 slot/field crops를 replay한다. 2. digit/item/margin/layout/crop/profile/reader disagreement 원인을 evidence로 분류한다.
T006B: 3. 지정 low-cost R0/R1/Q0/Q1 후보를 동일 grouped calibration/negative/OOD에서 비교한다. 4. field/slot/capture/stratum wrong HIGH·correct REVIEW·workload/latency 측정 및 candidate artifact를 제출한다. 5. 채택은 Sol에게 반환하고 임의 ML/threshold 변경은 하지 않는다.

### 오류 처리

digit region clipping은 capture invalid; 정상 token unverified/불일치는 REVIEW. 동일 오류2회/ML 필요는 중단·evidence 보고.

### Logging / diagnostics

original decision/final truth, correct REVIEW reason, digit confusion·품목/수량/crop/profile별 원인, 각 reader 후보/score direction, field/slot/capture/stratum paired metrics/crop hashes/latency.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_warehouse_recognition_v2 -v
& '<PY>' -B tools/recognition_benchmark.py --manifest tests/fixtures/recognition-v2/manifest.json --engine warehouse-v2 --runs 10 --mode shadow --out '<local-results>/warehouse-candidates.json'
```

### 완료 조건

7오확정 재현자료와 unknown분리가 있고 candidate metrics/label leakage test PASS; main-write 0. accuracy 개선은 수치가 나올 때만 true.

### Git commit

권장: `feat: benchmark separate warehouse recognition evidence` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T007 / Confidence policy와 shadow

착수 상태: T006 후 T007A deterministic derivation 개발 READY; T007B usable 정책·audit 빈도 승인 BLOCKED; auto 정책 별도

### 목적

deterministic calibration 후보를 생성하고 Sol 승인된 HIGH 표시 정책·shadow audit를 고정한다.

### 현재 동작

legacy MATCH는 자동허가가 아니며 최종threshold/coverage 목표는 미확정이다.

### 목표 동작

wrong HIGH 증가 없이 correct REVIEW·사용자 workload를 줄이는 policy artifact로 usable HIGH 상세 생략을 승인하고 auto는 별도 gate로 남긴다.

### 선행 Task

T001/T005B/T006. T007A derivation 후 T007B Sol usable policy/audit scope 승인; T009 auto 승인과 분리.

### 수정 파일

local_app/backend/services/warehouse_recognition.py; local_app/frontend/js/recognition-ui.js

### 신규 파일

tools/recognition_policy_derivation.py; local_app/recognition_data/policy.json; local_app/tests/backend/test_recognition_policy.py; local_app/tests/browser_recognition_shadow.mjs

### 수정 금지 파일/범위

main stock/session/revision 및 기존 V1 workflow

### 유지할 invariant

no oracle labels to engine, unknown strata 승격 금지, auto flags OFF, 0확정/0오류 PASS 금지.

### 데이터 흐름

V1+V2 동일capture → policy/reason/차이 → human label 비교 → 승인scope

### 함수/API 인터페이스

derive_candidate_policies(calibration_manifest,reader_outputs,derivation_spec)->candidate-policy.json. observed breakpoints/rule/hash/seed/tie-break로 결정론적 frontier 생성; metrics/workload/independent group risk 포함. approve는 Sol review artifact, usableReviewApproved와 releaseApproved 분리. audit frequency/confidenceLevel/허용risk 미승인은 null.

### 구현 순서

T007A: 1. 승인 없는 loader는 REVIEW 유지. 2. deterministic candidate derivation과 paired correct REVIEW/wrong HIGH/workload/risk·scope 결과를 만든다. 3. validation/holdout은 frozen policy를 평가하고 retune에 쓰지 않는다.
T007B: 4. Sol이 candidate artifact/표본/지원 scope/낮은 HIGH audit 빈도를 승인한다. 5. reproducible random HIGH audit 또는 periodic full audit를 crop 보존·human truth와 연결해 shadow 실행한다. 6. usableReviewApproved를 고정하며 auto releaseApproved는 별도 risk/G0~G5 결정까지 false.

### 오류 처리

golden/실사용wrong HIGH≥1이면 해당scope를 release 후보에서 제외. holdout을 본 threshold retune금지.

### Logging / diagnostics

empiricalstats/denominators/scope warnings/policy/model/profile hash.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_recognition_policy -v
node local_app/tests/browser_recognition_shadow.mjs
& '<PY>' -B tools/recognition_benchmark.py --manifest tests/fixtures/recognition-v2/manifest.json --engine warehouse-v2 --policy '<frozen-policy.json>' --runs 10 --mode shadow --out '<local-results>/shadow.json'
```

### 완료 조건

A: 동일 입력/hash의 deterministic artifact·metrics 재현 PASS. B: wrong HIGH scope 제외, verified HIGH>0, correct REVIEW/workload 개선 근거와 supported scope·audit 승인 명시, shadow main-write0. full auto 최소표본/예산 미완료는 usable policy 완료와 분리.

### Git commit

권장: `feat: gate recognition confidence through shadow validation` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T008 / Warehouse usable V2 예외 검수·사용자 적용·feedback

착수 상태: T007 후 READY, label schema는 T002부터 고정

### 목적

HIGH 상세 검수를 생략하고 예외만 확인한 뒤 전체 patch를 사용자 한 번 적용으로 저장하는 첫 usable V2를 완성한다.

### 현재 동작

현재 main feedback v2는 all review slots로 원자 저장; V2는 sidecar prediction이다.

### 목표 동작

53 HIGH/3 REVIEW 예시에서 3개만 펼치며 예외 확정 후 HIGH+final REVIEW whole-patch를 한 main transaction으로 적용하고 field별 feedback/evidence를 남긴다.

### 선행 Task

T007B usableReviewApproved/audit + T002 early evidence. T009 automatic apply는 선행 아님.

### 수정 파일

local_app/frontend/js/recognition-ui.js; local_app/frontend/js/patch-review.js; local_app/backend/api/recognition.py; tools/recognition_dataset.py

### 신규 파일

local_app/tests/backend/test_recognition_feedback.py; local_app/tests/browser_recognition_feedback.mjs

### 수정 금지 파일/범위

기존 V1 feedback schema/export/atomic update

### 유지할 invariant

자동HIGH는ground truth가 아님; legacyitemonly/quantityunknown명확, 예외수정label과stock저장성공 분리.

### 데이터 흐름

VALID capture → HIGH summary/REVIEW crops → explicit exception confirmation → sidecar labels → guard/전체 patch 재검사 → 사용자 기존 PATCH 한 transaction → workload/export

### 함수/API 인터페이스

feedback-dataset.md /feedback 정확한 schema와 idempotency. V1review는 그대로 유지. V2review는 profile/field evidence 별도map으로 표시하며 master_patch DTO에 metadata를 섞지 않는다.

### 구현 순서

1. HIGH 상세는 선택 열기, REVIEW만 기본 표시; CAPTURE_INVALID는 적용 없이 한 번 재캡처 안내.
2. explicit 수정/제외/label version을 저장하고 전체 HIGH+final REVIEW canonical/quantity/duplicates를 다시 검증한다.
3. queue/revision/대상 stock/pending/session guards를 재확인한 사용자 전체 수동 PATCH를 기존 saveWarehouseInventory로 연결한다. 0 REVIEW라도 초기엔 적용 클릭 필요.
4. 저장 실패와 human label 성공을 나누고 workload/corrected fields/audit evidence를 export한다. 자동 main 적용은 false 유지.

### 오류 처리

unchecked/excluded/disputed/pseudo는training label에서 제외; label API response loss 동일ID재시도.

### Logging / diagnostics

fieldverified/corrected/reason/provenance/applied상태; 원본불변.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_recognition_feedback local_app.tests.backend.test_warehouse_feedback_v2 -v
node local_app/tests/browser_recognition_feedback.mjs
```

### 완료 조건

53/3 fixture에서 확인 UI3개(강제HIGH검수0), CAPTURE_INVALID 수십REVIEW0, valid whole-patch 사용자 main transaction1회, original prediction/field truth/retry/dispute/workload PASS, V1feedback/fallback 유지. U3 package 실사는 T013/T014의 해당 scope에서 별도 완료.

### Git commit

권장: `feat: collect verified exception feedback without self labels` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T009 / 검증된 Warehouse automatic apply

착수 상태: BLOCKED: G0~G3/warehouse 정책 승인 필요; 생산 활성화는 T014의 G4~G5 이후

### 목적

전체eligible slots HIGH인 경우만 같은 stock patch/persistence에 한 번 저장한다.

### 현재 동작

창고는 현재 전체review후수동PATCH이고 자동적용0이다.

### 목표 동작

전체eligible slots HIGH인 경우만 같은 stock patch/persistence에 한 번 저장한다.

### 선행 Task

T008 + G0~G3 + Sol warehouse automatic policy/risk 승인; 생산 auto는 T014 G4~G5까지 OFF. T010/T011/usable release의 선행 아님.

### 수정 파일

local_app/backend/api/recognition.py; local_app/backend/recognition_store.py; local_app/frontend/js/recognition-ui.js; local_app/frontend/js/persistence.js

### 신규 파일

local_app/tests/backend/test_recognition_auto_apply.py; local_app/tests/browser_recognition_auto_apply.mjs

### 수정 금지 파일/범위

main storage/contracts/schema, target/settings/slots, scheduler/completion

### 유지할 invariant

wrong HIGH 발견 scope auto허가0, partiallyHIGHauto0, captured revision 고정, 동일mutationreplay, independent group 위험·scope 미승인 auto0.

### 데이터 흐름

immutable 승인된 run → PREPARED sidecarintent → existingvalidator+mainmutate → receipt reconciliation → notification

### 함수/API 인터페이스

confidence-policy.md /warehouse/<id>/apply 및 lost-response계약. saveRecognizedWarehouse는 기존queue의 send를 재사용하고 error시새mutation 생성하지 않는다.

### 구현 순서

1. serverauthority/wholepatch/schedule guard를 확인한다.
2. run별intentbind/idempotency를 구현한다.
3. mainstock mutation과sidecarreconcile를 연결한다.
4. 자동success/409/unknown states와kill flag를 표시한다.

### 오류 처리

409=STALE, 최신revision silentretry금지. receipt없어판명불가=COMMIT_UNKNOWN, 자동재적용금지. committed readback failure는저장실패와구분.

### Logging / diagnostics

run/mutation/requesthash/revision/intentstate와releasepolicy만 기록.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_recognition_auto_apply local_app.tests.backend.test_storage_api -v
node local_app/tests/browser_recognition_auto_apply.mjs
```

### 완료 조건

allHIGH once apply/재고외영향0, 409/response loss/sidecarfail/receipt 만료/configOFF/동시run PASS, freshholdout wrongHIGH0·nonempty verified proposals·독립group/risk 승인과 actualChrome PASS. usable V2 완료는 이 Task와 독립.

### Git commit

권장: `feat: apply approved warehouse snapshots safely` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T010 / 물교 숫자·OCR candidate 측정

착수 상태: T001/T002/T003/T005A 후 T010A local geometry/numeric 실험 READY; 추가 OCR T010B는 concrete experiment-selection 전 BLOCKED; T009 의존 없음

### 목적

새row/column/raw 숫자 evidence와 candidate 비교를 통해 engine-selection 결정자료를 만든다.

### 현재 동작

과거localOCR는80행rowexact0이고 마지막숫자coverage0이었다.

### 목표 동작

새row/column/raw 숫자 evidence와 candidate 비교를 통해 engine-selection 결정자료를 만든다.

### 선행 Task

T001 trade oracle mapping + T002 early evidence + T003 capture + T005A profile/validity. Warehouse T006/T009와 독립.

### 수정 파일

tools/recognition_benchmark.py; tools/recognition_experiments.py

### 신규 파일

local_app/backend/services/trade_recognition.py (experiment 호출 가능, production 적용 없음); local_app/tests/backend/test_trade_recognition_v2.py

### 수정 금지 파일/범위

production dependencies/기존 trade catalog/DTO/importer/과거 SPEC100코드 복원

### 유지할 invariant

partialrow, 숫자default금지, OCR는candidate, 원본oracle amendment별도

### 데이터 흐름

validated listcrop → rows/lanes → text/icon/number evidence → six-fieldreport → candidate metrics

### 함수/API 인터페이스

trade-design.md ReportV2/strict6field. T010A는 NumPy/Pillow component/token/row-column geometry 및 catalog에 실제 reference가 있는 icon 후보만 측정한다. text raw candidate 없으면 UNREADABLE로 남긴다. T010B의 OCR runtime/model/lang/version/license/preprocessing/search 후보는 Sol experiment-selection에 고정한 뒤 별도 환경에서 실행. production engine-selection은 결과 검토 이후 산출하므로 실험의 선행으로 요구하지 않는다. remote/key는 이번 범위 없음.

### 구현 순서

T010A: 1. verified oracle/source rows/group과 validity를 확인한다. 2. rows/lanes/full numeric token/crow strata를 지정 low-cost 방법으로 비교하고 early crops/evidence 저장. 3. field/row/capture/list exact·review/partial/unknown/workload를 제출한다.
T010B: 4. text/OCR 추가 필요를 Sol에 실행 가능한 experiment-selection 후보로 반환한다. runtime/model/hash/dependency/version이 승인된 후 별도 실험환경에서만 실행한다. 5. frozen candidate-policy와 독립 validation/holdout 및 CPU/package 비용으로 Sol production engine-selection을 확정한다. Luna는 모델을 임의 선택하지 않는다.

### 오류 처리

숫자coverage0/동일failure2회면 evidence 보고·중단. text가 아직 미실험이어도 geometry/numeric 실험을 전체 실패로 합치지 않는다. 숫자default/임의OCR/remote전송 금지.

### Logging / diagnostics

field/row/fullcaptureexact, false HIGH, latency/RAM/package/null인 미측정 항목.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_trade_recognition_v2 -v
& '<PY>' -B tools/recognition_benchmark.py --manifest tests/fixtures/recognition-v2/manifest.json --engine trade-candidate --selection '<experiment-selection.json>' --runs 10 --mode shadow --out '<local-results>/trade-candidate.json'
```

### 완료 조건

A local layout/numeric state·오류/abstain/source-row/crop/hash 재현, B 승인 후보 실행·6field metrics/holdout/비용 evidence 각각 완료 보고. production engine 채택은 Sol 결정 gate, product integration 완료와 별개.

### Git commit

권장: `test: evaluate constrained trade field recognition` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T011 / 다중 캡처 merge와 기존 trade adapter

착수 상태: BLOCKED: T010 채택engine/독립holdout/정책승인 필요

### 목적

capture batch 완료 시 검증된DTO를같은processParsedTrades/sessionqueue로연결한다.

### 현재 동작

JSON importer는있지만image batch/overlap은없고unknown 숫자default가있다.

### 목표 동작

capture batch 완료 시 검증된DTO를같은processParsedTrades/sessionqueue로연결한다.

### 선행 Task

T000 실제 persistence 검증 + T010B Sol approved trade engine-selection/frozen policy/독립 holdout. T009 의존 없음.

### 수정 파일

local_app/frontend/js/trade-ui.js; local_app/frontend/js/trade-import-review.js; local_app/frontend/js/persistence.js; local_app/frontend/js/recognition-ui.js; local_app/backend/api/recognition.py

### 신규 파일

local_app/frontend/js/domain/recognition-adapter.js; local_app/tests/trade_recognition_adapter.mjs; local_app/tests/browser_trade_capture.mjs

### 수정 금지 파일/범위

domain/trade-import.js protected body, scheduler/routing/completion/sessionDTO

### 유지할 invariant

duplicate/conflict/ambiguous/landraw/disabled/deleted/yield 보존, failedcommit기존회차유지

### 데이터 흐름

captureordered rows → exactoverlap/conflictholds → stricter6fieldgate → existingimporter → stagedsession → existingPUTqueue → UI

### 함수/API 인터페이스

trade-design.md merge/prepare/commit/CaptureBatch. 현재 existing: api.saveWorkingSession / saveWorkingSession() / whenPersistenceIdle / snapshotWorkingSession / restoreWorkingSession / PUT working-session. 신규: saveWorkingSessionSnapshot(candidate,{guard,pendingIntent})->{revision,idempotent}; queue실행시 guard검사, 동일mutation/body/base 유지, DB성공뒤 UI, event double-save0. receipt 확인은 existing PUT 동일 envelope replay이며 기존 receipt 조회 API를 가정하지 않음; 만료/확증불가 COMMIT_UNKNOWN.

### 구현 순서

T011A: 1. pure merge/strict field gate/source mapping/exact overlap/숫자 conflict·partial HOLD를 구현한다. 2. existing importer outcomes를 mapping하고 accepted DTO exact equality를 검사한다.
T011B: 3. trade-ui session 생성/invalidation 공통 helper와 신규 snapshot helper를 기존 PUTqueue에 연결한다. pending guard·response loss·COMMIT_UNKNOWN·committed readback을 나눠 처리한다. 4. 예외 batch 완료→DB-first UI와 JSON/manual fallback 동일성을 검증한다. engine/model/threshold 재선택은 이 Task 범위 아님.

### 오류 처리

identity같고숫자다름/overlap모호/partialrow는HOLD; stalebatch/runtimespending는commit거부, working session overwrite하지않음.

### Logging / diagnostics

batch/recognition/rowIDs, outcomes, excluded reason, persist revision.

### 테스트

```powershell
node local_app/tests/trade_recognition_adapter.mjs
node local_app/tests/trade_import_regression.mjs
node local_app/tests/equivalence/verify-migration.mjs
node local_app/tests/browser_trade_capture.mjs
node local_app/tests/browser_trade_session.mjs
```

### 완료 조건

overlap/delete/conflict/unknown 숫자/ellipsis/pending/stale/responsefail PASS, 기존 보호된 86행 결과 동일, JSONfallback/DB성공후notification PASS.

### Git commit

권장: `feat: adapt verified trade captures to existing imports` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T012 / Later active learning·retention 개선

착수 상태: T002 early evidence + T008 또는 T011의 실제 feedback 이후 각 scope READY; 최초 저장은 T002 완료

### 목적

이미 축적된 evidence로 반복 confusion/확인 우선순위/새 profile 및 retention 개선안을 정한다.

### 현재 동작

V1은원본PNG를계속mainDB에저장; V2는선별crop/feedback만필요하다.

### 목표 동작

실사용 workload와 재현 crop에서 V2.1 개선 후보를 만들고 pseudo label 오염 없이 유한 저장량을 관리한다.

### 선행 Task

T002 + 실제 feedback이 있는 T008(Warehouse) 또는 T011(Trade). feature별 독립 refinement; usable release의 선행 아님.

### 수정 파일

local_app/backend/recognition_store.py; local_app/frontend/js/recognition-ui.js; tools/recognition_dataset.py

### 신규 파일

local_app/tests/backend/test_recognition_active_learning.py (artifact budget 시험은 T002의 기존 test_recognition_artifacts 재사용)

### 수정 금지 파일/범위

existingmainscanBLOB/verifiedlabel삭제/mainDBschema

### 유지할 invariant

label다중확인변경의disputed 보존, originalhash, debugOFFfull화면저장0

### 데이터 흐름

uncertain/correctedunit → smallcrop/hash/provenance → activelearningqueue → verifiedexport

### 함수/API 인터페이스

feedback-dataset.md retention/budget/sample schema. known margin/disagreement/newprofile priorities는fixedreason-based이고model스스로trainingtruth승격하지않는다.

### 구현 순서

1. T002 수집·budget 시험을 재사용한다. 2. confusion/correct REVIEW/reader disagreement/profile/column 오류와 workload를 집계해 fixed reason priority를 만든다. 3. 반복 오류/새 profile의 확인 후보를 제안하되 자동 label truth 승격하지 않는다. 4. 저장량·label참조·재현성에 근거해 retention 개선안을 Sol에 제출한다.

### 오류 처리

diskfull/budget초과새image저장거부, metadata와mainV1유지; missingoriginal이면full-layout재현불가명시.

### Logging / diagnostics

artifactbytes/retention/skips/labelref/sourcehash; screenshot은일반로그제외.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_recognition_artifacts local_app.tests.backend.test_recognition_active_learning -v
```

### 완료 조건

T002 crop/hash/budget/replay 회귀 유지, 원인/우선순위/workload로 후속 V2.1 분석 가능, pseudo/disputed truth오염0. 이 Task 전에도 early crops가 보존됨.

### Git commit

권장: `feat: retain useful recognition corrections within budget` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T013 / 격리 패키지와 CPU 성능 검증

착수 상태: T008 usable scope 후 먼저 실행 가능; auto/trade는 해당 T009/T011 후 추가 matrix; T012 선행 아님

### 목적

별도stagingbuild로새resource/CPUstartup/rollback을검증한다.

### 현재 동작

현재package68.9MiB이고build.ps1은installedapp을교체한다; startup미측정이다.

### 목표 동작

별도stagingbuild로새resource/CPUstartup/rollback을검증한다.

### 선행 Task

공통 T002/T003/T005 + release 대상별 T008(usable), T009(auto), T011(trade). stream 범위는 T004 live evidence. 구현 없는 scope OFF; T012와 무관.

### 수정 파일

local_app/packaging/bdo-barter.spec; scripts/build.ps1 (DistPath parameter/검증만)

### 신규 파일

scripts/audit-recognition-package.py; local_app/tests/backend/test_recognition_packaging.py

### 수정 금지 파일/범위

installedapp/runtime/userDB/기존referencehash

### 유지할 invariant

실행중app종료/교체금지, userdata/modelsensitive파일package미포함, fixedport/mutex기존의미

### 데이터 흐름

stagingresources → isolatedbuild → copyDB/isolatedLOCALAPPDATA → packageaudit/CPUlifecycle

### 함수/API 인터페이스

release-strategy.md. build parameter DistPath는workspace내검증된stagingpath, default동작변경은별도검토. modelmanifest policyresourceshash를검증한다.

### 구현 순서

T013A: 1. staging DistPath/datas/hiddenimports와 파일명/hash/실제 dependency/package size를 검사한다.
T013B: 2. 선택 release scope의 isolated CPU startup/latency/RAM/Chrome/BDO/paste/stream/shadow/flags·evidence를 실사한다. 3. same-schema3 기존 package fallback을 copy DB로 검증한다. 자동 적용이 미구현이면 auto matrix는 BLOCKED로 보고하고 usable package 검증은 계속 가능하다.

### 오류 처리

port/mutex충돌은제품실패와구분하여새환경필요보고; installedprocess를kill하지않음. 새MLdependencypackage실패는Sol재승격.

### Logging / diagnostics

coldhealth/UIstartup, source/model/policyhash, packagebytes, CPU/RAM, actual browser여부.

### 테스트

```powershell
& '<PY>' -B -m unittest local_app.tests.backend.test_recognition_packaging -v
powershell -NoProfile -File scripts/build.ps1 -Python '<PY>' -DistPath 'D:\BDOBarterDev\_dev\test_results\recognition-v2-staging'
& '<PY>' -B scripts/audit-recognition-package.py --package '<staging>/app' --manifest local_app/recognition_data/model-manifest.json
```

### 완료 조건

선언 scope별 stagingaudit/CPUstartup/실제BDO입력/V1fallback/rollback/mainsemantic·policy scope PASS. usable 결과와 full auto/trade 미완료를 따로 기록, mock/build만으로 lifecycle PASS 금지.

### Git commit

권장: `build: package recognition resources in isolated staging` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.

## T014 / 최종 release gate와 handoff

착수 상태: T013 이후 scope별 gate; usable은 U0~U3, fullauto는 G0~G5, trade는 engine/holdout/import gate

### 목적

실제구현증거에따라release가능범위를명확히하며Luna작업을종료한다.

### 현재 동작

현재설계만있고automatic policy/engine은승인전이다.

### 목표 동작

실제구현증거에따라release가능범위를명확히하며Luna작업을종료한다.

### 선행 Task

T013의 해당 release scope 증거 + usable U0~U3 / automatic G0~G5 / trade T010B+T011 engine-freeze·holdout·integration. 모든 기능 완료를 usable의 선행으로 묶지 않는다.

### 수정 파일

specs/008-capture-recognition-v2/validation-report.md; 승인된 release metadata/사용자설명 문서만

### 신규 파일

specs/008-capture-recognition-v2/release-gate.json

### 수정 금지 파일/범위

unrelateddocs/기존역사보고서/installedapp/Git무승인작업

### 유지할 invariant

PASS는실행증거단위, unverifiednull, originalprotectedcontent 불변

### 데이터 흐름

test/benchmark/실사/manifest → release decision/scope/defaults → user-reviewableartifact

### 함수/API 인터페이스

release-gate.json {version,scope,status,sourceCommit,modelHashes,policyHash,datasetHash,metrics,workload,risk,audit,manualChecks,rollbackEvidence,unsupportedScopes,blockingReasons}. usableWarehouse/automaticWarehouse/tradeSession을 각각 PASS/BLOCKED/NOT_RUN. auto risk n/k/upperBound/confidenceLevel·capture 결과 미승인 BLOCKED.

### 구현 순서

1. 모든Task의diff와보고를수집한다.
2. 같은manifest의zero-error/coverage/CPU/package수치를확정한다.
3. actualChrome/game/rollback 증거를대조한다.
4. defaultflags와releaseauthority를확인한다.
5. 사용자승인용배포결과를구체화하되설계요청만으로배포/commit/push하지않는다.

### 오류 처리

missinggate는fail/blocked, scope안열기. 0auto-proposalprecision은null, 같은 failure 2회는Sol재검토.

### Logging / diagnostics

각gate의command/status/artifact/hash와미실행이유.

### 테스트

```powershell
node local_app/tests/equivalence/verify-migration.mjs
node local_app/tests/trade_import_regression.mjs
& '<PY>' -B -m unittest discover -s local_app/tests -v
기존원본9회귀: README의9commands를새결과경로로실행
이번V2benchmarks/actualChrome/package/rollback명령전부
```

### 완료 조건

선언 scope의 자동 checks/actualChrome·game/packaged·rollback/main/protected 보존·해당 정책 승인이 모두 true일 때 READY_FOR_RELEASE(scope). auto는 추가 zero wrong/nonemptyverified/독립group위험·허용risk·minimumGroups·cutoffs·holdout 필수. usable만 PASS이면 auto/trade BLOCKED를 그대로 보고.

### Git commit

권장: `docs: record recognition release gates and limits` (명시적 Git 작업 승인 후 해당 Task 변경만).

### 구현 완료 후 보고할 정보

수정/신규파일, command별결과, benchmark변화(없는경우미측정), 알려진제한,git diff요약, 이Task의boolean완료조건과다음Taskblocker. 자동검증/실제browser/게임검증은따로기록한다.


