# SPEC-008R — Current Roadmap

기준: 2026-09-30, source HEAD `66c45e4328ecd2c3de034527b37e6e3109038db8`. 목표 정본은 [CURRENT-PRODUCT-CONTRACT.md](CURRENT-PRODUCT-CONTRACT.md), 결정 근거는 [DECISION-REGISTER.md](DECISION-REGISTER.md). 이 문서가 유일한 active roadmap이다. [tasks.md](tasks.md)의 T000~T014는 historical plan/invariants로 남기며 완료를 일괄 소급 선언하지 않는다.

## 상태 의미와 현재 자산

`DONE`은 표에 명시된 구현/분석만 완료, `PARKED`는 보존하고 현재 진행하지 않음, `SUPERSEDED`는 이전 지시를 그대로 실행하지 않음, `ON_HOLD`는 명시된 재개 근거 필요, `ACTIVE_NEXT`는 다음 승인 후 실행할 한 과제, `FUTURE_GATE`는 미완료 후속 과제다. **DONE ≠ production-ready**. 이 realignment에서 신규 Trade E2E를 production-ready로 인증하지 않는다.

| 자산 | 상태 | 성격 / 현재 근거 / 한계 |
|---|---|---|
| Browser display/file/paste capture | DONE | 구현 자산, 실제 live 캡처에 사용(live-validated capture 사용 범위). 전 환경 품질 인증 아님. fidelity 계약 유지. |
| Trade ROI/멀티 queue | DONE | 구현 자산, `b2a9ada`와 current recognition-ui; 조절·순서·삭제·retry. 겹침 의미 병합은 별개. |
| Local trade batch API / PaddleOCR worker | DONE | experimental integration, `16f680d`, `84c9c36`; 현재 draft-only/production=false. 모델 정확도 인증 아님. |
| Row detection / edge policy | DONE | experimental, `66c45e4`; archive16captures/80rows, live2captures/11complete/3edges 기록. edge는 fields 없는 evidence. |
| Raw six-field draft / browser table | DONE | experimental read-only surface. correction prefill/edit/batch confirm/session bridge 미구현. |
| V1 correction analysis | DONE | analysis-only E0; text13 복구, numeric wrong accepted3 offline. V1 output truth 아님. |
| Live reviewed11행/66필드 | DONE | live-validated human evidence 범위, 원시 표시31 unchanged/35 incorrect. 독립 holdout/production 정확도 아님. |
| Numeric N2 | PARKED | experimental diagnostic; req/yield 각각10/11, combined production controller 미검증. R004에서 근거로만 재사용. |
| E0 correction-first audit | DONE | analysis-only, WRONG_ACCEPTANCE_REQUIRES_SOL_REDESIGN으로 종결된 근거. 제품 완료 아님. |
| E1 safety design | DONE | design-only + ignored prototype; all11 HOLD/safe0, 안전 개념만 재배치. |
| old T010P3E2 | SUPERSEDED | **SUPERSEDED_PENDING_PRODUCT_REALIGNMENT**. 옛 qualifier를 review prerequisite로 구현 금지. |
| T010P3D4-S1 | ON_HOLD | 새 correction+review 후 fromItem edit burden이 지배적이라는 근거가 있을 때만 재개. |
| Warehouse V1/기존 V2 실험 | PARKED | 현행 기능/안전/inventory 계약 보존. Trade 변경을 이유로 scanner·threshold·tier 범위를 바꾸지 않음. |
| Review-first E2E / Registry / 새 correction | FUTURE_GATE | design-only. 다음 표의 과제들을 통과하기 전 구현/출시 완료 아님. |

위 수치는 existing evidence 기록을 읽은 결과다. 이번 문서 작업에서 tests/OCR/browser를 다시 실행하지 않았다. 세부 source/hash/한계는 contract Appendix B를 본다.

## 작업 순서와 공통 경계

