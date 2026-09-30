# SPEC-008R — Active Decision Register

기준: 2026-09-30 / source `66c45e4328ecd2c3de034527b37e6e3109038db8`.

이 문서는 [CURRENT-PRODUCT-CONTRACT.md](CURRENT-PRODUCT-CONTRACT.md)의 결정 색인이다. 목표 동작은 그 문서가 유일한 정본이며 실제 실행 사실은 production code/tests가 정본이다. 실험 로그 전체를 복제하지 않는다. Evidence shorthand D2/D3/D4/E0/E1은 contract Appendix B의 local evidence 및 hash를 뜻한다. 로컬 파일 부재는 새 정확도 주장으로 보충하지 않는다.

## DR-001 — REVIEW-FIRST (ACTIVE)

- **Decision**: 첫 Trade production UX는 모든 COMPLETE 행·여섯 필드를 표시하고 편집 가능한 REVIEW-FIRST다. 최선 후보 prefill, 위험 강조, 명시적 batch 완료를 제공한다.
- **Reason**: 완벽 OCR보다 적은 수정으로 유효 회차를 만드는 것이 제품 목표다. 위험 판정도 틀릴 수 있어 일반 표시 필드를 숨기면 안 된다.
- **Evidence**: D2 11행 검수; D3 unflagged partial yield; 현재 recognition 표는 읽기용이고 JSON 검토는 제외행 전용.
- **Supersedes**: Trade의 예외 필드만 검토하는 target. Warehouse REVIEW-only 정책은 제외.
- **Still valid**: unknown/default 구분, revalidation, local only, 사용자 명시적 적용.
- **Revisit condition**: 독립 live에서 검수 부담·UNHIGHLIGHTED_ERROR_RATE 측정 후 제품 owner가 자동화를 요청할 때. 자동 전환은 금지.

## DR-002 — Review candidate와 automatic eligibility 분리 (ACTIVE)

- **Decision**: E1 numeric/source completeness·SAFE_ACCEPT/HOLD·final audit은 위험 표시 및 future unattended safety에 유지한다. COMPLETE row를 검수 후보로 보여주는 데 여섯 필드 SAFE를 선행 요구하지 않는다.
- **Reason**: E1 all11 HOLD는 자동수락 위험을 차단했지만 사용 가능한 후보를 만드는 목표를 해결하지 않는다.
- **Evidence**: E0 wrong accepted3, E1 domain calls0/safe0/held11; synthetic policy 검증은 real producer 검증 아님.
- **Supersedes**: 미구현 **T010P3E2 = SUPERSEDED_PENDING_PRODUCT_REALIGNMENT**. E1 implementation-plan의 E2 우선 실행 및 qualifier→V1 단일 흐름을 그대로 실행하지 않는다.
- **Still valid**: 기본값 금지, provenance/완전성, 부분 숫자 negative cases, future wrong-auto0과 eligible>0.
- **Revisit condition**: 자동수락 구현을 별도 요청하고 real producer evidence/독립 검증이 준비될 때. E2 이름만 바꿔 종전 gate를 review 앞에 복원하지 않는다.

## DR-003 — V1 지위와 전략 B (ACTIVE)

- **Decision**: V1은 compatibility baseline + proven design reference다. 새 recognition public contract는 V2 Correction Engine이 소유하고 helper를 점진 재사용하는 **B**를 선택한다.
- **Reason**: A는 manual default/force match와 신규 provenance를 결합하고, C는 검증된 복구를 버리는 rewrite risk가 크다.
- **Evidence**: E0 text13 복구/count11 parse와 req fallback10/yield 오답3; 실제 `trade-import.js` 계약.
- **Supersedes**: T010P1/E1의 V1을 영구 단일 correction authority로 두는 target. V1 출력=truth라는 해석은 허용되지 않는다.
- **Still valid**: V1/manual/JSON 함수와 회귀, bounded unique 0.75, tier restriction, scheduler 계약. 보정 후보는 사람 정답 아님.
- **Revisit condition**: helper 재사용이 안정적 version/provenance를 막는 증거가 나오면 Sol 검토. 장기 migration 변경은 Astra.

