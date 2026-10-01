# 현재 제품 계약 — 최종 보정 결과 중심

정본 갱신: **ARCH-RESET-01 / 2026-10-01**. 새 목표 계약이며 구현 완료 선언이 아니다. 현재 코드와 미래 interface의 차이, dependency graph, inventory, 작은 구현 Task는 [통합 아키텍처](UNIFIED-RECOGNITION-ARCHITECTURE.md)에 있다. 이번 변경은 문서만이며 production, Master, OCR, DB와 과거 observation은 그대로다.

## 1. 제품의 기본 흐름

```text
사용자 수동 capture
→ row detection / field recognition
→ normalization
→ Master exact / bounded correction
→ deterministic domain correction
→ numeric resolution
→ multi-capture reconciliation
→ final row construction / validation / classification
→ 문제 행 중심 검수 + 전체 최종 결과 접근
→ 최종 목록 확인 완료 한 번
→ immutable evidence save / validated DTO
→ DB-first staged working session
```

사용자의 주 검수 대상은 **모든 보정과 검증을 거친 최종 후보**다. raw OCR은 진단·보정 provenance·engine 평가용으로 보존한다. 전 행 여섯 필드를 처음부터 사람에게 확인시키는 기본 workflow를 폐기한다. per-field confirmation click도 요구하지 않는다. 모든 final row는 접근 가능하며 기본 작업 queue는 NEEDS_REVIEW와 미해결 CONFLICT/NEEDS_RECAPTURE다. FINAL_READY는 전체 결과에서 compact하게 볼 수 있다.

변하지 않는 경계: 자동수락/자동적용 없음, fuzzy 후보를 truth로 확정하지 않음, 숫자0/1 defaults 없음, unknown source 삭제 없음, 충돌값 자동 선택 없음, OCR에 따른 자동 Master 수정 없음. 적용은 explicit batch confirmation 이후다. FINAL_READY는 검증된 candidate completeness이며 인간 정답 선언이 아니다.

## 2. Master curation은 제품 내부 기능

앱 안의 ‘마스터 관리’에서 Item과 Island를 별도 kind로 검수한다. canonicalName(내부 대표명), game display names, verified aliases, legacy/deprecated names, status/provenance를 분리한다. Item에는 tier/category도 있다. stableId는 immutable opaque ID이며 owner가 새 entity를 승인하는 저장 transaction에서만 한 번 발급한다. name/index/locator/hash에서 파생하지 않는다. near-name을 자동 merge하지 않는다.

실제 항목·관계를 owner가 확인하고 저장한 것만 VERIFIED_CURATED다. entity 승인만으로 모든 alias를 승인하지 않는다. 현재 legacy source와 과거 reference flags는 자동 승격하지 않는다. stableId가 없는 legacy 이름도 review candidate로 사용할 수 있으나 verified identity라고 주장하지 않는다. tier0→1 open-world input은 유지한다.

OCR 관찰은 MASTER_CURATION_PROPOSAL까지만 만든다. 제안→Master 화면의 명시 승인→새 immutable bundle 순서이며 현재 batch를 뒤에서 바꾸지 않는다. Master의 quantity authority는 없다. reqAmount/count/yield를 저장·추론하지 않는다.

Master bundle v2는 registryVersion/contentHash, entities, compatibility mappings, source revisions/provenance, createdAt을 갖는다. createdAt과 version/hash 자체를 제외한 semantic content로 version을 재현한다. 한 batch는 정확히 한 bundle version/hash를 pin한다. 새Master는 다음 batch부터 적용하고 현재 batch는 명시 재보정으로만 새projection revision을 만든다. 변경된 projection은 옛confirmation을 stale로 한다.

현재 trade catalog는241 source occurrences,230 legacy names,stable entities0다. source가 준비된 것과 owner 검증이 끝난 것을 구분한다. trade-catalog.json과 Warehouse reference는 이번에 수정하지 않는다.

## 3. 하나의 correction pipeline

Stage0 RAW_OBSERVATION → Stage1 NORMALIZATION → Stage2 MASTER_EXACT_MATCH → Stage3 MASTER_BOUNDED_CORRECTION → Stage4 DOMAIN_CORRECTION → Stage5 NUMERIC_RESOLUTION → Stage6 MULTI_CAPTURE_RECONCILIATION → Stage7 FINAL_ROW_VALIDATION → Stage8 FINAL_CLASSIFICATION.