**다음 단 하나: R001**. 이후 R002→R003→R005→R006→R007→R008→R009로 review-first vertical path를 만든다. R004 numeric 개선은 R003 이후 별도 범위로 실행 가능하나 R005 후보 표시의 선행 safety gate가 아니다. R010 개선 loop와 R011 독립 live는 필요한 evidence 기능이 준비된 뒤, R012 release는 R011 뒤다. 번호는 workstream 식별자이며 단순 오름차순 강제 실행이 아니다. 모든 FUTURE_GATE는 해당 과제 착수 요청과 선행 gate가 필요하다. R001 성공이 나머지 일괄 구현 승인은 아니다.

모든 아래 target path는 **`D:/BDOBarterDev/_dev/` 기준**이며 `(new)`는 아직 없는 제안 파일이다. 착수 시 실제 경로/HEAD를 재확인한다. 아래 각 과제의 `prohibited: 공통`은 main, V1 reference/원본, frozen truth/기대 hash, 기존 live evidence, 사용자 DB/backup, 기존 dirty, 모델 bundle, Warehouse scanner/threshold, scheduler/routing 계산을 뜻한다. 열거한 target 외 파일을 필요 없이 늘리지 않는다. DB 검증은 isolated copy/mock만. 구현 시 관련 tests와 보존/equivalence gate를 수행하고 real browser/live 미실행을 구분한다.

모델: 일반 좁은 구현 **GPT-6 Luna High**. Correction contract/Master authority/truth/session 계약 변경 또는 반복 Luna 실패는 **Sol 검토**. 제품 전체·장기 migration 또는 Master/correction/session 동시 재설계는 **Astra 재검토**. 이 문서의 모델 추천은 현재 세션의 실제 모델 variant 인증이 아니다.

## R001 — Master Catalog Audit Foundation (ACTIVE_NEXT)

- **목적**: 현재 catalog의 구조·출처·collision을 재현 가능하게 조사한다. 게임 truth나 최종 Registry를 만들지 않는다.
- **현재 동작**: `frontend/data/trade-catalog.json`의 이름 배열과 tier별 목록이 importer 기준. verified alias/stableId/provenance 없음.
- **목표 동작**: offline read-only tool이 entry별 locator·원문·kind/tier scope·source hash와 exact/whitespace-normalized collision을 보고한다. 이름 유사성은 후보 보고만 하며 alias merge/정답 판정 금지.
- **Target files**: `local_app/tools/audit_trade_catalog.mjs` (new), `local_app/tests/trade_catalog_audit_regression.mjs` (new). 생성 audit/manifest는 `recognition-local/catalog-audit/r001/` ignored output. production JSON 추가/교체 없음.
- **Prohibited files**: 공통 + 전체 production frontend/backend/data, DB/schema, 기존 test source/expected truth. 위 신규 tool/test 두 개만 tracked 구현 범위. 문서 수정은 별도 요청 때만.
- **Invariants**: catalog raw bytes 불변; 관찰을 검증으로 승격하지 않음; 섬 short/long name 자동 동일시 금지; req/count/yield 추론 금지; production import 없음.
- **Interfaces**: pure `auditTradeCatalog(catalog, {sourceRevision, sourceSha256}) → {schemaVersion:1, entries, findings, counts}`. entry locator는 JSON pointer(예 `/masterData/1/0`), **영구 stableId 아님**. provenance 상태 `LEGACY_UNVERIFIED`; `displayNames` verified 목록 생성하지 않음. unknown metadata는 null. invalid shape는 명시 실패. CLI input/output 명시, source 덮어쓰기 거부.
- **Sequence**: HEAD/dirty/catalog hash 확인 → 현재 importer 소비 shape 대조 → pure audit/CLI → synthetic tests → 실제 catalog read-only audit2회 → stable semantic hash 비교 → 변경 경계 보고. timestamp는 manifest metadata로 분리하고 semantic hash에서 제외한 항목을 명시.
- **Tests**: 모든 source entry의 round-trip locator/raw 보존; missing/invalid top-level shape·nonstring entry; exact duplicate/공백 collision/다른 tier 같은 이름; 섬 scope overlap과 alias 미승격; empty list; deterministic order/input mutation 없음; output=input 거부; 기존 `trade_domain_contract.mjs`, `trade_import_regression.mjs` PASS. DB/OCR/browser 실행 필요 없음.
- **Completion gate**: source 모든 entries 누락0(수는 실제 audit으로 확정), typed findings와 미검증 상태 명시, 반복 semantic hash SAME, catalog byte hash 동일, 기존 domain tests PASS, 예상 두 파일만 tracked 변경. findings가 있어도 추측 수정 금지; schema authority에 영향 있는 항목은 R002/Sol로 보고.
- **Model recommendation**: Luna High. scope가 pure audit이므로 authority/UX 결정 없음. R001은 Registry stable IDs를 할당하거나 게임 표시를 verified 처리하는 과제가 아니다.

