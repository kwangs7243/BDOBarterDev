# SPEC-008 Design Validation / Handoff

조사·설계 및 최종 보정일: 2026-09-28. 상태: **READY_FOR_LUNA_PHASE0**. 최초에 설계 문서13개/기준 JSON1개를 작성했고 이번 최종 보정에서는 기존 문서13개만 수정했다. baseline-manifest.json bytes는 유지한다. 구현 코드/새 tests/모델 학습/라이브러리 설치/사용자 DB migration/배포/Git 변경은 수행하지 않았다.

## 핵심 판정

현재 stock persistence/import invariants를 재사용하는 architecture와 입력·report·sidecar·피드백·merge·auto-apply 계약, Luna Task 15개를 정의했다. Phase0·기반 작업의 계약은 확정했다. 현재 착수 가능은 T000A의 읽기 전용 조사·Git 해결안이며 생산 구현은 authoritative baseline 이후다. Warehouse usable exception-only review와 full auto 적용 gate를 분리했고 Trade 실험은 T009에 의존하지 않는다. 최종 HIGH cutoff/trade engine/허용 risk는 측정·승인 전이라 전체 자동화 READY를 선언하지 않는다.

## 최초 설계 작성 단계에서 실제 수행 — 보존된 측정

| 검증 | 결과 | 검증 범위 |
|---|---|---|
| 저장소/물리 파일 조사 | 완료 | current-state.md의 호출 흐름/실행 경계/차이 |
| Git status/log/refs | active repo 없음 | 분리 metadata에서 main/origin/main, v1.0, commit3개 확인; 현재 clean baseline 아님 |
| warehouse evaluate_fixture 두 함수 | PASS | 알려진 fixture2/target105, item/quantity exact105, patch99, wrongpatch0; 오래된 main의 HTML hash 검사를 변경하지 않고 함수만 호출 |
| 실제 사용자 feedback | 읽기 전용 집계 완료 | scan7/uniqueimage6, feedback5, labels179, verifieditem175, verifiedquantity163, 11unknown+7wrongMATCH |
| backend test_warehouse_scan + test_warehouse_feedback_v2 | 8 PASS | 실제 scanner adapter/limits/lock/cleanup/feedback/idempotent legacy export, 격리 DB |
| importer regression | PASS | fixture3/86행, exact accepted/held, 오류/특수·육지/ambiguous/duplicate/conflict |
| protected equivalence | PASS | 함수42/상수6/보호영역2/보호파일15 |
| warm CPU benchmark | 측정 완료 | fixture별 warmup1+10runs, mean/p95, includes decode/grid/resources/readers/hash |
| source/package 비교 | PASS | 대응 자원108개 hash 동일; 앱 전체 compiled module equivalence는 검사하지 않음 |
| 문서 구조/링크/Task 형식/190 hash | PASS | Markdown13/JSON1, Task15개 모두필수17절충족, brokenlink0, source변경0 |

scanner baseline 첫 wrapper 호출은 반환값 순서를 잘못 해석해 KeyError(slots)로 종료했다. evaluate_fixture의 실제 반환 `(patch,summary)`를 확인해 wrapper를 바로잡고 성공 측정했다. 제품/fixture/expectation은 수정하지 않았다. CIM hardware 조회는 액세스 거부였고 CPU registry/표준 Windows memory API로 수치를 확인했다. 기본 Python3.14에는 Pillow가 없었으며 설치하지 않고 기존 검증 Python3.12 환경을 사용했다. unittest의 multipart ResourceWarning 1건은 시험 클라이언트 자원 경고이며 8개 테스트 결과는 PASS였다.

## 미실행 / 한계

BROWSER_NOT_RUN. 이번 작업에서 실제 Chrome UI/BDO capture/paste/권한 picker/DPI/다중 monitor 실사를 하지 않았다. 설치 앱이 실행 중이므로 packaged startup/재시작/배포를 하지 않았다. 전체 backend suite/원본9개 대형 regression matrix는 이번 문서 작업에서 재실행하지 않았다. 일부 기존 evidence test의 `_dev/마스터창고.png`는 없고 고치지 않았다. 과거 SPEC100 prototype/model은 제거되어 역사 숫자를 현재 실행 결과로 취급하지 않는다. 신품목/모든 digit length/새 UI profiles의 성능과 신규 ML/OCR/remote 비교는 미측정이다.

## 정확한 blockers — milestone별