pure JavaScript domain pipeline이Stage1–8의 유일한 candidate authority다. Python worker는 raw reader/geometry evidence, backend는 schema/hash/source accounting 검증, UI는 최종값과 human edits를 담당한다. old importer 전체를 보정 프로그램처럼 호출하지 않는다. audited safe helper와 R007 logic을 재사용하며 legacy 경로와 새경로를 같은batch에 이중 적용하지 않는다.

각 field는 raw, normalized, masterMatches, correctionCandidates, selectedCandidate, correctionReasons, riskReasons, finalValue/finalStatus, stageTrace를 갖는다. stage/rule/version/alternatives/sourceRefs를 재현할 수 있어야 한다. raw를 덮어쓰지 않는다. normalization은 versioned whitelist며 unknown decoration/복수숫자 삭제로 정답을 만들지 않는다.

이름은 verified exact canonical/display/alias와 bounded unique를 사용한다. 현재0.75·거리bound·유일조건의 의미를 보존하고 임의 완화하지 않는다. 충돌/near-name/disputed 관계는 자동 확정하지 않는다. domain 관계는 verified Master의 tier/category/scope만 사용한다.

숫자는 reader observations와 strict parser, 허용 decoration, geometry completeness, conflict checks로 해결한다. reqAmount와yield는 positive safe integer, count는 nonnegative safe integer이며 **남은 교환 횟수**다. count0은 실제값, missing과 별개다. 품목 관계나 과거값으로 숫자를 복구하지 않는다. null/value 또는 여러 reader의 다른 값은 충돌로 남긴다.

## 4. source와 final logical row

source COMPLETE 수 S, 최종 logical row 수 R, confirmed logical row 수를 분리한다. 모든 source는 정확히 한 logical mapping으로 보존하며 edge는 가짜여섯field 행으로 만들지 않는다. capture order를 authority로 한다.

R007의 인접 different-image suffix/prefix 연속identity3 최소2행, strong boundary rowCropHash 단행 예외, same-image ordinal mapping, exact6 merge, sourceRefs union을 유지한다. ambiguous/unresolved identity는 일반 overlap authority로 쓰지 않는다. source loss와 중복 assignment는0이다. 숫자/identity 충돌은 alternatives와 모든 출처를 보존한다. 대표captureId/ordinal/rowBox는 earliest representative이지 전체source count의 authority가 아니다. captureEvidence.completeRowCount는 전용source ledger로 검증한다.

## 5. 최종 분류

우선순위는 CONFLICT → NEEDS_RECAPTURE → NEEDS_REVIEW → FINAL_READY이며 다른 사유도 모두 남긴다.

| 상태 | 계약 |
|---|---|
| FINAL_READY | six slots, resolved identity/legacy mapping, strict numeric, domain valid, 미해결충돌 없음, source lineage와 접근 가능한원본row/critical crops, pinned policy checks 통과. 아직 human truth 아님 |
| NEEDS_REVIEW | unresolved/ambiguous/legacy-only 이름, Master disagreement, numeric missing/invalid/suspicious, 확인이 필요한 evidence/quality. 원본과 최종후보를 비교해 수정 가능 |
| NEEDS_RECAPTURE | clipped/partial/geometry 부족/critical crop unavailable. 다시 찍을 위치 안내, six blanks 입력 강요 금지 |
| CONFLICT | reader/correction/reconciliation/domain 미해결 대안. 한쪽 선택 없이 parallel source values/crops 제공 |

문제는 사용자 수정, UNKNOWN, 사유가 있는 explicit exclusion 또는 recapture로 처리한다. 이 결정은 모두 evidence/coverage에 남긴다. unresolved/unknown 필수값은 DTO에 넣지 않는다. 모든READY라고 full game coverage를 주장하지 않는다. edge/omission과 캡처되지 않은 목록은 구분한다.

## 6. 검수 화면과 원본

전용 검수창 header에는 capture/S/R/상태별수를 표시한다. tabs는 문제 행(default), 전체 최종 결과, 원본·OCR, Master 제안이다. 문제행은 실제 row crop과 최종6필드를 같은 화면에 즉시 표시한다. field crop/full capture 위치와 multi-source conflict 비교도 접근 가능하다. raw/IDs/risk JSON은 접힌 보정이유 details에 둔다.

