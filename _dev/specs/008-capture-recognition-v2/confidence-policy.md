# Confidence / Auto Apply Policy

## Meaning

V1 MATCH는 HIGH와 다르다. raw similarity/distance, OCR engine confidence, calibrated correctness를 섞어 평균내지 않는다. 최종 decision은 **hard gates AND calibrated frontier**다. 불확실하면 abstain한다.

HIGH: 현재 engine/model/profile/catalog/threshold hash가 승인된 stratum이고, layout/slot/token/crop/identity/quantity evidence가 모두 통과함. REVIEW: 값 후보는 있지만 근거/검증/duplicate/scope가 부족함. REJECT: wrong task/layout/corruption/clipping 때문에 안전한 후보 제안을 할 수 없음. SKIP: 확정 EMPTY/TIER5, 해당 business rule로 patch 대상 아님.

| 요소 | HIGH 필요 조건 |
|---|---|
| layout/slot | approved anchor set, scale, 완전한 row/slot geometry; 모호한 anchor 없음 |
| item | 검증 stratum의 score+margin+OOD gate, eligible canonical, reader 불일치 없음 |
| quantity | VALUE, full-token/여백/digits gate, 문자열 exact agreement, 검증 digit length |
| UI quality | clipped/hover/occluded/black/stale frame reason 없음 |
| consistency | duplicate/candidate collision 없음; trade 6필드 모두 확정 |
| calibration | frozen training/calibration split의 policy와 새로운 holdout PASS |
| apply guard(인식 정확도와 별도) | captured revision unchanged, queue idle, pending completion 없음; stale는 인식 HIGH를 재분류하지 않고 저장 보류 |

`layoutConfidence`/`slotConfidence`는 수치 feature일 뿐 이 값 단독으로 probability를 주장하지 않는다. `confidence` 객체는 features+policyDecision+reasonCodes+empiricalStats로 반환한다. probability가 calibration되지 않으면 null이다.

## Policy artifact

`policy.json={version:1,policyId,engineHash,modelHashes,catalogHash,anchorSetHash,parameters,allowedStrata,calibrationManifestHash,goldenManifestHash,metrics,usableReviewApproved:false,releaseApproved:false,audit,risk}`. 각 allowed stratum은 source/profile/frame/UI geometry/digit-length/task/field scope를 정의한다. 숫자 cutoff와 coverageTarget은 **현재 미확정**이다. 기본 artifact에서 parameters={} / allowedStrata=[] / usableReviewApproved=false / releaseApproved=false. usableReviewApproved는 HIGH 상세 생략만 허용하며 auto 저장 권한을 주지 않는다. 0.35/0.045/0.03을 자동 승인 threshold로 복사하지 않는다.

T001/T007A의 grouped calibration에서 deterministic candidate grid/frontier를 생성한다. 관측 score/margin/digit/geometry breakpoints에서 후보를 도출하고 derivation rule/hash/seed/tie-break를 기록한다. wrong HIGH, correct REVIEW, capture workload/coverage 및 scope 위험 상한을 계산해 candidate-policy.json을 만든다. T007B에서 Sol이 독립 validation/holdout과 근거를 검토해 usableReviewApproved와 후속 releaseApproved를 각각 승인한다. Luna/Sol 모두 임의 cutoff를 발명하지 않는다. validation error가 나오면 holdout을 보고 cutoff를 다시 맞추지 않는다. 새 engine revision/새 split/새 holdout으로 재검토한다. 관찰되지 않은 profile/item-pair/digit length는 HIGH whitelist에 넣지 않는다. per-reader agreement 오류 상관을 별도로 보고한다.

## Warehouse policy

모든 대상 non-SKIP slot이 HIGH, patch nonempty, profile/정책 gate PASS인 경우만 automationEligible=true. 하나라도 REVIEW/REJECT면 **전체 capture automatic commit 금지**. VALID capture의 HIGH는 요약, 예외만 펼치며 초기 사용자 전체 적용을 허용한다. CAPTURE_INVALID는 patch 없이 재캡처 한 번만 안내한다. 수동 적용은 기존 partial stock absolute patch와 review 합산 의미를 보존한다. tier5/EMPTY/미검출을 재고 0으로 변환하지 않는다.