## DR-004 — Versioned Master Registry와 관찰 분리 (ACTIVE)

- **Decision**: stable program identity, canonicalName, displayNames, 검증 alias, lifecycle/version/provenance/legacy mapping을 분리한다. Master disagreement는 독립 상태다. 이번에는 JSON 교체 없음.
- **Reason**: 현재 이름 배열만으로 게임 표시 truth·동일 identity·alias를 증명할 수 없다.
- **Evidence**: 실제 `trade-catalog.json` 구조, 사용자 실사용 불일치 보고, E0 whitespace mapping/unknown island. 특정 게임 이름의 정답을 새로 확정하지 않음.
- **Supersedes**: catalog에 있으면 모든 게임 표기가 검증됐다는 가정.
- **Still valid**: 기존 catalog 호환 mapping과 reference 보존. 단일 review observation은 master를 자동 갱신하지 않음.
- **Revisit condition**: R001 audit/R002 schema에서 identity 충돌이 확인되면 Sol 검토. 대량 migration은 Astra 재검토.

## DR-005 — 동적 수량과 open-world (ACTIVE)

- **Decision**: req/count/yield는 source 또는 human review에서 얻는다. bounded label/unit parsing 허용, missing default·ratio·history derivation 금지. tier0→1 fromItem 원문과 OPEN_WORLD를 허용하되 가짜 canonical ID를 생성하지 않는다.
- **Reason**: 양수도 부분 숫자일 수 있으며 실제0과 미확인은 다르다. catalog 밖 육지 재료는 기존 의미다.
- **Evidence**: E0 req fallback10, yield48/2/5 오답; 현재 importer의 tier1 raw 유지와 count parsing.
- **Supersedes**: E1의 uncatalogued tier1 source를 일괄 review-only에 묶어 human-reviewed 최종 DTO까지 막는 해석; 그 자동수락 위험은 유지.
- **Still valid**: six-field 의미, count=remainingExchangeCount, manual legacy defaults의 기존 동작 보존.
- **Revisit condition**: parser grammar 또는 numeric evidence 정책 변경 시 Sol 계약 검토; arbitrary value manufacture는 허용하지 않음.

## DR-006 — 검수 evidence와 개선 (ACTIVE)

- **Decision**: prediction/unchanged/edit/unknown 분리, explicit confirmation revision에 묶인 field observation 저장. versioned dataset→taxonomy→candidate→offline replay→independent validation→promotion으로 소비한다.
- **Reason**: 후보 저장은 ground truth가 아니며 DB 누적만으로 품질이 개선되지 않는다.
- **Evidence**: FR12/feedback-dataset, D2 final confirmation 방식, D3 실험에 사용된11행의 비독립성.
- **Supersedes**: review 화면 진입/기본값 유지 자체를 truth로 해석하는 방식.
- **Still valid**: sidecar/main 분리, 200 MiB/30일/verified crop 보호, full screenshot 무제한 금지, unknown/disputed 제외와 coverage 보고.
- **Revisit condition**: truth label semantics 변경은 Sol, DB migration·장기 보관 구조의 전면 변경은 Astra/별도 승인.

## DR-007 — Multi-capture와 staged session (ACTIVE)

- **Decision**: exact6 duplicate만 확정 merge, numeric/identity conflict와 sourceRefs 보존. reviewed DTO를 검증 후 staged persistence로 기존 session/browser output에 연결한다.
- **Reason**: 현 V1의 island/output/input 중복만으로 숫자 차이가 사라질 수 있다. 현 저장 함수는 새 DB-first candidate helper가 아니다.
- **Evidence**: T011 설계, `trade-ui.js` state-first event flow, `persistence.js` mutation queue, `session_contracts.py`.
- **Supersedes**: raw recognition result→plain DTO→직접 session 변경이라는 shortcut. manual 기존 경로 변경은 이 결정의 자동 범위가 아님.
- **Still valid**: revision/conflict/receipt, main schema3, session 계산·routing 보존, isolated DB 검증.
- **Revisit condition**: 기존 API로 동일 payload retry/DB-first staging이 불가능하면 R009에서 Sol 검토; 스키마 변경은 자동 수행하지 않음.

