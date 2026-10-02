# ARCH-E1-DESIGN — 최종 결과 증거 v3 계약

상태: **ARCH_E1_V3_CONTRACT_READY — 설계 계약, 구현/마이그레이션 미실행**.
기준 committed HEAD: `63f64964c7405a6a0f55122af119876cbff9ce61`, branch `v2`.
이 문서는 ARCH-UNIFIED-02의 evidence/DTO/evaluation blocker를 해소하는 구현 authority다. 기존 구현이 이미 이 계약을 만족한다는 뜻은 아니다. 아래의 E1-A부터 별도 승인 범위로 구현한다. 이전 architecture의 E1a/b/c 분할과 ACTIVE_NEXT는 이 문서의 단계로 대체한다.

## 1. 현재 코드와 버전 축

| 축 | 현재 코드 | 목표 | 별개로 유지할 것 |
|---|---|---|---|
| Recognition sidecar SQLite | `recognition_store.py:SCHEMA_VERSION=2` | 3 | Main DB, Master store SQLite 1 |
| Trade review observation payload | 1 | 3 | recognition run/report 버전 |
| Trade review completion | 1 / REVIEW_FIRST | 3 / FINAL_CORRECTED_RESULT | confirmationRevision은 횟수 1, schema가 아님 |
| Trade review projection | null reconciliation=1, R007 reconciliation=2 | 3 | reconciliation ledger 버전 별도 |
| Trade review receipt / export | 각각 1 | 각각 3 | crop receipt와 truth-label 버전 별도 |
| Master Bundle | 2 / MASTER_CANONICAL_JSON_V2 | **2 유지** | evidence 3으로 이름 변경하지 않음 |
| Reviewed DTO validation result / staged session | 각각 1 | 각각 **1 유지** | v3 observation 입력 adapter / mapping policy만 추가 |

현재 `validate_trade_review_observation`은 observation 1 / completion 1 / projection 1·2 / Registry1만 받는다. `create_trade_review_observation`, `get_trade_review_observation`, `export_trade_review_observation`, `attach_trade_review_crop`은 기존 저장/해시 경로다. 기존 export의 `verificationMethod != USER_MARKED_UNKNOWN`에 따른 knownTruthEligible은 **legacy 의미**다. 새 accuracy에 이 값을 이식하지 않는다.

`reviewed-trade-dto.js:validateReviewedTradeBatch`가 v3 입력을 새 분기로 검증하되 기존 schemaVersion 1 validatedBatch 출력과 six-field `.dto`를 유지하면 `trade-session-staging.js:buildReviewedTradeSessionStage`와 Main DB schema 변경 없이 연결할 수 있다. old input의 검증과 hash basis는 그대로 둔다.

## 2. 의미 및 enum

| 축 / 허용 enum | 의미 | 독립 정답 eligible |
|---|---|---|
| operationalDecision: CANDIDATE_RETAINED | 보정 후 표시값을 수정 없이 유지 | no |
| operationalDecision: USER_EDITED | 운영 결과에 대한 사람의 실제 값 변경 | no |
| operationalDecision: USER_MARKED_UNKNOWN | 현재 값을 확정할 수 없음, finalValue=null | no |
| batchConfirmation.method: USER_FINAL_LIST_CONFIRMED | 이 revision의 최종 목록을 회차 적용 대상으로 확인 | no |
| truthEvidence: NONE | 별도 crop 정답 없음 | no |
| truthEvidence: HUMAN_CROP_VERIFIED | 명시 crop labeling으로 알려진 정답을 독립 기록 | **조건부 yes** |

마지막 yes에는 known non-null label, 정확한 bitmap/crop/field binding, label integrity, 미해결 label dispute 없음, cohort/split 검증이 모두 필요하다. 운영 enum에서 truthEvidence로 변환하는 코드 경로는 없다. USER_EDITED도 crop-label UI/endpoint를 자동 호출하지 않는다. legacy `HUMAN_VERIFIED` label이나 old unchanged는 자동 변환하지 않는다.

Projection row `classification`은 FINAL_READY / NEEDS_REVIEW / NEEDS_RECAPTURE / CONFLICT 네 값이다. primary 우선순위는 CONFLICT > NEEDS_RECAPTURE > NEEDS_REVIEW > FINAL_READY. 모든 사유는 classificationReasons에 보존한다.

- FINAL_READY: pinned correction/quality/identity/numeric 검증에서 운영상 완성된 후보. human truth/autoaccept가 아니다.
- NEEDS_REVIEW: identity/후보/검증의 미해결 위험. 명시 수정/operational acknowledgment가 필요한 상태.
- NEEDS_RECAPTURE: 필수 crop 소실·geometry 무효·clipping 등 원본 증거 부족. 값을 타이핑한 것만으로 해소되지 않는다.
- CONFLICT: overlap/reader/identity의 서로 다른 값이 아직 미해결. 어느 값도 조용히 고르지 않는다.

필수 UNKNOWN, missing numeric, 미해결 conflict, identity mapping 불가인 행은 DTO READY 금지. 저장은 가능하고 적용은 HOLD다. batch confirmation은 저장 가능한 업무 확인이며 저장/DTO 성공을 보장하지 않는다.

## 3. 공통 JSON/type/hash 규칙

아래 object는 명시된 키만 허용한다. `nullable`은 키 생략이 아니라 JSON null 허용이다. optional은 명시된 것만 생략 가능하다. 빈 배열도 필요한 키다. ID는 nonempty portable string(최대128자), mutation/observation/truth label ID는 canonical lowercase UUID. SHA는 lowercase 64 hex. revision은 safe integer >=0. 숫자 JSON bool을 int로 취급하지 않는다.

숫자는 `reqAmount,yield >=1`, `count >=0` 또는 null. count=0을 missing으로 처리하지 않는다. floating number, -0, NaN/Infinity, invalid surrogate, duplicate object key를 reject한다. original confidence는 decimal **string|null**로 보존한다. 이름/숫자 공백을 hash 계산 중 trim/Unicode normalize하지 않는다.

`C(x)` = Unicode code point 오름차순으로 object key를 정렬하고 array 순서는 유지하여 compact JSON으로 인코딩, UTF-8, ensure_ascii=false, LF/공백 변경 없음. escaping은 JSON.stringify와 동일한 JSON control-character escape, slash/비ASCII 임의 escape 금지. 이는 Master Bundle2 `compareOrdinal/canonicalStringify`의 serialization 규칙을 따른다. 이름 matcher normalization과는 별개다. `H(x)=SHA256(UTF8(C(x)))`. 아래 basis 문자열은 명세 이름이며 hash에 salt를 붙이지 않는다. 각 object의 hashBasis 키가 있으면 그 키도 해당 대상에 포함한다.

| hash | 대상 / 제외 |
|---|---|
| rawEvidenceHash / TRADE_RAW_EVIDENCE_JSON_V2 | sourceContext.rawEvidence.snapshot 전체, timestamp/latency는 snapshot 밖 audit에만 둠 |
| projectionHash / TRADE_FINAL_PROJECTION_JSON_V3 | FinalProjection3에서 projectionHash 키 **하나만 제외**. availability, 전체 source ledger, Master/correction binding, trace 모두 포함 |
| completionValuesHash / TRADE_COMPLETION_VALUES_JSON_V3 | Completion3에서 batchConfirmation 키 전체만 제외. reviewRevision, dispositions, 모든 final values 포함 |
| payloadHash / TRADE_REQUEST_JSON_V3 | POST Observation3 요청 전체. mutationId, createdAt, confirmedAt 포함 |
| observationHash / TRADE_OBSERVATION_JSON_V3 | 요청 전체 + observationId,persistedAt,hashBasis,payloadHash; observationHash 키만 제외 |
| Export3 semanticHash / TRADE_EXPORT_JSON_V3 | export.semantic 전체. generatedAt / semanticHash / 외부 export wrapper 제외 |
| truth label request / TRADE_CROP_TRUTH_REQUEST_JSON_V1 | 전체 label POST body, audit 시각 포함 |
| labelHash / TRADE_CROP_TRUTH_RECORD_JSON_V1 | server record에서 labelHash만 제외, audit 시각 포함 |

Projection에는 time/random/path/cwd를 넣지 않는다. Completion의 confirmedAt은 user event UTC RFC3339 string, 저장 persistAt은 server audit UTC다. confirmedAt이 semantic candidate hash를 바꾸지 않지만 **payload/observation hash는 바꾼다**. retry는 새 시각을 넣지 않고 동일 body를 재전송한다. 서버는 과거 receipt에서 persistedAt을 재사용한다. duplicate 플래그는 replay response에서만 true로 바꾸고 저장 record/hash를 다시 계산하거나 갱신하지 않는다.

Master `contentHash`는 기존 Bundle2처럼 schemaVersion/entities/compatibilityMappings/unresolvedLegacyNames/sourceRevisions/provenance/hashBasis를 hash한다. createdAt,registryVersion,contentHash를 제외한다. 기존 registry-v2:<contentHash> 규칙 유지. 기존 old PY_CANONICAL_JSON_V1 / JS_REGISTRY_SORTED_JSON_V1 알고리즘은 변경하지 않는다. PNG/bitmap raw-byte SHA에 텍스트/EOL normalization 금지.

## 4. 정확한 component 계약

### 4.1 MasterBinding2

필수 exact keys: `masterSchemaVersion=2, registryVersion, contentHash, hashBasis=MASTER_CANONICAL_JSON_V2`.
모든 Projection3/Completion3/receipt3/manifest의 binding은 deep equal이다. Observation3에는 sourceContext.masterBundle.snapshot으로 전체 immutable Bundle2를 함께 저장하고 contentHash를 검증한다. 최신 active Master를 server/DTO/evaluator가 대신 조회하지 않는다. 과거 Registry1 observation은 기존 snapshot을 그대로 읽는다.

### 4.2 Source, raw, crop

새 `RawEvidenceSnapshot2`는 현재 raw worker 출력에 대한 portable read adapter 결과다. OCR 의미나 reader를 변경하지 않는다. exact keys: `schemaVersion=2, recognitionBatchId, captures, sourceRows, edgeSegments`.

- Raw capture 정확한 키: `captureId,captureOrdinal,imageSha256,bitmapSha256,sourceType,frame,sourceFidelity,reencoded,completeRowCount`. frame exact `{width,height}` positive ints. sourceType FILE|CLIPBOARD|STREAM. sourceFidelity exact `{sourceWidth,sourceHeight,rescaled,evidence}` 현재 capture 의미 그대로; unknown은 null/null/null/unknown. decoded frame은 null 금지. reencoded bool. imageSha256은 제출 PNG bytes, bitmapSha256은 고정 RGB8 decoded pixels hash다.
- Raw source row 정확한 키: `sourceRowId,captureId,ordinal,rowBox,fields`. sourceRowId는 기존 R003 draftId 또는 captureId/ordinal fallback **그대로**; 새 자동 identity가 아님. ordinal >=0, capture마다 unique, 배열 순서는 captureOrdinal→ordinal. rowBox는 pixel Box|null. COMPLETE source는 모두 1회 존재.
- Raw field 정확한 키: `field,rawText,rawNumeric,readerStatus,confidence,cropRefs`. rawText string|null, rawNumeric safe integer|null(원시 parse만, 추측 없음), readerStatus nonempty current status token, confidence string|null. fields는 island/fromItem/reqAmount/toItem/count/yield 순서로 정확히6개.
- edge 정확한 키: `edgeId,captureId,ordinal,reason,rowBox,sourceRefs`. edge를 COMPLETE로 승격하지 않음. reason은 current nonempty token, sourceRefs는 SourceRef 배열.
- SourceRef 정확한 키: `{sourceRowId,captureId,ordinal}`. raw source ledger와 동일해야 하며 UNKNOWN ID 거부. edge refs는 edgeId를 sourceRowId 자리에 사용하고 COMPLETE accounting에서는 별도 처리.
- Box exact `{x,y,width,height}` nonnegative integer x/y, positive width/height. capture bounds 검증. normalized lane 좌표를 이 Box로 직접 쓸 수 없음.
- CropRef 정확한 키: `cropRefId,sourceRowId,captureId,field,bitmapSha256,frame,coordinateSpace=CAPTURE_BITMAP_PIXELS,box,pixelHashBasis=RGB8_ROW_MAJOR_V1,pixelSha256,pngArtifactSha256`. pngArtifactSha256 nullable. decoded RGB8 row-major bytes hash와 저장 PNG raw hash는 서로 다른 값이다. crop는 frame 안에 있고 source row/field에 결합. alpha는 deterministic RGB 변환 정책을 raw adapter version에 pin; 재인코딩 hash를 pixel hash라고 부르지 않음.

hash 또는 CropRef가 존재한다고 실제 pixels가 살아 있다고 간주하지 않는다. Projection3.pixelAvailability entries는 exact `{cropRefId,state}`, state IN_MEMORY|DURABLE|MISSING|EXPIRED|INVALID. positive state는 실제 decode/hash 검증으로만 생성한다. 배열은 raw cropRefs의 최초 등장 순서로 duplicate 없이 모두 포함. durable 검증 실패/Blob 소실은 새 projection/review revision을 요구하고 기존 confirmation을 stale 처리한다. 이미 저장·적용된 세션 reload는 기존 durable session 복원이며 새 적용 승인이 아니다.

capture 배열 순서가 authority이며 captureOrdinal은 현재 runtime처럼 index+1을 보존한다. sort하지 않고 순서 불일치를 거부한다. source row ordinal은 runtime의 원래 값을 유지한다(0 이상 정수, capture 내 unique). capture/source/edge ID는 서로 충돌하지 않아야 한다. Raw field.readerStatus/parse 실패 코드와 confidence string은 current adapter의 의미를 그대로 기록하고 보정 성공 코드로 바꾸지 않는다. 원본 PNG의 source hash와 decoded RGB hash는 같다고 가정하지 않는다.

