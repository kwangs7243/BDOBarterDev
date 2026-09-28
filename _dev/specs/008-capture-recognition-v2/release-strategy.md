# Git / Release Strategy

## Baseline resolution plan (이번 Git 변경 미실행)

루트/_dev에는 active .git이 없고 분리 metadata는 HTML v1.0 history다. T000은 repo 탐색이 아니라 authoritative baseline **해결** Task다. 이번에는 Git mutation을 실행하지 않는다.

Case A: 읽기 전용 commit/tree enumeration으로 현재 source/protected files/manifest와 repository-relative 경로·bytes hash가 일치하는 history를 검증한다. 일부 파일만 일치하는 옛 commit을 baseline으로 간주하지 않는다. current-only 자료와 excluded data도 별도 목록으로 보존한다. 사용자의 승인된 Git 복구 범위에서 별도 checkout/managed worktree에 검증 history를 연결하고 source hash를 재검증한다. 기존 폴더/metadata를 이동·덮어쓰지 않는다.

Case B: 정확히 일치하는 history가 없으면 현재 source tree/protected files/baseline manifest/사용자 변경을 기준으로 **새 authoritative baseline 생성** 절차를 제시한다. 구현자가 옛 metadata를 강제로 연결하지 않는다. git-baseline-proposal.json에 destination/source manifest/protected hashes/include-exclude 파일 목록(작은 source·docs·curated fixtures 포함, app binaries/DB/captures/secrets/venv 제외)/옛 history read-only 보존/실행 단계/rollback 경로를 기재해 사용자 Git 승인을 받는다. 승인 뒤 검증된 별도 destination에 현재 bytes를 복사→재해시→git init→명시된 파일만 stage→staged diff/secret·scope 검사→승인된 baseline commit→tree와 manifest 재대조한다. branch/remote/push는 승인 범위 밖이면 실행하지 않는다. 초기 baseline commit 없이 authoritative라고 표시하지 않는다.

T000 결과 repository-access.json에는 case A/B, resolutionStatus(INSPECTED|AWAITING_GIT_AUTHORIZATION|RESOLVED), sourceRoot/gitRoot/baselineCommit/baselineTreeHash/sourceManifestHash/protectedHashes/approvedChanges/excludedFiles를 기록한다. ready=true는 RESOLVED·commit/tree/source/hash 정합과 기존 변경 보존·실제 persistence 검증 PASS 이후만 허용한다. unresolved 동안 생산 구현 금지; 읽기 전용 조사·해결안은 착수 가능하다.

기존 규칙의 main/release/vX.Y 및 선택 work/<short-name>을 유지하되 V2 격리는 work/recognition-v2를 후속 승인 시 권장한다. 버전/tag/원격은 현재 추측하지 않으며 역사 v1.0 tag를 현재 exe release로 간주하지 않는다.

## Commit units / bisect

T000 기준점 해결 → T001 dataset/R0 baseline → T002 계약/security/early evidence → T003 입력. T004 stream과 T005 profile은 T003 후 분리 가능. 공통 T001/T002/T003/T005 뒤 T006 warehouse와 T010 trade 실험이 독립적이다. T006→T007 policy/shadow/audit→T008 usable V2; T009 full auto는 추가 gate 뒤 선택 분기. T010→T011 trade integration은 engine/holdout 승인 뒤이고 T009 의존 없음. T012 active learning은 각 feature의 feedback 이후. T013/T014는 usable/auto/trade 범위를 선언해 각 milestone별 실행하며 미구현 feature를 활성화하지 않는다.

각 Task의 실험(A)·결정(B)·integration 단위는 [tasks.md](tasks.md)의 stage exit에 맞춰 작은 commit을 권장한다. 같은 harness 파일을 동시에 수정하지 않는다. rollback flag/시험은 같은 단위에 넣고 미완성 auto 기본 ON 금지. source/dataset/무관 UI·계산을 섞지 않는다. commit은 제안일 뿐 명시적인 Git 요청 없이 add/commit/push하지 않는다. fixture/manifest/policy hash와 명령을 남겨 bisect가 가능하게 한다.

## Packaging

기존 PyInstaller onedir를 유지하고 frontend와 신규 recognition_data/작은 model metadata를 datas에 추가한다. 새 services/store/API import를 package audit한다. benchmark tool/raw captures/main·sidecar DB/Temp venv/SPEC100 큰 이미지/학습 출력은 production에 포함하지 않는다.

현재 `_dev/scripts/build.ps1`은 상위 app을 직접 교체하므로 후속 T013에서 명시적 DistPath를 추가한다. 검증 build는 workspace 안 staging에만 출력하고 installed app에 --noconfirm을 적용하지 않는다. resolved staging path가 workspace 안 새 경로인지 확인한다. build 실패 때 기존 app을 삭제하지 않는다.

release artifact에는 source commit/hash manifest, dataset/model/policy hashes, CPU metrics, dependency versions, 미지원 profile, default flags, 격리 package/실사 결과를 첨부한다. 실행 중 앱을 검증 목적으로 임의 재시작하지 않는다. startup 실사는 격리 DB와 충돌하지 않는 승인된 환경에서 고정 port/mutex를 확인한 뒤 한다.

## Dependency policy

초기 release의 새 production dependency는 **0**이다. Flask/Waitress/NumPy/Pillow/표준 SQLite를 재사용한다. native bridge/OpenCV/RapidOCR/ONNX/PyTorch/large VLM은 지금 채택하지 않는다. 후속 local OCR 실험이 필요하면 production pyproject를 바꾸지 않고 별도 환경에서 model/OS language/runtime/version/license/package 증가를 기록한다. 정확도 개선 없음, 숫자 coverage0, offline 불가, 추가 runtime/관리자 권한 필수, package 불안정이면 채택하지 않는다.

remote는 정확도/exception 감소를 비교하는 평가 계획만 있다. remoteFallback=false와 Gemini 제거를 유지하며 외부 전송/API key 관리 Task는 이번 release에 없다.

## Scope별 release artifact

usableWarehouse(U0~U3), automaticWarehouse(G0~G5), tradeSession(engine freeze/holdout/import/package) 결과를 별도로 기록한다. 전체 auto blocked여도 usable은 검증된 범위에서 릴리스 후보가 될 수 있다. auto artifact에는 independentGroups/observedWrongHigh/upperBound/confidenceLevel/scope/capture-level outcome을 요구한다. 허용 risk/최소표본/예산을 임의 결정하지 않으며 0 proposals은 NOT_EVALUABLE이다. 초기 feature flags는 모두 OFF, audit/evidence는 활성화하려는 scope의 gate 일부다.