## R002 — Registry snapshot adapter (FUTURE_GATE, A)

- **목적**: audit 근거로 V2가 사용할 versioned registry interface를 마련한다.
- **현재 동작**: legacy string catalog만 존재.
- **목표 동작**: schema validation + read-only legacy adapter, 별도 curated mapping 입력 지원. imported entities는 LEGACY_UNVERIFIED; displayName/alias 검증 상태 분리.
- **Target files**: `local_app/frontend/js/domain/trade-master-registry.js` (new), `local_app/tests/trade_master_registry_regression.mjs` (new). 실제 authoritative registry JSON 배포는 mapping 검토 후 별도 범위로 승인; 기존 catalog 수정 없음.
- **Prohibited files**: 공통 + importer/UI/backend/persistence/current catalog.
- **Invariants**: stableId는 name/index로 영구 재생성하지 않음, legacy locator와 구별. 독립 curation으로 확정된 ID mapping 없이 임시 import ID를 영구 identity로 광고하지 않음. Master≠observation.
- **Interfaces**: `validateRegistrySnapshot`, `adaptLegacyCatalog` → immutable registry view + unresolved mappings + source version/hash. raw snapshot의 source metadata null 허용, verified 조작 금지.
- **Sequence**: R001 findings→Sol schema/ID lifecycle 검토→pure adapter→compatibility tests. 자동 JSON migration 없음.
- **Tests**: duplicate ID/alias ambiguity/replacedBy cycle/invalid tier, name rename에도 curated ID 유지, deterministic snapshot, 미검증 provenance, 기존 catalog roundtrip.
- **Completion gate**: logical schema 전체 표현, unresolved 목록 명시, legacy names/values 불변, schema/authority Sol 검토 및 tests PASS. production activation은 별도.
- **Model recommendation**: Luna High 구현, Sol schema/authority review.

## R003 — V2 correction + review projection (FUTURE_GATE, B)

- **목적**: raw보다 유용한 후보를 모든 COMPLETE 행에 제공한다.
- **현재 동작**: raw table 또는 V1 all-six import; provenance-aware correction projection 없음.
- **목표 동작**: 전략 B의 pure JS projection; numeric unknown/source risk도 후보 표시를 막지 않음.
- **Target files**: `local_app/frontend/js/domain/trade-review-projection.js` (new), `local_app/tests/trade_review_projection_regression.mjs` (new). existing `trade-import.js`는 import/read-only 재사용.
- **Prohibited files**: 공통 + V1 importer/catalog/reader/UI/API/DB.
- **Invariants**: 전 COMPLETE 행/여섯 슬롯, no defaults, no truth claim, open-world fromItem, ambiguity/master disagreement, 0.75 규칙 임의 완화 없음.
- **Interfaces**: contract 6절 `buildTradeReviewProjection`; raw/candidate/alternatives/reason/risk/masterVersion/correctionVersion/lineage 분리.
- **Sequence**: R002 view 계약→Sol interface review→helper reuse/단계별 provenance→synthetic tests→local E0 evidence가 있으면 read-only comparison(없으면 미실행 표시). C1 cleanup은 독립 검증 전 넣지 않음.
- **Tests**: req missing remains null, partial48 candidate 위험 표시/무수락, count label10/0/multiple groups, tier ambiguity, exact alias collision, ellipsis, all-HOLD11도11 review rows, open-world, immutability/determinism.
- **Completion gate**: V1 manual tests unchanged PASS; COMPLETE 후보 누락0, numeric 제조0, no session mutation, Sol correction contract review. all-HOLD를 제품 완료로 세지 않음.
- **Model recommendation**: Luna High 구현, Sol contract 검토.

