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