1. Git: authoritative current commit/tree가 없어 생산 구현 BLOCKED. T000A 해결안은 지금 가능; Case A 검증 history 또는 Case B 승인된 새 baseline 생성으로 T000B가 실제 해결한다. 옛 metadata 강제 연결 금지.
2. 데이터: 기존 fixture2/feedback6 unique는 development/replay이며 holdout 아님. T001/T005/T006에서 provenance·wrong MATCH·correct REVIEW·scope/splits를 준비한다.
3. usable Warehouse: T007A deterministic derivation→T007B Sol usableReviewApproved/낮은 audit빈도→T008 사용자 전체 적용→U3 package/실사 미완료. 신규 cutoff는 null. **full auto 최소표본/허용risk 승인은 첫 usable의 선행이 아니다.**
4. full auto: T009/G0~G5 및 independent groups/upperBound/허용risk/범위·CPU/package 예산 승인 미완료; auto 기본OFF. wrong HIGH0 단독 판정 금지.
5. Trade: T010A 공통 기반 뒤 geometry/numeric 실험 가능. 추가 OCR T010B에는 실행 가능한 experiment-selection, T011에는 engine freeze/freshholdout 승인 필요. T009는 두 Task 선행이 아니다.
6. 실제 Chrome/BDO/packaged startup·CPU/rollback은 미실행이며 T013/T014에서 scope별 검증한다. T012 active learning까지 기다려 초기 evidence를 수집하지 않는다.

이 blockers는 측정·승인 전 단계를 나타내며 설계 계약의 미정과 구분한다. 이번 지시서는 문서 보정만 승인하며 자동으로 후속 구현/Git 작업을 수행하지 않는다.

## Luna handoff 규칙

[tasks.md](tasks.md) 순서/수정 파일/신규 파일/금지 범위/입출력/오류/명령/boolean 완료 조건을 따른다. final policy/engine artifact가 없는 Task는 BLOCKED를 유지한다. existing DTO/main migration/importer 의미 변경, 같은 오류2회, 설계 밖 큰 변경은 현재 diff/log를 정리하고 Sol 재검토로 돌린다. source/code/test expectation을 바꿔 잘못된 인식값을 정상으로 만들지 않는다.

## 이번 결과 파일

[현재 상태](current-state.md), [요구사항](spec.md), [architecture](plan.md), [capture](capture-design.md), [warehouse](warehouse-design.md), [trade](trade-design.md), [confidence](confidence-policy.md), [feedback](feedback-dataset.md), [benchmark](benchmark-plan.md), [migration/rollback](migration-rollback.md), [Git/release](release-strategy.md), [Luna Tasks](tasks.md), [baseline manifest](baseline-manifest.json).

## 최종 보정 A~K / 검증 근거

### A. 유지한 설계

동일 SPEC-008, frozen V1 scanner/resources, file/clipboard/stream hybrid, normalized profile/anchor, NumPy/Pillow 우선, NULL/0/EMPTY 구분, master_inventory_patch v1·stock-only 한 transaction, canonical6field/processParsedTrades, main schema3+sidecar 분리, revision/receipt/동일mutation/flag rollback, JSON/PNG/manual fallback과 격리 package 전략을 유지했다.

### B. 사용자 의도 반영

V1은 대부분 정상이며 false acceptance와 unnecessary review 모두 개선한다. 1~4단56종만 대상이고 5단은 수동 관리 business rule(SKIP, invalid 원인 아님). 첫 usable은 HIGH 상세 강제검수 없이 예외만 확인→사용자 whole-patch 적용. full auto는 후속 단계다. Trade는 신규 기능이며 Warehouse auto와 실험 의존성을 분리했다.

### C. Red-Team 보정

capture validity/recognition uncertainty 분리, PNG pixel-fidelity 과장 제거, correct REVIEW와 full capture/profile 지표, HIGH 저빈도 audit, T002 early evidence/budget·해시·필수crop 누락 fallback, 독립group/위험상한·미확정허용risk, deterministic calibration→artifact→Sol 승인, Git Case A/B 실제 해결, 기존 guard 재사용 security tests 및 actual persistence/new helper 구분을 추가했다. 필수 evidence 없이 HIGH를 숨기지 않는다.

### D. Warehouse workflow

capture → validity(실패는 CAPTURE_INVALID/재캡처 한 번) → frozen R0 대비 V2 item/quantity → HIGH 요약/REVIEW만 확인 → 전체 patch guard/중복검사 → 사용자 적용 → 한 main transaction. sidecar labels와 main apply 결과는 별개다. auto는 별도 승인 후 all HIGH/nonempty만 가능.