## R004 — Req/yield evidence improvement (FUTURE_GATE, C)

- **목적**: 실제 숫자 후보와 risk 근거 개선, 자동수락 활성화 아님.
- **현재 동작**: N2 diagnostic10/11, 기본 reader의 req/yield 실패 존재.
- **목표 동작**: opt-in numeric profile에서 전체 source quantity ROI와 token lineage/partial/conflict를 보존. fromItem crop은 그대로.
- **Target files**: `local_app/tools/trade_batch_draft_experiment.py`, `local_app/recognition_data/trade-r004-numeric-profile.json` (new), `local_app/tests/backend/test_trade_numeric_profile.py` (new). runtime default 전환은 별도 검토.
- **Prohibited files**: 공통 + fromItem/island/toItem/count 기본 lane/reader, API/UI/importer/default frozen profile.
- **Invariants**: truth/catalog로 OCR 후보 선정 금지, req1/ratio 금지, source completeness unknown 인정, D4-S1 우회 재개 금지.
- **Interfaces**: profileHash/producerVersion, parent source ROI/hash, tokenBox, raw candidate list, boundary/adjacent-component/conflict reasons → R003 risk.
- **Sequence**: numeric-only image applicability 선정→bounded same-model candidates→unit→archive multi-digit→local11행 진단 비교→independent R011. live11행을 holdout이라 부르지 않음.
- **Tests**: 123→1/148→48/151→5, merged icon, high-score wrong, cropped prefix/suffix, negative/invalid/multiple tokens; frozen controls/default semantic hash unchanged; relevant backend/API contract 회귀.
- **Completion gate**: req/yield 후보 개선과 wrong/unknown 수 동시 보고, default semantics 보존, partial을 SAFE로 승격0. 실패 시 expected hash 갱신으로 통과 금지.
- **Model recommendation**: Luna High, completeness contract 변경/반복 실패 Sol.

## R005 — All-row review UI (FUTURE_GATE, D)

- **목적**: 모든 후보를 보고 틀린 칸만 고치는 검수 UX.
- **현재 동작**: 읽기용 raw table; JSON 제외행 review는 별도.
- **목표 동작**: R003 prefill, 전 필드 editable, risk+crop, unknown, revision-bound 명시 완료. 적용 버튼 연결은 아직 없음.
- **Target files**: `local_app/frontend/js/recognition-ui.js`, `local_app/frontend/js/trade-recognition-review.js` (new), `local_app/frontend/css/trade-recognition-review.css` (new), stylesheet 연결용 `local_app/frontend/index.html` 최소, `local_app/tests/browser_trade_review.mjs` (new).
- **Prohibited files**: 공통 + JSON review/importer/backend/DB/reader. HTML/CSS 연결 이외 shell UI 개편 없음.
- **Invariants**: SAFE처럼 보여도 숨김 금지, prediction truth 금지, capture revision 바뀌면 완료 무효, edge는 별도 경고.
- **Interfaces**: ReviewProjection→pending edits→review completion event(immutable observation payload). session mutation 없음.
- **Sequence**: owner 강조/전체확인/disagreement UX 선택→R003 연결→편집/unknown→완료 상태→isolated browser validation.
- **Tests**: 일반필드 수정, 행 누락/필터/페이지 미검수 guard, 숫자0/null, unknown, 재인식 invalidate, cancel preserves input, edge warning, manual/queue 회귀. 실제 Chrome 1920×1080·130%는 별도로 기록.
- **Completion gate**: 전 COMPLETE×6 표시/편집, 한국어 reasons, explicit completion만 verified event, test PASS; browser 미실행이면 UI 검증 gate 미완료.
- **Model recommendation**: Luna High; truth event 변경 Sol.

## R006 — Verified evidence persistence/export (FUTURE_GATE, E)

