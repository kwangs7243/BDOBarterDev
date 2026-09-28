# Feedback / Dataset / Debug Design

## Reuse current collection

main schema 3의 warehouse_scan/warehouse_feedback와 GET /api/warehouse-dataset를 V1 adapter로 재사용한다. 기존 export format2, original model output, field별 verified flags를 유지한다. legacy match/different는 item label만 검증한다. four-way agreement는 item과 quantity 양쪽을 검증한다. unchecked/excluded/자동 HIGH는 학습 정답이 아니다.

V2의 별도 결과/설정은 `%LOCALAPPDATA%/BDOBarter/recognition/recognition.sqlite3`에만 둔다. main schema migration이나 existing scan BLOB cleanup은 하지 않는다. export tool은 읽기 전용 main SQLite snapshot을 import하여 common sample schema로 변환한다. 같은 sourceHash/scanId/slot/hash label을 중복 학습으로 세지 않는다.

## Sidecar schema v1

| 테이블 | column/constraint |
|---|---|
| recognition_meta | id=1, schema_version=1, config_revision INTEGER, config_json TEXT |
| capture_profile | profile_id TEXT PK, profile_version INTEGER, payload_json TEXT, unique(profile_id,profile_version)은 별도 version payload registry로 관리하지 않고 latest row만 CAS update |
| recognition_run | recognition_id TEXT PK, capture_id UNIQUE, batch_id NULL, created_at, task_type, input_hash, crop_hash NULL, engine_hash, model_hash, parameter_hash, profile_hash, policy_hash, report_json, mode, raw_artifact_ref NULL |
| recognition_label | label_id TEXT PK, recognition_id FK, unit_id, field_name, label_version, value_json, status, source, corrected, reason, created_at; UNIQUE(run,unit,field,version) |
| recognition_label_receipt | label_mutation_id TEXT PK, request_hash, response_json, created_at; label 기록과 같은 sidecar transaction |
| recognition_apply_intent | recognition_id TEXT PK/FK, mutation_id UNIQUE, request_hash, base_revision, state PREPARED/APPLIED/STALE/COMMIT_UNKNOWN, applied_revision NULL, created_at |

테이블은 신규 sidecar에만 생성하고 schema 1 이외 기존 sidecar를 자동 migration하지 않는다. profile history가 필요해지면 Luna가 column을 임의 추가하지 않고 Sol에 재검토를 요청한다. run report에 사용한 profile payload/hash를 고정하므로 최신 profile이 바뀌어도 당시 입력을 재현할 수 있다.

## RecognitionSample common schema

JSONL sample: `{version:1,sampleId,captureId,sourceScanId?,timestamp,taskType,unitId,sourceType,captureProfile,inputImageHash,cropHash,engineVersion,engineHash,modelVersion,modelHashes,parameterHash,profileHash,policyHash,predictedValue,candidateValues,confidence,decision,finalValue,corrected,correctionReason,processingTimeMs,labelStatus,labelSource,verifiedFields,groupId,artifactRefs,auditSelection,replayStatus,artifactMissingReasons}`.

predictedValue은 원본을 불변으로 보존한다. finalValue는 사람이 확정한 필드만 있다. labelStatus=UNVERIFIED/HUMAN_VERIFIED/FIXTURE_VERIFIED/PSEUDO_LABEL/DISPUTED. 자동 prediction을 finalValue로 복사하지 않는다. 독립 두 시스템 agreement만으로 정답을 만들지 않고 추가 검증/승인 provenance가 있어야 FIXTURE_VERIFIED로 승격한다. schema의 missing timestamp/modelVersion은 null로 남긴다.

label_source는 legacy_feedback_v1/four_way_feedback_v2/user_correction/curated_fixture/approved_external_label/high_audit/pseudo_prediction enum. 최종 ground truth는 verifiedFields 단위로 조회한다. 여러 human labels가 같은 input/slot/field에서 다르면 DISPUTED; 최신 값을 임의 선택하지 않는다. 수정 reason은 선택형(item/quantity/layout/clipping/catalog/other)+짧은 text이며 민감정보를 자동 채우지 않는다.

## V2 feedback API and persistence distinction

`POST /api/recognition/<recognitionId>/feedback`: `{version:1,labelMutationId,rows:[{unitId,fields:{field:{value,verification:"explicit",reason}}}]}`. 동일 labelMutationId/bodyHash는 idempotent, 다른 body는409. 새 명시 수정은 새로운 label version이다. 원본 run/unit/hash와 value type을 검증한다. draft input 변화는 verified label이 아니다. 사용자가 수정 완료/확정 적용을 눌렀을 때만 explicit confirmation으로 기록한다.

feedback 정답 저장과 main stock/session 적용 성공은 분리된 사실이다. sidecar label 저장 후 main mutation이 실패해도 human label은 유효하며 UI의 적용 상태는 FAILED/PENDING이다. 수동 label이 저장됐다는 이유로 DB 적용까지 성공했다고 기록하지 않는다. 두 DB의 atomic transaction을 주장하지 않는다. 기존 V1 feedback+inventory atomic contract는 유지한다. V2 수동 apply는 기존 saveWarehouseInventory를 feedback 없는 기존 request로 호출한다. main에 V2 report를 V1 feedback 형식으로 위장해서 넣지 않는다.

## Later Active learning — T012

