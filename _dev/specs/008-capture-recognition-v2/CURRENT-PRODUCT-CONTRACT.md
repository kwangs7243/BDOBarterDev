# SPEC-008R — Current Product Contract

상태: **SPEC008R_CURRENT_PRODUCT_CONTRACT_ESTABLISHED** — 목표 계약 확정, 구현·출시 완료 아님.

현재 구현 root는 `_dev/local_app`. 이 문서는 제품 목표와 보호 계약을 정의하며 완료 이력은 Git history에서 확인한다.

## Product Summary

### 무엇을 만드는가

검은사막 물물교환 화면을 캡처하면 프로그램이 섬, 소모품, 필요 수량, 획득품, 남은 교환 횟수, 수율을 읽고 검토할 후보를 만들어 준다. 사용자는 그 후보와 원본 화면을 비교해 틀린 부분만 고친다. 검토가 끝난 유효한 결과는 기존 물교 회차와 브라우저 목록으로 이어지고, 기존 배차·경로 계산을 그대로 사용한다. 목표는 OCR 문자 하나하나의 완벽함보다 **적은 수정으로 신뢰할 수 있는 물교 목록을 얻는 것**이다.

### 사용자는 어떻게 쓰는가

사용자는 화면을 연결하고 물교 영역을 맞춘 뒤 필요한 화면들을 차례로 캡처한다. 파일과 붙여넣기도 유지한다. 스크롤과 캡처 시점은 사용자가 정한다. 프로그램은 로컬에서 화면을 읽고 겹치는 행을 비교하며, 품목 기준 자료를 참고해 가장 그럴듯한 후보를 미리 채운다. 여러 화면에 걸친 동일 행의 출처는 함께 보존한다. 서로 다른 수량이나 이름을 같은 행으로 확신할 수 없으면 사용자에게 충돌을 보여준다.

검수 화면에는 **완전히 포착된 모든 행과 여섯 필드**가 보인다. 프로그램이 안전하다고 판단한 칸도 숨기지 않는다. 사용자는 맞는 칸을 다시 입력할 필요 없이 그대로 두고, 잘못된 칸만 수정한다. 숫자가 잘렸거나 이름 후보가 여러 개이면 이유와 원본을 쉽게 볼 수 있게 강조한다. 강조되지 않은 칸도 틀릴 수 있으므로 모든 행을 확인한다. 화면 경계에 걸린 조각이나 누락 가능성은 별도 경고로 남기며, 필요하면 추가로 캡처한다.

모든 완전한 행을 확인한 뒤 사용자가 명시적으로 **검수 완료**를 누른다. 그 전의 값은 시스템 예측이며 정답 자료가 아니다. 완료 시 수정하지 않은 값은 ‘확인 후 그대로 사용’, 고친 값은 ‘사용자 수정’, 읽을 수 없는 값은 ‘알 수 없음’으로 구분한다. 알 수 없는 값을 0이나 1로 채우지 않는다. 확인된 값이라도 필수값·수량 범위·중복·충돌 검사를 통과해야 회차에 들어간다. 검수 완료, 증거 저장 완료, 회차 저장 완료는 서로 다른 상태로 표시한다.

### 무엇을 자동화하고 무엇을 확인하는가

캡처 이미지 처리, 문자 읽기, 보정 후보 생성, 겹침 비교, 위험 표시와 검증을 자동화한다. 첫 실사용 모드는 **REVIEW-FIRST**다. 사람 확인 없이 값을 숨기거나 적용하는 자동수락은 나중의 별도 기능이다. 모든 숫자가 자동으로 안전하다고 입증될 때까지 검수 기능을 미루지는 않는다. 반대로 전부 보류해서 자동 오류가 0이라는 이유만으로 제품이 성공했다고 하지 않는다.

### 검수 결과를 왜 저장하는가

같은 오류를 되풀이하지 않기 위해 원래 판독값, 보정 후보, 사용자에게 보였던 값, 사용자의 최종값과 수정 이유를 연결해 남긴다. 필요한 행·필드 이미지와 해시, 모델·프로필·기준 자료 버전도 연결한다. 검수 자료는 이후 오류 분류와 새 보정·인식 방법의 비교에 쓰인다. 아직 검수하지 않은 예측은 학습·평가 정답에 넣지 않는다. 전체 스크린샷을 무제한 저장하지 않으며 기존 보관 용량·기간 정책을 지킨다.

