# Benchmark / Golden Plan

## 현재 baseline

이번 실행: warehouse known fixtures 2장, 126 전체 슬롯, 대상105칸 item top1/quantity exact105/105, 기존 patch99 entries, wrong patch0. 이 표본은 알려진 regression set이며 release holdout이 아니다. selective feedback:175 verified item exact, 163 verified quantity 중145 exact/11unknown/7wrong MATCH. 따라서 item 오류0과 fixture patch 오류0만으로 production precision을 선언할 수 없다.

historical trade:16장/80행의 legacy 실험, complete row0/80. 마지막 숫자validation32행 complete0, 확정0. 재실행 가능한 prototype/model은 없고 새 engine accuracy baseline은 null이다. expected JSON importer78 accepted/2 rejected는 recognition accuracy가 아니다.

CPU current: i3-10105F,8logical,RAM17,089,196,032bytes. warm10 runs별 warehouse mean422.69/435.89ms, p95452.32/504.64ms. 전체 upload/UI/DB latency 제외. 현재 package72,246,845bytes/259files. scanner subprocess peak40,480,768bytes. startup null(실행 중 앱을 재시작하지 않음).

## Golden manifest v1

repository `tests/fixtures/recognition-v2/manifest.json`: `{version:1,datasetId,createdAt,sourceHashes,groups,fixtures,splitManifestHash}`. fixture `{fixtureId,taskType,imagePath,imageHash,groupId,split,profileStratum,variationTags,expectedPath,expectedHash,labelProvenance,verifiedFields,eligibleForAutoEvaluation}`.

expected warehouse: slots의 itemId/programName/quantity state/quantity value/EMPTY/TIER5/GENERAL/duplicate relation. expected trade: 6필드 truth와 source별 row mapping, true overlap/order, partial row 상태, catalog supported 여부를 분리한다. unknown label은 null+unverified이며 평가정답으로 채우지 않는다.

5단은 수동 관리 business rule로 AUTO/REVIEW 분모에서 제외한다. 5단을 포함한 정상 capture는 invalid가 아니다. negative SKIP 분류는 별도 평가한다.

기존 2장의 truth는 warehouse_patch_regression.py의 DEDICATED/MIXED IDs/QTY에서 **unchanged** oracle로 추출한다. calibration.png/manifest와 NPZ source는 training 전용이다. live feedback의 같은 imageHash/source day/profile와 파생 crop/resize를 한 group으로 묶는다. 일반품/5단/negative를 golden에서 제거하지 않는다. 이는 SKIP/OOD·입력 validity 검증용이며 5단 수량 자동 판독 목표가 아니다. 현재 6 unique live images는 오류재현/development data이며 독립 holdout으로 재분류하지 않는다.

trade16장은 현재 oracle의 이미지별 row mapping/ellipsis/catalog부재2행을 먼저 검수한다. 기존 oracle는 수정하지 않고 승인된 label amendment를 별도 파일+provenance로 만든다. oracle source가 부족하면 해당 field/screenshot은 unverified로 남기고 80행 완전 ground truth라고 주장하지 않는다.

## Required variations / coverage matrix

Warehouse: 정상, UI scale/resolution/DPI/source 차이, quantity0/1/2/3+/5+자리, high number, 유사 seed/icon, hover/highlight, clipped, EMPTY, 일반품 unknown, tier5, duplicate stack, reader disagreement, known7wrong MATCH. Trade: 긴 한글/ellipsis/유사섬/유사품목, land0→1/특수/coin, req>1/다른yield/count0, 긴목록/overlap/nonoverlap/같은identity숫자충돌/partial/scroll boundary/회차변경.

각 stratum의 fixtureCount/verified field count/known missing cells를 출력한다. 없는 variation은 synthetic으로 존재하는 것처럼 채우지 않는다. synthetic transforms는 robustness regression으로 분리하며 실제 profile validation을 대체하지 않는다.

## Split and leakage

TRAIN: templates/feature fitting. CALIBRATION: thresholds/policy frontier 선택. VALIDATION: 고정 policy 검토. HOLDOUT: 새로운 capture session/day/profile의 처음 보는 data; release authority 최종 검사. 원본 frame/hash group와 near duplicate는 같은 split이다. row/crop단위 random split은 금지한다. crop 생성/label export는 evaluator에서 분리하며 recognizer에는 image/profile/model만 전달한다.

현재 데이터는 sparse/이미 관찰돼 위 split의 독립성을 확보하지 못한다. 최소 sample 수와 최종 coverage target은 데이터 분포/stratum별 오류 frontier 분석 후 Sol 결정 artifact에 기록한다. 임의 95% coverage/99.9% accuracy를 먼저 지정하지 않는다. 검증된 stratum만 scope를 제한할 수 있다. 0오류의 작은 표본은 일반화 보증으로 쓰지 않는다.

## Harness interface and commands (후속 구현 예정)

