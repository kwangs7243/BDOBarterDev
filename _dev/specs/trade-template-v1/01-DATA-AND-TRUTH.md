# 01 · 자료와 정답 계약

## 1. 입력과 파일

`BASELINE-MANIFEST.json`의 dataSources, priorBaselineReplays, snapshotFiles만 읽는다. live AppData DB를 검색해 추가하지 않는다. 각 source의 SHA-256을 먼저 검증한다. source path가 없어도 비슷한 DB를 자동 검색하지 않는다.

S1 산출물은 다음과 같다. 전부 `runRoot/<runId>/data/` 안에 둔다.

| 파일 | 내용 |
|---|---|
| `inventory.json` | source별 records, capture IDs, 이미지 hash 수, frame·phase·worker 분포 |
| `captures.jsonl` | 이미지 1개당 원본 메타데이터와 모든 출처 membership |
| `truth.jsonl` | 필드별 정답·범위·원본 증거 |
| `quarantine.jsonl` | 충돌, 잘못된 geometry, 불명확 row 매핑, 부적격 라벨 |
| `split.json` | source group과 ENROLL/CALIBRATION/TEST/LEGACY_EVAL 역할 |
| `baseline-index.json` | 고정 baseline 응답의 입력·소스·모델 fingerprint |
| `png/<imageSha256>.png` | 중복을 제거한 실제 원본 PNG |

DB는 `sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)`로 연결한다. `trade_correction`은 `feedback_id,capture_id,created_at,image_png,details_json`을 읽는다. rowid 순서는 정답 우선순위가 아니다. stream으로 읽고 모든 BLOB를 한꺼번에 메모리에 올리지 않는다. 창고 기록은 수만 audit하고 template 자료로 혼용하지 않는다.

최근 77개 index와 최근 15개 index의 absolute imagePath는 사용자 이름을 추측해 재작성하지 않는다. manifest root와 일치하는 위치를 확인한 후 읽고, hash로 DB 자료와 합친다. 같은 이미지가 여러 source에 있어도 원본은 1개, membership은 모두 유지한다.

## 2. 이미지·행 identity

- 이미지 identity: 원본 PNG bytes SHA-256. 별도로 decoded RGB+dimensions hash도 기록한다. PNG encoding만 다른 동일 픽셀은 같은 split group으로 묶는다.
- source membership: source ID, feedback_id 또는 index 위치, captureId, batchId, createdAt/capturedAt, phase, workerVersion, metadata.
- row identity: decoded-image hash와 **실제 rowBox**. captureId+ordinal만으로 다른 버전의 행을 연결하지 않는다.
- 현재 고정 detector로 행을 찾고, 과거 rowBox와 IoU≥0.90인 행이 정확히 하나일 때만 연결한다. 불명확하면 `ROW_MAPPING_AMBIGUOUS`로 격리한다. 전체 rowBox의 면적·경계를 검사한다.
- legacy oracle은 mapping의 oracleRows 순서를 사용하되, 검출 행 수와 기대 행 수가 다르면 순서대로 억지 zip하지 않고 그 이미지의 필드 정렬을 미확정으로 보고한다.

## 3. 정답 자격

| truthClass | 자동 bank 등록 가능 여부 |
|---|---|
| `EXISTING_ORACLE` | 기존 정답 JSON과 mapping이 명확한 경우 가능. legacy 크기는 현재 자동 layout 자격에서 다시 제외됨 |
| `USER_CORRECTION` | corrections entry의 finalValue. 원본 geometry와 필드가 매핑되고 충돌이 없으면 가능 |
| `USER_CONFIRMED_FIELD` | reviewed snapshot에서 **그 필드의** valueSource=USER_REVIEW, reviewRequired=false, row.excluded!=true이면 가능 |
| `BASELINE_CANDIDATE` | OCR·MASTER·CONSTRAINED_OCR·CONSENSUS 결과. 비교 자료이며 bank 정답으로 쓰지 않음 |
| `UNLABELED` | 정답 없음. 오답률 분모에 넣지 않음 |

근거 코드: frozen `frontend/js/trade-live-list-ui.js`는 검수 입력 필드만 USER_REVIEW로 바꾸고, 단순 회차 적용도 reviewed snapshot을 남긴다. 그러므로 phase=reviewed 전체를 정답으로 취급하면 안 된다. `TRADE_RULE`은 관측 수량의 정답 이미지가 아니다.

corrections entry의 현재 형식은 `captureId,ordinal,rowBox,field,box,rawOCR,confidence,automaticCorrected,finalValue`다. UNKNOWN/null/빈 값, 숫자 bool·음수, yield/reqAmount=0, catalog 밖 이름은 bank에 넣지 않는다. count=0은 유효한 정답이며 평가에는 남기되 이번 matcher 대상으로 쓰지 않는다.

동일 원본·동일 행·동일 필드에서 서로 다른 확인값이 발견되면 **전체 충돌 집합을 quarantine**한다. 마지막 기록을 임의로 정답으로 선택하지 않는다. 같은 값의 중복 확인은 evidence 목록으로 합친다.

truth 레코드의 필수 필드:

