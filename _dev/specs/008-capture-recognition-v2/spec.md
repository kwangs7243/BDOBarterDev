# SPEC-008 — Capture / Recognition Automation V2

상태: **READY_FOR_LUNA_PHASE0 — 최종 설계 보정 완료**. T000의 읽기 전용 기준점 조사·해결안 작성은 지금 착수 가능하다. 생산 구현은 authoritative Git baseline 확정 후에만 시작한다. Phase 1 기반 계약은 확정됐으며 선행 조건은 [tasks.md](tasks.md)에 있다. 이 상태는 Warehouse usable V2·완전 자동 적용·Trade engine의 검증 완료를 뜻하지 않는다. 이번에는 문서만 보정했다.

## Purpose / User Outcome

Warehouse V1은 이미 실사용 중이며 대부분 정상 판독한다. V1을 frozen R0로 보존하고 **틀린 값의 확정(false acceptance)**과 **정답인데 확인을 요구하는 unnecessary review**를 함께 줄인다. 1~4단 56종만 자동 판독 대상이다. 5단은 stack/count 의미와 판독 조건이 달라 사용자가 직접 관리하는 확정 business rule이며 AUTO/REVIEW 분모에서 제외한다. 5단이 보인다는 이유로 정상 capture를 거부하지 않는다.

첫 usable milestone: 캡처 → 자동 인식 → REVIEW 슬롯만 확인·수정 → 사용자 적용 버튼 → 전체 patch 한 main transaction. 예를 들어 53 HIGH/3 REVIEW라면 3개만 펼치고 53개의 세부 검수를 강제하지 않는다. 이후 충분한 근거가 확보됐을 때의 완전 무인 auto apply는 별도 milestone이며 첫 usable V2의 선행 조건이 아니다.

Trade screenshot recognition은 현재 앱에 없는 신규 기능이다. 캡처 → 행/필드 후보 → 기존 catalog/validation → 예외 행 확인 → 완료 클릭 → 기존 영속 회차 생성이 첫 목표다. JSON 입력/수동 행 편집을 유지한다.

## Source of truth

[현재 구조](current-state.md), [파일 hash/측정 snapshot](baseline-manifest.json), 기존 실제 코드가 정본이다. SPEC-007의 영속 회차/슬롯과 schema 3 피드백을 유지한다. 과거 SPEC-003의 scan history 미저장, SPEC-001의 3-table, 동결 당시 memory-only 회차 설명은 현재 계약으로 사용하지 않는다. 과거 문서는 변경하지 않는다.

## In Scope

공통 PNG capture envelope, clipboard image paste, 세션 browser stream, normalized region+anchor profile, local warehouse V2 실험/평가, confidence/abstention, shadow, 기존 stock PATCH adapter, multi-capture trade 후보/merge/upstream validation, 기존 피드백 재사용, golden/benchmark, feature flags, 격리 package 검증과 후속 Luna Task.

## Out of Scope

게임 키 입력/자동 스크롤/메모리/패킷 조작, scheduler/routing/completion 계산 변경, canonical DTO 변경, 5단 창고 자동 판독·AUTO/REVIEW, 기존 입력 제거, 원본/기존 reference/fixture 덮어쓰기, 사용자 DB migration, Gemini 재도입, native capture production 도입, 미측정 ML dependency production 채택, 이번 설계 중 실제 학습·배포·Git 변경.

## Functional Requirements