작업 디렉터리 `D:/BDOBarterDev/_dev`; 아래 `<PY>`는 Pillow/NumPy/Flask/Waitress가 설치된 검증된 Python3.11+ 실행기다. 이번 확인에서는 `C:/Users/kwang/AppData/Local/Temp/BDOBarterSpec006Venv/Scripts/python.exe`가 3.12.14로 사용 가능했으나 Temp 경로를 영구 빌드 설정에 고정하지 않는다.

```powershell
& '<PY>' -B tools/recognition_dataset.py --main-db '<copied-read-only-db>' --source legacy-feedback --out '<local-dataset>'
& '<PY>' -B tools/recognition_benchmark.py --manifest tests/fixtures/recognition-v2/manifest.json --engine warehouse-current --runs 10 --mode shadow --out '<local-results>/warehouse-current.json'
& '<PY>' -B tools/recognition_benchmark.py --manifest tests/fixtures/recognition-v2/manifest.json --engine warehouse-v2 --policy '<frozen-policy.json>' --runs 10 --mode shadow --out '<local-results>/warehouse-v2.json'
& '<PY>' -B tools/recognition_benchmark.py --manifest tests/fixtures/recognition-v2/manifest.json --engine trade-candidate --selection '<experiment-selection.json>' --runs 10 --mode shadow --out '<local-results>/trade.json'
```

현재 없는 신규 CLI다. 이미 실행된 것처럼 보고하지 않는다. 기본 모드는 main DB를 변경하지 않는다. label/expected는 evaluator만 읽으며 engine에 전달하지 않는다.

output `{version,fixtureCount,verifiedUnits,unverifiedUnits,exactCorrect,wrong,abstained,autoProposed,autoAppliedActual:0,falseAutoProposed,reviewRequired,rejected,autoApplyPrecision,autoApplyCoverage,reviewRate,rejectRate,itemAccuracy,quantityExactMatch,tradeFieldAccuracy,tradeRowExactMatch,fullCaptureExactMatch,correctHigh,wrongHigh,correctReview,wrongReview,unreadable,captureInvalid,reviewSlotsPerCapture,capturesRequiringReview,touchlessRecognitionRate,fullCaptureExactRate,byField,bySlot,byCapture,byStratum,risk,audit,confusionPairs,latency:{cold,mean,p95,runs},peakMemoryBytes,engineVersion,modelHashes,policyHash,datasetHash,environment,scopeWarnings}`.

Precision은 검증된 올바른 자동 적용 제안 수/검증된 전체 자동 적용 제안 수다. 분모가 0이면 null이다. Coverage는 검증된 eligible HIGH units/검증된 전체 eligible units다. wrong과 unknown은 따로 세며 라벨이 없는 결과를 correct로 세지 않는다.

latency는 request-to-result와 단계별 시간을 나눈다. cold initialization, warm inference, decode, normalization, readers, policy, evidence 저장을 측정한다. p95는 run 수와 quantile 계산 방법을 기록한다. 프로세스 peak를 얻지 못하면 null이다. startup은 health ready/UI ready와 모델 load 전후를 구분하고 같은 복사 DB로 비교한다. GPU 사용 여부도 기록한다.

## Acceptance gates

### Usable Warehouse V2 — U0~U3

U0: G0 provenance/grouped split과 validity negatives PASS. frozen R0의 correct REVIEW/7wrong MATCH/11unknown replay를 구분한다.

U1: deterministic candidate policy→Sol usableReviewApproved. 같은 manifest/stratum에서 wrong HIGH를 늘리지 않고 correct REVIEW/capture당 확인 부담을 줄인 paired 결과, 독립 validation/holdout과 scope risk evidence를 제출한다. 실제 개선량·표본 적절성은 자료로 승인하고 임의 목표값을 설정하지 않는다. 미승인 scope는 REVIEW 또는 CAPTURE_INVALID다.

U2: T007 shadow의 낮은 빈도 HIGH audit + T008 예외 검수/사용자 whole-patch apply/feedback PASS. 53 HIGH/3 REVIEW라면 3개만 확인한 뒤 한 main transaction으로 적용하며 NULL/0/target/session/slots 보존. wrong HIGH scope는 상세 생략 승인 OFF. auto는 OFF이며 auto 전용 최소표본/허용위험 예산 결정은 U2의 선행 조건이 아니다.

U3: 해당 usable 범위의 T013 실제 Chrome/BDO 입력·CPU package/evidence budget/cleanup/V1 fallback/rollback과 T014 usable release artifact. T009/T011/T012 미완료라도 Warehouse usable 범위 검증 가능.

### Later full automatic apply — G0~G5

G0: provenance/hash/labels/split/leakage 검사와 variation 누락 보고.

G1: 동일 manifest의 V1/V2를 field/slot/full capture/stratum로 평가. wrong/unknown/correct REVIEW를 구분하고 HIGH 전체 payload를 truth와 비교.