RGB8_ROW_MAJOR_V1의 bytes는 top→bottom, left→right의 R,G,B unsigned8 순서다. palette/gray 이미지는 표준 PNG decode 후 RGB8로 확장한다. alpha가 있으면 관련 crop pixels가 모두255여야 하며 translucent pixel은 INVALID로 보류한다. 색 보정/리사이즈/배경 합성 없이 해시한다. browser ImageData와 Pillow RGB bytes가 동일해야 한다. PNG metadata의 profile/text를 pixel hash에 섞거나 외부 색변환 설정을 적용하지 않는다.

### 4.3 ReconciliationLedger2

FinalProjection3에는 null 대신 다음 **필수 ledger**를 넣는다. algorithm은 기존 R007 suffix/prefix/2-row/strong crop/duplicate-image 정책을 유지한다. ledger payload version 2는 evidence3 exact shape이며 기존 projection2의 reconciliation1을 rewrite하지 않는다.

필수 keys: `schemaVersion=2,policyVersion,captureOrder,sourceRows,groups,sourceToLogical,findings`.

- sourceRows: `{sourceRowId,captureId,ordinal,projectionSourceIndex}`; index는 RawEvidenceSnapshot2.sourceRows의 정확한 index.
- groups: `{groupId,status,memberSourceRowIds,representativeSourceRowId,logicalRowId,memberEvidence}`. status SINGLE|EXACT_OVERLAP|CONFLICT. members deterministic source order. memberEvidence는 SINGLE이면[], multi-source이면 모든 member의 `{sourceRowId,fields}`; fields는 4.4의 ProjectionField3에서 rawEvidenceRefs로 source를 제한한 source correction 결과6개. multi-source source trace를 잃지 않음.
- sourceToLogical: `{sourceRowId,logicalRowId}` source 배열 순서 그대로.
- finding: `{code,sourceRowIds,detail}`; detail string|null, 새로운 게임 사실을 포함하지 않음.

각 source가 정확히 한 group/map에 속하고 각 logical row가 정확히 한 group에 대응한다. representative는 earliest source, row.captureId/ordinal/rowBox는 representative이다. 각 capture.completeRowCount는 **sourceRows**에서 재계산; logical row나 sourceRefs.length로 세지 않는다. 6source→4logical→4completion 허용, source map5/7, A2/B4 spoof, 중복/unknownsource, group-map 불일치, representative 밖member는 거부.

sourceRefs는 member의 union, 첫 source 순서 유지/중복 제거. 같은 bitmap 반복은 source2/logical1일 수 있고 human 독립 정답 표본2가 아니다. 숫자 null/value, 0/1, 48/148 conflict는 null + alternatives + RECONCILIATION_CONFLICT, 자동 보간 없음. 다른 identity/unresolved 일반 overlap은 병합하지 않는다.

### 4.4 FinalProjection3

필수 keys: `schemaVersion=3,reviewMode=FINAL_CORRECTED_RESULT,recognitionBatchId,rawEvidenceHash,masterBinding,correctionVersion,reconciliation,pixelAvailability,rows,edgeWorkItems,hashBasis=TRADE_FINAL_PROJECTION_JSON_V3,projectionHash`.

row 정확한 키: `projectionRowId,captureId,ordinal,rowBox,sourceRefs,fields,classification,classificationReasons`. fields6개 순서는4.2와 동일.

ProjectionField3 정확한 키:
`field,rawEvidenceRefs,normalizedValue,candidates,selectedCandidateIndex,correctedValue,finalValue,identity,valueState,riskReasons,correctionReasons,alternatives,cropRefs,stageTrace`.

- rawEvidenceRefs: `{sourceRowId,field}` 배열. 항상 sourceContext.rawEvidence를 참조; raw evidence를 final 값으로 덮어쓰지 않는다.
- normalizedValue: name string / numeric integer / null. candidates: `{value,identity,reason}` 배열, reason nonempty rule token. selectedCandidateIndex: valid index|null.
- identity: null 또는 `{kind,stableId,legacyNameKey,authorityStatus}`. kind ITEM|ISLAND, stableId UUID|null, legacyNameKey string|null; authorityStatus OPEN_WORLD 또는 Master status. numeric은 identity=null. OPEN_WORLD는 fromItem만 허용, exact shown token 보존. legacy key는 stableId가 아님.
- correctedValue / finalValue: field에 맞는 string/int/null. Projection3.finalValue는 **human edit 전** fully corrected 최선의 후보. Completion3.finalValue와 구분한다. UI에서 Projection3.finalValue를 처음 보여준다.
- valueState RESOLVED|UNRESOLVED|CONFLICT|CLIPPED. CONFLICT finalValue=null, selectedCandidateIndex=null, alternatives에 모든 distinct source 값 포함.
- alternatives exact `{value,sourceRefs,riskReasons}`. null alternative도 보존. risk/correctionReasons는 deduplicated nonempty token 배열, 최초 등장 순서 유지.
- cropRefs: 해당 field RawEvidence CropRef ID 배열. source refs와 일관성 검증.
- stageTrace: `{stage,ruleVersion,inputValue,outputValue,reason}` 배열. stage 0..8 순서; 변경/abstention 근거 명시. 문자열 reason|null, ruleVersion nonempty. 임의 accuracy/truth 플래그 금지.

edgeWorkItem 정확한 키: `{workItemId,edgeId,classification=NEEDS_RECAPTURE,reason,sourceRefs}`. edgeId는 raw edge, COMPLETE/DTO로 자동 변환 금지.

Stage8 분류 검증은 다음 순서로 재현한다. 값 충돌/valueState=CONFLICT 또는 identity 충돌이면 CONFLICT. 필수 field crop가 없거나 availability가 positive가 아니거나 bounds/hash/clipping 오류면 NEEDS_RECAPTURE. 남은 numeric missing/invalid, identity unmatched/legacy-unverified/alias dispute, quality policy abstention은 NEEDS_REVIEW. 어느 조건도 없고 six values와 positive pixel evidence, pinned verified identity 또는 허용 OPEN_WORLD, pinned numeric policy 검증이 모두 유효할 때만 FINAL_READY. FINAL_READY에 risk/hard-failure를 숨겨 넣을 수 없다. NEEDS_REVIEW를 사용자가 확인해도 hard DTO hold가 사라지지 않는다. field마다 numeric policy의 decision/reason을 stageTrace에 기록하며 구체 confidence threshold는 O3/O4에서 사전 승인·pin한다. policy 미제공은 NUMERIC_POLICY_UNAVAILABLE로 abstain하며 기본 threshold를 발명하지 않는다.

### 4.5 Completion3

필수 keys: `schemaVersion=3,reviewMode=FINAL_CORRECTED_RESULT,recognitionBatchId,projectionHash,masterBinding,correctionVersion,reviewRevision,rows,workItems,batchConfirmation`.

row 정확한 키: `projectionRowId,sourceRefs,fields,disposition,dispositionReason`.
disposition INCLUDE|EXCLUDE|RECAPTURE_REQUIRED. EXCLUDE는 사용자 명시 행동, reason nonempty; 그 외 reason string|null. INCLUDE는 READY 보장 아님. EXCLUDE는 R008의 held-only explicit exclusion 검증을 그대로 거쳐야 한다. 성공률을 위해 READY row를 자동 제외하지 않는다.

field required keys: `field,shownValueBefore,finalValue,operationalDecision,riskReasons,cropRefs`.
optional key **하나**: `userEditReason` string|null. shownValueBefore / risks / cropRefs는 Projection3 field 값과 동일. RETAINED final=shown, shown null이면 null을 보존하고 DTO HOLD. EDITED final non-null, shown과 semantic unequal. UNKNOWN final=null. 동일값 입력은 EDITED로 꾸미지 않는다. string 비교는 운영 DTO의 명시 규칙 이전에는 exact다.

workItem 정확한 키: `{workItemId,decision,reason}`. decision RECAPTURE_REQUIRED|EXPLICITLY_EXCLUDED. 모든 projection.edgeWorkItems에 정확히1개, reason nonempty. edge를 조용히 무시하거나 COMPLETE로 만들지 않는다.

batchConfirmation 정확한 키: `{method=USER_FINAL_LIST_CONFIRMED,confirmedAt,projectionHash,reviewRevision,completionValuesHash}`. projectionHash/revision/bindings는 Completion3와 같다. completion.rows는 projection.rows와 ID/순서/갯수 동일. 일괄 확인은 생성 직전 전체값 snapshot에 결합하고 편집·Master재보정·crop상태·queue변경 후에는 취소한다. 필드별 확인 6N개를 요구하지 않는다.

NEEDS_REVIEW의 retained를 사용하려면 해당 risk를 UI가 보여주고 한 번의 최종 확인 대상으로 포함해야 한다. 이 확인도 정답 labeling이 아니며 unmapped/unknown/conflict 등의 hard hold는 해제하지 않는다. CONFIRMED 이후 화면의 editable object를 observation job이 공유하지 않도록 deep-clone/freeze한다.

### 4.6 Observation3, receipt, crop plan

POST request exact keys: `schemaVersion=3,reviewMode=FINAL_CORRECTED_RESULT,mutationId,createdAt,confirmationRevision=1,supersedesObservationId,projection,completion,sourceContext,cropPlan`.
projection은 FinalProjection3, completion은 Completion3. supersedesObservationId는 null 또는 같은 recognition batch의 **기존 v3** observation ID. old v1을 v3로 대체/수정하는 기능 아님. 이전 v3 record는 그대로 두고 새 UUID로 append한다. 생성시각은 client audit이며 truth가 아님.

sourceContext 정확한 키: `schemaVersion=3,authority=CLIENT_ATTESTED,rawEvidence,masterBundle,audit`.
rawEvidence exact `{hashBasis=TRADE_RAW_EVIDENCE_JSON_V2,rawEvidenceHash,snapshot}`.
masterBundle exact `{binding,snapshot}`. audit exact `{recognitionStartedAt,recognitionFinishedAt,latencyMs,gameVersion}` 모두 nullable; time string, latency integer>=0, version string. machine paths/secret/이미지base64 금지. CLIENT_ATTESTED를 server OCR 보증으로 격상하지 않는다. server는 shape/hash/count/binding/PNG를 검증하고 OCR 정답은 보증하지 않는다.

cropPlan exact `{schemaVersion=3,policy=C2_LOGICAL_REPRESENTATIVE_V3,entries}`.
entries는 모든 logical six-field에 하나씩 exact `{projectionRowId,field,cropRefId,selected,reasons,retentionClass}`. cropRefId는 representative source의 해당 field crop ID|null. reasons는 USER_EDITED|USER_MARKED_UNKNOWN|RISKY_FIELD 중 실제 해당 항목, 순서 enum 순서. 하나라도 해당하면 selected=true; cropRef 없으면 selected=false, reasons 보존하고 DTO pixel gate HOLD. null crop일 때 retentionClass=NONE, 그 외 unknown은 UNKNOWN_EVIDENCE, 다른 selected는 OPERATIONAL_REVIEW_EVIDENCE, unselected는 NONE. 서버가 plan을 재계산해 비교한다. 대표 source에 field crop가 여러 개면 첫 raw cropRefs 순서의 유효 crop를 사용하며 나머지 lineage는 유지한다.

crop storage는 logical field당 대표 crop 하나. conflict UI는 메모리에서 각 source를 병렬 비교하고 multi-source geometry는 projection/raw/ledger에 보존한다. HUMAN_TRUTH_EVIDENCE crop는 독립 truth-label 저장 경로에서 별도 부착 가능; operational C2에 여러 source durablecrop를 밀어넣지 않는다.

persisted Observation3는 request exact keys + `observationId,persistedAt,hashBasis=TRADE_OBSERVATION_JSON_V3,payloadHash,observationHash`이다.
Receipt3 exact keys: `schemaVersion=3,observationId,mutationId,payloadHash,observationHash,persistedAt,duplicate,evidenceSaved=true,sessionApplied=false,reviewMode=FINAL_CORRECTED_RESULT,projectionHash,masterBinding,reviewRevision,cropPolicy=C2_LOGICAL_REPRESENTATIVE_V3`.
evidenceSaved는 immutable observation commit 성공, **모든 crop 업로드 성공이 아니다**. crop receipt 별도. sessionApplied는 recognition API에서 항상 false; actual session apply는 기존 Main/session receipt다.

## 5. Additive SQLite sidecar 3 DDL

기존 11개 table과 old constraints/row/payload/receipt/hash를 그대로 둔다. 기존 v1 CHECK를 바꾸거나 row를 rewrite하지 않는다. 아래 5개 table을 추가한다. SQLite foreign_keys=ON, 기존 busy timeout/WAL 정책 유지. TEXT hashes는 SQL length + 애플리케이션 lowercase hex 검증 둘 다 수행. UUID/JSON/cross-row consistency는 validator에서 검증한다. PK text는 명시 NOT NULL. `json_valid` extension을 신규 의존성으로 요구하지 않는다.