현재 회차에 생성된 schedule/completed가 있으면 초기 릴리스 auto apply는 보류하고 기존 수동 창고 review로 보낸다. 인식 재고가 기존 계획의 기준을 바꾸는 효과를 자동화로 숨기지 않는다. 영구 target/설정/slot은 변경하지 않는다.

## Server auto apply endpoint

`POST /api/recognition/warehouse/<recognitionId>/apply` input exact `{mutationId,baseRevision,proposalHash}`. output `{ok:true,revision,idempotent,recognitionId}`. patch는 immutable server run에서 재구성하고 frontend가 HIGH/stock 값을 보내지 않는다. `proposalHash=sha256(canonical master_inventory_patch)`이며 report/engine/profile hash도 sidecar run에 고정한다.

서버는 flags recognitionV2/autoApplyHighConfidence, releaseApproved, policy/model/catalog/profile equality, all HIGH, captured revision==request baseRevision, fresh server receive timestamp(같은 active capture workflow 안), current working_session schedule 없음을 확인한다. capture freshness의 최종 허용 시간은 latency/사용 실사 후 policy에 잠그며 미확정이면 auto OFF. profile/flag/policy 변경은 pending authority를 취소한다.

기존 `validate_inventory_patch`에 서버 생성 `{mutationId,baseRevision,kind:"warehouse",patch}`를 통과시키고 `Storage.update_inventory(...,feedback=None)`를 호출한다. 기존 `/api/inventory` contract/main schema는 변경하지 않는다. confidence policy는 main mutation 직전 같은 guarded operation에서 다시 확인한다. `/api/recognition/*`의 작업도 shutdown drain에 포함한다.

동기화는 앱 프로세스 공용 `recognition_authority_lock` RLock을 사용한다. config/profile 변경과 최초 automatic apply 모두 이 lock을 취득한다. lock 순서는 authority lock → 해당 recognitionId의 run lock → sidecar PREPARED transaction → main mutate이며 sidecar transaction은 main mutate 전에 종료한다. 정책/flag 재검사부터 main commit까지 authority lock을 유지한다. config OFF가 완료된 뒤 시작되는 apply는 거부하고, 이미 commit 중인 저장은 결과를 확인한다. 별도 lock 순서를 Luna가 임의로 바꾸지 않는다.

## Idempotency / lost-response contract

sidecar apply_intent은 main DB와 분리돼 있으며 두 DB를 원자 commit한다고 주장하지 않는다. 순서: sidecar에 runId/동일 mutationId/bodyHash/기준 revision을 PREPARED로 고정 → main mutate → sidecar APPLIED receipt 기록. recognitionId당 automatic intent는 하나만 bind한다. 다른 mutationId로 같은 run을 적용하는 요청은 거부한다. 동시 요청은 per-run lock+sidecar uniqueness로 serialize한다.

성공 응답 유실 시 **같은 mutationId/baseRevision/bodyHash**만 재전송한다. main의 mutation_receipt를 읽어 성공을 확인하며 이미 저장됐으면 현재 flags가 OFF여도 새 mutation 없이 기존 성공을 반환할 수 있다. PREPARED는 config OFF일 때 새 main mutation을 실행하지 않는다. main 성공/sidecar final 실패면 reconciler가 receipt로 APPLIED를 복구한다. receipt가 128개 이후 제거됐고 성공 여부를 입증할 수 없으면 COMMIT_UNKNOWN, 사용자 read-back 필요; stock 값이 같다는 이유로 성공 또는 재적용을 추정하지 않는다.

409이면 STALE_RECOGNITION. 최신 revision을 붙여 자동 재전송하지 않는다. 기존 수동 review로 옮기거나 새 capture한다. READBACK_FAILED but committed는 성공 기록을 보존하고 재조회만 한다. 브라우저 session에 미확인 intent를 유지하여 UI 재클릭으로 새로운 mutation을 만들지 않는다. page reload 뒤에는 sidecar의 pending 상태를 조회한다.