### V1과 무엇이 다른가

V1의 유용한 이름 보정과 기존 입력 흐름은 유지할 가치가 있다. 그러나 V1 출력이 언제나 정답인 것은 아니다. 실제 자료에서는 이름 오류를 복구했지만 잘린 수율 숫자를 통과시키고 빠진 필요 수량을 1로 채운 사례가 있었다. 기준 품목명과 게임 표시명이 다를 수도 있다. V2는 원본 관찰, 보정 후보, 사용자 확인, 프로그램 내부 품목 식별자를 구분한다. 게임 표기가 기준 자료와 다르면 바로 OCR 오류로 단정하지 않고 별도의 ‘기준 자료 불일치’로 남긴다. 기준 자료의 수정은 검수 한 번으로 자동 실행하지 않는다. 기존 수동·JSON 입력은 V2 문제 때도 사용할 수 있게 남긴다.

## 1. Authority와 현재 구현

현재 실행 사실은 `local_app` 코드와 테스트, 제품 목표는 이 문서와 결정 목록, 남은 실행 순서는 CURRENT-ROADMAP을 기준으로 한다. 옛 설계·migration 보고서는 Git history에서 조회한다.

현재 file/paste/stream 캡처, 로컬 draft, versioned Registry adapter, V2 correction, source/logical reconciliation, 전 행 편집과 명시 검수 완료, sidecar observation/export, reviewed DTO와 staged NEW session, 버전 평가가 구현되어 있다. dedicated review 창은 원문·후보·출처와 여러 행을 표시한다. R011 최종 independent usability 및 R012 release는 미완료다. 기존 수동 JSON/창고/배차 흐름은 유지한다.

## 3. 정상 흐름과 책임

```text
Browser capture → Local recognition → Multi-capture row reconciliation
→ Correction candidate generation → Review projection → User review
→ Verified evidence save → Final DTO validation → Trade session/browser output
```

| 계층 | 소유 책임 | 금지 |
|---|---|---|
| Capture | 원본 frame/ROI, 순서, source fidelity와 hash | 브라우저가 모르는 원본 display fidelity를 증명했다고 기록 |
| Recognition | raw text/numeric, crop lineage, confidence·완전성 evidence | master/정답을 reader에 주입, 임의 canonical 확정 |
| Reconciliation | overlap 제안·출처 연결·충돌 보존 | 불확실 행을 조용히 병합/삭제 |
| Correction | V2 후보/대안/reason/provenance 생성 | 후보를 human truth로 기록 |
| Master | program identity·검증된 이름·호환 mapping·버전 | 동적 수량 추론, 관찰의 자동 승격 |
| Review | 전 행·전 필드 표시, 편집·unknown·완료 기록 | 일반/안전 표시 필드 숨김 |
| Evidence | 표시값과 최종값, 검증 방법, 버전을 재현 가능하게 저장 | 미검수 예측을 정답으로 사용 |
| Final DTO | 확인된 값의 mapping/범위/중복/충돌 검사 | 사용자 입력이라는 이유만으로 invalid 허용 |
| Session | staged snapshot 저장 후 기존 브라우저/배차로 연결 | 저장 실패를 적용 성공으로 표시 |
| Automation policy | 미래 무인 수락의 별도 eligibility/audit | review eligibility와 혼합 |

Logical envelopes는 버전을 갖는다. `RecognitionDraft` → `ReconciledRows` → `ReviewProjection` → `ReviewObservation` → `ValidatedTradeBatch` → `SessionCommitReceipt`로 provenance를 연결한다. 이는 설계상 인터페이스이며 현 API DTO의 즉시 변경 지시가 아니다. 각 단계는 원본을 immutable로 보존하고 새 revision을 만든다. UI 편집값을 raw/correction slot에 덮어쓰지 않는다.

## 4. Review contract

**Review Candidate Eligibility**: 구조적으로 COMPLETE이고 source/capture/row 식별과 여섯 field 슬롯을 재현할 수 있으면 후보를 표시한다. 숫자나 이름이 unknown이어도 표시한다. 프로토콜 손상/출처 누락은 검증 오류와 재시도 안내로 표시하고 truth 저장을 차단한다. COMPLETE는 구조 상태이며 모든 값의 정확성을 뜻하지 않는다.