- **목적**: 검수 자료를 재현 가능한 개선 데이터로 저장.
- **현재 동작**: recognition sidecar/warehouse evidence와 local review files; 신규 Trade observation pipeline 없음.
- **목표 동작**: versioned observation append/read/export, 멱등성·payload conflict, finite retention, 실패/재시도 UI. main DB migration 없음.
- **Target files**: `local_app/backend/recognition_store.py`, `local_app/backend/api/recognition.py`, `local_app/frontend/js/trade-recognition-review.js`, `local_app/tests/backend/test_trade_review_observations.py` (new). 기존 store/API를 최소 확장하며 별도 store를 중복 도입하지 않음.
- **Prohibited files**: 공통 + main schema/user DB/원본 evidence/warehouse 저장 semantics. sidecar schema 변경 필요성은 먼저 Sol 검토.
- **Invariants**: raw/shown/final 구분, explicit completion, unknown/disputed 제외, 200MiB/30일/verified crop 보호, full screenshot 무제한 금지.
- **Interfaces**: observation+confirmation revision→durable receipt; export manifest+source hashes; session receipt와 별도.
- **Sequence**: existing store audit→Sol truth/storage review→isolated write/read/export→UI retry. E0/E1 원본 출력 재생성 금지.
- **Tests**: 동일 ID동일 body replay, 다른 body conflict, save failure retains edits, export/import reproducibility, unreviewed truth 차단, quota/retention 보호(복사본에서만).
- **Completion gate**: contract 필수 provenance 재현, verified unchanged/edit/unknown 구별, isolated tests PASS, 사용자 DB 접근0.
- **Model recommendation**: Luna High 구현, Sol truth/storage 검토.

## R007 — Multi-capture reconciliation (FUTURE_GATE, F)

- **목적**: overlap을 합치되 숫자/identity 충돌을 잃지 않는다.
- **현재 동작**: ordered queue/API; V1 tuple duplicate는 numeric conflict를 구별하지 않음.
- **목표 동작**: preliminary source groups와 correction 후 exact6 merge, conflict review, edge/missing warning.
- **Target files**: `local_app/frontend/js/domain/trade-batch-reconciliation.js` (new), R003 projection/R005 review 최소 연결, `local_app/tests/trade_batch_reconciliation_regression.mjs` (new).
- **Prohibited files**: 공통 + detector/reader/V1 importer/DB.
- **Invariants**: unsafe merge 금지, sourceRefs union, capture order, 누락 범위 완료 주장 금지.
- **Interfaces**: captures+drafts→source groups; corrected/reviewed rows→merged candidates/conflicts+mapping. pre-correction group는 확정 duplicate 아님.
- **Sequence**: synthetic pure reconcile→numeric conflict→review resolutions/evidence 연결→browser queue regression.
- **Tests**: exact6 overlap, same names different req/count/yield, different input, duplicate image, changed capture order, partial only, unknown identity, deterministic source mapping.
- **Completion gate**: 불명확 group의 silent merge0, source loss0, 명시 resolve 기록, 기존 manual duplicate semantics 불변.
- **Model recommendation**: Luna High; duplicate/domain 정책 변경 Sol.

## R008 — Reviewed DTO validation (FUTURE_GATE, G1)

- **목적**: 확인한 값으로 유효한 canonical six-field batch를 만든다.
- **현재 동작**: reviewed recognition DTO bridge 없음.
- **목표 동작**: completion receipt+review values→V2 mapping→range→duplicate/conflict→staged snapshot candidate. 아직 save 없음.
- **Target files**: `local_app/frontend/js/domain/reviewed-trade-dto.js` (new), `local_app/tests/reviewed_trade_dto_regression.mjs` (new).
- **Prohibited files**: 공통 + V1 importer/DB/persistence/reader.
- **Invariants**: req/yield>0, count>=0 safe integer; unknown !=0; legacy compatible output; reviewed invalid 자동 통과 없음.
- **Interfaces**: confirmed observations+registry+existing session snapshot→validated batch/held reasons/source mapping, immutable.
- **Sequence**: owner unknown/subset 처리 결정→Sol final mapping contract review→pure validation→isolated session-shape compatibility.
- **Tests**: invalid user edit, missing confirmation/revision mismatch, duplicate/numeric conflict, OPEN_WORLD0→1, registry disagreement, stale mapping, numeric defaults0, exact fields semantics.
- **Completion gate**: prediction-only DTO0, invalid/unknown silent insertion0, V1 manual tests PASS, Sol contract 검토.
- **Model recommendation**: Luna High 구현, Sol importer/session boundary 검토.