## Flags / activation

기본: recognitionV2=false, autoApplyHighConfidence=false, nativeCapture=false, remoteFallback=false, debugCapture=false. recognitionV2 ON의 최초 상태는 shadow다. usableReviewApproved 및 T008/U0~U3 이후 예외 검수·사용자 수동 적용을 허용한다. autoApplyHighConfidence=false는 usable V2 수동 적용을 막지 않는다. autoApplyHighConfidence ON도 승인된 정책 scope에서만 동작한다. native/remote를 ON하는 config 요청은 이번 구현에서 unsupported_feature로 거부한다.

잘못된 HIGH가 shadow/golden에서 1건이라도 발생하면 해당 scope는 release 후보가 아니다. release 후 human correction에서 HIGH error가 확인되면 해당 engine/policy automatic authority를 즉시 OFF하고 구체적인 capture/label로 재현한다. 과거 stock을 자동 undo하지 않는다.

## Usable policy / shadow audit / statistical risk

usableReviewApproved는 frozen HIGH 표시 정책의 권한이다. field/slot/capture/stratum별 wrong HIGH·correct REVIEW를 비교하고 wrong HIGH scope는 상세 생략 승인을 제외한다. auto releaseApproved에는 별도 G0~G5·독립 group 위험/CPU/package/rollback 승인이 필요하다. audit 빈도·최소 independentGroups·허용 risk·confidenceLevel은 결정 전 null이며 null인 auto-risk 조건은 auto OFF다. usable을 auto 전용 minimumGroups/risk 예산 승인 뒤까지 묶지 않는다.

shadow에는 낮은 빈도 HIGH random audit 또는 periodic full audit를 둔다. audit={strategy:"random-high"|"periodic-full"|"disabled",frequency:null|approvedValue,seed,samplingUnit,policyVersion}; 실사용 shadow 활성화 전 Sol이 초기 자료로 빈도를 승인한다. random-high는 재현 가능한 seed로 slot을 선택하고 필요한 crop을 먼저 보존한다. periodic full은 일부 capture만 전수 확인한다. 일반 usable UX에서는 HIGH 전수검사를 강제하지 않는다. 선택확률/정책·확인 field·미확인 수를 남겨 exception label의 선택편향과 구분한다. capture exact와 group risk는 완전 truth holdout/선택 full audit로 계산하며 random slot audit만으로 capture 전체 exact를 주장하지 않는다.

risk={unit:"capture-group-any-wrong-HIGH",scope,independentGroups,evaluatedCaptures,evaluatedHighSlots,observedWrongHighSlots,groupsWithWrongHigh,confidenceLevel,upperBound,method:"one-sided-exact-binomial",independenceAssumptions,unverifiedGroups}. frame/파생 crops/연속 capture·회차는 source session/day group으로 묶고 어느 HIGH라도 wrong이면 error group이다. 같은 scope의 독립 Bernoulli group이라는 가정이 성립할 때만 binomial bound를 release 근거로 사용한다. 서로 다른 strata를 합쳐 missing scope를 통과시키지 않으며 미확인 HIGH group은 fully evaluated로 세지 않는다.

alpha=1-confidenceLevel, n=독립 fully labeled eligible groups, k=error groups. n=0이면 upperBound=null/NOT_EVALUABLE. k=0이면 U=1-alpha^(1/n). 0<k<n이면 binomial CDF(k;n,U)=alpha를 [0,1]의 deterministic bisection으로 풀고 k=n이면 U=1. n/k/방법/수치 tolerance/scope를 남긴다. [NIST exact binomial bounds](https://itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm)의 단측 방식에서 도출한 설계식이며 confidenceLevel/허용 upperBound는 현재 선택하지 않는다. 독립성·대표성 부족이면 riskStatus=INSUFFICIENT/assumptionWarnings를 남기고 추가 수집·scope 제한을 Sol에 반환한다. 0 wrong만으로 PASS 불가.