pixels는 decoded capture bitmap 좌표의 명시 CropRef로 연결한다. normalized lane과 pixelbox, pixel-content hash와PNG byte hash를 분리한다. cache 만료/페이지 종료 등으로 원본을 잃으면 ‘원본 확인 불가’를 표시하고 READY로 유지하지 않는다. hash만 있다는 이유로 crop 접근을 증명하지 않는다. full screenshot 영구보관 없이 review session pixels와 선택된 evidence crops를 사용한다.

## 7. Batch confirmation과 evidence

‘최종 목록 확인 완료’ 한 번을 immutable finalprojection/hash, registry/policy/reader/profile versions, review revision, 전logical row set/source mapping, unknown/exclusion/edge disposition에 bind한다. 수정/재보정/rowset 변경은 이전confirmation을 무효화한다. evidence 저장 실패와 session 저장 실패를 분리하고 기존값·mutationId를 보존해 재시도한다.

새field decisions는 CANDIDATE_RETAINED / USER_EDITED / USER_MARKED_UNKNOWN, batch scope는 USER_FINAL_LIST_CONFIRMED다. retained는 **독립crop 검증truth가 아니다**. OCR benchmark truth는 별도 HUMAN_CROP_VERIFIED label이다. 일반batch 확인만으로 known-truth 분모를 채우지 않는다.

계획: FinalProjection/Completion/Observation/export schema3, recognition sidecar schema3 additive tables. 현재CHECK 제한 때문에 미래E1 migration이 필요하다. 기존R006 schema1 payload/옛projection1·2/table/artifact/hash/read/export는 그대로 지원하고 자동rewrite/relabel하지 않는다. Main DB schema3와session schema는 바꾸지 않는다. 새Master 전용store와recognition evidence sidecar를 구분한다. 상세버전/hashing 계약은 통합아키텍처9절이다.

## 8. DTO와 session 보호

검수된 final values→명시legacy mapping→six-field/conflict/coverage validation→receipt 검증→R009 staged session이다. mapping은 재fuzzy하거나final값을조용히바꾸지 않는다. 수동 JSON processParsedTrades defaults를 새path에 끌어오지 않는다. NEW/APPEND intent, session revision, 동일mutation retry, durable servercommit/readback 후localapply/render/reload를 유지한다. scheduler/routing/완료계산은 재설계하지 않는다.

## 9. 평가와 운영 gate

RAW recognition / CORRECTION / FINAL을 따로 평가한다. rawwrong-finalcorrect는OCR 실패·보정성공이다. 핵심은 FULLY_CORRECTED_ROW_READY_RATE, USER_EDIT_RATE_AFTER_FULL_CORRECTION, NUMERIC_FAILURE_RATE, MASTER_UNRESOLVED_RATE다. unknown/exclusion/edge, wrong-ready, sourcecoverage, DTO/session성공을 같이 보고한다. 문제queue만 평가해 정확도를 높이지 않는다. 분모0=N/A, all-HOLD 오류0은 PASS 아님.

OCR adapter는 text/numeric reader를분리할수있다. 교체는owner-labeled 동일crop/split의사전freeze 평가gate를통과할때만한다. 현재engine 유지 또는교체는미결정이다. Master는candidateauthority이며croptruth가아니다.

현재구조 R011 independentlive와R012release는보류한다. 기존실사자료의향후용도는DEVELOPMENT_ARCHITECTURE_EVIDENCE이며옛cohort/hash는변경하지않는다. 새구조구현·offlinequality·새freshindependentL1·ownerusability후release를별도검증한다. [승인기준](ACCEPTANCE.md)을따른다.

## 10. 보존 범위와 결정 이력

manual JSON fallback, file/paste/STREAM capture, capture frame/fidelity 구분(clipboard source fidelity unknown), PNG lossless, 수동capture/no gameinput, local/offlineOCR, 기존session/scheduler/warehouse/DB안전, R008/R009/immutable evidence 원칙을 유지한다. remoteOCR/Gemini/OpenAI, 자동스크롤, unattended apply를 추가하지 않는다. Warehouse tier1–4/56종·tier5제외·inventory safety는변경하지않는다.

artifact budget200MiB, 미검수debug30일정책, verified crops보호/debugoff를유지한다. 정리는명시적동작이며실사증거·MainDBBLOB·사용자backup을이정책으로자동삭제하지않는다.

DR-012~019가이전DR-001/003/004/005/006/008/010/011의관련제품의미를명시적으로supersede한다. 옛결정과기존storedmeaning은[결정기록](DECISION-REGISTER.md)에보존한다. 다음구현은[로드맵](CURRENT-ROADMAP.md)의M1부터별도지시로시작한다.
