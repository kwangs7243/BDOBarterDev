# 02 · 기준 이미지 bank와 matcher

## 1. 자료 구조와 함수 계약

다음 타입은 dataclass 또는 같은 키를 갖는 immutable dict로 구현한다. 필드 의미·반환 상태는 바꾸지 않는다.

```text
LayoutProbe(valid, offset_x, anchor_supports, reason)
MatchContext(kind, field, source_tier, destination_tier, to_item,
             frame_size, row_box, layout, name_field)
TemplateMatch(status, value, reference_ids, method, score, margin,
              matched_box, reason, timings)
status = HIT | ABSTAIN | ERROR
method = EXACT_RGB | CALIBRATED_GLYPH_23
```

`probe_layout(image, metadata)`, `build_bank(dataset, split, baseline, config)`, `calibrate(bank, calibration_samples, config)`, `match(row, context, bank, config)`를 공개 함수로 둔다. match는 파일 쓰기·학습·bank 갱신을 하지 않는다. reason은 고정 enum을 사용한다.

kind enum은 `YIELD_23, YIELD_BLACKSTONE, NAME_ISLAND, NAME_FROM_ITEM, NAME_TO_ITEM`이다. type/field 이름이 같은지 임의로 추정하지 않고 이 enum으로 통계·bank·보고서를 연결한다.

`LAYOUT_UNSUPPORTED, ANCHOR_UNCERTAIN, COVERAGE_SUSPECT, CONTEXT_UNCERTAIN, RULE_ALREADY_FIXED, NO_REFERENCE, CROP_INCOMPLETE, AMBIGUOUS_REFERENCE, NO_EXACT_MATCH, GLYPH_UNCERTAIN, CALIBRATION_DISABLED, DISTANCE_REJECTED, MARGIN_REJECTED, OUT_OF_CATALOG, TEMPLATE_ERROR`를 사용한다.

## 2. 문맥 자격

수량 matcher 호출 전에 source/destination 이름이 catalog의 정확한 canonical 값이며 reviewRequired=false인지 확인한다. 기존 OCR 이름이면 confidence≥0.90, VERIFIED_TEMPLATE 이름이면 유효한 reference evidence가 있어야 한다. recognizedStage만 있는 추측 단계로 숫자를 자동 확정하지 않는다.

V1 자격은 (sourceTier,destinationTier)가 (1,2)/(2,3), field=yield, 기존 TRADE_RULE이 아닌 경우다. V2의 추가 자격은 toItem이 정확히 `파도의 블랙스톤`, field=yield인 경우다. `블랙스톤` substring으로 다른 품목까지 포함하지 않는다.

## 3. crop 좌표

frozen detector의 원본 rowBox를 사용한다. 유효한 layout offset x가 있으면 전체 row를 `image.crop((offset_x, top, width+offset_x, bottom))`로 정렬한다. 화면 밖 padding이 실제 비교 crop을 침범하면 ABSTAIN한다. row를 확대·축소하거나 y 좌표를 추정 보정하지 않는다.

EXACT 수량 crop은 설정의 guardBounds=(.645,.45,.745,.99)다. v13 `_crop`와 동일하게 각 경계를 Python round로 계산한다. 숫자의 일부만 잘라 비교하지 않도록 원래 yield box보다 넓은 영역을 사용한다. crop은 원본 RGB, width/height 그대로다.

이름 crop은 frozen bounds를 사용한다: island (.063,.05,.241,.48), fromItem (.340,.10,.558,.47), toItem (.714,.10,.931,.87). row가 완전하고 crop 전체가 원본 안에 있어야 한다. 이름 비교용 RGB를 회색으로 바꾸거나 threshold로 글자를 지우지 않는다.

좌표·offset·원본 rowBox·cropBox·원본 image hash는 reference에 저장한다. 결과 preview box는 현재 이미지 좌표로 만든다. 과거 captureId나 과거 box를 결과 필드에 복사하지 않는다.

## 4. EXACT bank

reference의 필수 내용:

```text
referenceId, bankVersion, kind, label, truthId, truthClass,
sourceGroupId, sourceImageSha256, sourceRowBox, sourceCropBox,
frameSize, rowHeight, sourceTier, destinationTier, toItem,
rgbShape, rgbSha256, cropFile, extractorVersion, catalogSha256
```

context key는 다음과 같다.

- 수량: kind + sourceTier + destinationTier + toItem + rowHeight + crop shape + extractor version.
- 이름: kind(name_field 포함) + rowHeight + crop shape + extractor version. 이름 label을 검색 key에 넣지 않는다.
- 어느 경우든 bank에 baseline model bundle, baseline source, catalog, config hashes를 기록한다.

등록 시 같은 context와 RGB bytes가 서로 다른 label에 연결되면 해당 key 전체를 quarantine한다. 같은 label의 반복은 evidence 목록으로 합친다. 후보는 각 context/label당 최대 8개, 전체 최대 4096개다. 정렬은 truthClass 우선(USER_CORRECTION, USER_CONFIRMED_FIELD, EXISTING_ORACLE), sourceGroupId, source image hash, truthId 순이다. 이 순서로 앞의 항목을 보관하고 나머지는 `BANK_CAP_EXCLUDED`로 기록한다.