```sql
CREATE TABLE trade_review_observation_v3 (
 observation_id TEXT NOT NULL PRIMARY KEY,
 mutation_id TEXT NOT NULL UNIQUE,
 schema_version INTEGER NOT NULL CHECK(schema_version=3),
 review_mode TEXT NOT NULL CHECK(review_mode='FINAL_CORRECTED_RESULT'),
 recognition_batch_id TEXT NOT NULL,
 projection_hash TEXT NOT NULL CHECK(length(projection_hash)=64),
 master_schema_version INTEGER NOT NULL CHECK(master_schema_version=2),
 registry_version TEXT NOT NULL,
 master_content_hash TEXT NOT NULL CHECK(length(master_content_hash)=64),
 correction_version TEXT NOT NULL,
 review_revision INTEGER NOT NULL CHECK(review_revision>=0),
 confirmation_revision INTEGER NOT NULL CHECK(confirmation_revision=1),
 supersedes_observation_id TEXT REFERENCES trade_review_observation_v3(observation_id),
 created_at TEXT NOT NULL, persisted_at TEXT NOT NULL,
 hash_basis TEXT NOT NULL CHECK(hash_basis='TRADE_OBSERVATION_JSON_V3'),
 payload_json TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 observation_hash TEXT NOT NULL CHECK(length(observation_hash)=64),
 receipt_json TEXT NOT NULL,
 CHECK(supersedes_observation_id IS NULL OR supersedes_observation_id<>observation_id)
);
CREATE INDEX trade_review_observation_v3_batch
 ON trade_review_observation_v3(recognition_batch_id,persisted_at);
CREATE TABLE trade_review_artifact_v3 (
 observation_id TEXT NOT NULL REFERENCES trade_review_observation_v3(observation_id),
 projection_row_id TEXT NOT NULL,
 field_name TEXT NOT NULL CHECK(field_name IN ('island','fromItem','reqAmount','toItem','count','yield')),
 crop_ref_id TEXT NOT NULL,
 artifact_hash TEXT NOT NULL REFERENCES recognition_artifact(artifact_hash),
 pixel_sha256 TEXT NOT NULL CHECK(length(pixel_sha256)=64),
 byte_size INTEGER NOT NULL CHECK(byte_size>0),
 width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1024),
 height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 256),
 operational_decision TEXT NOT NULL CHECK(operational_decision IN
 ('CANDIDATE_RETAINED','USER_EDITED','USER_MARKED_UNKNOWN')),
 retention_class TEXT NOT NULL CHECK(retention_class IN
 ('OPERATIONAL_REVIEW_EVIDENCE','UNKNOWN_EVIDENCE')),
 state TEXT NOT NULL CHECK(state IN ('AVAILABLE','EXPIRED','MISSING')),
 attached_at TEXT NOT NULL, expired_at TEXT,
 PRIMARY KEY(observation_id,projection_row_id,field_name),
 CHECK(width*height<=262144),
 CHECK((operational_decision='USER_MARKED_UNKNOWN' AND retention_class='UNKNOWN_EVIDENCE') OR
 (operational_decision<>'USER_MARKED_UNKNOWN' AND retention_class='OPERATIONAL_REVIEW_EVIDENCE'))
);
CREATE INDEX trade_review_artifact_v3_hash ON trade_review_artifact_v3(artifact_hash,state);
CREATE TABLE trade_review_crop_receipt_v3 (
 crop_mutation_id TEXT NOT NULL PRIMARY KEY,
 observation_id TEXT NOT NULL REFERENCES trade_review_observation_v3(observation_id),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE trade_crop_truth_label_v3 (
 label_id TEXT NOT NULL PRIMARY KEY,
 observation_id TEXT NOT NULL REFERENCES trade_review_observation_v3(observation_id),
 source_row_id TEXT NOT NULL, field_name TEXT NOT NULL CHECK(field_name IN
 ('island','fromItem','reqAmount','toItem','count','yield')),
 crop_ref_id TEXT NOT NULL,
 label_revision INTEGER NOT NULL CHECK(label_revision>=1),
 supersedes_label_id TEXT REFERENCES trade_crop_truth_label_v3(label_id),
 truth_evidence TEXT NOT NULL CHECK(truth_evidence='HUMAN_CROP_VERIFIED'),
 label_status TEXT NOT NULL CHECK(label_status IN ('KNOWN','UNKNOWN','DISPUTED')),
 value_json TEXT NOT NULL,
 artifact_hash TEXT NOT NULL REFERENCES recognition_artifact(artifact_hash),
 pixel_sha256 TEXT NOT NULL CHECK(length(pixel_sha256)=64),
 provenance_json TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 created_at TEXT NOT NULL, persisted_at TEXT NOT NULL,
 label_hash TEXT NOT NULL CHECK(length(label_hash)=64),
 UNIQUE(observation_id,source_row_id,field_name,crop_ref_id,label_revision),
 CHECK(supersedes_label_id IS NULL OR supersedes_label_id<>label_id),
 CHECK((label_status='KNOWN' AND value_json<>'null') OR
       (label_status<>'KNOWN' AND value_json='null'))
);
CREATE INDEX trade_crop_truth_label_v3_subject
 ON trade_crop_truth_label_v3(pixel_sha256,field_name,label_revision);
CREATE INDEX trade_crop_truth_label_v3_artifact ON trade_crop_truth_label_v3(artifact_hash);
CREATE TABLE trade_crop_truth_receipt_v3 (
 mutation_id TEXT NOT NULL PRIMARY KEY,
 label_id TEXT NOT NULL REFERENCES trade_crop_truth_label_v3(label_id),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER trade_review_observation_v3_no_update
 BEFORE UPDATE ON trade_review_observation_v3 BEGIN SELECT RAISE(ABORT,'immutable observation'); END;
CREATE TRIGGER trade_review_observation_v3_no_delete
 BEFORE DELETE ON trade_review_observation_v3 BEGIN SELECT RAISE(ABORT,'immutable observation'); END;
CREATE TRIGGER trade_crop_truth_label_v3_no_update
 BEFORE UPDATE ON trade_crop_truth_label_v3 BEGIN SELECT RAISE(ABORT,'immutable truth label'); END;
CREATE TRIGGER trade_crop_truth_label_v3_no_delete
 BEFORE DELETE ON trade_crop_truth_label_v3 BEGIN SELECT RAISE(ABORT,'immutable truth label'); END;
```


새 observation은 기존 review table/recognition_run과 FK로 연결하지 않는다. immutable source snapshot이 authority이며 기존 run 재저장을 요구하지 않는다. 새 artifact/truth의 FK는 shared recognition_artifact와 새 observation만 참조한다. receipt는 append-only이고 API에 수정/삭제 기능이 없다. artifact link에서 변경 가능한 것은 state/expired_at뿐이다. digest/decision/binding은 불변이며 GET 시 plan/PNG/hash를 대조한다.

### 5.1 보존 등급 / budget / 파일 재사용

- OPERATIONAL_REVIEW_EVIDENCE: 운영 증거. 보호하지만 verified truth라고 부르지 않는다. 자동30일 삭제 대상이 아니다.
- HUMAN_TRUTH_EVIDENCE: 새 truth table이 참조하는 crop. 자동삭제 대상이 아니다. UNKNOWN/DISPUTED labeling 이력도 보호한다.
- UNKNOWN_EVIDENCE: 운영 검수의 unknown crop. 명시 cleanup 실행 시 attached_at부터30일이 지나면 EXPIRED 처리할 수 있다.
- NONE: 미선택/미첨부. GET/export의 NOT_UPLOADED와 파일 소실 MISSING을 구분한다.

기존 설정 budget(default200 MiB)과 크기 제한을 유지한다. budget 초과는507이며 옛 증거나 정답을 자동 퇴출하지 않는다. cleanup_unlabelled_artifacts에 새 operational/truth 참조 보호를 추가하기 전에는 새 데이터에 cleanup을 실행하지 않는다. 공유 PNG는 old protected/new operational/new truth/만료 전 unknown/run-label 중 한 참조라도 살아 있으면 삭제 금지다. 동일 digest는 raw SHA 검증 후 CAS 파일 재사용, old PNG 복사 불필요. 기존 registry의 bytes/path를 덮어쓰지 않는다. rollback 후 미연결 CAS 파일도 budget에 산입하고 별도 명시 cleanup에서 처리한다.

### 5.2 sidecar SQLite 2→3 migration

1. version>3, unknown/malformed/collision schema를 거부한다. fresh는 기존11 tables+신규5 tables를 sidecar3으로 생성. v1은 기존1→2 후2→3, 이미3이면 전체 schema 검증 후 멱등 return.
2. 현재 version2 schema SQL/old tables/rows/blob값과 artifact registry/path/raw-byte SHA manifest를 읽는다. logical digest는 sqlite_master(type,name,sql) 정렬 + 각 table의 모든 row를 타입별 canonical value로 표현하고 정렬한 결과의 SHA다. BLOB은 hex 타입 태그, NULL/int/text를 구분하며 SELECT의 자연 순서에 의존하지 않는다.
3. `<database>.v2-backup`을 SQLite backup API로 같은 directory의 임시 파일에 생성, version2/full digest 일치 검증, fsync/atomic publish. 기존 backup이 현재 source digest와 같으면 재사용. 다른/stale/corrupt backup은 덮어쓰거나 삭제하지 않고 migration 실패. 임의 세대명 변경으로 우회하지 않는다. 기존 .v1-backup은 그대로 둔다.
4. source digest 재확인 → BEGIN IMMEDIATE → schema version/digest 재확인. 대기 중 source가 바뀌면 rollback/보고. 다른 initializer가3으로 완료했으면 완성 schema 확인 후 return, DDL 중복 실행 금지.
5. 신규 table/index/trigger를 개별 execute한다. executescript의 implicit commit에 의존하지 않는다. meta의 schema_version만2→3, update rowcount=1 검증. meta의 다른 값/old SQL/rows/artifact manifest가 그대로인지 확인 후 commit.
6. backup/DDL/meta/commit 실패 시 rollback, partial tables/meta3 잔류0. backup은 보존. live DB를 backup으로 자동 교체하지 않는다. 재실행 전 정확한 실패를 보고한다.

허용된 차이는 recognition_meta.schema_version과 신규 schema object뿐이다. old payload/receipt/observationHash/payloadHash/PNG bytes는 차이0. SQLite page 배치는 바뀔 수 있으므로 DB 전체 physical raw hash 동일성을 요구하지 않는다. old semantic export와 semanticHash는 동일, generatedAt만 실행 시각 차이를 허용한다. old export manifest.sidecarSchemaVersion=2도 그대로 유지하며 실제 DBversion3으로 고치지 않는다.

## 6. API / store version dispatch

기존 prefix `/api/recognition/trade-review-observations` 유지.

| API | dispatch / 검증 |
|---|---|
| POST base | observation1+REVIEW_FIRST는 old validator/store, observation3+FINAL_CORRECTED_RESULT는 new validator/store. 다른/누락/mixed version은422 |
| GET `/<id>` | 두 table 조회 후 실제 record version으로 dispatch. optional `?schemaVersion=1\|3` 불일치는404. 양쪽 동일ID 충돌은500 integrity error |
| GET `/<id>/export` | 같은 dispatch. Export1 불변 / Export3 분리. 최신 Master나 truth로 old record 재해석 금지 |
| POST `/<id>/crops` | observation version별 metadata/receipt dispatch. old shape 유지 |
| GET `/<id>/export/crops/<sha>` | 해당 observation의 old/new/truth 참조 hash만 허용. available200 / expired410 / missing404 / hash오류500, no-store |
| POST `/<id>/truth-labels` 신규 | 명시 crop labeling 전용. 운영 review는 호출하지 않음. label payload schemaVersion1 / observation3 검증 |
| GET `/<id>/truth-labels` 신규 | immutable label 이력/receipt integrity. old observation은404, legacy label 변환 없음 |

old observation1 **write도 호환용 유지**. 새 FINAL_CORRECTED_RESULT를 old write로 낮추지 않는다. old read-only 전환은 별도 지시 전까지 하지 않는다. 기존 Origin/localhost auth/CSRF/body 제한/security를 공통 적용하고 unsupported version을 유사 버전으로 변환하지 않는다.

BEGIN IMMEDIATE 안에서 mutationId를 old/new observation tables 모두 조회한다. same version+same canonical body만 기존 receipt replay(200, duplicate=true); 다른 body/version은409. observation UUID도 양쪽 table 충돌 검사. crop mutationId는 old/new crop receipt 양쪽 확인해 version간 재사용409. truth mutation은 별도 endpoint namespace에서 same body replay. new201/replay200, shape/hash422, binding stale409, 크기413, budget507, storage500.

v3 crop multipart metadata exact `{schemaVersion:3,cropMutationId,projectionRowId,field,cropRefId,sha256,pixelSha256,width,height}` + image PNG. requestHash 대상은 `{observationId,metadata,pngSha256}`. receipt exact `{schemaVersion:3,cropMutationId,observationId,projectionRowId,field,cropRefId,sha256,pixelSha256,persistedAt,duplicate}`. retry는 같은 PNG/metadata, response loss/doubleclick 후 링크1개. real Pillow decode/geometry/dimensions/pixel SHA/raw-byte SHA/metadata restrictions/singleframe을 모두 검증한다.

기존 제한 유지: canonical observation8 MiB, captures100/COMPLETE1000/edge200, capture20 MiB/32,000,000pixels, crop512 KiB/1024×256/262144pixels. truth JSON 최대64 KiB. multi-source trace가8MiB를 초과하면413, 증거를 버려 통과시키지 않는다. capacity 확장은 별도Task.

### 6.1 독립 truth storage (확정)

**신규 trade_crop_truth_label_v3 / trade_crop_truth_receipt_v3** 사용. 기존 recognition_label은 recognition_run/unit의 user_correction/HUMAN_VERIFIED/DISPUTED이며 새 review crop/binding이 없다. 재사용하면 운영 수정이 independent truth에 섞인다. 기존 label 변경/이동/자동승격0.

Truth POST required exact keys:
`schemaVersion=1,mutationId,sourceRowId,field,cropRefId,labelRevision,supersedesLabelId,labelStatus,value,provenance,createdAt`.
optional key: `artifact`(아래 조건에 따라 필수).
provenance exact `{method=HUMAN_CROP_VERIFIED,labelerRole=PRODUCT_OWNER,sourceFamilyId,cohort,splitManifestHash,sourceOrigin,independentOfOperationalReview,note}`.
cohort DEVELOPMENT|INDEPENDENT, sourceOrigin FRESH_CAPTURE|ARCHIVED_CAPTURE, independentOfOperationalReview bool, note string|null. INDEPENDENT accuracy에는 fresh source + true + 사전 freeze splitManifest binding이 필요. 개발 source는 DEVELOPMENT. crop labeling 화면은 crop로 시작하고 candidate/Master/final을 자동 prefill하지 않는다. KNOWN은 type-valid non-null, UNKNOWN/DISPUTED는 null.

