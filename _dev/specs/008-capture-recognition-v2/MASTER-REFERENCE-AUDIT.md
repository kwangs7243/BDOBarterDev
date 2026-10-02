# ARCH-UNIFIED-02 기준 자료 조사 — 부분 결과와 중단 사유

확인일: 2026-10-02. 상태: `ARCH_UNIFIED_02_BLOCKED_DESIGN`.

이 문서는 완성된 기준 Master 또는 검증 완료 선언이 아니다. 지시서 50항의 계약 중단 조건을 확인하여 제품 구현 전에 멈췄다. 기존 제품 계약·데이터·저장된 증거를 변경하지 않았다.

## 1. 시작 기준과 원작 범위

- branch: `v2`; HEAD와 origin/v2: `63f64964c7405a6a0f55122af119876cbff9ce61`.
- main: `f13b8e15af392f167d153c873448a4b2abec5a0c`. 시작 작업 트리: clean.
- 원작은 현재 checkout에서 제거되어 있으나 main의 `_dev/BDO_물교_v1.0.html` Git blob에서 직접 읽었다. `ORIGINAL_v14_1.html`로 대체하지 않았다.
- 원작 Git blob SHA-256: `924e01e1b424af3f5fe376d76223149c1927afe45b44d961af5ce725344421d6`.
- 현재 catalog SHA-256: `8183b03e6aa0ee354142cf9720b401494bec365e528632f3c0c84ec11b46b4b3`.
- 단계별 일반 품목: 1~5단계 각 14개, 6~7단계 각 24개. 합계 **118개**.
- 특수 허용 토큰: **9개, 까마귀 주화 포함**. 화려한 진주 결정, 화려한 암염 주괴, 빛나는 코발트 주괴, 오킬루아의 꽃, 파도의 블랙스톤, 대양의 견고한 현철, 유실된 무역품 상자, 흑수정 장식 팔찌, 까마귀 주화.
- 위치: `rawData`를 복사한 `islandCoordinates`의 **100개 토큰**. 현재 게임 identity 100개가 검증됐다는 뜻이 아니다.
- 6단계 장소 제한: 8개 토큰. 7단계 장소 제한: 6개 토큰. 이름 일부는 일반 위치와 겹친다.
- 일반 품목/특수품/일반 위치/6단계 장소/7단계 장소를 각각 추출하여 catalog와 배열 전체 deepEqual: **PASS**.
- source occurrences: **241**; exact legacy-name groups: **230**. near-name identity를 합치지 않았다.
- 전체 섬×입력품×출력품 조합표: 조사한 원작 처리 경로에는 **없음**. 이름 pool, 장소 좌표, 단계 및 단계별 장소 제한을 이용한다. 전체 조합표 부재는 정적 코드 조사 결과이며 실행으로 증명한 게임 규칙이 아니다. 신규 전체 조합 DB를 만들지 않았다.
- 0→1 입력: 원작 `processParsedTrades`의 `rawFrom` 보존 및 `getItemTier`의 미등록 재료 tier 0 경로를 확인했다. 육지 재료 전체 DB를 추가하지 않았다.

재현 자료: `../../recognition-local/arch-unified-02/source-scope.mjs`, `source-scope.json`.

## 2. 확인한 한국어 외부 자료