**Automatic Acceptance Eligibility**: source completeness, numeric provenance, unique identity, conflict 없음 및 별도 safety audit을 요구한다. 지금은 자동수락을 켜지 않는다. E1의 SAFE_ACCEPT/HOLD는 이 축과 risk annotation으로만 사용한다.

필드 projection은 `{rawEvidence, candidate, alternatives, correctionReason, masterRevision, riskReasons, shownValue, reviewState}`를 갖는다. 최선의 후보가 없으면 null/알 수 없음과 원문을 표시한다. 부분 숫자48도 ‘불완전 후보’로 보여줄 수 있으나 확인된148로 바꾸어 보여주지 않는다. 애매한 이름의 최선 후보 표시도 identity 승인과 다르다. 모든 필드 editable, 원본 crop 접근 가능, 강조는 색상뿐 아니라 한국어 이유를 함께 제공한다.

| 상태 | 의미 / 확정 시점 |
|---|---|
| `SYSTEM_PREDICTION_UNREVIEWED` | 초기 후보·재인식·변경된 projection. truth 아님. |
| `USER_BATCH_CONFIRMED_UNCHANGED` | 사용자가 모든 COMPLETE 행을 확인하고 명시적으로 검수 완료한 visible unchanged 필드. |
| `USER_EDITED` | 사용자가 바꾼 값. 완료 전에는 pending edit; batch 완료 이후 human observation으로 확정. typed라는 이유로 유효 DTO라고 보지 않음. |
| `USER_MARKED_UNKNOWN` | 사용자가 판독 불가를 명시. 완료 후에도 값 정답이 아니고 unknown label. |

Batch 확인은 표시된 projection revision/hash와 전체 COMPLETE row ID 집합에 묶는다. 필터로 숨긴 행·검토하지 않은 페이지·capture 변경·재인식·master/correction revision 변경을 그대로 unchanged truth로 확정하지 않는다. lazy render는 가능하지만 모든 행을 확인할 수 있고 미확인 행 수를 드러내야 한다. 확인 후 편집은 새 review revision을 만들며 종전 evidence를 덮지 않는다. 앱은 눈으로 실제 확인했는지 추정하지 않고 사용자의 명시적 batch declaration을 기록한다.

`EDGE_SEGMENT_UNCERTAIN`/partial/누락 가능성은 출처와 경계 위치를 가진 별도 안내로 남긴다. 행 숫자를 부풀리는 six-field OCR을 하지 않는다. 추가 캡처로 해결되거나 사용자가 미완성 범위를 인지할 때까지 ‘전체 목록 완료’라고 표시하지 않는다. UNKNOWN 행은 검수 evidence에 남고, 유효 DTO에 포함할 수 없는 행은 사용자의 명시 제외 결정 없이는 조용히 제거하지 않는다. 어느 경우에도 조용한 누락과 강제 기본값은 금지다.

## 5. Master Registry

Registry는 program identity와 game display observation을 분리한다. 직렬화 기본안은 UTF-8 versioned JSON bundle `{schemaVersion, registryVersion, sourceRevision, entities, compatibilityMappings}`다. legacy adapter는 목록을 교체하지 않으며 stableId는 curated mapping에서만 받는다. 실행 시 immutable snapshot 한 버전을 참조하고, bundle hash를 correction/evidence에 기록한다. item과 island는 분리된 entity kind를 사용한다.

| 개념 필드 | 논리 계약 |
|---|---|
| `stableId` | 이름/순서가 바뀌어도 유지하는 식별자. 이름 자체나 배열 index를 영구 ID로 쓰지 않음. 최초 curation 시 할당, 이후 변경 금지. |
| `canonicalName` | 프로그램 표시·호환을 위한 이름. 게임의 현재 표기와 반드시 같다고 주장하지 않음. |
| `displayNames[]` | `{text, locale, gameVersion, status, provenance, firstObserved, lastVerified}`. version 미확인은 null. |
| `aliases[]` | `{text, scope, status, provenance}`. 검증된 alias와 legacy/관찰 중 alias를 구분. 미검증 alias를 자동 확정 근거로 쓰지 않음. |
| `tier`, `category/type` | 프로그램 domain 분류; 불명은 null. 섬에 item tier를 억지 부여하지 않고 적용 가능한 tier scope를 별도 기록. |
| `status` | `LEGACY_UNVERIFIED`, `VERIFIED`, `DISPUTED`, `DEPRECATED` 등 lifecycle. legacy 목록을 일괄 VERIFIED로 변환 금지. |
| `provenance` | source 파일/revision/hash/entry locator 및 검수 observation 참조. |
| `firstObserved`, `lastVerified` | 실제 관찰·검증 시각; import 실행 시각을 과거 검증 시각으로 만들지 않음. 모르면 null. |
| `verificationCount`, `disputed` | 독립 observation 단위의 검증 수와 분쟁 여부. OCR 실행 횟수/중복 capture 수를 검증 수로 세지 않음. |
| `deprecated/replacedBy` | 종료/대체 관계. 기존 ID 삭제 대신 mapping 보존, cycle 금지. |
| `notes`, `version/source revision` | 판단 근거·변경 이력·재현 기준. |
| `compatibilityMappings` | stableId→legacy catalog token/경로의 명시적 연결. 문자열 변화로 기존 scheduler/session을 깨지 않도록 별도 검증. |