## R009 — Staged session/browser bridge (FUTURE_GATE, G2)

- **목적**: 검수·저장한 결과를 기존 물교 회차와 browser output으로 연결한다.
- **현재 동작**: JSON flow는 state-first event save; `saveWorkingSessionSnapshot(candidate)` 없음.
- **목표 동작**: 새 recognition 전용 staged save, revision/동일-body retry/receipt 후 state 반영; new/append 의사 구분.
- **Target files**: `local_app/frontend/js/persistence.js`, `recognition-ui.js`, R005 review module, `local_app/tests/browser_trade_review_session.mjs` (new); backend API 변경 필요 시 범위 확대 전 Sol 검토.
- **Prohibited files**: 공통 + main schema/manual import behavior/scheduler algorithm.
- **Invariants**: 저장 실패시 기존 session 보존, evidence/session 별도 성공, revision conflict 재확인, same mutationId+body retry.
- **Interfaces**: R008 staged candidate+expected revision+evidence receipt→session commit receipt. 기존 queue를 무비판적으로 재호출하여 새 mutationId를 만들지 않음.
- **Sequence**: R006~R008→기존 receipt semantics 검증→Sol staging review→isolated save/cancel/failure→browser output.
- **Tests**: response loss/409/retry/double click, 저장 후 reload 실패, review 중 session 변경, pending completion guard, new/append/reset, scheduler unchanged. 실제 사용자 DB 사용 금지.
- **Completion gate**: no silent default/no stale overwrite, 성공 후 기존 목록·schedule 생성 가능, browser+backend/equivalence 해당 회귀 PASS. DB migration 필요하면 BLOCKED/재설계.
- **Model recommendation**: Luna High 구현, Sol session contract 검토.

## R010 — Improvement loop (FUTURE_GATE, H)

- **목적**: review evidence를 master/correction 개선 후보로 연결.
- **현재 동작**: 개별 진단 기록, 통합 versioned review dataset 없음.
- **목표 동작**: export→dataset manifest→taxonomy/metrics→candidate compare→curation proposal. 자동 master 쓰기 없음.
- **Target files**: `local_app/tools/trade_review_evaluation.mjs` (new), `local_app/tests/trade_review_evaluation_regression.mjs` (new), ignored versioned reports.
- **Prohibited files**: 공통 + production registry/catalog/engine/truth 덮어쓰기.
- **Invariants**: unreviewed는 truth 제외, unknown/disputed와 분모, 동일 capture/session split leakage 방지, 임의 promotion threshold 금지.
- **Interfaces**: observation manifest+fixed policy versions→field/row metrics+failure taxonomy+promotion proposal(hash).
- **Sequence**: R006 export sample→분모/label 검증→candidate replay→독립 R011 평가→수동 curation 결정. 제안만으로 배포하지 않음.
- **Tests**: recovery/harm/unhighlighted error, denominator0=N/A, duplicate observations, master disagreement vs OCR error, edited vs unchanged vs unknown, seed/hash 결정성.
- **Completion gate**: contract metric 전부 재현, raw primary로 사용 안 함, proposal과 promotion 분리, training/eval leakage0.
- **Model recommendation**: Luna High, truth/master authority 변경 Sol.

## R011 — Independent live review-first gate (FUTURE_GATE, I)