labelRevision은 `(obs,sourceRowId,field,cropRefId)` subject의 직전+1, 첫1/supersedesnull. 후속은 직전 label을 supersede, 별 subject/self/cycle 불가. race는409, same mutation replay는 같은 receipt. endpoint는 multipart `metadata`(위 JSON) + optional image PNG; artifact가 이미 있으면 image 생략 가능. CropRef.pngArtifactSha256이 있으면 그 hash를 사용한다. null이면 request.artifact `{sha256,pixelSha256,width,height}` 필수. 둘 다 있으면 hash 일치. 새파일은 PNG decode와 CropRef pixel/geometry 일치 후 shared artifact에 등록한다. observation/cropPlan을 수정하지 않는다.

label record = request + labelId,observationId,persistedAt,artifact,truthEvidence=HUMAN_CROP_VERIFIED,labelHash. artifact는 server가 확정한 위4keys로 항상 존재. request에 artifact가 없던 경우도 record에 추가; requestHash는 실제 request, labelHash는 확정 record에서 labelHash 제외. receipt exact `{schemaVersion:1,labelId,mutationId,observationId,labelHash,persistedAt,duplicate}`.

truth table.payload_json/payload_hash에는 실제 request를 그대로 canonical 저장한다. GET은 이 request와 indexed server columns/확정 artifact를 결합해 label record/hash를 재현한다. omitted optional artifact를 나중에 request에 삽입해 payloadHash를 바꾸지 않는다. provenance_json/value_json/labelRevision/supersedes 및 request의 동일성도 조회 시 대조한다. label receipt의 request_hash는 payload_hash와 동일하다.

동일 물리crop `(bitmapSha256,box,pixelSha256,field)`의 유효 latest KNOWN label이 서로 다르면 derived DISPUTED, accuracy 제외/coverage 보고. 다른 label의 값을 덮어쓰지 않는다. 모든 충돌 subject의 latest KNOWN이 명시 재label 후 일치할 때만 해소된다. 집계기가 한 표를 고르지 않는다. truth 추가는 observation 변경 없이 export가 선택한 label IDs/hashes에 pin한다.

## 7. Export3 / 세 층 evaluation

Export3 exact top `{schemaVersion:3,exportType:TRADE_FINAL_REVIEW_OBSERVATION,generatedAt,hashBasis:TRADE_EXPORT_JSON_V3,semanticHash,semantic}`.
semantic exact `{manifest,observation,cropEvidence,truthLabels,dataset}`.
manifest exact `{observationSchemaVersion:3,sidecarSchemaVersion:3,projectionSchemaVersion:3,completionSchemaVersion:3,masterBinding,projectionHash,payloadHash,observationHash,truthLabelBindings,evaluationPolicyVersion}`. truthLabelBindings `{labelId,labelHash}` 배열은 labelId 정렬. evaluationPolicyVersion=`trade-final-review-evaluation-v3`.
cropEvidence exact `{projectionRowId,field,cropRefId,artifactSha256,pixelSha256,state,retentionClass}`. hashes nullable, state AVAILABLE|NOT_UPLOADED|MISSING|EXPIRED, 등급은5.1. truthLabels는 integrity 확인된 전체 record 배열, 없으면[]. dataset exact `{recognitionBatchId,rows,sourceFields,edgeWorkItems}`.

dataset row exact `{projectionRowId,classification,disposition,sourceRefs,fields}`.
dataset field exact `{field,operationalDecision,truthEvidence,knownTruthEligible,truthValue,truthLabelIds,rawEvidence,normalizedValue,correctedValue,shownValueBefore,finalValue,riskReasons,correctionReasons,masterBinding,sourceRefs,cropRefs}`.
rawEvidence: `{sourceRowId,rawText,rawNumeric,readerStatus,confidence}` 배열. cropRefs는 완전한 CropRef 배열.
sourceFields exact `{sourceRowId,field,rawEvidence,normalizedValue,correctedValue,truthEvidence,knownTruthEligible,truthValue,truthLabelIds,cropRefs}`. rawEvidence는 위 rawrecord1개. source6S를 모두 열거하며 merge 때문에 raw 결과를 버리지 않는다.

적격 KNOWN label이면 truthEvidence=HUMAN_CROP_VERIFIED, 아니면 NONE/truthValue=null. knownTruthEligible은 server/evaluator의 재계산값, client claim 불가. logical field는 member별 distinct physicalcrop가 모두KNOWN/동일truth일 때 eligible. duplicate image의 같은 crop는1건으로 충분. 다른 source의 label로 미label member를 채우지 않는다. disputed/unknown/integritymissing은false. label 없이 operational export 가능, accuracy=N/A.

| 분모 | 정의 |
|---|---|
| S / R / F | source COMPLETE / 전체logical rows / 6R |
| V / T | logical independent-known fields / 전6field independent-known rows |
| K | eligible source physicalcrop수. bitmap+box+pixel+field가 같으면1회. 동일crop의 여러 raw 출력이 다르면 전체 attempts를 보존하고 all-exact로 채점, 좋은 출력만 대표로 고르지 않음 |
| B | batch-confirmed operational slots=F, V에 더하지 않음 |
| E | edgeWorkItems수, COMPLETE와 별도 |

### 7.1 metric 정의

- RAW_TEXT_EXACT: rawText exact일치 / eligible name K. trim/유사일치 금지.
- RAW_NUMERIC_EXACT: pinned raw parse가 integer label과 일치 / eligible numeric K. rawempty도 분모 유지.
- RAW_EMPTY_RATE: missing/null/empty raw / 전체 source6S. knownK 비율도 별도.
- RAW_WRONG_CONFIDENT_RATE: rawwrong+사전freeze calibrated threshold 이상 / calibrated confident eligibleK. calibration 없으면N/A, 임의 confidence threshold 금지.
- CORRECTION_RECOVERY: rawwrong→pre-human correctedcorrect / rawwrong eligibleK. CORRECTION_HARM: rawcorrect→correctedwrong/null / rawcorrect eligibleK. source member trace를 사용하고 post-edit를 candidate로 채점하지 않음.
- MASTER_UNRESOLVED: unresolved identity slots / 3R. OPEN_WORLD는 허용resolved로 별도내역. DISPUTED/DEPRECATED/alias미해결 포함.
- NUMERIC_RESOLUTION_FAILURE: final numeric null/invalid/clipped/conflict / 3R. rawfailure는3S 분모로 별도.
- FINAL_FIELD_ACCURACY: human edit 전 Projection3.finalValue exact / V, six-field exact는 전6exact / T. Completion.finalValue vs label은 POST_REVIEW_OPERATIONAL_EXACT로 별도, USER_EDITED 자체를label로 사용하지 않음.
- FINAL_ROW_READY_RATE / NEEDS_REVIEW_RATE / NEEDS_RECAPTURE_RATE / CONFLICT_RATE: 각 primary classification rows / R. unknown/exclusion/held를 분모에서 빼지 않음.
- USER_EDIT_RATE_AFTER_FULL_CORRECTION: USER_EDITED수 / F, 수정행 / R, field별edit/unknown 병기. Completion3 운영 증거만으로 계산 가능.
- UNHIGHLIGHTED_ERROR_RATE: risk0 labelwrong 후보 / risk0 eligibleV, coverage/bias 명시. UNHIGHLIGHTED_EDIT_COUNT는 risk0 USER_EDITED수로 truth accuracy와 별도.
- DTO success: readyoutput/R 및 readyoutput/(R-explicitexclusions) 둘 다. 독립truth 정확도라 부르지 않음. sessiondurable 결과 별도.

분모0은 `{numerator:n,denominator:0,rate:null,status:"N/A"}`. 분모>0은 fraction 기반 decimal string(소수6자리half-up)과 numerator/denominator를 출력. independent/operational coverage와 cohort를 병기한다. old Export1/evaluation1은 별dispatch/별report, legacyknown을 v3accuracy에 합치지 않는다. export/audit hash와 candidate semantic 비교를 구분한다.

## 8. DTO / session acceptance

v3 branch는 다음을 모두 검증하고 기존 schemaVersion1 validatedBatch를 반환한다.

1. receipt3 evidenceSaved=true/sessionApplied=false, server record/hash/index 일치.
2. expectedReview의 batch/projectionHash/reviewRevision/Master/correctionVersion 일치, USER_FINAL_LIST_CONFIRMED와 completionValuesHash 일치. cropavailability가 변하면 STALE_REVIEW로 새projection/revision 요구.
3. RETAINED는 operational final로 사용 가능. UNKNOWN/미해결conflict/recapture/missingnumeric/invalidkind는held. EDITED도 type/identity/quality gate를 우회하지 못함.
4. pinned Bundle2 exact stable/compatibility/legacy mapping, fromItem OPEN_WORLD 기존 예외를 사용. 마지막 fuzzy 재보정 금지. DISPUTED/DEPRECATED는 automatic authority 불가. legacy-only는 기존R008 명시exact compatibility 조건, reference를 무조건verified로 취급하지 않음.
5. duplicate/conflict/exclusion held-only와 이유 검증은 기존R008대로. allheld/전부제외/empty READY 금지.

mappingPolicyVersion=`reviewed-trade-dto-mapping-v3`.
output.observationRef는 `{schemaVersion:3,observationId,observationHash,projectionHash,reviewRevision,completionValuesHash,masterBinding}`을 pin. 다른 기존 validatedBatch keys/semanticHash API 유지, 이 출력버전1을 evidence3과 혼동하지 않음. R009 NEW/APPEND stage는 schema1 `.dto` six values를 그대로 받는다. DB-first CAS/idempotency→durable commit/readback→localapply→reload 변경 없음. Main/session schema/table/저장순서 변경 불필요. receipt3을 session receipt로 위장하지 않는다.

v3 expectedReview의 필수 keys는 `schemaVersion=3,recognitionBatchId,projectionHash,reviewRevision,masterBinding,correctionVersion,completionValuesHash,pixelAvailability`다. pixelAvailability는 실제 현재 decoder/cache가 재검증한4.2 entries를 전달하며 frozen projection 값과 일치해야 한다. 이것은 server 영구 truth가 아닌 새 적용 직전 client source 상태 검증이다. old expectedReview 입력 계약은 그대로 유지한다.

## 9. VERIFIED_REFERENCE — Master Bundle2 호환 확장

entity.status/name.status에 VERIFIED_REFERENCE 추가. 현재 JS/Python validator는 reject하므로 **M4-R에서 둘 다 갱신한 후 발행**. shape/hashbasis/stableId/immutable history 그대로, Master schema3 불필요. status 의미 추가이며 oldbytes/oldcontentHash 재작성0.

우선순위 VERIFIED_CURATED > VERIFIED_REFERENCE > LEGACY_UNVERIFIED는 같은stable entity/property에서만 적용. 이름이 비슷한 별stableId를 merge하지 않는다. aliases/displayNames도 개별status 확인, entityverified로 전체alias를 승격하지 않음. owner DISPUTED는 reference로 자동fallback 금지, DEPRECATED는 현재정답 자동선택 금지, replacement는 명시relation검증만.

reference entity/name.provenance 필수 추가(JSON provenance 기존 슬롯 사용):
`authority:VERIFIED_REFERENCE, referenceEvidence:[{sourceKind,sourceUrl,checkedAt,externalId,verifiedProperties}], referenceDecision:MATCHED`.
sourceKind BDO_OFFICIAL_KR|BDOCODEX_KR, sourceUrl https 공식KR 또는 bdocodex.com/kr/ 실제 확인page, checkedAt UTC RFC3339, externalId string|null, verifiedProperties nonempty subset canonicalName|displayName|tier|category|identity. 근거별 검증 범위를 보존하고 이름일치로tier/alias/identity를 발명하지 않음. snippet/CAPTCHA만으로 verified 불가. 한국어 원문을 기록한 감사artifact SHA를 bundle.provenance.referenceAuditHash에pin.

CURATED는 owner explicitapproval/provenance/publish receipt 필수, reference를owner확인으로 위장하지 않는다. ID는 승인된curation 발행권한으로 UUID를1회 발급해 고정, name/index/hash 파생 금지. reference mapping도 owner-approved publish를 거치지만 값authority 출처는REFERENCE 유지. 241occurrences/230grouping/legacytier/category/locator를 그대로 둔다. 외부tier와legacytier가 다르면 현재Bundle2 제약에 맞춰 해당mapping을 unresolved/DISPUTED로 보류, legacytier를 고쳐 우회하지 않는다. enum추가를 넘는 tier-contract 변경은 별decision 필요.

SOURCE_CONFLICT는 unresolved record(reason=NO_CURATED_IDENTITY) 유지 + bundle.provenance.referenceFindings의 `{legacyNameKey,status:SOURCE_CONFLICT,evidenceRefs}`로 설명. 이미 identity가 별도확인된 경우 entity/name DISPUTED 가능. 고급 묵양함 계열의 한쪽을 임의채택하지 않는다.

단일immutable bundle snapshot을 저장한다. 별owner/reference store의 silent runtime overlay 금지. M4-R은 activeversion base CAS로 기존ID/curated값/mapping을 보존하고 미검증부분을reference로 채운 새version을 제안. 동일identity 근거없으면 미해결유지. backend는 client의status/URL만 믿지 않고 승인된referenceAuditHash/mappingmanifest exact차분을 검증한다. manifest 파일scope는 아래명시.

조사보존: 원작 일반118/특수9/위치100, 전체조합표 없음, 확인48/충돌1/미조사181. MASTER-REFERENCE-AUDIT.md는 partial evidence이며 완성Master가 아니다. 이Task에서181조회 재개0.

