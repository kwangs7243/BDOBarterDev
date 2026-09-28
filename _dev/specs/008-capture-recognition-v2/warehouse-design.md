# Warehouse Recognition Design

## Pipeline / Ownership

실사용 V1은 대부분 맞는 frozen R0다. 목표는 wrong acceptance와 correct REVIEW를 함께 줄이는 것이다. 대상은 1~4단 56종이며 5단은 사용자 수동 관리 business rule로 SKIP한다.

capture_normalization → capture validity → validated layout → per-slot raw+normalized crops → item evidence → quantity evidence → global duplicate/OOD checks → confidence_policy → report. V1 convert와 reference/quantity_templates는 변경하지 않는다. V2 services는 resource를 읽기만 한다. 새 calibration/model은 recognition_data에 버전/hash와 함께 따로 저장한다.

## Functions

`normalize_capture(image,profile,anchor_data) → NormalizedCapture{image,validity,transform,layoutEvidence,qualityReasons,profileStratum}`.

`recognize_items(icon_crop,reference_bundle) → ItemEvidence{candidates:[{programName,itemId,distance,readerId}],top1Margin,agreement,oodReasons}`.

`recognize_quantity(raw_quantity_crop,normalized_quantity_crop,quantity_bundle) → QuantityEvidence{status,value,rawText,digitEvidence,tokenBox,qualityReasons,agreement}`.

`recognize_warehouse(capture,profile,engine_bundle,policy) → WarehouseReportV2`. recognizer에는 oracle/현재 stock/target을 전달하지 않는다. 기존 stock으로 숫자를 추론하지 않는다.

## Item candidates

R0=기존 color+structure 거리 재사용 읽기 baseline. R1=normalized grayscale NCC와 color evidence를 별도로 제공. brightness 정규화는 calibration에서 고정, denominator=0이면 reject한다. pHash는 색을 잃으므로 단독 item authority가 아니다. template ROI는 quantity 영역을 제외한다. raw와 normalized 각각의 candidate가 불일치하면 REVIEW다.

Dual agreement는 정확히 같은 programName을 독립 비용이 낮은 두 reader가 제안했을 때의 feature다. 동일 score를 다른 threshold로 판단한 것은 두 reader로 세지 않는다. 두 reader가 같은 training crop/source를 공유하는 오류 상관과 일반품 OOD를 별도 negative set으로 측정한다. agreement만으로 HIGH를 만들지 않는다. 유사 seed 쌍은 confusion-pair strata로 분리한다.

## Quantity candidates and full-token guards

Q0=frozen fixed-cell reader, Q1=raw token connected-component segmentation+digit/blank template 비교. 목적은 Q0의 고정 위치 가정과 별도 geometry evidence를 확보하는 것이다. Q1 구현 실험 입력 규격: white-neutral mask, connected components, component boxes/ordering, grayscale crop, glyph size normalization을 모두 versioned parameter로 기록한다. mask/spacing/blank limit은 calibration-derived policy가 없으면 후보만 제안한다.

Q1은 token bounding box와 좌/우 안전 여백, stroke가 crop 경계에 닿는지, component merge/split, 숫자 외 punctuation, digit별 top2 margin을 반환한다. 모든 digit와 전체 token이 검증된 경우만 value를 만든다. 0~9 label coverage가 없는 classifier/template는 해당 digit를 확정하지 않는다. 4자리를 초과하는 숫자가 더 있을 가능성을 검사하고 잘린 5자리→4자리 결과를 HIGH로 하지 않는다. 양수인지 여부로 string을 덮어쓰지 않는다.

Q0/Q1 exact string agreement와 full-token 품질은 feature이며 최종 threshold는 deterministic policy derivation으로 후보를 만들고 Sol이 측정 artifact를 승인한다. 어느 reader가 unknown이거나 불일치하면 기본 REVIEW다. 한 reader가 unknown이어도 다른 evidence로 안전하게 확정 가능한지는 별도 calibration 후보로 측정할 수 있지만 artifact 없이 guard를 완화하지 않는다. raw-digit crop과 정규화 crop이 충돌하면 crop 재표본화 오류 가능성을 이유로 표시한다. quantity 0을 실제로 읽은 `VALUE,0`과 숫자 부재 `MISSING,null`을 구분한다. 숫자가 안 보이면 1/0을 추정하지 않는다.

## Report schema v2