top1/top2 작은 margin, reader disagreement, 새로운 profile, 반복 digit 오류, seed confusion, fuzzy multi-candidate, crop clipping을 수집 priority로 삼는다. exception 화면에서 실제 필요한 슬롯/row만 요청한다. HIGH prediction을 모두 검사하게 하지 않는다. 검증 데이터에 없는 stratum은 abstain하고 새 독립 표본을 모은다. 선택된 exception labels로 전체 population accuracy를 주장하지 않는다.

## Early Evidence Store / Artifacts / retention — T002

기본 debugCapture=false: 전체 화면 PNG는 request/processing 동안만 temp에 있으며 응답 종료/취소 후 지운다. 원본 파일 input은 앱이 별도 복사해 계속 보존하지 않는다. exception/human-corrected 및 audit 선택 HIGH crop은 local recognition/artifacts/<sha256>.png에 자동 수집하되 task unit의 필요한 부분만 저장한다. metadata와 원본/crop hash, boxes/transform/engine/timing은 남긴다.

debugCapture=true인 캡처에 한해 full image/normalized crop/boxes/slot crops/quantity crops/candidate scores를 보존한다. 사용자에게 저장 범위와 보존 위치를 설정 화면에서 명확히 표시한다. default budget=200MiB(new V2 artifacts), 초과 시 새 artifact 저장을 멈추고 metadata/실패 이유를 보존한다. verified label/crop과 existing main BLOB는 자동 삭제하지 않는다. unlabeled debug artifacts는 30일 retention이며 cleanup은 설정에 명시된 경우에만 실행한다. label 참조가 있는 파일은 retention 대상에서 제외한다. retention 값은 recognition 저장 정책이지 ML accuracy 목표가 아니다.

실패 report는 run.json, engine/profile/policy/model manifest, image/crop hash, transform, candidate/scores/reasons/timing과 보존된 필요한 crop을 묶는다. debug OFF에서 원본 frame이 없으면 layout 전체 재현 한계를 명시한다. 예외 crop만으로 재현 가능한 숫자 오류와 layout 오류를 구분한다.

## Git separation

Git에는 production source, SPEC-008 docs, 작은 curated tests/fixtures/recognition-v2/와 manifest, model metadata, 승인된 작은 NPZ resources를 넣는다. daily captures/feedback DB/debug/experiments/training outputs는 local app data로 분리한다. 후속 T001에서 .gitignore에 recognition-local/, experiment outputs, *.sqlite3와 동작 로그를 추가한다(이번에는 기존 파일을 변경하지 않음). curated fixture도 label provenance/hash가 있어야 golden에 들어간다. Git LFS는 현재 필요하지 않으며 큰 model 채택 시 별도로 결정한다.

## Evidence lifecycle / reproducibility

T001 R0 replay 도구는 복사 DB/기존 PNG의 field crops+immutable evidence JSON을 local dataset에 즉시 내보낸다. T002는 Early Evidence Store/budget/hash-idempotent writer를 구현하고 T005/T006/T010 실험이 사용한다. T012는 우선순위/retention 개선이며 최초 저장 Task가 아니다. 처리 동안 필요한 slot·field crops를 임시 보유하고 decision/audit 선택 후 영구 보존한다.

unit evidence는 run/capture/batch ID, profile payload/version/hash, engine/model/parameter/policy/catalog/anchor hashes, source hash, raw/normalized slot·field crop/boxes/transform, original value/candidates/raw score direction/confidence/reason, final human field/value/corrected flag, item/quantity/layout correction category, timing을 포함한다. audited HIGH도 확인 전 unverified다. invalid capture는 target panel/geometry context crop과 validity evidence를 보존하고 unrelated 전체 화면은 debug OFF에서 저장하지 않는다. 전체 layout 재현 불가면 replayStatus=PARTIAL_LAYOUT으로 명시한다.

200MiB 예산은 신규 crops/metadata JSON을 포함하며 SQLite overhead는 별도 보고한다. disk/budget 부족이면 verified crop 삭제 없이 새 image 저장 중단, artifactMissingReasons를 남긴다. 필수 crop이 누락된 run은 evidenceIncomplete=true로 HIGH 상세 생략/auto authority를 주지 않고 재캡처 또는 V1 수동 검수로 안내한다. metadata까지 쓰기 실패하면 run 성공을 주장하지 않는다. 이미 main commit된 값을 undo하지 않는다. hash 기반 artifact 경로에 클라이언트 path/파일명을 사용하지 않는다. 200MiB/30일 규칙은 T002에서 시험하며 T012는 실제량·재현성에 근거한 개선안만 제출한다.

## Product workload counters — V2.1 입력

Warehouse: captures/noReviewCaptures/capturesRequiringReview/meanReviewSlots/itemCorrections/quantityCorrections/captureInvalid/auditedWrongHigh/reviewDeltaVsV1. Trade: batches/confirmedRows/reviewRows/rejectedRows/partialRows/editedFields/fullListExact. capture/batch ID별 retry를 중복 성공으로 세지 않는다. 인식/사람 수정/적용 성공/감사 완료를 별도 events로 남긴다. unverified를 정답으로 세지 않고 전체 목록 truth/completeness가 없으면 fullListExact=null이다. 분모는 [benchmark-plan.md](benchmark-plan.md)가 정본이다.