## 10. Luna High 구현 Task 분할

모든path는 `_dev/local_app/` 기준. 각Task의 새지시에서 base/scope/environment를 재확인한다. 아래는 구현에 필요한 파일/금지/검증/완료조건의 계약이며 이번Task의 변경목록이 아니다. NEW는 아직 없을 수 있는 신규파일. scope확대 금지, 모순 STOP/report, 실제DB 대신tempDB. tests는 미래gate, 이번 실행결과 아님.

예외: M4-R의 MASTER-REFERENCE-AUDIT.md는 `_dev/specs/008-capture-recognition-v2/MASTER-REFERENCE-AUDIT.md`다. 구현 완료 보고 문서의 임의 추가는 허용하지 않는다.

새 backend 분기는 `validate_trade_final_review_observation(payload)`, `create_trade_final_review_observation(payload)`, `get_trade_final_review_observation(observation_id)`, `export_trade_final_review_observation(observation_id)`로 명명한다. 기존 v1 함수는 그대로 유지하고 API가 version dispatch를 소유한다. crop/truth는 각각 `attach_trade_final_review_crop`, `create_trade_crop_truth_label`, `get_trade_crop_truth_labels`를 새 분기로 둔다. 이 함수들은 기존 canonical helper를 v1 호출에서 교체하지 않는다.

E1-B 신규 domain module의 public exports는 다음3개로 제한한다.

- `buildFinalProjection3({recognitionBatchId,rawEvidenceHash,masterBinding,correctionVersion,reconciliation,pixelAvailability,rows,edgeWorkItems})`: 이미 correction/classification된 exact component를 검증/clone/freeze하고 projectionHash 부여. OCR/correction을 여기서 수행하지 않는다.
- `buildFinalReviewCompletion({projection,reviewRevision,rows,workItems,confirmedAt})`:4.5의 exact rows/workItems를 검증하고 batchConfirmation/hash 부여. current UI state를 caller가 배열로 투영하되 decision derivation(equal→retained, unequal non-null→edited, explicitunknown→unknown)은 이 함수에서도 검증한다.
- `buildFinalReviewObservationRequest({projection,completion,sourceContext,mutationId,createdAt,supersedesObservationId=null})`:4.6의 request+재계산 cropPlan 생성. 저장/fetch/random/time/DOM 없이 pure. timestamp/UUID는 explicit action caller가 한 번 만들고 retry에 재사용한다.

E1-D는 기존 `evaluateTradeReviewDataset`의 evaluationPolicyVersion으로 legacy/new dispatch하고 신규 v3 evaluation 함수 `evaluateFinalTradeReviewDataset({observations,evaluationPolicyVersion,splitManifest})`를 도구 내부에 둔다. observations는 Export3 배열, splitManifest는 provenance의 hash로 pin된 sourceFamily/cohort assignment다. INDEPENDENT라면서 manifest가 없거나 source family가 development/tuning과 겹치면 INVALID_EVALUATION, accuracy 결과를 내지 않는다. label 없는 정상 operational export는 VALID_DESCRIPTIVE_EVALUATION이며 accuracy N/A다. sourceGroup을 변경해 같은 crop를 독립 재사용하지 않는다.

### E1-A — sidecar3 / v3 validator-store-API

- 수정: backend/recognition_contracts.py, backend/recognition_store.py, backend/api/recognition.py; tests/backend/test_recognition_store.py, test_trade_review_observations.py, test_recognition_contracts.py, test_recognition_security.py, test_recognition_artifacts.py; NEW tests/backend/test_final_review_observations.py.
- 금지: frontend/Master/OCR/Main/session/real sidecar/oldJSON재저장/평가UI.
- 검증: fresh3/initialize twice/v1chain/2→3, backup같음재사용/stale/corrupt/failure, DDL/meta/commitrollback, oldrows/receipt/hashes/PNG/exportsemantic동일, future/malformed/collision, read/writedispatch, mutationrace/lostresponse/differentbody, master/raw/projection/revision/hashnegative, source6→logical4/accountingspoof, realPillow bounds/pixelhash/metadata/oversize, retention/budget/sharedoldPNG, explicittruth와operational분리/labeldispute.
- 완료: oldAPI회귀+syntheticv3저장/read/export기본열거PASS, partialmigration0, actualDB0, test_trade_batch_api/runtime/contract_hash도temp환경PASS. GUI연결 없음.

### E1-B — Projection3 / Completion3 producer (preview)

- NEW frontend/js/domain/trade-final-evidence.js, tests/trade_final_evidence_regression.mjs; 수정 frontend/js/trade-recognition-review.js, tests/browser_trade_review_persistence.mjs.
- 금지: oldcorrection semantics/primaryUI activation/OCR/Master/backend/session.
- pureproducer가 exactshape/hash/accounting 제공, syntheticcorrected-input으로검증. 미완성C1/C3 대신 R003후보를fullycorrected라 표시하지 않음. oldUI write1유지, newpath explicitpreview/test만.
- 검증: 3decisions/batch≠truth/samevalue/edit/null/count0/Unicodecrosslanguagehash/cropstale/revision/immutablejobs/R0076→4/conflict/8MiBnegative/realE1-A save/retry/crop/oldbrowserreview-persistence/capture-client-domain회귀.
- 완료: deterministicproducer/receipt3/savejobPASS, truthPOST0, activeflow변경0.

### E1-C — DTO v3 adapter / session binding

- 수정 frontend/js/domain/reviewed-trade-dto.js; tests/reviewed_trade_dto_regression.mjs, tests/trade_session_staging_regression.mjs, tests/browser_trade_review_session.mjs; NEW tests/reviewed_trade_dto_v3_regression.mjs.
- 금지: Main/sessionbackend/state/schema/trade-session-staging.js/OCR/Master/runtimeactivation/storageAPI.
- 검증: retained+confirmedoperationalREADY, unknown/recapture/conflict/missingnumeric/unmappedHOLD, receipt/master/hash/revision/pixelstale, exclusion/allheld, duplicates/appendconflict, schema1output→NEW/APPENDdurable/readback/reload, oldDTO불변.
- 완료: 기존stage가schema1결과를그대로사용, DTO성공≠croptruth, sessioncode변경0.

### E1-D — Export3 / 3층평가

- 수정 backend/recognition_store.py, tools/trade_review_evaluation.mjs; tests/backend/test_final_review_observations.py, tests/trade_review_evaluation_regression.mjs; NEW tests/trade_final_evaluation_regression.mjs.
- 금지: oldexport/evaluator1의미변경/OCR/Master/UI/자동label/migrationDDL추가.
- 검증: retained/edited분모0, explicitknown만V/T/K, overlap/physicalduplicate/count0, dispute/unknown/coverage, recovery/harm, pre-editcandidatevsCompletion, denominator0N/A, operationaledit, split/cohortleakage거부, exportlabelmanifest/newlabelsoldobsHash불변/legacydispatch.
- 완료: 운영/독립accuracy분모분리, fraction재현, source/truth/exportintegrityPASS.

### M4-R — 한국어reference완료 / VERIFIED_REFERENCE발행

- 수정 frontend/js/domain/trade-master-bundle.js, backend/master_store.py, backend/api/master.py; tests/trade_master_bundle_regression.mjs, tests/backend/test_master_store.py, test_master_api.py; NEW frontend/data/trade-master-reference-manifest.json; MASTER-REFERENCE-AUDIT.md.
- 금지: trade-catalog.json/Registry1/OCR-correction/Main-session/oldbundle업데이트/ID재발급.
- 미조사181계속, 48/1history보존. 미확인/충돌unresolved/DISPUTED유지. manifest는 승인된sourceclaims/mapping/고정UUID/sourcehash와audit hash, dynamic수량없음.
- 검증: provenance/statusJS-Python/hashparity/priority/owner값불변/conflict-tiermismatchreject/forgedreferencepublishreject/CAS-IDcontinuity/immutableold-export. liveOCR불필요.
- 완료: ownerapproved새Bundle2발행/coverage명시, conflict를0이라위장하지않음. 미조사0목표와조사후미해결을구분.

### C1/C2/C3 — 통합correction / classifier

- C1 NEW frontend/js/domain/trade-final-correction.js, tests/trade_final_correction_regression.mjs.
- C2 위file + frontend/js/domain/trade-review-projection.js, tests/trade_review_projection_regression.mjs.
- C3 NEW frontend/js/domain/trade-final-classification.js, tests/trade_final_classification_regression.mjs + C1file/test.
- 범위: architecture12절안전helper, Masterpin/numeric0-unknown/stage0..8/source6→4/conflict-no drop/4states-pixels. backend-storage-session/threshold무단변경/새OCR금지. E1-B shape사용, 이중correction금지.
- 검증: raw-normalized-corrected분리/exact-bounded-openworld-disputed/referencepriority/숫자clipping-readerconflict-추측금지/pixelmissingREADY0/oldR003parity-nullpath/R007accounting/hashdeterminism.
- 완료: 실제raw→Projection3purepipeline, runtimeactive0.

### U1/U2 — 최종검수 / pixels / 명시activation

- U2a NEW tools/trade_ocr_adapter.py, tests/backend/test_trade_ocr_adapter.py, tests/backend/test_trade_crop_contract.py; tools/trade_batch_draft_experiment.py, tools/trade_batch_worker.py. 기존O1+U2a의 currentreader adapter만, engine/profile변경금지.
- U2b NEW frontend/js/trade-source-evidence.js, tests/trade_source_evidence_regression.mjs.
- U1 NEW frontend/js/trade-final-review.js, frontend/css/trade-final-review.css, tests/browser_trade_final_review.mjs; frontend/index.html.
- activation 별substep: frontend/js/recognition-ui.js, frontend/js/trade-recognition-client.js, backend/services/trade_batch_runtime.py, backend/api/recognition.py; tests/trade_recognition_client.mjs, tests/backend/test_trade_batch_api.py, test_trade_batch_runtime.py; NEW tests/browser_trade_final_flow.mjs.
- 금지: sessionalgorithm/MainDBschema/OCRengine-threshold/Masterauthority변조/oldsource독립선언/Warehouse-scheduler/generalUI(별후속Task). raw2adapter/workernegotiation외backend확대금지.
- 검증: 실제fixturepixels/hash/좌표변환bounds/cacheloss-stale/problemfirst-allrows/충돌비교/oneconfirm/edited-unknown-exclusion/manualimport-capture-Warehouse-scheduler회귀/v3save→DTO→NEW-APPENDDBfirst-readback-reload/actualworker shape-Pillow. independentlive는별freeze후gate.
- 완료: C3+E1-A/B/C/D를realcurrentraw로결합, legacyflow유지, 모든binding동일, truth자동생성0. 이후owner지시로전체UI/UX재구성Task정의.

순서 **E1-A→E1-B→E1-C→E1-D→M4-R→C1/C2/C3→U2/U1→activation→전체UI/UX**. 증거의미를먼저고정하고syntheticproducer/DTO준비, 실제correction/pixels가후에합류한다. E1-B/C완료를새primaryflow완료라하지않는다. O1/U2rawadapter가U1의선행조건인것은유지한다. packaging/OCRcandidate선택/independentlive는별gate.

## 11. 검증 / 호환 / 공격거부

| 입력 / 변화 | 요구결과 |
|---|---|
| oldobservation1/projection1·2/Registry1 read-export | oldhash/receipt/의미그대로 |
| oldREVIEW_FIRSTwrite | oldvalidator, sidecar3의oldtables로저장 |
| retained6+batchconfirmed+labels0 | 저장가능, knownTruthEligible전false, accuracyN/A |
| edited+labels0 | 수정률산입, independenttruth불산입 |
| requiredunknown | 저장가능/DTOheld/sessionREADY불가 |
| source6/logical4/completion4 | ledger정합이면허용 |
| missing/duplicate/unknownsource-capture/invalidordinal-group-union | 422/source숨김0 |
| master/projection/completion/revision/valuehash불일치 | reject/최신Master자동적용0 |
| v3ledgernull + mergedmetadata | reject/ledger필수 |
| same mutation/body/lostresponse/concurrency | record1/고정receipt hash/replayduplicate만변화 |
| same mutation/다른timestamp-body-version | 409 |
| PNG1byte/pixels-geometry-dimensions-metadata오류 | reject/바이너리정규화0 |
| laterindependentlabel추가 | 새exportmanifest/hash, oldobservationHash그대로 |
| backupstale/DDL-commit실패 | rollback/meta2/oldsemantic그대로/backup보존 |

이번Task검증은현재code의경로/함수/버전대조, 문서JSONparser/hashbinding, git diff --check뿐이다. runtime/DB/Pillow/migration/성능/ownerusability/independentaccuracy PASS를주장하지않는다. 구현Task에서모순발생시보고하고범위를넓히지않는다.

## 12. JSON 실례

아래는 synthetic 설계예이며 실제capture/게임정답/PNG검증을 주장하지 않는다. JSONbinding hashes는 실제 재계산, pixel/PNG digest는 synthetic식별자. 1source/1logical, legacy미mapping으로NEEDS_REVIEW. count를UNKNOWN으로 표시한 Completion도 저장 가능하나DTOHOLD. 3decisions를모두시연. Master는syntheticemptyBundle2이며production241/230data의대체가아니다.

### 12.1 FinalProjection3