| 자료 | 확인한 사실 | 한계 |
|---|---|---|
| [한국 공식 2026-04-15 업데이트](https://www.kr.playblackdesert.com/ko-KR/News/Detail?groupContentNo=15451) | 6·7단계 교역품과 장소, 까마귀 주화 입력 단계 변경, 대양 분리 | 공지의 표기가 Codex와 충돌하는 품목 존재 |
| [한국 공식 2026-05-20 업데이트](https://www.kr.playblackdesert.com/ko-KR/News/Detail?groupContentNo=15614) | 육지 일반 재료→1단계 교역품 개편 | 이 일반 재료를 Master 범위에 추가하지 않음 |
| [한국 공식 2025-02-05 업데이트](https://www.kr.playblackdesert.com/ko-KR/News/Detail?groupContentNo=13508) | 마고리아 및 근해 까마귀 주화 교환 변경 | 과거 동적 수량을 현재 숫자 정답으로 사용하지 않음 |
| [한국어 Codex 800023](https://bdocodex.com/kr/item/800023/) | 한국어 제목 `[2단계] 나르보산 해삼`, 외부 ID 800023 | 페이지의 무게는 오래된 값; 공식 현행 변경이 우선 |
| [한국어 Codex 800219](https://bdocodex.com/kr/item/800219/) | 검색 결과 제목 `[6단계] 고급 묵향함` | 직접 페이지는 CAPTCHA; 검색 결과 증거로만 기록 |

영문 페이지 본문이나 번역명은 Master 자료로 사용하지 않았다. 검색 과정에서 반환된 `/us/` 결과도 채택하지 않았다. 공개 페이지만 순차 조회했으며 CAPTCHA·로그인·보안을 우회하지 않았다. 사이트 HTML·설명문을 저장소에 복제하지 않았다.

### 조사 진행률의 정확한 분모

- 공식 6·7단계 표의 48개를 기존 토큰과 대조: **47개 이름·단계 일치, 1개 출처 충돌**.
- 한국어 Codex 직접 페이지로 이름·단계를 확인한 별도 품목: **1개**.
- 총 이름·단계 사실 일치: **48개**. 이것은 fixed identity 발급/최종 reference entity 검증 수가 아니다.
- 출처 충돌 발견: **1개**. 전 범위 조사 완료 후의 총 충돌 수라고 주장하지 않는다.
- 계약 중단 후 개별 조회하지 않은 legacy-name groups: **181개**. 항목별 `NOT_RESEARCHED_AFTER_DESIGN_STOP` 사유를 `research-accounting.json`에 기록했다.
- 현재 확정한 이름 정정: **0**; 단계 정정: **0**. 발견한 차이를 임의로 확정하지 않았다.
- 새 기준 Master entity/위치 identity/alias 발급 및 publish: **0**.
- 외부 범위 밖 품목 추가: **0**. 조사에서 접한 새 일반 재료와 5개 대양 교역품은 추가하지 않았다. 전체 외부 DB를 조회하지 않았으므로 전체 제외 대상 수는 산출하지 않는다.
- `REFERENCE_UNRESOLVED=0` 달성: **아님**. 남은 182개 그룹은 충돌 1개 + 개별 조사 미완료 181개다. 이 수는 아직 identity 관계를 검증하지 않은 48개의 자동 identity 승인을 의미하지 않는다.
- 최종 Master 품목 수/위치 수: **미확정**. 사용자 초기 수동 검수 수를 0으로 달성했다고 주장하지 않는다.

### SOURCE_CONFLICT — 고급 묵양함 상자

- 원작/현재 catalog: `고급 묵양함 상자`.
- 공식 2026-04-15 공지: `고급 묵양함`.
- 한국어 Codex 검색 결과 ID 800219: `고급 묵향함`.
- 후속 검색에서 이 교역품의 표기를 확정하는 공식 정정 자료를 찾지 못했다. 별개의 일반 무역품 `묵향함` 공지는 해당 6단계 품목의 정정 증거로 사용하지 않았다.

## 3. Catalog Provenance v2 runtime baseline reconciliation (2026-10-03)

- `0c5133b8c7d8895e27607690d37d9e881d6c641d320e9f24bd77f425259763ce`는 M4 reference-audit 시점의 **historical semantic Bundle2 hash**이며, 현재 runtime expected hash가 아니다. 당시 기록은 보존한다.
- Registry1 source/snapshot provenance가 실제 Bundle semantic envelope에 포함된 runtime integration은 `37c5df1303a83aaae8aed7e1bf3f4d1cd1a1c8bc` (`feat: support verified reference master`)에서 이루어졌다.
- Catalog Provenance Digest v2는 CRLF/LF checkout 차이를 입력 provenance에서 제거한다. 전체 LF 및 CRLF 재구성에서 catalog digest `bc7f1e50460ea29ebe822018606008506334315cab07ac67f8cdbec2a19e606e`, Registry snapshot hash `9b2fa94dfb3c77d550777354a224ab3bfd336284c0097b948ce0a5a86bd3fc3f`, 그리고 Bundle2 content hash `ad0b6a929130dfeafd0f66bc5c302a7d2c60c400d5145cd16cd20b66bd3e652b`가 동일하게 재현됐다.
- 2026-10-03 전체 R2F 필수 회귀가 PASS했다. 현재 runtime의 authoritative provenance-v2 Bundle2 baseline은 `ad0b6a929130dfeafd0f66bc5c302a7d2c60c400d5145cd16cd20b66bd3e652b`다. 이 기준은 M4 historical audit hash를 대체하거나 과거 조사 결과를 수정하지 않는다.
- 결정: `SOURCE_CONFLICT`, 확정명 없음. 공식 표의 오탈자라고 추정하거나 Codex 검색 제목만으로 VERIFIED_REFERENCE를 발행하지 않는다.

## 3. 구현 중단을 일으킨 cross-layer 계약

최종 결과 위주 UI에서 정상 행을 한꺼번에 확인하는 동작과, 기존 R006의 필드별 확인 truth는 같은 의미가 아니다.

현재 authority는 `CURRENT-PRODUCT-CONTRACT.md` 7절과 `UNIFIED-RECOGNITION-ARCHITECTURE.md` 9절에서 다음을 이미 구분한다.

- 새 필드 decision: `CANDIDATE_RETAINED` / `USER_EDITED` / `USER_MARKED_UNKNOWN`.
- 새 batch confirmation: `USER_FINAL_LIST_CONFIRMED`.
- 독립 crop 정답: 별도 `HUMAN_CROP_VERIFIED`. retained를 accuracy 정답 분모에 넣지 않는다.
- 새 FinalProjection/Completion/Observation/export schema 3와 recognition sidecar schema 3의 additive migration을 **미래 E1 계약**으로 계획한다.

현재 실행 코드는 아직 그 계약을 구현하지 않는다.

| 경계 | 현재 코드 | 필요한 의미와 충돌 |
|---|---|---|
| UI completion | `trade-recognition-review.js`의 동일값은 USER_BATCH_CONFIRMED_UNCHANGED | 미검수 정상 행을 retained로 저장할 수 없음 |
| API validator | `recognition_contracts.py`는 observation/completion 1, REVIEW_FIRST와 기존 3종 method만 허용 | 새 review mode/retained/version 3를 거부 |
| SQLite | `recognition_store.py`의 schema_version=1 CHECK 및 artifact verification_method CHECK | validator enum만 늘려도 새 evidence 계약을 저장할 수 없음 |
| DTO | `reviewed-trade-dto.js`는 observation 1, projection 1/2, registry v1 bindings만 허용 | bundle v2를 pin한 FinalProjection3의 승인·receipt 경로 없음 |
| 평가 | `trade_review_evaluation.mjs`는 기존 knownTruthEligible 판정 | 새 retained를 옛 unchanged로 위장하면 raw/보정 정확도를 잘못 측정 |
| Master | JS/Python Bundle2 validator는 VERIFIED_REFERENCE 미지원 | 최소 enum/출처 검증 확장이 필요; 이것만으로 DB 재설계가 필요하다고 판정하지 않음 |

기존 동작이 고장 났다는 판정이 아니다. 새 제품 의미로 통과시키기 위해 현재 wire contract·truth·버전 경계를 함께 보정해야 한다는 증거다. 미래 계약의 개념적 방향은 있으나 실제 저장/DTO/평가로 이어지는 schema3 dispatch와 구체적 payload가 아직 없다. 이 경계를 기존 schema1로 숨기거나 임의로 완성하는 대신, 지시서 50항의 correction pipeline 계약 보정 중단 조건을 적용했다.

Master reference/owner 우선순위가 구조적으로 불가능하다고 판정하지 않았다. 기존 CAS·immutable bundle·stableId continuity는 보존해야 한다. reference 추가만을 기존 owner 직접 검증으로 위장하는 방법은 배제했다.

## 4. 재현한 검증

Python: 깨끗한 `recognition-local/r006-env-recovery/venv314/Scripts/python.exe`, 3.14.2. `-B`와 `PYTHONDONTWRITEBYTECODE=1`. 기존 repo `.venv` 미사용.

- 기존 observation fixture validator: ACCEPT.
- 해당 fixture의 unchanged field method만 CANDIDATE_RETAINED로 변경: REJECT.
- 해당 fixture의 reviewMode만 FINAL_CORRECTED_RESULT로 변경: REJECT.
- 해당 fixture의 observation schemaVersion만 3으로 변경: REJECT.
- 기존 Master Bundle2: ACCEPT.
- 동일 구조의 entity status를 VERIFIED_REFERENCE로 변경하고 hash 재계산: `entities[0].status is unknown`.
- SQLite `:memory:`에 실제 R006 DDL 사용: 기존 schema1 INSERT ACCEPT; schema3 INSERT는 `CHECK constraint failed: schema_version=1`.
- 위 3개 control ACCEPT / 5개 예상 REJECT 확인: PASS. 이것은 새 기능 gate PASS가 아니다.
- `trade_catalog_audit_regression`: PASS.
- `trade_master_bundle_regression`: PASS.
- 원작→catalog source 배열 deepEqual: PASS.
- backend full / correction / numeric / browser full / viewport 시각 gate: **미실행**. 제품 구현을 시작하지 않았기 때문이다.

재현: repo root에서 `node _dev/recognition-local/arch-unified-02/source-scope.mjs`, `node _dev/recognition-local/arch-unified-02/research-accounting.mjs`. Python probe는 `_dev`를 PYTHONPATH에 지정하고 위 clean Python으로 `-B _dev/recognition-local/arch-unified-02/contract-probe.py`를 실행한다. 실제 DB 호출은 없으며 파일에 기존 observation을 재작성하지 않는다.

## 5. 다음에 확정해야 하는 범위

1. 이미 승인된 retained≠crop truth 의미에 맞춰 FinalProjection3→Completion3→Observation3→receipt/export→DTO→evaluation의 정확한 입력/출력과 버전 dispatch를 고정한다.
2. R006 옛 tables/JSON/artifacts/hash를 보존하는 additive sidecar3 migration 및 rollback/backup/미래 버전 거부 범위를 고정한다. Main/session 계약은 유지한다.
3. VERIFIED_REFERENCE의 출처 기준과 VERIFIED_CURATED override 우선권을 확정하고 source conflict는 임의 해결하지 않는다.
4. 이 계약 경계를 해결한 뒤 남은 한국어 조사→기준 Master→보정→검수→전체 workspace 구현 순서로 재개한다.

이번 작업에서 production/기존 tests/catalog/기존 authority 문서/실제 Main·recognition·Master DB/기존 실사 evidence를 변경하지 않았다. 독립 실사나 OCR을 실행하지 않았고 commit/push도 하지 않았다. 이 요청이 명시한 신규 audit만 추가했으며 재현 스크립트와 JSON은 ignored 영역에 둔다.
+

## 6. ARCH-M4-R 결과 — 2026-10-02

이 절은 M4-R 실행 결과다. 위 1–5절은 ARCH-UNIFIED-02에서 남긴 **이전 partial audit**로 보존한다. M4-R은 해당 181개 미조사 후보를 포함한 원작 legacy group 230개 각각에 대해 한국 공식 사이트와 한국어 BDO Codex 후보별 검색을 수행했다. `/us/` 자료, 영어 번역, 검색 미리보기만으로 Verified claim을 만들지 않았다.

- 범위 해시 재검증: 원작 HTML blob `f13b8e15af392f167d153c873448a4b2abec5a0c:_dev/BDO_물교_v1.0.html` SHA-256은 `924e01e1b424af3f5fe376d76223149c1927afe45b44d961af5ce725344421d6`; 현재 catalog 원시 bytes SHA-256은 `8183b03e6aa0ee354142cf9720b401494bec365e528632f3c0c84ec11b46b4b3`. 원작 파일은 현재 working tree에 없어 V1 baseline Git blob의 원본 bytes를 읽어 재계산했다.
- source occurrences 241, exact legacy groups 230을 manifest가 전부 정확히 나눠 기록한다. catalog 배열이나 원작 범위는 변경하지 않았다.
- `VERIFIED_REFERENCE` claims 87개(한국 공식 source evidence 72 claim, BDO Codex KR direct page evidence 15 claim). 동일 group을 여러 출처 claim으로 중복 계산하지 않았다.
- unresolved 143개: `NO_DIRECT_REFERENCE` 142, `SOURCE_CONFLICT` 1, `TIER_CONFLICT` 0. 각 미해결 후보는 아래 표에 남긴다. 모든 NO_DIRECT_REFERENCE는 후보별 한글 검색을 수행했으나 현재 이름/종류를 뒷받침하는 정확한 직접 페이지를 확보하지 못한 경우다.
- SOURCE_CONFLICT: `고급 묵양함 상자`. 한국 공식 교역표는 `고급 묵양함`, Codex KR 검색 제목은 `고급 묵향함`이지만 Codex 직접 페이지는 CAPTCHA로 열리지 않았다. 어느 이름도 선택하지 않았다.
- 0→1 육지 입력품 전체 목록, 새 특수 품목, 전체 섬×교역 조합 DB를 추가하지 않았다. near-name 후보(예: `하코번 섬`/ `하코번`, `일리야 섬`/ `일리야`)를 합치지 않았다.
- manifest policy `trade-master-reference-v1`, schemaVersion 1. UUID v4 87개는 한 번 발급해 manifest에 고정했다. referenceAuditHash: `46c10355ccf3b8b5aba08880cd5947408cc66720dafdccef4d9deeb12ab2df82`.

### 최종 조사 및 기준 Bundle2 accounting

| 원작 legacy kind | 전체 group | VERIFIED_REFERENCE | 기존 VERIFIED_CURATED 보존 | unresolved | 세부 unresolved |
|---|---:|---:|---:|---:|---|
| MASTER_ITEM | 118 | 57 | 0 | 61 | NO_DIRECT_REFERENCE 60, SOURCE_CONFLICT 1 |
| SPECIAL_ITEM | 9 | 3 | 0 | 6 | NO_DIRECT_REFERENCE 6 |
| ISLAND (교환 장소 namespace) | 103 | 27 | 0 | 76 | NO_DIRECT_REFERENCE 76 |
| **합계** | **230** | **87** | **0** | **143** | **NO_DIRECT_REFERENCE 142, SOURCE_CONFLICT 1, TIER_CONFLICT 0, NOT_RESEARCHED 0** |

출처 coverage는 verified claim group 단위이며 중복 없이 계산했다. 한국 공식 자료가 근거인 claim은 72, BDO Codex 한국어 직접 페이지가 근거인 claim은 15, 양쪽 출처가 함께 근거인 claim은 0이다. source occurrences 241개 모두 이 230개 group의 resolved entity 또는 unresolved source record에 한 번씩 남는다. 기준 Bundle2는 entity 87개, compatibility mapping 87개, unresolved legacy record 143개이며 source occurrence 합계는 241이다. Bundle2 schemaVersion은 2, Master Store schemaVersion은 1을 유지한다. 의미 hash는 `0c5133b8c7d8895e27607690d37d9e881d6c641d320e9f24bd77f425259763ce`이고 registryVersion은 `registry-v2:0c5133b8c7d8895e27607690d37d9e881d6c641d320e9f24bd77f425259763ce`다. `createdAt`만 바꾼 재생성에서도 같은 contentHash가 나왔다.

이 표는 unresolved를 자동으로 정답 처리하지 않는다. 해당 143개는 원작 문자열과 각 한국어 후보별 검색 이력을 보존하며, 직접 reference page를 확보하지 못한 142개와 직접 자료 표기가 충돌한 1개를 분리한다. 따라서 미조사 0을 달성했지만 reference-resolved 범위는 87 group이며, audit 결과를 230개 전체가 외부 자료로 검증됐다고 해석하면 안 된다.

한국 공식 자료는 [2026-04-15 교역 개편 및 6·7단계 표](https://www.kr.playblackdesert.com/ko-KR/News/Detail?groupContentNo=15451), [소산 주둔지 관련 공식 업데이트](https://www.kr.playblackdesert.com/ko-KR/News/Detail?groupContentNo=13135), [델링하트 섬 관련 공식 업데이트](https://www.kr.playblackdesert.com/ko-KR/News/Detail?groupContentNo=8555)다. 직접 확인한 한국어 Codex 페이지 예시는 [말린 푸른 장미](https://bdocodex.com/kr/item/800001/), [칼페온 기사단의 전투 교본](https://bdocodex.com/kr/item/800230/), [카슈마 섬](https://bdocodex.com/kr/node/1370/), [라시드 섬](https://bdocodex.com/kr/node/1008/)다. manifest claim은 확인된 page URL, checkedAt, externalId, verifiedProperties만 포함한다.

### 조사 후 unresolved 목록

| 원작 후보명 | 원본 종류 / tier | occurrence 수 | 상태 | 판정 |
|---|---|---:|---|---|
| 알마이 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 네트넘 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 던데 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 베이루와 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 널찍한 돌판 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 스타렌 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 오스트라 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 청동 촛대 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 만병통치약 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 때 탄 갈매기 조각상 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 타라무라 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 조각상의 눈물 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 웨이타 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 알브레서 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 나르보산 해삼 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해적선 돛대 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해골무늬 카페트 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 족제비 가죽 외투 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 굳어진 용암 액 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 고대 항아리 파편 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 고급 묵양함 상자 | MASTER_ITEM / 6 | 1 | SOURCE_CONFLICT | 공식/Codex 표기 충돌, direct Codex page 미확인 |
| 종유석 파편 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 바라테르 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 레라오 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 팔랑나비 박제품 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해적 금주화 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 젊음을 담은 비약 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 타슈 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 란디스 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 대양의 견고한 현철 | SPECIAL_ITEM | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 오킬루아의 꽃 | SPECIAL_ITEM | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 알나하 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 마르카 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 테야말 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해양 구조품 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 오르프스 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 아라킬 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해적의 열쇠 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 균형잡힌 돌탑 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해적단의 보급상자 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 리에드 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 시오닐 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 비옥한 흙 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 로즈반 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 샤샤 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 청록빛 소금덩어리 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 뗏목 조각품 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 빛바랜 황금용 조각상 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 소산 선착장 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 티그리스 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 더코 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 필바라 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 나르보 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해상 기사단의 투구 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 낡은 지령서 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 섬마을 도시락 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 오래된 모래 시계 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 하코번 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 루이바노 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 리스즈 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 최고급 굴 상자 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 포르타넨 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 갈퀴 꽃 씨앗 주머니 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 정찰병 망원경 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 마리베노 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 바레미 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 보아 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 난파된 콕스해적선 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 푸자라 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 아레하자 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 일리야 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 에프데 룬 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 안카도 내항 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 벨리아 마을 해변 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해모 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 소코타 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 앙쥬 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 시르나 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 떠돌이 상인의 배 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 푸른빛 석영 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 루루브 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 깊은 밤 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 틴베라 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 화려한 진주 결정 | SPECIAL_ITEM | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해적의 화약 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 102년 묵은 황금초 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 소라게 껍질 장식 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 희귀 약초 무더기 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 자수정 파편 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 오벤 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 반달 조리용 칼 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 황금빛 모래 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 쫄깃한 전어 회 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 금주화가 담긴 낡은 상자 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 오색 구슬 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 화려한 암염 주괴 | SPECIAL_ITEM | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 고급 문양의 옷감 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 아지르 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 정제된 식수 | MASTER_ITEM / 2 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 롬타스 그물 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 쿠이트 제도 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 찢어진 해적 보물지도 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 데이튼 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 테스테 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 아리타 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 흑수정 장식 팔찌 | SPECIAL_ITEM | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 정체불명의 암석 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 푸른 양초 더미 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 흰색 애벌레 박제품 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 팔각 문양 보관함 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 파라타마 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 목 잘린 용 조각상 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 라메다 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해상 기사단의 창 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 앵두나무 씨앗 주머니 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 오리샤 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 두흐 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 성전 해안 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 오킬루아의 눈 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 거대한 물고기 뼈 | MASTER_ITEM / 1 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 황금빛 물고기 비늘 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 툴루 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 마를레느 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 에버딘 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 할마드 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 조개 껍질 장식 | MASTER_ITEM / 4 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 걸쭉한 괴생물 혈액 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 세르카 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 모드릭 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 파딕스 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 유실된 무역품 상자 | SPECIAL_ITEM | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 인버넨 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 알 수 없는 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 37년된 약주 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 진버레이 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 에베토 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 해골 장식 찻잔 | MASTER_ITEM / 3 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 최고급 황금 촛대 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 발베쥬 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 바에자 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 고대인을 형상화한 초상화 | MASTER_ITEM / 5 | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 에스파 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
| 칸베라 섬 | ISLAND | 1 | NO_DIRECT_REFERENCE | 공식 KR 및 Codex KR 후보별 검색 완료; 정확한 직접 근거 페이지 미확보 |