lookup은 context와 RGB shape/hash를 찾은 후 **원본 RGB bytes까지 확인**한다. exact label이 정확히 하나이면 HIT, 없거나 여러 label이면 ABSTAIN한다. 검색 대상이 64개보다 많으면 임의 일부를 비교하지 않고 해당 lookup을 ABSTAIN한다. 정답값은 reference label에서 가져오며 과거 OCR 예상값에서 가져오지 않는다.

bank는 `bank.json`, `references/*.png`, `calibration.json`으로 저장한다. bankVersion은 baseline source+model bundle+extractor code+config+catalog+정렬된 reference/label/evidence hashes를 canonical JSON으로 직렬화한 bytes의 SHA-256이다. 이미지·정답·설정·판독 코드 변경 시 version이 바뀌어야 한다. 로딩 중 hash/파일/enum 불일치는 bank 전체를 비활성화하고 baseline으로 실행한다.

## 5. V1의 선택적 glyph 비교

이 절은 EXACT 이후 NO_EXACT_MATCH일 때만 적용한다. 블랙스톤·이름은 이 절을 사용하지 않는다.

### 추출

frozen `_outlined_quantity_image(row,'yield')` 알고리즘을 실험 모듈 안에 그대로 옮겨, 반환값에 **추출 bbox와 guard 좌표**만 추가한다. 기존 함수는 수정하지 않는다. 모든 지원 표본에서 기존 filtered RGB/group count와 동일함을 시험한다. 숫자를 잘라 단순한 2/3으로 만드는 별도 후처리를 넣지 않는다.

추출 불가·경계 접촉이면 ABSTAIN한다. guard 안에서 같은 baseline band(top-2 .. bottom+2)에 있는 outlined white component를 확인한다. component height≥추출 glyph height의 0.6이며 component bbox가 추출 bbox를 1px 확대한 영역 밖에 있으면 추가 숫자 가능성으로 ABSTAIN한다. component를 지워 결과를 맞추지 않는다.

filtered image의 black padding을 제거해 foreground bitmap을 만든다. width≤128, height≤32, reference와 width/height 차이가 각각≤1인 경우만 비교한다. resize·비율 변형은 하지 않고 canvas에 padding한다. 2/3의 한 글자 reference만 허용한다. projection group count가 1이 아니면 ABSTAIN한다.

### 거리

candidate/reference의 bitmap을 dx,dy∈{-1,0,1}로만 비교한다. shift로 ink가 canvas 밖으로 사라지는 경우는 무효다. 최소 Dice distance `1 - 2*intersection/(inkA+inkB)`를 사용한다. 각 label의 최소 거리와 그 reference를 찾는다. 다른 label의 최소 거리에서 best distance를 뺀 것이 margin이다. tie 또는 다른 label reference가 없으면 ABSTAIN한다.

같은 shift에서 원래 guard RGB의 평균 절대 차이(byte 단위 MAE)도 제한한다. 숫자 모양만 비슷하고 guard가 다른 표본을 강하게 확정하지 않는다. `distance≤T`, `margin≥M`, `guardMae≤G`를 모두 만족해야 한다. 이 view는 검사 근거이며 OCR confidence로 바꾸지 않는다.

### calibration 결정

- ENROLL에서 label 2와 3 각각 서로 다른 sourceGroup 2개 이상, CALIBRATION에서도 각각 2개 이상이 있어야 한다. 부족하면 근사 비교는 `CALIBRATION_DISABLED`다. EXACT는 계속 사용할 수 있다.
- 설정의 T×M×G grid를 전부 평가한다. calibration의 모든 확인된 target·비대상·adversarial 사례에서 wrong-auto-accept가 0인 조합만 남긴다.
- 남은 조합 중 올바른 HIT 수 최대 → T 최소 → M 최대 → G 최소 순으로 하나를 고른다. 고정값 외 탐색·재분할·TEST를 보고 튜닝하지 않는다.
- 올바른 HIT 0이거나 조건을 만족하는 조합이 없으면 disabled로 저장한다. 기준을 느슨하게 하라는 구현자의 판단은 필요하지 않다.
- test 결과가 나쁘면 그 버전은 NO_GO다. test를 다시 calibration에 넣지 않는다.

## 6. 반환과 예외

HIT는 label·referenceIds·method·distance/margin·현재 matchedBox·bankVersion을 반환한다. ABSTAIN은 value=null과 reason을 반환한다. matcher 예외는 ERROR/TEMPLATE_ERROR로 잡아 sidecar에 기록하고 기존 판독을 계속한다. baseline의 예외 처리까지 성공 결과로 바꾸지 않는다.

EXACT를 먼저 검사하고 HIT면 glyph 비교를 하지 않는다. matcher 결과를 다음 표본의 새 reference로 자동 추가하지 않는다. 사용자 확인 자료를 반영할 때도 S1/S2에서 새 bank를 만들고 전체 검증을 다시 한다.