- **목적**: 새 flow의 실제 검수 비용과 DTO/browser 성공 검증.
- **현재 동작**: D2 두 화면11행은 개발에 이미 사용, 신규 독립 E2E 없음.
- **목표 동작**: 새로운 다양한 화면/수량/겹침에서 모든 후보를 확인하고 최종 회차까지 검증.
- **Target files**: `local_app/tests/browser_trade_review_live.mjs` (new, isolated harness), `recognition-local/live-validation/r011/` (new ignored package). production tuning 포함 금지.
- **Prohibited files**: 공통 + 검증 중 engine/threshold/master/기존 truth 조정.
- **Invariants**: actual Chrome/game와 mock 자동검증 구별, 1920×1080·130% 조건 포함 및 source scaling 기록, 사용자 조작 capture, local only.
- **Interfaces**: frozen versions+새 captures+explicit human observations→metrics/manifest/release recommendation.
- **Sequence**: R005~R010의 준비 gate→독립 capture 요청→review→isolated session/browser output→오류/부담 집계. 기준 미달 시 tuning과 test set 분리.
- **Tests**: whole user flow, clipboard/file/stream fidelity, overlap/unknown/master disagreement, numeric multi-digit, evidence failure/retry, manual fallback. package는 R012.
- **Completion gate**: review-first readiness의 전 항목 실제 확인, observed errors/unknowns/수정 부담 정직 보고. 자동 SAFE 전체 충족은 불필요. owner가 usability 승인, unresolved product/safety blocker 없음.
- **Model recommendation**: Luna High 실행, Sol 실패/metric review; 제품 계약 변경 Astra.

## R012 — Package / release / rollback (FUTURE_GATE, J)

- **목적**: 검증된 review-first를 재현 가능한 배포로 제공.
- **현재 동작**: 새 flow package 미검증.
- **목표 동작**: frozen build manifest, clean install/copy data restart, fallback/rollback. 자동수락 활성화는 제외.
- **Target files**: `scripts/build.ps1`, `scripts/verify-frozen-package.py`의 필요한 최소 변경 및 `recognition-local/release-validation/r012/` (new ignored evidence). 착수 시 현재 packaging 경로를 다시 확인하고 필요 없는 source 변경은 하지 않는다.
- **Prohibited files**: 공통 + main 병합/설치본 교체/사용자 DB migration은 별도 명시 승인 전 금지.
- **Invariants**: schema3, offline models/hash, no remote OCR, main V1 baseline 보호, legacy input fallback.
- **Interfaces**: R011 release candidate+source/model/registry hashes→artifact manifest+validation+rollback instructions.
- **Sequence**: [release-strategy](release-strategy.md) 및 [migration-rollback](migration-rollback.md) 보존 경계 대조→isolated package→Chrome/game/package lifecycle→사용자 승인된 배포.
- **Tests**: fresh environment, model missing/offline/network denial, artifact integrity, evidence storage budget, session restart, manual fallback, rollback copy 검증.
- **Completion gate**: 실제 package validation과 rollback PASS, 독립 live 결과 연결, user DB untouched; 자동화 gate와 구분.
- **Model recommendation**: Luna High 실행, Sol release review; 장기 migration Astra.

## 별도 Future Automation Gate (FUTURE_GATE)

R012 완료가 무인 수락을 승인하지 않는다. 자동으로 행/필드를 숨기거나 적용하려면 별도 좁은 task 지시가 필요하다. E1 numeric/source provenance와 final safety audit을 재사용하되 contract 8절 WRONG_AUTO_ACCEPT/SAFE_AUTO_ACCEPT_COVERAGE, eligible sample>0, independent holdout, actual Chrome/game/package gates를 통과한다. 전부 HOLD로 오류0은 PASS가 아니다. 위험 없는 듯 보였지만 실제 수정된 UNHIGHLIGHTED_ERROR_RATE를 검토하지 않고 숨김을 도입하지 않는다.

## Documentation consistency audit

이번 변경은 신규3문서와 spec/tasks 상단 notice만이다. Current contract=1, roadmap=1, register는 결정 색인. E2 SUPERSEDED/D4-S1 ON_HOLD와 R001 ACTIVE_NEXT는 세 문서에서 동일하다. V1은 truth oracle이 아니며 master observation/truth/prediction, review/auto를 분리했다. 원 FR와 T000~T014는 그대로 보존한다. production/test/data/DB/evidence 변경은 허용하지 않는다. 문서 검증은 local link·원문 byte 보존·Git 범위·evidence hash·diff whitespace를 확인하며 production test PASS를 대신하지 않는다.