공통 `{version:2,recognitionId,captureId,taskType:"warehouse",engineVersion,engineHash,modelVersion,modelHashes,parameterHash,policyHash,catalogHash,anchorSetHash,profileHash,profileId,profileVersion,input:{sha256,width,height,fidelity},validity,automationDecision,layout,quality,timing,slots,patchProposal,automationEligible}`. input.path는 없다. latencyMs는 측정값, 메모리 unavailable이면 null.

slot: `{slot,row,column,boxes:{raw,normalized,icon,quantity},decision,automationDecision,reasonCodes,item:{value,candidates,rawScores,top1Margin,agreement},quantity:{status,value,rawText,digits,tokenQuality,agreement},calibration:{stratumId,supported,probability:null},labelStatus:"unverified"}`.

quantity.status: VALUE/MISSING/UNREADABLE/CLIPPED/NOT_APPLICABLE. quantity value는 VALUE일 때만 0..MAX_SAFE_INTEGER 정수, 다른 status에서는 null. rawScores는 reader별 방향(lower/higher better)을 포함한다. calibrated probability가 없는 상태의 null을 0/1로 바꾸지 않는다.

semantic decision은 기존 MATCH/EMPTY/TIER5_IGNORE/ICON_MATCH_UNKNOWN/QUANTITY_UNKNOWN/DUPLICATE_ITEM_DETECTED에 맞춘다. automationDecision은 HIGH/REVIEW/REJECT/SKIP(EMPTY/TIER5) 별도다. V2 MATCH라도 calibration이 없으면 REVIEW다. REJECT/SKIP에는 patch entry가 없다. 입력 validity 실패는 CAPTURE_INVALID/automationDecision=REJECT, slots=[]/patchProposal=null이다. 정상 입력의 국소 불확실성만 REVIEW다.

## Whole-patch safety

값은 누적 증분이 아닌 스캔 당시 절대 stock이다. absent/empty item은 existing stock을 0으로 만들지 않는다. EMPTY/TIER5로 확정된 slot은 SKIP이며 숫자 unknown이어도 auto 대상 분모에 포함하지 않는다. unknown 일반품이 target item일 가능성이 남으면 REVIEW다.

동일 finalItem, 또는 REVIEW candidate가 HIGH 품목과 충돌하는 경우 전체 capture 자동 적용을 보류한다. 자동 합산하지 않는다. 수동 합산은 기존 patch-review 명시적 수정/적용 의미를 유지한다.

`patchProposal={type:"master_inventory_patch",version:1,items}`는 eligible item의 **제안**이며 stock 저장을 뜻하지 않는다. 초기 usable V2는 HIGH 상세 검수를 생략하고 REVIEW만 확인한 뒤 사용자가 전체 patch를 한 번 적용한다. HIGH 상세 열기는 선택 사항이다. 후속 auto는 ALL_HIGH/nonempty 및 별도 release gate를 통과해야 기존 validator/Storage.update_inventory를 호출한다. HIGH 먼저 저장→REVIEW 나중 합산은 초기 릴리스에서 하지 않는다.

실제 7 wrong MATCH 원인은 아직 재현되지 않았다. 숫자 위치/threshold/scale가 코드상 취약점이라는 점과 실제 원인을 구분한다. 첫 개선 Task는 해당 error crop 재현과 fixture화이며 특정 알고리즘의 개선을 미리 주장하지 않는다.

## Usable V2 transaction / replay

VALID capture → per-slot policy → HIGH 요약 + REVIEW slots. 예외를 확정/수정/제외한 뒤 HIGH+final REVIEW를 canonical item/quantity/duplicate 검사하여 전체 absolute stock patch를 구성한다. 제외는 명시적인 수동 선택이며 fullCaptureExact/touchless 성공에서 제외한다. 예외가 없어도 초기에는 사용자 적용 클릭을 한 번 요구한다. 저장은 기존 saveWarehouseInventory(items)→PATCH /api/inventory의 한 main transaction이며 sidecar label과의 원자성은 주장하지 않는다. 적용 직전 revision/대상 stock/queue/pending/session guard를 다시 확인한다.

R0 replay는 item-only/quantity-only/both exact, original MATCH/UNKNOWN, correct-but-REVIEW, wrong MATCH, unreadable/missing을 교차 분류한다. seed margin/숫자0·1·3·5·8/icon crop 내 숫자/일반품/font mask/scale/reader 불일치 원인을 truth crop에 연결한다. 정답 abstain이 margin/calibration 때문인지 geometry/crop 때문인지 구분한다. wrong HIGH 증가 없이 correct REVIEW·capture당 review slots를 줄인다는 paired evidence 없이는 후보를 채택하지 않는다.