### E. Trade workflow

capture/사용자scroll/multi capture → valid rows/fields+catalog → exact overlap merge/partial·같은identity숫자충돌HOLD → 예외 확인 → 완료 → 기존 processParsedTrades → DB-first PUT working-session → UI 반영. 숫자default/자동scroll 없음, JSON/manual 편집 유지.

### F. Task graph

T000 baseline 해결→T001 R0/dataset→T002 early evidence/security→T003. T004 stream과 T005 profile은 분리 가능. 공통 기반 후 T006 Warehouse와 T010 Trade 연구가 독립. T007/T008은 usable Warehouse, T009는 후속 auto. T010B engine/holdout→T011 integration, T012는 feedback 이후 refinement. T013/T014는 scope별이며 usable을 T009/T011/T012에 묶지 않는다. A/B stage는 기존15 Task 내부에 나눴다.

### G. Luna가 지금 시작할 범위

T000A 현재 source/hash/history 비교, persistence/API 실증, Case A/B baseline 해결안·repository-access artifact 작성과 기존 R0 자료의 읽기 전용 분석. T000B Git 실행은 별도 명시승인 후. T000 ready=true 뒤 T001 신규 CLI/fixtures, 이어 T002 contract/security/early-store 및 T003/T004/T005A 기반 구현은 고정 계약으로 진행 가능하다. 이 설계 보정 요청만으로 실제 구현하지 않았다.

### H. Sol 결정 / blockers

T005B profile scale/kernel/validity scope, T007B deterministic-derived usable policy/audit 빈도, T009 auto 최소독립표본/허용risk/confidence level/예산·scope, T010B OCR experiment 실행명세와 최종engine freeze/holdout은 자료 검토 필요. 후보 없이 Luna/Sol이 임의 수치를 결정하지 않는다. 실제 API가 이미 존재하지만 saveWorkingSessionSnapshot(candidate)는 신규 helper이며 현재 enqueueMutation은 호출마다 새 UUID여서 응답 유실 안전성을 별도로 구현해야 한다.

### I. 변경 파일

spec.md/current-state.md/plan.md/capture-design.md/warehouse-design.md/trade-design.md/confidence-policy.md/feedback-dataset.md/benchmark-plan.md/migration-rollback.md/release-strategy.md/tasks.md/validation-report.md. 같은 디렉터리 baseline-manifest.json은 사실·hash 변경 없음으로 유지한다. production/test source·사용자 DB·package·Git metadata는 수정하지 않는다.

### J. 이번 보정 검증

실제 code 재대조: storage schema3/working_session/update_session/mutate + session PUT API + frontend api.saveWorkingSession/queue/runtime snapshot·restore가 존재하여 **SPEC-007 docahead 가정이 아니라 현재 source persistence 구현**임을 확인했다. packaged compiled 모듈의 버전 동일성은 이 판단 범위 밖이다. existing Host/Origin guard의 missing-Origin 허용도 code로 확인했고 보강은 future T002로 표시했다. 최초 측정값/8unittest·86row/equivalence PASS는 위 보존표의 이전 실행 결과이며 이번 보정에서 재실행하지 않는다.

최종 파일 저장 후 문서 검사 PASS: Markdown13개, local links35개/broken0, 15Tasks×17필수절 누락0, code fence 오류0, parent Task 의존성 cycle0(대상별 OR 선행은 별도 검토), existing 인터페이스의 실제 source 파일10개 존재 확인. T010은 T009 의존 없이 공통 기반만 선행, T013은 usable 범위에서 T009/T011/T012 선행 없음으로 검토했다. source SHA-256 190개 변경0, baseline-manifest.json SHA-256 418ad7e0e7fa3aefeeaca981b1e3d3c6d5ef524f4263ff7fe8f7ef906465b3c6 동일. 보정 변경은 같은 SPEC 문서13개만 확인했다. Chrome/게임/package·risk 측정은 BROWSER_NOT_RUN/NOT_RUN이며 설계 정합성 PASS와 제품 milestone PASS를 구분한다.

### K. 판정

**READY_FOR_LUNA_PHASE0**. T000A 및 후속 기반 Task의 입력/출력/범위·중단조건이 설계됐다. authoritative Git 해결 이전 생산 구현은 BLOCKED, usable/full-auto/Trade 릴리스는 아직 검증되지 않았다.