| ID | 요구사항과 boolean 판정 |
|---|---|
| FR01 | 파일/붙여넣기/stream이 공통 CaptureInput v1으로 들어가고 엔진은 source UX를 모른다 |
| FR02 | 프로그램의 명시적 창고/물교 context에서 image paste; 텍스트/입력란 paste 동작을 보존한다 |
| FR03 | stream은 사용자가 선택한 세션에서만 유지하며 disconnect/reload/종료 시 해제한다 |
| FR04 | 입력 validity를 먼저 검사; 잘못된 UI/grid/crop/심각한 profile mismatch/숫자 clipping은 CAPTURE_INVALID로 한 번 재캡처 안내; 정상 화면의 일부 불확실성만 REVIEW |
| FR05 | raw distance와 probability를 구분; item/quantity/layout/quality/duplicate gate 모두 통과해야 HIGH |
| FR06 | NULL, 0, EMPTY, MISSING, UNREADABLE을 별도로 보존한다 |
| FR07 | warehouse patch v1, tier1~4, stock only, 없는 품목 보존; duplicate 자동합산 금지 |
| FR08 | 초기에는 HIGH 세부 검수 없이 예외만 확인한 후 사용자 전체 patch 적용; 후속 auto는 모든 대상 HIGH인 nonempty capture 및 별도 승인 gate 필요 |
| FR09 | revision/session/pending guard와 동일 mutation replay; 충돌 후 silent retry 금지 |
| FR10 | trade 6필드 전부 safe validation 후 processParsedTrades; 기본숫자로 unknown을 숨기지 않는다 |
| FR11 | overlap exact merge와 숫자/identity 충돌 hold; 새/추가 회차 UX 및 schedule invalidation 재사용 |
| FR12 | 자동 output은 ground truth=false; verified human label은 필드별로 분리한다 |
| FR13 | V1/PNG/JSON fallback은 계속 사용 가능하며 flag OFF 즉시 V2 데이터 적용이 중단된다 |
| FR14 | baseline/golden manifest/정책 hash/모델 hash와 결과를 한 명령으로 재현한다 |
| FR15 | T002부터 run/crop/hash/evidence를 유한 budget에 보존; 예외와 낮은 빈도 HIGH audit로 확정 오류·정답 REVIEW를 재현하고 라벨 편향을 명시한다 |

## Nonfunctional Requirements

CPU inference 필수, GPU/관리자 권한 필수 의존 없음. 동일 origin/loopback, 기존 20MiB/32MP 제한 유지. PNG encoding은 lossless이지만 capture source의 원본 pixel fidelity를 보장하지 않는다. 실제 frame rescale·crop·letterbox·transform을 기록하고 검증 범위 밖은 HIGH를 제한한다. 앱 UI zoom과 게임 UI scale 분리. 로그는 screenshot/인증/absolute user path를 일반 로그에 출력하지 않는다. dataset은 app 바깥 Git 제외 경로에 둔다. 신규 DB는 recognition sidecar만 허용하고 main schema 3을 보존한다.

속도/메모리/package 수치의 최종 예산은 현재 측정과 새 엔진 benchmark 이후 결정 기록으로 잠근다. 임의 목표를 현재 달성 수치처럼 제시하지 않는다. 상세 nonnumeric release gates는 [benchmark-plan.md](benchmark-plan.md)에 있다.

## Invariants / Acceptance

보호 scanner.py와 processParsedTrades 및 계산 42함수/6상수는 hash/equivalence를 유지한다. scan/shadow/취소는 main inventory/settings/working_session/revision을 변경하지 않는다. review feedback를 저장하는 기존 수동 적용 transaction은 유지한다. 자동 apply는 main stock 절대값 한 transaction이며 target/slot/영구 설정을 변경하지 않는다.

Usable V2는 U0~U3(benchmark-plan.md)의 HIGH 표시 정책·예외 검수·사용자 적용·실사 gate로 판단한다. 완전 auto는 별도 G0~G5를 모두 통과해야 한다. 두 milestone 모두 확인하지 않은 HIGH를 정답으로 세지 않는다. auto 정책에는 독립 평가 group 수, wrong HIGH, capture-level 결과, upper risk bound와 승인 scope를 기록한다. 허용 risk/표본 수/감사 빈도는 실제 자료로 후속 Sol이 승인하며 지금 숫자를 발명하지 않는다. 0 HIGH/0오류는 PASS가 아니다.

## Deliverables

[Architecture](plan.md), [Capture](capture-design.md), [Warehouse](warehouse-design.md), [Trade](trade-design.md), [Confidence](confidence-policy.md), [Feedback](feedback-dataset.md), [Benchmark](benchmark-plan.md), [Migration/Rollback](migration-rollback.md), [Git/Release](release-strategy.md), [Luna Tasks](tasks.md), [이번 검증/차단 사유](validation-report.md).