화면에서 A를 확인했는데 legacy catalog가 B이면 원문A·내부B·mapping 상태를 동시에 보존한다. `MASTER_DISAGREEMENT`는 독립 상태이며 자동 `OCR_WRONG` 판정이 아니다. 철자·공백 차이가 alias인지 다른 identity인지는 근거 없이 합치지 않는다. 섬의 짧은 이름/긴 이름 중복도 배열만 보고 하나의 ID로 묶지 않는다.

Review observation은 evidence이고 Master update는 별도 promotion/curation이다. 반복되는 독립 검수, 같은 게임 버전에서의 일관성, 기존 목록과의 반복 불일치, 수동 검토를 근거로 제안한다. 정량 threshold는 실제 자료 없이 정하지 않는다. 새 Registry 버전은 이전 버전·mapping을 보존하고 rollback 가능해야 한다. `reqAmount/count/yield`는 Registry 값·tier ratio·과거 이력에서 도출하지 않는다.

## 6. V2 Correction Engine — 전략 B

| 전략 | 유지보수/회귀 | Master·numeric·review 적합성 | 결론 |
|---|---|---|---|
| A: V1 영구 권위 보강 | 재사용 빠르나 manual parser/force match와 새 정책 결합 | provenance 없는 accepted/fallback 계약을 계속 감싸야 함; Master 버전 분리 어려움 | 미선택 |
| B: V2 interface + V1 helper 점진 재사용 | 기존 검증된 matcher를 활용하고 adapter 단위 교체/회귀 가능 | 후보·risk·대안·Registry 버전을 V2가 소유, manual과 numeric safety 분리 | **선택** |
| C: 전면 독립 rewrite | 새 구현·기존 호환 회귀 비용 큼 | 장기 자유도는 크나 현재13 text 복구 evidence를 버릴 이유 없음 | 보류 |

`buildTradeReviewProjection({draftRows, reconciliation, registrySnapshot, correctionPolicyVersion})`는 순수 함수다. 출력은 원본 row/source 순서, 여섯 후보, alternatives, status(`MATCHED/AMBIGUOUS/UNMATCHED/MASTER_DISAGREEMENT/OPEN_WORLD`), risk/reason, correctionVersion/masterVersion/hash를 포함한다. API/DB/session side effect가 없다. recognition producer와 분리된 JS domain layer가 새 public contract를 소유한다. Python에 병렬 fuzzy master authority를 만들지 않는다.

재사용: whitespace/format 정규화의 유효 부분, stage/tier prefix 처리, 기존 `getSafeUniqueItemMatch`의 유일·bounded 매칭, tier 제약, item 분류와 duplicate/conflict의 호환 개념. V1 helper 결과도 대안·전후값·정규화 단계·policy version을 붙인다. 정규화 collision이면 first-match를 신뢰하지 않고 ambiguity로 올린다. 기존 0.75 규칙을 이 문서에서 낮추지 않는다.

그대로 재사용하지 않는 것: `processParsedTrades` 전체를 후보 생성기로 실행하는 방식, req1/count0 defaults, island force-nearest를 안전성 증거로 취급, positive yield만으로 완전성 확정, 숫자를 무시하는 중복 판정을 multi-capture 병합에 적용하는 것. V1 함수 자체는 수정하지 않는다. 후속 변경이 필요하면 별도 호환 gate를 통과한다.