G2: frozen golden/새 독립 holdout wrong HIGH=0, fully verified HIGH proposals>0. 독립 group 수와 capture-group upper risk bound/대표성/scope를 보고하며 Sol이 승인한 허용 risk·최소표본을 충족. 0오류만으로 PASS 불가.

G3: shadow HIGH audit/완전 truth capture의 unknown·선택편향 명시, 해당 scope wrong HIGH=0. 실사용 coverage/확인 슬롯/수정량 기록. audited slot만 맞았다고 전체 capture exact로 계산하지 않음.

G4: 실제 Chrome/BDO resize/minimize/hover/DPI/다중 모니터, 격리 CPU package/Python 없는 실행/cleanup/rollback/main-data 보존 PASS.

G5: release-policy에 deterministic-derived cutoffs, scope별 confidenceLevel/허용 upperBound/최소 independentGroups, coverage·CPU-memory-package-startup 예산이 측정 artifact로 승인됨. 미확정 null이면 auto OFF.

G0~G3 + warehouse auto policy 승인은 T009 비활성 integration 선행 gate, G4~G5는 T013/T014 이후 생산 auto 활성화 gate다. 테스트 policy/flags는 copy DB만 사용한다. 미측정 gate는 BLOCKED, 0 HIGH/0오류는 NOT_EVALUABLE. Trade T010 실험과 Warehouse U0~U3는 T009/G5 완료에 의존하지 않는다.

## Shadow mode

같은 입력의 V1/V2 결과를 비교한다. V1의 정상 review/적용은 기존 동작이고 V2는 main stock/session/revision을 쓰지 않는다. V2는 sidecar prediction과 필요한 exception crop만 남긴다. V1/V2 차이와 human label은 run/hash로 연결한다. V1 결과를 그대로 ground truth로 삼지 않는다. remote 후보는 이번 사양에서 API 호출을 허용하지 않으며 미측정 항목을 null로 두고 Sol 재설계 대상으로 남긴다.

## Workload / classification definitions

대상은 VALID capture의 tier1~4 non-SKIP slots이며 verifiedFields/truth availability를 분모와 함께 출력한다. field exact와 slot exact(item+quantity 모두 exact)를 나눈다. 결과는 correct HIGH/wrong HIGH/correct REVIEW/wrong REVIEW/REJECT/unreadable로 보고한다. unreadable은 REVIEW/REJECT와 겹치는 reason count이므로 합계에 중복 더하지 않는다. 후보가 없거나 truth가 없는 REVIEW는 correct/wrong으로 추정하지 않고 unknownReview/unverified다. correct REVIEW는 exact top candidate를 가지고도 REVIEW인 불필요 개입이다. R0 MATCH를 V2 HIGH로 바꾸지 않고 proposal 통계와 실제 UI workload를 나란히 둔다.

reviewSlotsPerCapture = capture별 REVIEW 슬롯수와 mean/median/p95(분모 VALID captures). capturesRequiringReview = REVIEW≥1 VALID capture수; 비율은 /VALID captures. noReviewCaptures = VALID/nonempty이며 unresolved·non-SKIP REJECT 없이 모든 대상 HIGH인 수. touchlessRecognitionRate = noReviewCaptures/VALID nonempty target captures; 초기 적용 클릭은 이 **인식** 지표에서 제외하고 무인 DB 적용으로 부르지 않는다. 예외 수동 제외/malformed input을 버려 touchless 성공으로 세지 않는다.

fullCaptureExactRate = 모든 대상 slots 및 EMPTY/TIER5/OOD/duplicate 의미가 truth와 exact인 capture수/전체 target truth verified VALID captures. unverified capture는 분모 제외와 미평가수 동시 보고. captureInvalid/rejected 비율은 total inputs 분모로 함께 출력하여 VALID 조건부 accuracy가 낮은 수용률을 숨기지 않는다. field/slot/full capture/profile-stratum 결과 필수.

Warehouse product 지표: total/no-review/review captures, mean review slots, item·quantity corrected fields, captureInvalid, audited wrong HIGH, paired reviewDeltaVsV1. V1 실제 UI는 MATCH 포함 전체 대상 슬롯을 노출하므로 V1VisibleReviewSlots와 reader correct-but-UNKNOWN을 구분한다. Trade: batches/confirmed/review/rejected/partial rows/edited fields, fullListExactRate(완전 목록 truth가 검증된 batches만 분모). completeness UNKNOWN이면 exact=null이다. 같은 run/retry는 중복 집계하지 않는다.

digit confusion(0/1/3/5/8 등), item-vs-quantity wrong, correct REVIEW reason(margin/calibration/layout/crop), reader disagreement, 품목/seed, profile·scale·frame resampling, trade column lane/partial/counter 오류를 evidence ID로 연결한다. wrong HIGH 증가 없이 correct REVIEW/workload를 줄이는 paired evidence로 채택하며 통계 한계도 보고한다. risk 객체/단측 binomial은 [confidence-policy.md](confidence-policy.md), confidenceLevel/허용위험/최소표본은 미확정이다. audit seed/선택확률/확인 분모도 export한다.