## DR-008 — 지표와 release gate 분리 (ACTIVE)

- **Decision**: primary는 pre-review 후보 정확도·edit burden·recovery/harm·unhighlighted error·master disagreement·numeric review·verified DTO 성공. 자동화 지표는 별도다.
- **Reason**: raw literal 오류가 보정될 수 있고 all-HOLD 오류0은 처리 성공이 아니다.
- **Evidence**: D3/E0/E1. N2 10/11은 diagnostic이며 production 수치 아님.
- **Supersedes**: raw OCR exact를 단독 제품 gate로 사용, all-HOLD를 제품 PASS로 선언하는 해석.
- **Still valid**: future false auto0/eligible>0/독립 holdout/actual Chrome/game/package/rollback.
- **Revisit condition**: 측정 가능한 실제 검수 비용으로 목표 threshold를 정할 때 owner와 Sol 검토. 현재 임의 수치 threshold 없음.

## DR-009 — FromItem crop redesign (ON_HOLD)

- **Decision**: **T010P3D4-S1 = ON_HOLD**. 기존 D4 후보를 승인하거나 crop 실험을 이어 하지 않는다.
- **Reason**: 91행 이미지 구조 gate에서 안전 후보 없음. 기존 correction으로 live fromItem10/11 회복 가능하여 perfect crop부터 할 근거 부족.
- **Evidence**: D4 F570/F575/F580 94.42%<95%, 경계 crossing1/7/12; E0.
- **Supersedes**: D3/D4의 fromItem geometry 우선 구현 순서. 실패 evidence 자체는 그대로 유지.
- **Still valid**: crop 문자 보존/안전성 요구, raw 보존, candidate 선정에 truth 누출 금지.
- **Revisit condition**: 새 correction+review evidence 이후 fromItem이 실제 사용자 수정 비용의 주요 원인임이 입증될 때만 재설계 요청.

## DR-010 — 범위·fallback·다음 한 과제 (ACTIVE)

- **Decision**: Warehouse architecture는 PARKED로 보존하고 Trade만 realign한다. 문서 승인 후 단 하나의 다음 구현은 [R001](CURRENT-ROADMAP.md#r001--master-catalog-audit-foundation-active_next) read-only catalog audit이다.
- **Reason**: Registry authority에 앞서 현 catalog의 구조·중복·출처를 조사해야 한다. 한 번에 UI/engine/DB를 바꾸지 않는다.
- **Evidence**: current catalog 구조, 기존 SPEC warehouse invariants, 본 제품 지시.
- **Supersedes**: 과거 T000~T014 계획을 현재 미실행 순서로 간주하는 해석. 완료 이력은 삭제하지 않음.
- **Still valid**: local/offline, no Gemini/OpenAI/remote OCR, main/V1 보호, 수동/JSON fallback, 사용자 DB 접근 금지(이번 작업).
- **Revisit condition**: R001에서 actual source drift/critical identity conflict가 나오면 범위 확대 대신 보고. 제품 flow 자체 변경은 Astra.

## 실행 상태 요약

| 대상 | 현재 상태 | 처리 |
|---|---|---|
| DR-001~008,010 | ACTIVE | current contract의 대응 절에 따라 구현 |
| DR-009 / D4-S1 | ON_HOLD | 실제 review 비용 증거 전 재개 금지 |
| old T010P3E2 | SUPERSEDED_PENDING_PRODUCT_REALIGNMENT | 그대로 실행 금지; 자동화 아이디어만 미래 gate로 재사용 |
| original T000~T014 | HISTORICAL | 번호·본문 보존, 현재 실행 순서 아님 |
| R001 | ACTIVE_NEXT | 문서 승인 뒤 별도 좁은 구현 요청에서 착수 |

상세 UX 미결정은 contract의 Product Owner Decision Surface 한 곳에서 관리한다. 이 register는 그 결정을 대신 확정하거나 minor technical choice를 사용자 승인 blocker로 만들지 않는다.