동작 순서: 원본 보존 → format/stage 정규화 기록 → toItem 후보 열거 → tier별 fromItem 후보 제한 → island 후보와 source ellipsis 확인 → 검증 alias/unique bounded 매칭 → numeric label/unit parse → 대안·risk projection. toItem tier가 애매하면 fromItem 후보 공간도 애매하다고 기록하며 하나의 tier를 조용히 선택하지 않는다. R03 C1 suffix 가설은 독립 검증 전 활성화하지 않는다.

**Open-world fromItem**: tier0→1의 catalog 밖 육지 재료는 raw text를 후보로 유지하며 stableId=null/OPEN_WORLD로 표시한다. 사용자가 확인한 유효한 nonempty 이름은 기존 호환 의미로 최종 DTO에 쓸 수 있다. 이를 허구의 Registry entity로 등록하지 않는다. 이 허용은 tier2+ closed-world 품목의 unmatched를 무조건 통과시키는 근거가 아니다.

**숫자 책임**: `수 : 10회`처럼 하나의 숫자를 표현하는 label/unit/format은 bounded grammar로 parse하며 원문을 보존한다. count는 실제0과 missing을 구분한다. 복수 숫자군·invalid glyph·불완전 token은 unknown/risk. missing req→1, 48→148 추측, ratio/history/catalog 유래 수량은 금지. 사람이 이미지에서 고친 값은 `USER_EDITED` provenance이며 `STRICT_COMPLETE_RECOGNITION`으로 바꾸지 않는다.

## 7. Evidence와 개선 loop

Field observation 필수 논리 항목:

| 묶음 | 항목 |
|---|---|
| Identity | schemaVersion, observationId, runId, batchId, captureId(s), rowId/draftId, field, source row mapping |
| Source | source/crop hashes, crop geometry/lineage, 필요한 row/field crop 참조, model/version, profile/version |
| Prediction | raw OCR, raw numeric candidate, correction candidate, alternatives, reason, correction policy/version, Master version |
| Review | risk/highlight reasons, value shown, projection revision/hash, user final value 또는 null, review action, verification method, batch confirmation ID |
| Context | timestamp, session metadata(필요 최소), game version 알면 값/모르면 null, evidence 저장 결과와 후속 DTO/commit receipt 참조 |

Unchanged/edited/unknown은 별도 strata로 평가한다. `SYSTEM_PREDICTION_UNREVIEWED`는 training/evaluation truth 금지. USER_MARKED_UNKNOWN도 값의 정답 분모에서는 제외하되 unknown 수·율을 보고한다. Master disagreement는 화면 관찰 truth와 program identity mapping truth를 별도로 보존한다. Review 완료 후 DTO validation이 실패해도 유효한 human observation은 남을 수 있다; session 성공 증거와 혼동하지 않는다.

저장은 recognition sidecar/evidence store 경계를 사용한다. main schemaVersion=3은 그대로 보호한다. 현 sidecar와 main 저장은 단일 transaction이 아니므로 evidence 성공 후 session 실패/재시도 상태를 구분한다. 같은 review revision의 동일 observation ID 재저장은 멱등, 다른 payload는 conflict. 증거 저장이 실패하면 완료를 가장하지 않고 검수 입력을 유지해 재시도한다.

보관: 새 artifact+metadata **200 MiB budget**, 미검수 debug 자료 **30일 정리 정책**, 검증 crop 보호, debug 기본 off를 유지한다. 정책에 따른 정리는 명시적으로 실행하며 verified evidence를 용량 확보용으로 무단 삭제하지 않는다. 예산 초과 시 사용자에게 저장 제한/내보내기 필요를 알린다. production full screenshot 무제한 저장 금지. 필요한 crop/hash/provenance를 유지하고 export manifest로 재현한다. main DB의 기존 BLOB·사용자 백업을 이 정책으로 청소하지 않는다.

```text
Production review observations → versioned evaluation dataset
→ failure taxonomy → candidate algorithm/master change → offline replay
→ independent validation → promotion (version + rollback reference)
```

Taxonomy: `RECOGNITION_ERROR`, `CORRECTION_ERROR`, `MASTER_DISAGREEMENT`, `NUMERIC_INCOMPLETE`, `ROW_DETECTION_ERROR`, `CAPTURE_INCOMPLETE`, `DUPLICATE_CONFLICT`, `USER_UNKNOWN`, `OTHER`. 복수 원인 허용, 원인 미확정은 OTHER+설명으로 남긴다. 유저 오류 표시와 분석자의 원인 attribution은 덮어쓰지 않고 분리한다. 같은 capture/session의 반복 자료를 독립 holdout으로 쓰지 않는다. D2 11행은 이미 후보 설계에 사용됐으므로 독립 검증군이 아니다.