```json
{
  "truthId": "sha256-of-canonical-record",
  "imageSha256": "original-png-hash",
  "decodedImageSha256": "rgb-and-size-hash",
  "rowBox": {"x": 0, "y": 0, "width": 987, "height": 70},
  "field": "yield",
  "value": 3,
  "truthClass": "USER_CORRECTION",
  "sourceEvidence": [{"sourceId": "source-id", "feedbackId": "id", "captureId": "id", "entryIndex": 0}],
  "scope": "THIS_FIELD_ONLY"
}
```

위 JSON의 좌표와 id는 형식 예시이며 실제 정답으로 등록하지 않는다. 라벨을 추측해서 예시 값을 복사하지 않는다.

## 4. 분할과 누출 방지

1. 동일 PNG, 동일 decoded image, 동일 captureId, 동일 batchId가 연결하는 membership을 union-find로 묶는다. 같은 원본을 reviewed/recognized로 나눠 다른 split에 넣지 않는다.
2. groupId는 정렬한 decoded-image hash 목록을 LF로 연결한 bytes의 SHA-256이다.
3. `int(sha256((salt + ':' + groupId).encode()).hexdigest(),16)%10`을 계산한다. 설정의 0~4=ENROLL, 5~6=CALIBRATION, 7~9=TEST를 적용한다.
4. 최근 15장 index에 포함된 group은 모두 `TEST_LOCKED`가 우선한다. 그 group과 연결된 이전 membership도 TEST가 된다.
5. 기존 16장/80행 oracle group은 `LEGACY_EVAL`로만 사용한다. 다른 source와 중복돼도 bank/calibration으로 승격하지 않는다.
6. 역할 우선순위는 LEGACY_EVAL > TEST_LOCKED > hash split이다. 데이터가 부족해도 재추첨·seed 변경·임의 이동을 하지 않는다.

서로 다른 실제 캡처에서 숫자 2의 픽셀이 동일한 것은 정상적인 반복이다. 이런 반복은 성능 hit로 측정하되 `seen_pattern_test_hits`와 `unseen_pattern_test_hits`를 따로 보고한다. 같은 패턴 반복을 새로운 글꼴·배율에 대한 일반화 성능으로 주장하지 않는다.

## 5. 등록 조건과 부족 자료

- ENROLL truth만 bank에 등록한다. TEST truth와 TEST crop은 등록·threshold 선택에 사용하지 않는다.
- 등록 source도 현재 native 987×456 layout probe를 통과해야 한다. 987×458 등은 자동 resize해서 옮기지 않는다.
- 전체 이름은 원래 rawOCR에서 단계 표기를 제거하고 NFC/공백 정규화한 값이 canonical 이름 전체와 같고, 말줄임 기호가 없으며 crop이 완전해야 한다. 사용자 수정 이름이 있다는 이유로 잘린 문자열을 전체 이름 reference로 만들지 않는다. 검사 불가이면 `NEEDS_FULL_NAME_EVIDENCE`로 남긴다.
- land master 0단 이름, 미등록 이름, 지원되지 않는 geometry는 제외 사유를 기록하고 OCR로 처리한다.
- 특정 label/context의 이미지가 없으면 그 항목은 ABSTAIN이다. 마스터 213종을 채우려고 합성 이미지·게임 외부 icon·OCR 예측을 정답으로 추가하지 않는다.
- native 블랙스톤의 확인된 표본 수가 적을 수 있다. 실제 확인된 값만 bank로 만들고, 1/2/3/4만 존재한다고 제한하지 않는다.

## 6. 평가 truth와 정규화

숫자는 Python int 기준 정확히 비교한다. 문자열 숫자 변환, 끝자리 일치, 유사값 허용은 금지한다.

이름 평가의 canonicalization은 Unicode NFC, 공백 제거 비교, frozen importer에 명시된 섬 alias 3개만 허용한다. 임의 fuzzy match는 사용하지 않는다. oracle의 `.../…` 말줄임 이름은 `PARTIAL_ORACLE`로 분리해 해당 이름의 exact accuracy 분모에서 제외하고 원문·예측을 보고한다. 그 행의 숫자 truth는 계속 유효하다. 기존 정답 파일을 고치지 않는다.

정답이 없는 필드는 baseline과의 값·검수 변화만 비교한다. 일치율을 정확도라고 부르지 않는다.

## 7. 계획 시 확인한 자료 한계

정리 전/최근 백업의 USER_REVIEW 경로를 예비 집계하면, 현재와 같은 native 987×456에서 2/3 대상 확인 필드는 9개, 블랙스톤은 5개였다. 987×458에는 추가로 2/3 4개와 블랙스톤 1개가 있지만 현재 자동 layout에는 등록하지 않는다. 이 집계는 row 매핑·충돌·ENROLL 분할 전이며, 최종 bank 자격 수가 아니다. 실제 counts의 authority는 S1 산출물이다.

따라서 보관 이미지 수가 많아도 현재 truth만으로 모든 kind의 TEST 20 HIT gate나 근사 비교 calibration을 채울 수 있다고 가정하면 안 된다. 추가 정답을 발명하지 않고 EXACT/FALLBACK 구현과 연구 비교를 마친 뒤, 어느 kind가 얼마나 더 필요한지 보고한다. 표본 부족은 모델·설계 판단을 하위 모델에게 넘기는 문제가 아니라 이미 정해 둔 HOLD_DATA 처리다.