```json
{
  "schemaVersion": 3,
  "reviewMode": "FINAL_CORRECTED_RESULT",
  "recognitionBatchId": "batch-example-1",
  "rawEvidenceHash": "1d5a5251d75b8ab99fbee9c6b4488492114d9d9ac5b7fc2f1d6c21be96ad96c3",
  "masterBinding": {
    "masterSchemaVersion": 2,
    "registryVersion": "registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
    "contentHash": "5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
    "hashBasis": "MASTER_CANONICAL_JSON_V2"
  },
  "correctionVersion": "synthetic-full-correction-v1",
  "reconciliation": {
    "schemaVersion": 2,
    "policyVersion": "trade-batch-reconciliation-v1",
    "captureOrder": [
      "capture-example-1"
    ],
    "sourceRows": [
      {"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0,"projectionSourceIndex":0}
    ],
    "groups": [
      {"groupId":"group-example-1","status":"SINGLE","memberSourceRowIds":["draft-example-1"],"representativeSourceRowId":"draft-example-1","logicalRowId":"logical-example-1","memberEvidence":[]}
    ],
    "sourceToLogical": [
      {"sourceRowId":"draft-example-1","logicalRowId":"logical-example-1"}
    ],
    "findings": []
  },
  "pixelAvailability": [
    {
      "cropRefId": "crop-island",
      "state": "IN_MEMORY"
    },
    {
      "cropRefId": "crop-fromItem",
      "state": "IN_MEMORY"
    },
    {
      "cropRefId": "crop-reqAmount",
      "state": "IN_MEMORY"
    },
    {
      "cropRefId": "crop-toItem",
      "state": "IN_MEMORY"
    },
    {
      "cropRefId": "crop-count",
      "state": "IN_MEMORY"
    },
    {
      "cropRefId": "crop-yield",
      "state": "IN_MEMORY"
    }
  ],
  "rows": [
    {
      "projectionRowId": "logical-example-1",
      "captureId": "capture-example-1",
      "ordinal": 0,
      "rowBox": {"x":0,"y":0,"width":140,"height":30},
      "sourceRefs": [{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],
      "fields": [{"field":"island","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"island"}],"normalizedValue":"예제 섬","candidates":[{"value":"예제 섬","identity":{"kind":"ISLAND","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 섬","finalValue":"예제 섬","identity":{"kind":"ISLAND","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-island"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":"MASTER_UNRESOLVED"}]},{"field":"fromItem","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"fromItem"}],"normalizedValue":"예제 원료","candidates":[{"value":"예제 원료","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 원료","finalValue":"예제 원료","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-fromItem"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":"MASTER_UNRESOLVED"}]},{"field":"reqAmount","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"reqAmount"}],"normalizedValue":1,"candidates":[{"value":1,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":1,"finalValue":1,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-reqAmount"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":1,"outputValue":1,"reason":null}]},{"field":"toItem","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"toItem"}],"normalizedValue":"예제 획득품","candidates":[{"value":"예제 획득품","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 획득품","finalValue":"예제 획득품","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-toItem"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":"MASTER_UNRESOLVED"}]},{"field":"count","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"count"}],"normalizedValue":0,"candidates":[{"value":0,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":0,"finalValue":0,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-count"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":0,"outputValue":0,"reason":null}]},{"field":"yield","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"yield"}],"normalizedValue":48,"candidates":[{"value":48,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":48,"finalValue":48,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-yield"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":48,"outputValue":48,"reason":null}]}],
      "classification": "NEEDS_REVIEW",
      "classificationReasons": ["MASTER_UNRESOLVED"]
    }
  ],
  "edgeWorkItems": [],
  "hashBasis": "TRADE_FINAL_PROJECTION_JSON_V3",
  "projectionHash": "4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428"
}
```

### 12.2 Completion3

```json
{
  "schemaVersion": 3,
  "reviewMode": "FINAL_CORRECTED_RESULT",
  "recognitionBatchId": "batch-example-1",
  "projectionHash": "4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428",
  "masterBinding": {
    "masterSchemaVersion": 2,
    "registryVersion": "registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
    "contentHash": "5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
    "hashBasis": "MASTER_CANONICAL_JSON_V2"
  },
  "correctionVersion": "synthetic-full-correction-v1",
  "reviewRevision": 1,
  "rows": [
    {
      "projectionRowId": "logical-example-1",
      "sourceRefs": [{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],
      "fields": [{"field":"island","shownValueBefore":"예제 섬","finalValue":"예제 섬","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-island"]},{"field":"fromItem","shownValueBefore":"예제 원료","finalValue":"예제 원료","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-fromItem"]},{"field":"reqAmount","shownValueBefore":1,"finalValue":1,"operationalDecision":"CANDIDATE_RETAINED","riskReasons":[],"cropRefs":["crop-reqAmount"]},{"field":"toItem","shownValueBefore":"예제 획득품","finalValue":"예제 획득품","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-toItem"]},{"field":"count","shownValueBefore":0,"finalValue":null,"operationalDecision":"USER_MARKED_UNKNOWN","riskReasons":[],"cropRefs":["crop-count"]},{"field":"yield","shownValueBefore":48,"finalValue":148,"operationalDecision":"USER_EDITED","riskReasons":[],"cropRefs":["crop-yield"]}],
      "disposition": "INCLUDE",
      "dispositionReason": null
    }
  ],
  "workItems": [],
  "batchConfirmation": {
    "method": "USER_FINAL_LIST_CONFIRMED",
    "confirmedAt": "2026-10-02T00:01:00Z",
    "projectionHash": "4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428",
    "reviewRevision": 1,
    "completionValuesHash": "c4e53b6cbd7d68d60d834738852e1b0713f8cb0f11835bf66c92f97272eb7c35"
  }
}
```

### 12.3 Observation3 (persisted record)

```json
{
  "schemaVersion": 3,
  "reviewMode": "FINAL_CORRECTED_RESULT",
  "mutationId": "00000000-0000-4000-8000-000000000001",
  "createdAt": "2026-10-02T00:01:00Z",
  "confirmationRevision": 1,
  "supersedesObservationId": null,
  "projection": {
    "schemaVersion": 3,
    "reviewMode": "FINAL_CORRECTED_RESULT",
    "recognitionBatchId": "batch-example-1",
    "rawEvidenceHash": "1d5a5251d75b8ab99fbee9c6b4488492114d9d9ac5b7fc2f1d6c21be96ad96c3",
    "masterBinding": {
      "masterSchemaVersion": 2,
      "registryVersion": "registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
      "contentHash": "5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
      "hashBasis": "MASTER_CANONICAL_JSON_V2"
    },
    "correctionVersion": "synthetic-full-correction-v1",
    "reconciliation": {
      "schemaVersion": 2,
      "policyVersion": "trade-batch-reconciliation-v1",
      "captureOrder": ["capture-example-1"],
      "sourceRows": [{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0,"projectionSourceIndex":0}],
      "groups": [{"groupId":"group-example-1","status":"SINGLE","memberSourceRowIds":["draft-example-1"],"representativeSourceRowId":"draft-example-1","logicalRowId":"logical-example-1","memberEvidence":[]}],
      "sourceToLogical": [{"sourceRowId":"draft-example-1","logicalRowId":"logical-example-1"}],
      "findings": []
    },
    "pixelAvailability": [
      {"cropRefId":"crop-island","state":"IN_MEMORY"},
      {"cropRefId":"crop-fromItem","state":"IN_MEMORY"},
      {"cropRefId":"crop-reqAmount","state":"IN_MEMORY"},
      {"cropRefId":"crop-toItem","state":"IN_MEMORY"},
      {"cropRefId":"crop-count","state":"IN_MEMORY"},
      {"cropRefId":"crop-yield","state":"IN_MEMORY"}
    ],
    "rows": [
      {"projectionRowId":"logical-example-1","captureId":"capture-example-1","ordinal":0,"rowBox":{"x":0,"y":0,"width":140,"height":30},"sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"fields":[{"field":"island","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"island"}],"normalizedValue":"예제 섬","candidates":[{"value":"예제 섬","identity":{"kind":"ISLAND","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 섬","finalValue":"예제 섬","identity":{"kind":"ISLAND","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-island"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":"MASTER_UNRESOLVED"}]},{"field":"fromItem","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"fromItem"}],"normalizedValue":"예제 원료","candidates":[{"value":"예제 원료","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 원료","finalValue":"예제 원료","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-fromItem"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":"MASTER_UNRESOLVED"}]},{"field":"reqAmount","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"reqAmount"}],"normalizedValue":1,"candidates":[{"value":1,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":1,"finalValue":1,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-reqAmount"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":1,"outputValue":1,"reason":null}]},{"field":"toItem","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"toItem"}],"normalizedValue":"예제 획득품","candidates":[{"value":"예제 획득품","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 획득품","finalValue":"예제 획득품","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-toItem"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":"MASTER_UNRESOLVED"}]},{"field":"count","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"count"}],"normalizedValue":0,"candidates":[{"value":0,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":0,"finalValue":0,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-count"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":0,"outputValue":0,"reason":null}]},{"field":"yield","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"yield"}],"normalizedValue":48,"candidates":[{"value":48,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":48,"finalValue":48,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-yield"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":48,"outputValue":48,"reason":null}]}],"classification":"NEEDS_REVIEW","classificationReasons":["MASTER_UNRESOLVED"]}
    ],
    "edgeWorkItems": [],
    "hashBasis": "TRADE_FINAL_PROJECTION_JSON_V3",
    "projectionHash": "4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428"
  },
  "completion": {
    "schemaVersion": 3,
    "reviewMode": "FINAL_CORRECTED_RESULT",
    "recognitionBatchId": "batch-example-1",
    "projectionHash": "4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428",
    "masterBinding": {
      "masterSchemaVersion": 2,
      "registryVersion": "registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
      "contentHash": "5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
      "hashBasis": "MASTER_CANONICAL_JSON_V2"
    },
    "correctionVersion": "synthetic-full-correction-v1",
    "reviewRevision": 1,
    "rows": [
      {"projectionRowId":"logical-example-1","sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"fields":[{"field":"island","shownValueBefore":"예제 섬","finalValue":"예제 섬","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-island"]},{"field":"fromItem","shownValueBefore":"예제 원료","finalValue":"예제 원료","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-fromItem"]},{"field":"reqAmount","shownValueBefore":1,"finalValue":1,"operationalDecision":"CANDIDATE_RETAINED","riskReasons":[],"cropRefs":["crop-reqAmount"]},{"field":"toItem","shownValueBefore":"예제 획득품","finalValue":"예제 획득품","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-toItem"]},{"field":"count","shownValueBefore":0,"finalValue":null,"operationalDecision":"USER_MARKED_UNKNOWN","riskReasons":[],"cropRefs":["crop-count"]},{"field":"yield","shownValueBefore":48,"finalValue":148,"operationalDecision":"USER_EDITED","riskReasons":[],"cropRefs":["crop-yield"]}],"disposition":"INCLUDE","dispositionReason":null}
    ],
    "workItems": [],
    "batchConfirmation": {
      "method": "USER_FINAL_LIST_CONFIRMED",
      "confirmedAt": "2026-10-02T00:01:00Z",
      "projectionHash": "4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428",
      "reviewRevision": 1,
      "completionValuesHash": "c4e53b6cbd7d68d60d834738852e1b0713f8cb0f11835bf66c92f97272eb7c35"
    }
  },
  "sourceContext": {
    "schemaVersion": 3,
    "authority": "CLIENT_ATTESTED",
    "rawEvidence": {
      "hashBasis": "TRADE_RAW_EVIDENCE_JSON_V2",
      "rawEvidenceHash": "1d5a5251d75b8ab99fbee9c6b4488492114d9d9ac5b7fc2f1d6c21be96ad96c3",
      "snapshot": {"schemaVersion":2,"recognitionBatchId":"batch-example-1","captures":[{"captureId":"capture-example-1","captureOrdinal":1,"imageSha256":"25d904824a3610fa63797fad1cf8cd182f84853144744af7050b9552dbfb0868","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","sourceType":"STREAM","frame":{"width":1024,"height":768},"sourceFidelity":{"sourceWidth":null,"sourceHeight":null,"rescaled":null,"evidence":"unknown"},"reencoded":true,"completeRowCount":1}],"sourceRows":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0,"rowBox":{"x":0,"y":0,"width":140,"height":30},"fields":[{"field":"island","rawText":"예제 섬","rawNumeric":null,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-island","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"island","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":10,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"5db435346a97ecdcfa8684f05a89567da53be0fd7f0bda1ad663649cb7b0fb0f","pngArtifactSha256":"79a30a4f51e1844947f4af14461595d2116dd3e801ec375e0adba7946fc7e5b3"}]},{"field":"fromItem","rawText":"예제 원료","rawNumeric":null,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-fromItem","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"fromItem","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":30,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"840afdb34ac28e69d546e71aac24255ec7ce5bc501bc9a62cee0347f80350c4b","pngArtifactSha256":"1b1c667e13e24751b6dc903ed1ac2e3a42d095cfdf7acc139928057981cdc146"}]},{"field":"reqAmount","rawText":"1","rawNumeric":1,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-reqAmount","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"reqAmount","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":50,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"3d7cefff61ba8e2e4bc679059b2e92ee0101630e5ae9da3cc5a1303484e180b9","pngArtifactSha256":"9e8adc113f1dfb116c893407dcb1937c1904ccf0999da89bde35ec24590f83fb"}]},{"field":"toItem","rawText":"예제 획득품","rawNumeric":null,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-toItem","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"toItem","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":70,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"2e23631b80a661ae1a78b552208d58d839dc87f7fdf7f78412756c00283dabf4","pngArtifactSha256":"07aa1225571153ed76165fef631387b40c949e932fed3305b090bb629b901375"}]},{"field":"count","rawText":"0","rawNumeric":0,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-count","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"count","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":90,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"74330e7051d319300fc46d3894bb83abbf4dbeb093aab5e66b8e27f32b349407","pngArtifactSha256":"487e43695da372c1036fd44713fb540e688053463a39e70e1480ac7f05b1c1a1"}]},{"field":"yield","rawText":"48","rawNumeric":48,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-yield","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"yield","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":110,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"7acbb42b5281d32734df7caf314d33b39d15baf725372db9506c51e555e9ab89","pngArtifactSha256":"5277fb84eaceddd8e409df0251f2d0c5e2da0099c4f83c85ff0ff623f79a9217"}]}]}],"edgeSegments":[]}
    },
    "masterBundle": {
      "binding": {"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},
      "snapshot": {"schemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","createdAt":"2026-10-02T00:00:00Z","entities":[],"compatibilityMappings":[],"unresolvedLegacyNames":[],"sourceRevisions":[],"provenance":{"purpose":"SYNTHETIC_CONTRACT_EXAMPLE"},"hashBasis":"MASTER_CANONICAL_JSON_V2","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508"}
    },
    "audit": {
      "recognitionStartedAt": null,
      "recognitionFinishedAt": null,
      "latencyMs": null,
      "gameVersion": null
    }
  },
  "cropPlan": {
    "schemaVersion": 3,
    "policy": "C2_LOGICAL_REPRESENTATIVE_V3",
    "entries": [
      {"projectionRowId":"logical-example-1","field":"island","cropRefId":"crop-island","selected":true,"reasons":["RISKY_FIELD"],"retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},
      {"projectionRowId":"logical-example-1","field":"fromItem","cropRefId":"crop-fromItem","selected":true,"reasons":["RISKY_FIELD"],"retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},
      {"projectionRowId":"logical-example-1","field":"reqAmount","cropRefId":"crop-reqAmount","selected":false,"reasons":[],"retentionClass":"NONE"},
      {"projectionRowId":"logical-example-1","field":"toItem","cropRefId":"crop-toItem","selected":true,"reasons":["RISKY_FIELD"],"retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},
      {"projectionRowId":"logical-example-1","field":"count","cropRefId":"crop-count","selected":true,"reasons":["USER_MARKED_UNKNOWN"],"retentionClass":"UNKNOWN_EVIDENCE"},
      {"projectionRowId":"logical-example-1","field":"yield","cropRefId":"crop-yield","selected":true,"reasons":["USER_EDITED"],"retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"}
    ]
  },
  "observationId": "00000000-0000-4000-8000-000000000002",
  "persistedAt": "2026-10-02T00:01:01Z",
  "hashBasis": "TRADE_OBSERVATION_JSON_V3",
  "payloadHash": "94590b38401284fa851663bfba80abc43d2cc0654a6757b41f7fea358e78542f",
  "observationHash": "a2e48c9d3a85f8a7ecf7556777591101292f77df80fbe13b0d304ebd1a3ce631"
}
```