## 8. 제품 metric / denominator 계약

검수 완료된 projection revision별로 계산한다. `F`=표시된 COMPLETE 행의 여섯 필드, `V`=그중 최종값이 확인된 필드(unknown/disputed truth 제외), `R`=표시된 COMPLETE 행, `T`=최종 여섯 값의 truth와 mapping이 확인된 행. 수치와 함께 F/V/R/T 및 미검수·unknown·disputed·edge 수를 보고한다. 분모0은 N/A이며0%로 쓰지 않는다. 수정량은 동작 횟수가 아니라 최종값과 표시값의 의미 차이로 센다; 중간 타이핑/되돌림은 별도 interaction metric이다.

| Metric | 분자 / 분모 및 의미 |
|---|---|
| `PRE_REVIEW_FINAL_CANDIDATE_CORRECTNESS` | 검수 전 최종 보정 후보가 truth와 같은 V 필드 / V. missing 후보는 정답 아님. 별도 전체 six-field exact 행 / T도 보고. ‘final candidate’는 final DTO가 아님. |
| `USER_EDIT_RATE` | 검수 완료 시 표시값과 최종값이 달라진 V 필드 / V. USER_EDITED action 수는 별도 집계. |
| `ROWS_REQUIRING_EDIT` | 적어도1개 semantic edit 있는 행 수 / 검수 완료 R. unknown-only 행은 edit0 성공으로 숨기지 않고 별도 보고. |
| `FIELDS_REQUIRING_EDIT` | semantic edit 필드 수, field 종류별 분해 및 /V. |
| `CORRECTION_RECOVERY_RATE` | raw 오답·missing에서 보정 후 정답이 된 필드 / raw가 오답·missing이고 truth를 아는 필드. raw 평가 정규화 기준을 version으로 고정. |
| `CORRECTION_HARM_RATE` | raw가 정답인데 보정이 오답·missing으로 바꾼 필드 / raw 정답 필드. |
| `UNHIGHLIGHTED_ERROR_RATE` | 위험 표시 없이 일반/안전으로 보여줬으나 실제 semantic edit된 필드 / 위험 표시 없이 보여준 V 필드. unknown로 바뀐 수 별도 보고. 높으면 검수 필드 숨김 자동화 금지; 임의 threshold 미정. |
| `MASTER_DISAGREEMENT_RATE` | 검수상 game display와 registry 관계가 충돌한 identity 필드 / registry와 비교 가능한 human-confirmed identity 필드. 순수 표기 alias와 identity 불명은 분리. |
| `NUMERIC_REVIEW_RATE` | risk 표시 또는 edit/unknown인 numeric 필드 / 검수 완료 행의 numeric 슬롯(3×R). risk·edit·unknown 겹침은 union, 각각도 보고. REVIEW-FIRST의 ‘모두 눈으로 검토’와 구별. |
| `FINAL_VERIFIED_DTO_SUCCESS` | 검수 완료 후 validation+충돌 해소를 통과한 unique DTO 행 / 제출 대상 unique COMPLETE 행(unknown/invalid 포함). 명시 제외 행을 포함/제외한 수 둘 다 보고. session 저장/브라우저 출력 성공 수는 별도 단계 결과로 보고. |

재현을 위해 row와 field 평가를 분리하고 whitespace/display alias 비교는 versioned mapping 기준을 사용한다. unknown을 V/T에서 제외해 정확도가 올라가는 경우 coverage를 같이 제시한다. edge에는 가짜 여섯 필드를 만들지 않고 capture-level omission metric을 별도로 둔다.

향후 자동화: `WRONG_AUTO_ACCEPT`=사람 확인 없이 수락한 값 중 검증된 오답 건수(+unknown audit 수), `SAFE_AUTO_ACCEPT_COVERAGE`=독립 평가에서 정확·안전성이 확인된 자동수락 행/자동화 평가 대상 COMPLETE 행. eligible sample>0, false auto apply0, 독립 holdout, 실제 Chrome/game, package gate를 함께 요구한다. **all-HOLD 오류0은 PASS가 아니다.** raw OCR exact는 diagnosis에만 사용한다.

## 9. Multi-capture / final DTO / session

