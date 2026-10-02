# Architectural Decision Register

정본은 [현재 제품 계약](CURRENT-PRODUCT-CONTRACT.md)이다. ARCH-RESET-01(2026-10-01)은 새 목표 계약이며 runtime 변경이 아니다. 아래 이전 결정과 새 superseding decision을 구분한다. 옛 observation에 새 의미를 소급하지 않는다.

## 이전 결정 — 이력 보존

| ID | 당시 결정 | 현재 상태 |
|---|---|---|
| DR-001 | 모든 COMPLETE 행/6필드 REVIEW-FIRST, 안전 후보도 표시 | primary 검수 의미는 DR-012로 대체. source 보존 유지 |
| DR-002 | 후보와 자동수락 분리. unknown/unmatched/stableId 없음은 삭제 근거 아님 | 유지, DR-012/015로 구체화 |
| DR-003 | V2가 candidate/risk/provenance 소유. V1 manual 호환 분리 | DR-014의 단일 pipeline/final 결과 계약으로 대체 |
| DR-004 | curated mapping만 stableId 발급. canonical/display/alias/truth 분리, near-name 자동 merge 금지 | 원칙 유지, 제품 내부 curation/VERIFIED_CURATED는 DR-013 |
| DR-005 | source/human 숫자, null/0 구분, req1/yield 추측 금지, open-world0→1 | 유지, Stage5·별 reader는 DR-014/018 |
| DR-006 | 명시 검수 후 unchanged/edited/unknown, immutable/idempotent/export/C2 | old records에 유효. 새 확인·truth·schema는 DR-017 |
| DR-007 | source/logical 분리, 인접 overlap/union/충돌, DTO 후 DB-first session | 유지, final projection 연결은 DR-015/017 |
| DR-008 | 기술 PASS/descriptive/owner usability/release/automation 분리 | 유지, 새 평가 분모는 DR-018 |
| DR-009 | fromItem geometry 변경은 별도 근거·지시 전 보류 | 임의 tuning 보류 유지. U2 좌표계 계약 보정만 DR-016 |
| DR-010 | 현재 trade 경로 우선, manual JSON/file/paste fallback, Warehouse 분리 | 보호 유지, ACTIVE_NEXT는 DR-019로 대체 |
| DR-011 | 실제 사용자 환경 live, CDP DPR≠Windows 배율,130% 강제 금지 | 환경 원칙 유지, live 진행 시점은 DR-019 |

기존 null reconciliation과 R007 ledger의 저장된 의미/hash는 유효하다. ‘DB schema/hash/stored observation 변경 금지’는 과거 구현 경계였다. 미래 E1의 명시 migration 설계를 금지한다는 의미로 해석하지 않는다. 이번에는 migration을 실행하지 않는다.

## ARCH-RESET-01 새 결정

| ID | 확정 목표 결정 | supersedes / 경계 |
|---|---|---|
| DR-012 | fully corrected final candidate가 primary. 문제 행 기본, 모든 final 접근, READY compact, 한 번 batch confirm, per-field click 없음 | DR-001 대체. 모든 source 보존·자동적용 금지 유지 |
| DR-013 | in-app Master curation, Item/Island 분리, owner explicit VERIFIED_CURATED, opaque IDs, immutable bundle2/pinned batch, proposal≠authority | DR-004 제품화. 실제 mapping 자동 생성 금지 |
| DR-014 | Stage0–8 단일 pipeline. V1 규칙 감사·재사용, Python raw/JS 보정/backend 검증, strict numeric 별 축, defaults 없음 | DR-003/005 확장. manual JSON 별도 호환 |
| DR-015 | final4states/reasons, 모든 source exactly once, R007 충돌·lineage 유지, invalid/unknown DTO 금지 | DR-002/007 구체화. READY≠truth |
| DR-016 | 문제 행 row crop+final6 즉시 비교. pixel CropRef/normalized lane/hash basis 분리, pixels 없는 READY 금지 | DR-009 좌표계 계약 보정 scope. 무근거 geometry tuning 아님 |
| DR-017 | confirmation을 final hash/전 row set/versions에 bind. retained≠crop truth. projection/completion/observation/export3, sidecar3 additive, old read/export/hash 불변 | DR-006 새 의미. 미래 E1 migration, Main DB 불변 |
| DR-018 | raw/correction/final 세 층, 독립 human-labeled crop truth, versioned 분모/coverage, 측정 후 engine 선택, text/numeric 분리 가능 | DR-005/008 평가 확장. 현재 library 교체 결정 없음 |
| DR-019 | ACTIVE_NEXT architecture 승인→M1. 현재 R011/R012 보류, old live의 향후 용도는 development architecture evidence | DR-010/011 진행 순서 대체. 옛 cohort/hash rewrite 금지 |

상세 schema, current code inventory, 검수/evidence/OCR gate, Task scope는 [통합 아키텍처](UNIFIED-RECOGNITION-ARCHITECTURE.md)에 정의한다. 이 결정은 코드가 새 계약을 이미 충족한다는 뜻이 아니다.

## DR-020 — 최종 목록 확인과 독립 crop truth 분리 (ARCH-E1-DESIGN)

확정: 운영3decisions + USER_FINAL_LIST_CONFIRMED를 독립 HUMAN_CROP_VERIFIED와 별축으로 저장한다. knownTruthEligible은 적격crop label만. raw/correction/final accuracy는 독립분모, 수정률은운영분모. [계약](EVIDENCE-V3-CONTRACT.md) 2–8절. DR-017/018의 구현 세부를 확정하며 old observation 의미/hash를 바꾸지 않는다.

## DR-021 — Additive evidence3 / Master reference authority

Sidecar SQLite3 신규5tables, old1observation/receipt/export와 projection1·2 읽기·호환write 유지. 독립truth는 새 crop truth table, oldrecognition_label 재사용안함. Master Bundle2에 VERIFIED_REFERENCE 호환확장, CURATED>REFERENCE>LEGACY, DISPUTED/DEPRECATED 자동선택금지. 별reference overlay/oldhash rewrite/자료충돌 강제선택0. 계약5/6/9절.

## DR-022 — 구현 순서 재고정

DR-019와 architecture12/13절의 E1a/b/c 세부분할을 E1-A→B→C→D→M4-R→C1/C2/C3→U2/U1→명시activation→전체UI/UX로 대체한다. 먼저 synthetic evidence/DTO계약을 준비하며 실제pipeline/UI가 완성되기 전 primaryflow 활성화금지. 계약10절의 파일scope/금지/검증/완료조건을 따른다.