### 12.4 Receipt3

```json
{
  "schemaVersion": 3,
  "observationId": "00000000-0000-4000-8000-000000000002",
  "mutationId": "00000000-0000-4000-8000-000000000001",
  "payloadHash": "94590b38401284fa851663bfba80abc43d2cc0654a6757b41f7fea358e78542f",
  "observationHash": "a2e48c9d3a85f8a7ecf7556777591101292f77df80fbe13b0d304ebd1a3ce631",
  "persistedAt": "2026-10-02T00:01:01Z",
  "duplicate": false,
  "evidenceSaved": true,
  "sessionApplied": false,
  "reviewMode": "FINAL_CORRECTED_RESULT",
  "projectionHash": "4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428",
  "masterBinding": {
    "masterSchemaVersion": 2,
    "registryVersion": "registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
    "contentHash": "5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508",
    "hashBasis": "MASTER_CANONICAL_JSON_V2"
  },
  "reviewRevision": 1,
  "cropPolicy": "C2_LOGICAL_REPRESENTATIVE_V3"
}
```

### 12.5 Export3

```json
{
  "schemaVersion": 3,
  "exportType": "TRADE_FINAL_REVIEW_OBSERVATION",
  "generatedAt": "2026-10-02T00:01:02Z",
  "hashBasis": "TRADE_EXPORT_JSON_V3",
  "semanticHash": "50ed48309fa7f061fa2d958057eea7a4c942d85616eb11191f07bd132d323705",
  "semantic": {
    "manifest": {
      "observationSchemaVersion": 3,
      "sidecarSchemaVersion": 3,
      "projectionSchemaVersion": 3,
      "completionSchemaVersion": 3,
      "masterBinding": {"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},
      "projectionHash": "4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428",
      "payloadHash": "94590b38401284fa851663bfba80abc43d2cc0654a6757b41f7fea358e78542f",
      "observationHash": "a2e48c9d3a85f8a7ecf7556777591101292f77df80fbe13b0d304ebd1a3ce631",
      "truthLabelBindings": [],
      "evaluationPolicyVersion": "trade-final-review-evaluation-v3"
    },
    "observation": {
      "schemaVersion": 3,
      "reviewMode": "FINAL_CORRECTED_RESULT",
      "mutationId": "00000000-0000-4000-8000-000000000001",
      "createdAt": "2026-10-02T00:01:00Z",
      "confirmationRevision": 1,
      "supersedesObservationId": null,
      "projection": {"schemaVersion":3,"reviewMode":"FINAL_CORRECTED_RESULT","recognitionBatchId":"batch-example-1","rawEvidenceHash":"1d5a5251d75b8ab99fbee9c6b4488492114d9d9ac5b7fc2f1d6c21be96ad96c3","masterBinding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"correctionVersion":"synthetic-full-correction-v1","reconciliation":{"schemaVersion":2,"policyVersion":"trade-batch-reconciliation-v1","captureOrder":["capture-example-1"],"sourceRows":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0,"projectionSourceIndex":0}],"groups":[{"groupId":"group-example-1","status":"SINGLE","memberSourceRowIds":["draft-example-1"],"representativeSourceRowId":"draft-example-1","logicalRowId":"logical-example-1","memberEvidence":[]}],"sourceToLogical":[{"sourceRowId":"draft-example-1","logicalRowId":"logical-example-1"}],"findings":[]},"pixelAvailability":[{"cropRefId":"crop-island","state":"IN_MEMORY"},{"cropRefId":"crop-fromItem","state":"IN_MEMORY"},{"cropRefId":"crop-reqAmount","state":"IN_MEMORY"},{"cropRefId":"crop-toItem","state":"IN_MEMORY"},{"cropRefId":"crop-count","state":"IN_MEMORY"},{"cropRefId":"crop-yield","state":"IN_MEMORY"}],"rows":[{"projectionRowId":"logical-example-1","captureId":"capture-example-1","ordinal":0,"rowBox":{"x":0,"y":0,"width":140,"height":30},"sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"fields":[{"field":"island","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"island"}],"normalizedValue":"예제 섬","candidates":[{"value":"예제 섬","identity":{"kind":"ISLAND","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 섬","finalValue":"예제 섬","identity":{"kind":"ISLAND","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-island"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 섬","outputValue":"예제 섬","reason":"MASTER_UNRESOLVED"}]},{"field":"fromItem","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"fromItem"}],"normalizedValue":"예제 원료","candidates":[{"value":"예제 원료","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 원료","finalValue":"예제 원료","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-fromItem"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 원료","outputValue":"예제 원료","reason":"MASTER_UNRESOLVED"}]},{"field":"reqAmount","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"reqAmount"}],"normalizedValue":1,"candidates":[{"value":1,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":1,"finalValue":1,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-reqAmount"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":1,"outputValue":1,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":1,"outputValue":1,"reason":null}]},{"field":"toItem","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"toItem"}],"normalizedValue":"예제 획득품","candidates":[{"value":"예제 획득품","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":"예제 획득품","finalValue":"예제 획득품","identity":{"kind":"ITEM","stableId":null,"legacyNameKey":null,"authorityStatus":"LEGACY_UNVERIFIED"},"valueState":"RESOLVED","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-toItem"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":"예제 획득품","outputValue":"예제 획득품","reason":"MASTER_UNRESOLVED"}]},{"field":"count","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"count"}],"normalizedValue":0,"candidates":[{"value":0,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":0,"finalValue":0,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-count"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":0,"outputValue":0,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":0,"outputValue":0,"reason":null}]},{"field":"yield","rawEvidenceRefs":[{"sourceRowId":"draft-example-1","field":"yield"}],"normalizedValue":48,"candidates":[{"value":48,"identity":null,"reason":"EXACT_RAW_CANDIDATE"}],"selectedCandidateIndex":0,"correctedValue":48,"finalValue":48,"identity":null,"valueState":"RESOLVED","riskReasons":[],"correctionReasons":[],"alternatives":[],"cropRefs":["crop-yield"],"stageTrace":[{"stage":0,"ruleVersion":"synthetic-stage-0-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":1,"ruleVersion":"synthetic-stage-1-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":2,"ruleVersion":"synthetic-stage-2-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":3,"ruleVersion":"synthetic-stage-3-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":4,"ruleVersion":"synthetic-stage-4-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":5,"ruleVersion":"synthetic-numeric-policy-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":6,"ruleVersion":"synthetic-stage-6-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":7,"ruleVersion":"synthetic-stage-7-v1","inputValue":48,"outputValue":48,"reason":null},{"stage":8,"ruleVersion":"synthetic-stage-8-v1","inputValue":48,"outputValue":48,"reason":null}]}],"classification":"NEEDS_REVIEW","classificationReasons":["MASTER_UNRESOLVED"]}],"edgeWorkItems":[],"hashBasis":"TRADE_FINAL_PROJECTION_JSON_V3","projectionHash":"4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428"},
      "completion": {"schemaVersion":3,"reviewMode":"FINAL_CORRECTED_RESULT","recognitionBatchId":"batch-example-1","projectionHash":"4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428","masterBinding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"correctionVersion":"synthetic-full-correction-v1","reviewRevision":1,"rows":[{"projectionRowId":"logical-example-1","sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"fields":[{"field":"island","shownValueBefore":"예제 섬","finalValue":"예제 섬","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-island"]},{"field":"fromItem","shownValueBefore":"예제 원료","finalValue":"예제 원료","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-fromItem"]},{"field":"reqAmount","shownValueBefore":1,"finalValue":1,"operationalDecision":"CANDIDATE_RETAINED","riskReasons":[],"cropRefs":["crop-reqAmount"]},{"field":"toItem","shownValueBefore":"예제 획득품","finalValue":"예제 획득품","operationalDecision":"CANDIDATE_RETAINED","riskReasons":["MASTER_UNRESOLVED"],"cropRefs":["crop-toItem"]},{"field":"count","shownValueBefore":0,"finalValue":null,"operationalDecision":"USER_MARKED_UNKNOWN","riskReasons":[],"cropRefs":["crop-count"]},{"field":"yield","shownValueBefore":48,"finalValue":148,"operationalDecision":"USER_EDITED","riskReasons":[],"cropRefs":["crop-yield"]}],"disposition":"INCLUDE","dispositionReason":null}],"workItems":[],"batchConfirmation":{"method":"USER_FINAL_LIST_CONFIRMED","confirmedAt":"2026-10-02T00:01:00Z","projectionHash":"4f3b8be5c71bad1c8b611d9bf8268277b7836400543508d5df809025d8792428","reviewRevision":1,"completionValuesHash":"c4e53b6cbd7d68d60d834738852e1b0713f8cb0f11835bf66c92f97272eb7c35"}},
      "sourceContext": {"schemaVersion":3,"authority":"CLIENT_ATTESTED","rawEvidence":{"hashBasis":"TRADE_RAW_EVIDENCE_JSON_V2","rawEvidenceHash":"1d5a5251d75b8ab99fbee9c6b4488492114d9d9ac5b7fc2f1d6c21be96ad96c3","snapshot":{"schemaVersion":2,"recognitionBatchId":"batch-example-1","captures":[{"captureId":"capture-example-1","captureOrdinal":1,"imageSha256":"25d904824a3610fa63797fad1cf8cd182f84853144744af7050b9552dbfb0868","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","sourceType":"STREAM","frame":{"width":1024,"height":768},"sourceFidelity":{"sourceWidth":null,"sourceHeight":null,"rescaled":null,"evidence":"unknown"},"reencoded":true,"completeRowCount":1}],"sourceRows":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0,"rowBox":{"x":0,"y":0,"width":140,"height":30},"fields":[{"field":"island","rawText":"예제 섬","rawNumeric":null,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-island","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"island","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":10,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"5db435346a97ecdcfa8684f05a89567da53be0fd7f0bda1ad663649cb7b0fb0f","pngArtifactSha256":"79a30a4f51e1844947f4af14461595d2116dd3e801ec375e0adba7946fc7e5b3"}]},{"field":"fromItem","rawText":"예제 원료","rawNumeric":null,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-fromItem","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"fromItem","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":30,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"840afdb34ac28e69d546e71aac24255ec7ce5bc501bc9a62cee0347f80350c4b","pngArtifactSha256":"1b1c667e13e24751b6dc903ed1ac2e3a42d095cfdf7acc139928057981cdc146"}]},{"field":"reqAmount","rawText":"1","rawNumeric":1,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-reqAmount","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"reqAmount","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":50,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"3d7cefff61ba8e2e4bc679059b2e92ee0101630e5ae9da3cc5a1303484e180b9","pngArtifactSha256":"9e8adc113f1dfb116c893407dcb1937c1904ccf0999da89bde35ec24590f83fb"}]},{"field":"toItem","rawText":"예제 획득품","rawNumeric":null,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-toItem","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"toItem","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":70,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"2e23631b80a661ae1a78b552208d58d839dc87f7fdf7f78412756c00283dabf4","pngArtifactSha256":"07aa1225571153ed76165fef631387b40c949e932fed3305b090bb629b901375"}]},{"field":"count","rawText":"0","rawNumeric":0,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-count","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"count","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":90,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"74330e7051d319300fc46d3894bb83abbf4dbeb093aab5e66b8e27f32b349407","pngArtifactSha256":"487e43695da372c1036fd44713fb540e688053463a39e70e1480ac7f05b1c1a1"}]},{"field":"yield","rawText":"48","rawNumeric":48,"readerStatus":"READ","confidence":"0.80","cropRefs":[{"cropRefId":"crop-yield","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"yield","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":110,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"7acbb42b5281d32734df7caf314d33b39d15baf725372db9506c51e555e9ab89","pngArtifactSha256":"5277fb84eaceddd8e409df0251f2d0c5e2da0099c4f83c85ff0ff623f79a9217"}]}]}],"edgeSegments":[]}},"masterBundle":{"binding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"snapshot":{"schemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","createdAt":"2026-10-02T00:00:00Z","entities":[],"compatibilityMappings":[],"unresolvedLegacyNames":[],"sourceRevisions":[],"provenance":{"purpose":"SYNTHETIC_CONTRACT_EXAMPLE"},"hashBasis":"MASTER_CANONICAL_JSON_V2","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508"}},"audit":{"recognitionStartedAt":null,"recognitionFinishedAt":null,"latencyMs":null,"gameVersion":null}},
      "cropPlan": {"schemaVersion":3,"policy":"C2_LOGICAL_REPRESENTATIVE_V3","entries":[{"projectionRowId":"logical-example-1","field":"island","cropRefId":"crop-island","selected":true,"reasons":["RISKY_FIELD"],"retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},{"projectionRowId":"logical-example-1","field":"fromItem","cropRefId":"crop-fromItem","selected":true,"reasons":["RISKY_FIELD"],"retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},{"projectionRowId":"logical-example-1","field":"reqAmount","cropRefId":"crop-reqAmount","selected":false,"reasons":[],"retentionClass":"NONE"},{"projectionRowId":"logical-example-1","field":"toItem","cropRefId":"crop-toItem","selected":true,"reasons":["RISKY_FIELD"],"retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},{"projectionRowId":"logical-example-1","field":"count","cropRefId":"crop-count","selected":true,"reasons":["USER_MARKED_UNKNOWN"],"retentionClass":"UNKNOWN_EVIDENCE"},{"projectionRowId":"logical-example-1","field":"yield","cropRefId":"crop-yield","selected":true,"reasons":["USER_EDITED"],"retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"}]},
      "observationId": "00000000-0000-4000-8000-000000000002",
      "persistedAt": "2026-10-02T00:01:01Z",
      "hashBasis": "TRADE_OBSERVATION_JSON_V3",
      "payloadHash": "94590b38401284fa851663bfba80abc43d2cc0654a6757b41f7fea358e78542f",
      "observationHash": "a2e48c9d3a85f8a7ecf7556777591101292f77df80fbe13b0d304ebd1a3ce631"
    },
    "cropEvidence": [
      {"projectionRowId":"logical-example-1","field":"island","cropRefId":"crop-island","artifactSha256":null,"pixelSha256":"5db435346a97ecdcfa8684f05a89567da53be0fd7f0bda1ad663649cb7b0fb0f","state":"NOT_UPLOADED","retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},
      {"projectionRowId":"logical-example-1","field":"fromItem","cropRefId":"crop-fromItem","artifactSha256":null,"pixelSha256":"840afdb34ac28e69d546e71aac24255ec7ce5bc501bc9a62cee0347f80350c4b","state":"NOT_UPLOADED","retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},
      {"projectionRowId":"logical-example-1","field":"reqAmount","cropRefId":"crop-reqAmount","artifactSha256":null,"pixelSha256":"3d7cefff61ba8e2e4bc679059b2e92ee0101630e5ae9da3cc5a1303484e180b9","state":"NOT_UPLOADED","retentionClass":"NONE"},
      {"projectionRowId":"logical-example-1","field":"toItem","cropRefId":"crop-toItem","artifactSha256":null,"pixelSha256":"2e23631b80a661ae1a78b552208d58d839dc87f7fdf7f78412756c00283dabf4","state":"NOT_UPLOADED","retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"},
      {"projectionRowId":"logical-example-1","field":"count","cropRefId":"crop-count","artifactSha256":null,"pixelSha256":"74330e7051d319300fc46d3894bb83abbf4dbeb093aab5e66b8e27f32b349407","state":"NOT_UPLOADED","retentionClass":"UNKNOWN_EVIDENCE"},
      {"projectionRowId":"logical-example-1","field":"yield","cropRefId":"crop-yield","artifactSha256":null,"pixelSha256":"7acbb42b5281d32734df7caf314d33b39d15baf725372db9506c51e555e9ab89","state":"NOT_UPLOADED","retentionClass":"OPERATIONAL_REVIEW_EVIDENCE"}
    ],
    "truthLabels": [],
    "dataset": {
      "recognitionBatchId": "batch-example-1",
      "rows": [{"projectionRowId":"logical-example-1","classification":"NEEDS_REVIEW","disposition":"INCLUDE","sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"fields":[{"field":"island","operationalDecision":"CANDIDATE_RETAINED","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"rawEvidence":[{"sourceRowId":"draft-example-1","rawText":"예제 섬","rawNumeric":null,"readerStatus":"READ","confidence":"0.80"}],"normalizedValue":"예제 섬","correctedValue":"예제 섬","shownValueBefore":"예제 섬","finalValue":"예제 섬","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"masterBinding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"cropRefs":[{"cropRefId":"crop-island","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"island","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":10,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"5db435346a97ecdcfa8684f05a89567da53be0fd7f0bda1ad663649cb7b0fb0f","pngArtifactSha256":"79a30a4f51e1844947f4af14461595d2116dd3e801ec375e0adba7946fc7e5b3"}]},{"field":"fromItem","operationalDecision":"CANDIDATE_RETAINED","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"rawEvidence":[{"sourceRowId":"draft-example-1","rawText":"예제 원료","rawNumeric":null,"readerStatus":"READ","confidence":"0.80"}],"normalizedValue":"예제 원료","correctedValue":"예제 원료","shownValueBefore":"예제 원료","finalValue":"예제 원료","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"masterBinding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"cropRefs":[{"cropRefId":"crop-fromItem","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"fromItem","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":30,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"840afdb34ac28e69d546e71aac24255ec7ce5bc501bc9a62cee0347f80350c4b","pngArtifactSha256":"1b1c667e13e24751b6dc903ed1ac2e3a42d095cfdf7acc139928057981cdc146"}]},{"field":"reqAmount","operationalDecision":"CANDIDATE_RETAINED","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"rawEvidence":[{"sourceRowId":"draft-example-1","rawText":"1","rawNumeric":1,"readerStatus":"READ","confidence":"0.80"}],"normalizedValue":1,"correctedValue":1,"shownValueBefore":1,"finalValue":1,"riskReasons":[],"correctionReasons":[],"masterBinding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"cropRefs":[{"cropRefId":"crop-reqAmount","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"reqAmount","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":50,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"3d7cefff61ba8e2e4bc679059b2e92ee0101630e5ae9da3cc5a1303484e180b9","pngArtifactSha256":"9e8adc113f1dfb116c893407dcb1937c1904ccf0999da89bde35ec24590f83fb"}]},{"field":"toItem","operationalDecision":"CANDIDATE_RETAINED","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"rawEvidence":[{"sourceRowId":"draft-example-1","rawText":"예제 획득품","rawNumeric":null,"readerStatus":"READ","confidence":"0.80"}],"normalizedValue":"예제 획득품","correctedValue":"예제 획득품","shownValueBefore":"예제 획득품","finalValue":"예제 획득품","riskReasons":["MASTER_UNRESOLVED"],"correctionReasons":[],"masterBinding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"cropRefs":[{"cropRefId":"crop-toItem","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"toItem","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":70,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"2e23631b80a661ae1a78b552208d58d839dc87f7fdf7f78412756c00283dabf4","pngArtifactSha256":"07aa1225571153ed76165fef631387b40c949e932fed3305b090bb629b901375"}]},{"field":"count","operationalDecision":"USER_MARKED_UNKNOWN","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"rawEvidence":[{"sourceRowId":"draft-example-1","rawText":"0","rawNumeric":0,"readerStatus":"READ","confidence":"0.80"}],"normalizedValue":0,"correctedValue":0,"shownValueBefore":0,"finalValue":null,"riskReasons":[],"correctionReasons":[],"masterBinding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"cropRefs":[{"cropRefId":"crop-count","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"count","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":90,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"74330e7051d319300fc46d3894bb83abbf4dbeb093aab5e66b8e27f32b349407","pngArtifactSha256":"487e43695da372c1036fd44713fb540e688053463a39e70e1480ac7f05b1c1a1"}]},{"field":"yield","operationalDecision":"USER_EDITED","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"rawEvidence":[{"sourceRowId":"draft-example-1","rawText":"48","rawNumeric":48,"readerStatus":"READ","confidence":"0.80"}],"normalizedValue":48,"correctedValue":48,"shownValueBefore":48,"finalValue":148,"riskReasons":[],"correctionReasons":[],"masterBinding":{"masterSchemaVersion":2,"registryVersion":"registry-v2:5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","contentHash":"5db343159c5b0762003774b24abd16e7efe96965901a8be724f0c7eeb4178508","hashBasis":"MASTER_CANONICAL_JSON_V2"},"sourceRefs":[{"sourceRowId":"draft-example-1","captureId":"capture-example-1","ordinal":0}],"cropRefs":[{"cropRefId":"crop-yield","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"yield","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":110,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"7acbb42b5281d32734df7caf314d33b39d15baf725372db9506c51e555e9ab89","pngArtifactSha256":"5277fb84eaceddd8e409df0251f2d0c5e2da0099c4f83c85ff0ff623f79a9217"}]}]}],
      "sourceFields": [{"sourceRowId":"draft-example-1","field":"island","rawEvidence":{"sourceRowId":"draft-example-1","rawText":"예제 섬","rawNumeric":null,"readerStatus":"READ","confidence":"0.80"},"normalizedValue":"예제 섬","correctedValue":"예제 섬","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"cropRefs":[{"cropRefId":"crop-island","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"island","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":10,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"5db435346a97ecdcfa8684f05a89567da53be0fd7f0bda1ad663649cb7b0fb0f","pngArtifactSha256":"79a30a4f51e1844947f4af14461595d2116dd3e801ec375e0adba7946fc7e5b3"}]},{"sourceRowId":"draft-example-1","field":"fromItem","rawEvidence":{"sourceRowId":"draft-example-1","rawText":"예제 원료","rawNumeric":null,"readerStatus":"READ","confidence":"0.80"},"normalizedValue":"예제 원료","correctedValue":"예제 원료","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"cropRefs":[{"cropRefId":"crop-fromItem","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"fromItem","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":30,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"840afdb34ac28e69d546e71aac24255ec7ce5bc501bc9a62cee0347f80350c4b","pngArtifactSha256":"1b1c667e13e24751b6dc903ed1ac2e3a42d095cfdf7acc139928057981cdc146"}]},{"sourceRowId":"draft-example-1","field":"reqAmount","rawEvidence":{"sourceRowId":"draft-example-1","rawText":"1","rawNumeric":1,"readerStatus":"READ","confidence":"0.80"},"normalizedValue":1,"correctedValue":1,"truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"cropRefs":[{"cropRefId":"crop-reqAmount","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"reqAmount","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":50,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"3d7cefff61ba8e2e4bc679059b2e92ee0101630e5ae9da3cc5a1303484e180b9","pngArtifactSha256":"9e8adc113f1dfb116c893407dcb1937c1904ccf0999da89bde35ec24590f83fb"}]},{"sourceRowId":"draft-example-1","field":"toItem","rawEvidence":{"sourceRowId":"draft-example-1","rawText":"예제 획득품","rawNumeric":null,"readerStatus":"READ","confidence":"0.80"},"normalizedValue":"예제 획득품","correctedValue":"예제 획득품","truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"cropRefs":[{"cropRefId":"crop-toItem","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"toItem","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":70,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"2e23631b80a661ae1a78b552208d58d839dc87f7fdf7f78412756c00283dabf4","pngArtifactSha256":"07aa1225571153ed76165fef631387b40c949e932fed3305b090bb629b901375"}]},{"sourceRowId":"draft-example-1","field":"count","rawEvidence":{"sourceRowId":"draft-example-1","rawText":"0","rawNumeric":0,"readerStatus":"READ","confidence":"0.80"},"normalizedValue":0,"correctedValue":0,"truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"cropRefs":[{"cropRefId":"crop-count","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"count","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":90,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"74330e7051d319300fc46d3894bb83abbf4dbeb093aab5e66b8e27f32b349407","pngArtifactSha256":"487e43695da372c1036fd44713fb540e688053463a39e70e1480ac7f05b1c1a1"}]},{"sourceRowId":"draft-example-1","field":"yield","rawEvidence":{"sourceRowId":"draft-example-1","rawText":"48","rawNumeric":48,"readerStatus":"READ","confidence":"0.80"},"normalizedValue":48,"correctedValue":48,"truthEvidence":"NONE","knownTruthEligible":false,"truthValue":null,"truthLabelIds":[],"cropRefs":[{"cropRefId":"crop-yield","sourceRowId":"draft-example-1","captureId":"capture-example-1","field":"yield","bitmapSha256":"d9140d0a72ad70d4c1ff154eb51b20b1f72daf1350d837d98398a59afaf4596a","frame":{"width":1024,"height":768},"coordinateSpace":"CAPTURE_BITMAP_PIXELS","box":{"x":110,"y":10,"width":10,"height":10},"pixelHashBasis":"RGB8_ROW_MAJOR_V1","pixelSha256":"7acbb42b5281d32734df7caf314d33b39d15baf725372db9506c51e555e9ab89","pngArtifactSha256":"5277fb84eaceddd8e409df0251f2d0c5e2da0099c4f83c85ff0ff623f79a9217"}]}],
      "edgeWorkItems": []
    }
  }
}
```

Observation POST에는 12.3의 server-generated observationId/persistedAt/hashBasis/payloadHash/observationHash를 제외한 request만 보낸다. Receipt3는 서버가 반환한다. Export3는 stored record에 독립 label이 아직 없는 상태다.