캡처 순서·scroll overlap·row source mapping을 보존한다. Correction 전 reconciliation은 geometry와 overlap으로 같은 행 가능성을 연결하고, correction/review 후 identity+숫자까지 비교해 확정한다. 불확실한 연결을 강제 merge하지 않는다. exact six-field duplicate만 확정 merge 가능하며 모든 sourceRefs를 union한다. 동일 island/toItem/fromItem이어도 req/count/yield가 다르면 numeric conflict로 남긴다. 동일 island/output에 서로 다른 input도 conflict. 같은 이미지 중복 입력이 검증 observation 수를 늘리지 않도록 group identity를 유지한다.

병합은 source 행을 숨기는 수단이 아니다. review에는 각 원본 COMPLETE 행과 여섯 필드를 확인할 수 있는 source별 표시를 유지하고 병합 제안을 연결한다. 중복 source의 확인이 끝나기 전 한 행의 확인을 다른 source의 unchanged truth로 전파하지 않는다. verified final DTO는 unique 행으로 만들되 source별 observations와 metric을 보존한다.

경계 조각·스크롤 누락 경고와 사용자의 처리 결정을 유지한다. unseen 목록 전체를 캡처한 것처럼 선언하지 않는다. 충돌에서 사용자 선택한 source/value와 버린 대안을 evidence에 기록한다.

Final flow: **reviewed values → V2 mapping → six-field validation → duplicate/conflict → staged trade session**. 섬·fromItem·toItem은 확인된 nonempty text, reqAmount/yield는 positive safe integer, count는 nonnegative safe integer이며 **남은 교환 횟수**다. reqAmount는 교환1회 소모량, yield는 교환1회 획득량으로 재고와 다르다. 필수 unknown/unresolved mapping/conflict는 final DTO에 넣지 않는다. open-world fromItem 예외는 6절대로 허용한다. mapping 결과가 사용자가 확인한 identity와 다르면 재검토하고 조용히 바꾸지 않는다.

기존 V1 import는 호환 reference로 유지한다. 새 bridge는 validation 전 `processParsedTrades` defaults를 호출해 빈값을 채우지 않는다. Session adapter는 기존 scheduler가 기대하는 legacy tokens로 mapping하고 그 mapping 버전을 evidence에 남긴다. 새 회차/append 의사와 검수 시 session revision을 확인한다. 적용 직전 기존 상태가 달라지면 다시 비교하고 사용자에게 알린다.

목표 staging은 candidate snapshot을 만들고 revision/mutation receipt 확인 후 메모리와 화면에 반영하는 방식이다. 현행 일반 `saveWorkingSession()`이 이를 이미 제공한다고 주장하지 않는다. response loss 재시도는 같은 mutationId+동일 payload를 보존해야 하고, 기존 receipt 계약으로 해결 불가능하면 session task에서 별도 설계 gate로 보고한다. 테스트는 isolated DB/mock만 사용한다. 이번 문서로 main schema migration을 승인하지 않는다. scheduler/routing/정상 완료 계산은 재설계하지 않는다.

## 10. Readiness / 보호 invariant

Review-first **실제 사용 검증 진입**: COMPLETE 전 행·전 필드 표시/편집, 후보 prefill, 위험과 경계 경고, 명시적 완료, 확인된 값만 DTO 사용, evidence 저장/실패 안내, silent default 없음, 기존 session/browser output 연결. 이 gate는 자동 SAFE_ACCEPT 전 필드 달성을 요구하지 않는다. 실제 사용 검증 통과와 패키지 배포는 별도 후속 gate다.

Future unattended gate는 8절 지표와 [현재 승인 기준](ACCEPTANCE.md)의 독립 검증을 유지한다. 현재 HIGH=0/production=false를 문서만으로 해제하지 않는다.

반드시 보존: six-field 의미, count=남은 교환 횟수, unknown/default 구분, V1/manual/JSON fallback, scheduler/routing/완료 semantics, user DB migration 없음, main schema3, local/offline recognition, Gemini/OpenAI/remote OCR 없음, full screenshot 무제한 보관 금지, human label/prediction 구분. Warehouse tier1–4/56종·tier5 제외·inventory safety는 그대로이며 Trade 정책으로 다시 설계하지 않는다. capture frame과 fidelity 구분(clipboard 원본 source fidelity unknown), PNG lossless 의미, explicit capture/no game input도 유지한다.
