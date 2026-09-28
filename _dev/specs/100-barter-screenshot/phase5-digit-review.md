# SPEC-100 Phase 5 Numeric Recognition Review

감사 범위는 Phase 4 코드·결과·기존 16장 PNG 및 정답 JSON이다. 새 external holdout은 열거나 사용하지 않았다. 실험용 contact sheet와 스크립트는 TEMP에만 생성했다. 저장소에서는 이 보고서만 생성했으며 Phase 4 prototype, production, importer, HTML, scanner, reference, 정답 JSON은 수정하지 않았다.

## 1. Verdict

**RETRY_NUMERIC_WITH_NEW_REPRESENTATION**

주요 원인은 단순히 confidence cutoff가 엄격해서가 아니다.

1. reqAmount/yield crop 대부분은 숫자 overlay가 붙은 아이콘 픽셀을 포함한다. 현재 중성 밝기 mask가 숫자 glyph와 아이콘의 밝은 무채색 픽셀을 함께 남긴다.
2. reqAmount와 yield가 서로 다른 lane·배경·값 분포인데도 Phase 4는 prototype과 cutoff를 함께 학습한다. digit OOF에서 두 field를 묶은 채 zero-error cutoff를 찾지 못했다.
3. 안전한 digit 후보가 UNKNOWN으로 떨어져도 RapidOCR만 confidence 0.88 이상이면 CONFIRMED_OCR로 올린다. weak digit 후보가 실제로 다른 숫자를 읽었는지 검사하지 않는다.
4. yield의 350→35 오확정은 위 승격 경로를 실제로 통과했다.

따라서 숫자 crop representation과 field별 인식을 다시 설계한다. 실패한 숫자를 수동 검토로 남기는 동작은 유지한다. Phase 4의 tier·icon·text·count 구조는 유지하되, 확인된 아이콘과 충돌하는 미등록 text를 강제 확정하는 한 경로는 Phase 5 안전 수정 대상으로 지정한다.

## 2. Phase 4 Numeric Failure

### 결과 기준

| Split | 전체 행 | 완전 확정 | 숫자 field 확정 |
|---|---:|---:|---|
| Training | 48 | 0 | reqAmount 4/48, yield 6/48 |
| Internal validation | 32 | 0 | reqAmount 4/32, yield 5/32 |

Validation yield는 5건 중 4건이 정답이고 1건이 오답이다. 숫자 미확정만으로 전체 32행이 review에 남았다. 이 validation은 Phase 4 작업과 본 감사에서 이미 열람되었으므로 blind holdout이 아니다.

### 현재 crop과 mask

화면 PNG를 실제로 확대해 확인했다. 숫자는 각 아이템 아이콘의 하단부에 overlay된다. 따라서 crop과 icon 영역이 겹치는 것 자체는 UI 배치상 정상이다. 결함은 overlay 숫자만 남겨야 할 mask가 아이콘 전체의 밝은 neutral pixel도 glyph로 취급한다는 점이다.

| 필드 | Phase 4 numeric box | 대응 icon box | 사각형 교차 |
|---|---|---|---:|
| reqAmount | x=286..329, y=40..68 | x=278..322, y=19..63 | 36×23 px, numeric box 면적의 68.8% |
| yield | x=666..710, y=40..68 | x=653..697, y=19..63 | 31×23 px, numeric box 면적의 57.9% |

phase4_digits.py의 digit_mask는 min RGB ≥135, 채널 spread ≤60을 남긴다. 이 조건은 채도가 낮은 아이콘 highlight도 남긴다. 이어지는 segment_digits는 열 투영에서 2px 이하 간격을 붙이고 폭 14px 이상 그룹을 버린다. 아이콘 highlight가 glyph로 들어오거나 실제 숫자 stroke가 나뉘면 자릿수 개수와 glyph shape가 달라진다. 시각 감사용 crop·mask·component box·8×12 normalized glyph sheet는 TEMP에만 생성했다.

확인한 숫자 sample에는 reqAmount 1, 10, 20, 100, 200, 500 및 yield 1, 2, 3, 4와 100 이상 coin yield가 포함된다. 예를 들면 첫 PNG의 row 0~4에는 각각 500, 10, 200, 100, 100이 있고, 350은 2026년 9월 25일 08_45_37 PNG row 1이다. 원본 PNG와 정답 JSON은 그대로 두었다.

임시 시각 감사 결과는 C:\Users\kwang\AppData\Local\Temp\spec100_phase5_visual\reqAmount.png, yield.png, zoom.png에 있으며 저장소에는 복사하지 않았다.

### Segmentation과 score 분포

Training 48행에서 자릿수 segment 수가 정답 자릿수 수와 맞은 행은 reqAmount 29/48 (60.4%), yield 32/48 (66.7%)이다. Internal validation에서는 각각 19/32, 18/32다. 정답 자릿수와 수가 맞는 경우도 숫자 분류가 맞는다는 뜻은 아니다.

OOF 후보는 필드마다 48개 중 reqAmount 43개, yield 44개였다. 나머지는 빈 segment 또는 불완전 결과였다.

| Field | OOF 후보 중 top-1 정답 | 거리 중앙값 / P90 / 최대 | minGap 최소 / 중앙값 / 최대 |
|---|---:|---|---|
| reqAmount | 25/43 (58.1%) | 0.1979 / 0.3833 / 0.4583 | 0.0014 / 0.2092 / 0.3120 |
| yield | 22/44 (50.0%) | 0.2240 / 0.3896 / 0.4792 | 0.0032 / 0.1360 / 0.3229 |

거리는 8×12 binary glyph와 해당 class prototype 사이의 mean absolute difference이고, gap은 가장 가까운 다른 class와의 거리 차이다. 값이 낮을수록 유사하다. 행 단위 무조건 top-1은 reqAmount 25/48, yield 22/48 정확도이며 틀린 후보도 다수다.

아래 same/different 거리는 training에서 정답 자릿수 개수와 맞은 glyph만으로 계산한 pairwise mean absolute difference다. 값 범위는 0~1이다. held-image-out class prototype과 비교한 per-digit 요약도 함께 표시한다. 모델이 두 field의 glyph를 공유하므로 field별 거리 또한 완전히 독립된 인식기 성능으로 해석하면 안 된다.

| Field | 같은 숫자 거리 P50 / P90 | 다른 숫자 거리 P10 / P50 | per-digit 관찰 |
|---|---|---|---|
| reqAmount | 0.0312 / 0.4271 | 0.4792 / 0.6146 | 0: 6 glyph, same P50 0.0000 / nearest-different P50 0.4583 / 6 correct; 1: 28 glyph, 0.0990 / 0.3438 / 25 correct of 28; 5: 1 glyph만 있어 안정적인 OOF 비교 불가 |
| yield | 0.0312 / 0.4167 | 0.3646 / 0.4167 | 1: 22 glyph, same P50 0.0990 / nearest-different P50 0.3438 / 18 correct of 22; 2: 11 glyph, 0.1458 / 0.4167 / 10 correct of 11 |

per-digit training glyph 수 중 분할 수가 정답과 맞은 샘플은 reqAmount에서 0:6, 1:28, 5:1뿐이었다. yield는 0:1, 1:22, 2:11, 3:1, 6:1, 7:1, 8:3, 9:2였다. 4는 training 정답 값에 없고 template도 없다. 3·5·6·7·8·9의 다수는 screenshot 단위 fold에서 같은 digit template이 남지 않아 독립 OOF 품질을 판단할 표본이 부족하다.

같은 class와 다른 class score 분포는 겹친다. 특히 yield의 same-class P90 0.4167이 different-class P10 0.3646보다 크다. UI 배경·glyph 분할·희소 class 문제가 normalize 후에도 남아 있다.

### OOF accepted=0의 실제 의미

phase4_digits.py의 _learn은 한 화면 행의 reqAmount와 yield glyph를 같은 prototype 집합에 넣는다. _fit_thresholds도 두 field의 96 OOF numeric fields에 하나의 maxDistance/minGap cutoff를 맞춘다. 검색 grid의 어떤 조합도 두 field 전체에서 오확정 없이 양수 coverage를 만들지 못했다. 그래서 best.accepted가 0이면 fallback으로 maxDistance=0.0, minGap=1.0을 기록한다.

이 값은 유효한 optimum이 아니다. 관측된 minGap의 최대가 reqAmount 0.3120, yield 0.3229이므로 minGap 1.0은 모든 결과를 제외한다. 즉 OOF accepted=0은 다음 두 사실을 함께 나타낸다.

- 현재 representation의 OOF top-1 오답 비율이 높아 joint zero-error threshold가 없었다.
- fallback은 실제 score 보정값이 아니라 빈 결과를 표시하는 불가능 cutoff다.

진단용으로 cutoff를 field별로 분리하고 넓은 범위에서 재탐색했을 때 reqAmount는 OOF 23/48을 0 wrong으로 남기는 조합이 있었으나 yield는 non-empty zero-error 조합이 없었다. 이 same-OOF cutoff sweep은 탐색 자료일 뿐, held-out 품질이나 Phase 5 성공 증거로 쓰지 않는다. field별 보정은 필요하지만 현 representation만 field별로 나눠도 yield 문제는 해결되지 않는다.

### Training 숫자 분포

| Field | 전체 80행 분포 |
|---|---|
| reqAmount | 1:70, 10:4, 20:1, 100:3, 200:1, 500:1 |
| yield | 1:34, 2:27, 3:6, 4:1, 100:1, 127:1, 129:1, 161:1, 167:1, 173:1, 188:1, 192:1, 198:1, 200:1, 209:1, 350:1 |

Training 48행의 reqAmount는 1:42, 10:2, 100:2, 200:1, 500:1이다. validation 32행은 1:28, 10:2, 20:1, 100:1이다. 전체 데이터에서 1은 reqAmount의 87.5%다. 단순히 1만 내는 recognizer는 이 불균형 때문에 coverage가 높아 보일 수 있다.

yield는 training에서 일반 yield 1/2/3이 42행이고, 100 이상의 coin 수량이 6행이다. validation은 일반 1/2/3/4가 26행이고, 100 이상의 서로 다른 coin 수량이 6행이다. 이 분포는 calibration 표본의 prior일 뿐 게임 규칙이 아니다. 미관측 수량을 가장 가까운 학습 값으로 바꾸면 안 된다.

## 3. Crop / Recognition Candidate Experiments

모든 실험은 현재 16장 기존 dataset만 대상으로 했다. OCR ablation과 내부 validation을 열람했으므로 아래 결과는 외부 성능 증명이나 blind 검증이 아니다.

### A. glyph segmentation + digit template

- phase4의 열 투영 segment와 8×12 prototype을 그대로 쓰면 training OOF 정답 후보는 reqAmount 25/43, yield 22/44였다.
- 두 필드 공동 zero-error threshold는 accepted 0이다.
- neutral bright mask가 아이콘 하단의 무채색 highlight까지 glyph로 남기고, 분할 폭·간격 규칙이 접촉/분할된 stroke에 민감하다.
- 정확한 crop overlay 분리 후 다시 측정할 가치는 있지만 현재 구조를 통과 기준으로 채택할 근거는 없다.

### B. whole-number visual template

화면 숫자의 전체 crop을 고정 크기 binary token으로 정규화하고 screenshot 단위 leave-one-image-out nearest centroid를 탐색했다. 아이콘을 포함한 큰 box의 값 token은 변동이 컸다. numeric box 오른쪽 25px의 mask를 48×32 fixed-position으로 변환한 진단 모델은 training top-1이 reqAmount 40/48, yield 15/48이었다.

training에서 거리 cutoff를 고르고 zero wrong만 받게 하면 reqAmount 34/48까지 남았지만 validation에서 받아들인 20/32는 전부 값 1이었다. yield는 training zero-error non-empty cutoff가 없었고 validation accepted도 0이었다. 따라서 높은 전체 coverage가 reqAmount의 지배적인 값 1에만 반응한 것이다. 이는 의미 있는 숫자 범위 coverage가 아니다.

Whole-number token은 전체 숫자를 한 번에 비교해 자릿수 assembly 오류를 피할 가능성은 있지만, 현재 crop/mask와 데이터만으로 unseen value 처리를 검증하지 못했다. 가장 가까운 known number를 무조건 반환하는 방식은 금지한다.

### C. tight-crop RapidOCR recognition-only

비교한 mask OCR은 기존 numeric box의 오른쪽 25px를 자른 뒤 neutral mask를 만들고 3배 nearest upscale 후 recognition-only OCR에 넣었다. 학습기 자체를 fitting하지 않고 training 결과에서 confidence cutoff를 검토했다.

| Field | Training 결과 | Training cutoff | validation 결과 |
|---|---|---|---|
| reqAmount | OCR 출력 43/48, 정답 36, 오답 7 | non-empty zero-error confidence cutoff 없음. 0.9999에서 모두 거부됨 | 출력은 유일한 수치로 인정 불가 |
| yield | 출력 45/48, 정답 39, 오답 6 | confidence ≥0.999에서 26/48, training 오답 0 | 같은 cutoff로 19/32 수용, 18 정답·1 오답 |

yield validation false read는 2026년 9월 25일 08_45_37 PNG row 5의 192를 OCR raw “2”로 읽은 사례이며 confidence는 0.9997이다. 신뢰도만으로 high-confidence OCR을 자동 확정해서는 안 된다는 직접 근거다.

### D. A+B consensus

현재 Phase 4에 있는 glyph 결과와 B whole-number 결과의 독립 결합은 구현하지 않아 수치를 주장하지 않는다. 둘은 같은 noisy icon pixel을 공유하므로 단순 동의가 독립 근거처럼 보일 위험이 있다. ROI correction 후 grouped OOF에서 별도로 비교해야 한다.

### E. B+C whole-number / OCR consensus

rightmost-25px binary whole-token 후보와 tight-mask OCR 전체 정수 후보가 일치할 때만 수용하는 diagnostic consensus를 측정했다. field별 training cutoff는 reqAmount visual distance ≤0.05, yield OCR confidence ≥0.999 및 visual distance ≤0.05였다. Training OOF에서 reqAmount 16/48, yield 11/48이 zero wrong이었다.

이 cutoff를 고정한 validation에서는 reqAmount 17/32, yield 7/32가 수용되고 오답은 없었지만, **수용된 모든 값이 1**이었다. 이 방법은 학습 분포의 기본값만 확인했으며 요구된 수량 다양성을 인식하지 못한다. 따라서 성공으로 판정하지 않는다.

### F. 작은 supervised visual classifier

현 nearest-centroid는 작은 deterministic classifier의 기준선으로 볼 수 있다. 다만 지금 feature로는 training top-1과 zero-error coverage가 충분하지 않고 rare/coin digit을 검증할 screenshot이 부족하다. 새 ML package나 큰 모델이 성능을 끌어올린다고 가정할 근거가 없다. 현재 runtime 계약의 Pillow·NumPy만으로 후보를 우선 평가하고, 추가 dependency는 별도 근거가 생기기 전까지 도입하지 않는다.

### OCR / pixel feature 비교 결론

| 후보 | 예상 precision | 현재 coverage 징후 | unknown 처리 | 표본 요구 | dependency / 결정성 / 복잡도 |
|---|---|---|---|---|---|
| A 개선 glyph + prototype | 현 자료로 높다고 주장 불가 | segmentation은 training 60~67%; 공동 OOF 무오류 cutoff 없음 | 분할 불가·미학습 digit은 UNKNOWN 가능 | 각 digit이 여러 screenshot fold에 반복 필요 | Pillow·NumPy, 결정적, geometry/mask 조정 복잡도 높음 |
| B whole-number pixel token | 전체 token 변동과 한쪽 값 쏠림 | req 값 1만 validation에 반복 수용; yield validation 0 | 거리·gap 낮은 경우에만 값, 미관측/저품질은 UNKNOWN | 여러 field·mode와 숫자 길이별 실제 crop 필요 | Pillow·NumPy, 결정적, 중간 복잡도 |
| C tight-crop OCR | confidence만으로는 안전하지 않음 | req training zero-error coverage 0; yield validation에서 1 false high-confidence | 파싱 불가·충돌은 UNKNOWN | 특히 rare 숫자와 coin을 여러 screenshot에서 확인 | RapidOCR는 임시 venv에 있음; production pyproject에는 미선언. CPU 결정적 여부도 재확인 필요 |
| D A+B 동의 | 미측정 | 아직 수치 없음 | 불일치·미학습 glyph는 HOLD | screenshot 단위 OOF로 상관 오류 측정 | 새 dependency 불필요 예상, 중간~높은 복잡도 |
| E B+C 동의 | training candidate subset에서만 0 wrong | validation 수용 값이 전부 1; 의미 있는 coverage 실패 | 동의하지 않으면 UNKNOWN | 일반/coin validation 및 새 외부 holdout 필요 | RapidOCR 환경 필요, NumPy/pixel 보조, 중간 복잡도 |
| F 작은 classifier | 현재 centroid 기준 insufficient | rare labels와 yield는 특히 낮음 | class score가 부족하면 UNKNOWN | 불균형 숫자 class별 training screenshot 추가 필요 | NumPy로 작은 linear/centroid 가능; scikit-learn을 추가할 정확도 근거 없음 |

## 4. Wrong Confirmations

### fromItem training 2건

| Identity | Expected | Phase 4 value / status | Raw evidence / confidence | Tier·icon evidence | 원인 분류 |
|---|---|---|---|---|---|
| 2026-09-25 08_43_53 PNG, row 5, batch index 5 | 영롱한 비취 | 영롱한비취 / CONFIRMED_OPEN_TEXT | OCR UNVERIFIED_TEXT “영롱한비취” 0.9977; 보조 crop “영롱한비취오” 0.8041 | from tier UNKNOWN; to tier 1, confidence 0.9989; icon UNKNOWN_ICON | 0→1 open-world gate가 미등록 OCR 문자열을 승인. expected와 actual은 공백만 달라 compact 비교상 같은 문자열이고 현 item catalog 밖이다. 다른 아이템으로 오인한 사례는 아니지만 catalog-backed 확인도 아니다. |
| 2026-09-25 08_45_25 PNG, row 3, batch index 59 | 황금 사막의 모래 반지 | 황금 사막의 모래반지 / CONFIRMED_OCR | OCR EXACT raw “[6단계]황금사막의모래반지”, 0.9992 | from tier 6, to tier 7; icon OUT_OF_REFERENCE (tier 6) | 현재 app catalog에 있는 canonical 명칭과 expected 표기 사이의 whitespace 차이. exact-string metric에서는 오답이지만 item identity가 다른 사례는 아니다. |

첫 사례는 field status가 CONFIRMED_OPEN_TEXT이므로 낮은 신뢰도를 억지로 올린 것은 아니다. 다만 “인식된 open-world text”와 “현재 importer/catalog에서 수용됨”은 별도 status여야 한다. 두 번째는 catalog canonical spelling과 JSON oracle 표기 차이를 정확한 문자열 비교가 오차로 셌다. 기존 정답 JSON을 고치거나 이 두 결과로 matcher cutoff를 완화하지 않는다.

### toItem internal validation 1건

- Identity: 2026-09-25 08_45_09 PNG, row 0, batch index 37.
- Expected: 해적의 열쇠.
- Actual: 해적의열쇠오, CONFIRMED_OCR.
- Text evidence: raw “[4단계]해적의열쇠오”, UNVERIFIED_TEXT, confidence 0.951.
- Icon evidence: CONFIRMED_ICON “해적의 열쇠”, tier 4; score 29.9866, gap 8.18.
- Root cause: phase4_pipeline.py의 _resolve_item은 text_safe와 icon_safe가 다른 경우에는 HOLD_CONFLICT를 내지만, UNVERIFIED_TEXT는 text_safe에 포함되지 않는다. 이후 literal_out_of_catalog_text branch가 icon-safe fallback보다 먼저 실행되어 확인된 icon과 반대인 자유 text를 자동 CONFIRMED_OCR로 낸다.
- Phase 5 최소 안전조건: icon이 확인됐고 미등록 OCR text가 다른 item이면 HOLD_CONFLICT. literal out-of-catalog recognition을 유지하더라도 importer acceptance와 혼동하지 않는다.

### yield internal validation 1건

- Identity: 2026-09-25 08_45_37 PNG, row 1, batch index 70.
- Expected: 350.
- Actual: 35, CONFIRMED_OCR.
- OCR evidence: raw “35”, status EXACT, confidence 0.9993.
- Pixel evidence: extracted digits [3, 5, 0], candidate 350; maxDistance 0.01042, minGap 0.19792, final digit status UNKNOWN because current shared cutoff is maxDistance 0/minGap 1.
- Tier/type: from tier 4; to tier UNKNOWN, raw “까마귀주화”, confidence 0.9194. This provides text-based coin-mode evidence but does not validate numeric value.
- Root cause: phase4_pipeline.py checks UNKNOWN/CANDIDATE plus OCR confidence ≥0.88 and promotes OCR at lines 171–173. A weak digit candidate with a different parsed integer is treated like absent evidence. 350 therefore loses to OCR’s truncated 35.
- Phase 5 minimum safety condition: if OCR and pixel evidence each contain a parseable integer and disagree, return HOLD_CONFLICT independent of which confidence is higher. An unresolved pixel result may not silently erase a conflicting numeric candidate.

## 5. Current Architecture and Path-Fix Audit

### Preserve

- Tier: internal validation confirmed-label results from 22/22 from-side and 19/19 to-side were correct.
- Icon: accepted validation candidates were 17 from-side + 12 to-side, all 29 correct. Covered top-1 had one error on each side, so preserve abstention thresholds.
- Text/island/item: validation island 28/32 and fromItem 23/32 were correct among confirmed fields. Keep field-specific crop OCR, catalog safety, unique-prefix handling and explicit review states.
- Count: validation 32/32 exact. Keep separate from reqAmount/yield; do not combine it into numeric crop calibration.
- Recognition/importability split: phase4_pipeline.py holds recognitionStatus separately from importabilityStatus. The untouched existing importer baseline on 80 expected rows is accepted 78 / rejected 2. Expected indices 67 and 68 remain recognition targets even though the importer reports unmatched output. Field recognition must score all rows; import filtering must not delete those labels from accuracy denominators.

### Path fix

phase3_evaluate.py passes --images into both recognize_phase3 and determinism. phase4_pipeline.py resolves every pixel row under its explicit image_dir; text, icon and digit crops use that opened image. phase4_evaluate.py passes the same directory to recognition and repeated determinism.

test_phase4_paths.py contains a same filename / different pixel folders regression. Its Phase 4 test records the explicit B-folder path for OCR and checks pixel sentinels in text, icon and digit stages; another test verifies the requested folder reaches both determinism runs. The Phase 3 test verifies the pixel stage reads folder B. These tests exercise dependency wiring with mocked recognizers rather than a real OCR recognition test, but the path defect is reproduced and guarded. No remaining image_dir leak was found in the audited call paths.

### Existing warehouse quantity templates

tools/warehouse_patch/quantity_templates.npz is a protected warehouse-scanner artifact with 92×96 digit features, 92 labels, four blank-position feature arrays and source/manifest hashes. warehouse_patch.py reads four right-aligned 8px cells from its warehouse UI and applies a warehouse-specific white-core mask. The screenshot numeric overlay has a different crop, icon background and font presentation; these templates are not barter-screenshot ground truth and were not loaded into the experiments. The warehouse scanner implementation and artifact remain unchanged.

No tools/barter_scan/phase4_tier.py exists. Tier parsing is implemented in phase4_layout.py. No functional finding depends on a missing file.

## 6. Recognition vs Importability Contract

The existing test_phase4_pipeline.py checks the relevant boundaries:

- An out-of-catalog text can be recognized independently of importer matching.
- Expected rows 67 and 68 are sent to the existing importer and rejected as unmatched.
- A Unicode catalog item passes the unchanged importer.
- The recognized row schema retains six fields.

The Phase 4 evaluation keeps recognition field metrics over all 80 expected rows and reports the 78/2 importer baseline separately. Because Phase 4 confirmed zero complete rows, importer accepted/rejected for recognized rows is correctly 0/0; that is not the expected-data baseline. Phase 5 must preserve these separate counters and must not label importer rejection as OCR failure.

## 7. Selected Phase 5 Numeric Architecture

Primary candidate: **field- and mode-specific numeric overlay crop → open-set whole-number OCR candidate plus whole-token pixel evidence → exact agreement gate**.

1. Re-measure the two numeric overlays from the lower-right area of the from-item and to-item icons. Do not feed the whole icon crop into number segmentation. The overlay is inside the icon by design, so the crop must contain complete digits while the feature mask removes frame/artifact pixels.
2. Keep reqAmount and yield as separate lanes with separate crop parameters, training evidence, thresholds and metrics. Do not share prototypes/cutoffs between them.
3. Use recognition-only OCR on the isolated crop to produce the complete raw digit string and confidence. In parallel, produce a whole-number pixel token candidate. Digit segmentation may be retained as an audit/corroboration signal, not as an uncalibrated value substitution.
4. Yield mode may be selected only from independently confirmed screenshot evidence: toItem text/icon canonicalized to “까마귀 주화”. If the item evidence is unresolved or conflicting, numeric mode is UNKNOWN. Do not inspect expected JSON to choose coin mode.
5. Confirm a positive integer only when the OCR and pixel candidates parse to the same complete integer and both meet mode/field cutoffs locked from image-grouped training OOF. Any disagreement, missing digit, crop boundary issue, unseen pixel class with no open-set OCR corroboration, or insufficient score remains HOLD/UNKNOWN.
6. A confidence threshold by itself is not enough. The observed OCR error “2” at 0.9997 and “35” at 0.9993 demonstrate that highly confident truncated/partial values occur.
7. Training value frequencies are not game rules. No candidate may rewrite an unseen value to the nearest expected/trained number. Preserve raw crop, raw OCR, candidate values, confidence, coordinates, mode source and review reason.

This is a Phase 5 prototype selection, not a validated production recognizer. Its current agreement ablation still accepts only the dominant value 1 in validation and therefore fails the numeric coverage gates below.

## 8. Training, Validation and External Holdout

- Keep the existing screenshot-level split: training 48 rows from the manifest’s training images; internal validation 32 rows from the manifest’s validation images.
- Fit crop parameters, prototypes and every cutoff from training only. Use leave-one-image-out folds, not random row splits; rows in the same screenshot share layout, rendering and icon artifacts.
- The recognizer function receives pixels/configuration only. Expected JSON is evaluator-only and must not be imported by inference code.
- Freeze ROI, mode rule, algorithm, thresholds, model/config, code hash and split-manifest hash before scoring internal validation once. No post-validation retuning on the same 32 rows.
- Current internal validation is already inspected and cannot count as a future blind test. Keep externalHoldout PENDING; do not use fresh screenshots until Phase 5 parameters/code have been frozen.
- Keep importability outcomes separate from recognition labels and metrics, including indices 67/68.

## 9. Numeric Success Gates

These are proposed Phase 5 internal engineering gates, not claims that the current prototype meets them.

| Gate | Required internal validation result |
|---|---|
| reqAmount | Wrong confirmed = 0; at least 24/32 exact values; additionally at least 3/4 non-1 values must be covered so a constant-1 recognizer cannot pass |
| Normal yield | Wrong confirmed = 0; at least 20/26 exact values |
| Coin yield | Wrong confirmed = 0; at least 4/6 exact values, with mode selected from independent confirmed toItem evidence |
| Complete row | At least 8/32 fully confirmed rows and wrong complete rows = 0, retaining the existing Phase 4 review gate |
| Importability | Report accepted/rejected separately; unmatched expected rows remain in recognition scoring |

The non-1 and coin sub-gates address the measured class imbalance and prevent “always 1” from appearing successful. If training OOF cannot produce a non-empty zero-error cutoff for a field/mode, report that gate FAIL/INCONCLUSIVE and leave all candidates for that lane in review; do not weaken the cutoff to manufacture coverage.

## 10. Luna Implementation Specification

Implementation remains unstarted. The following ordered tasks are the next bounded work package.

### T1. Numeric overlay geometry

- **Purpose:** Isolate the full quantity text inside each item icon without feeding the complete icon background to the classifier.
- **Files:** Add tools/barter_scan/phase5_numeric_geometry.py and tools/barter_scan/test_phase5_numeric_geometry.py. Save locked coordinates/mask settings in specs/100-barter-screenshot/phase5-numeric-parameters.json.
- **Input:** Existing training PNGs, phase4-split-manifest.json, row height and phase4_layout icon geometry. Training truth may be read by the evaluator only; geometry selection must be based on visible glyph/crop audit, not a number lookup table.
- **Output:** Separate row-relative reqAmount/yield overlay crops, pixel coordinates, mask version and crop diagnostics.
- **Algorithm:** Select the smallest fixed row-relative boxes that contain complete overlay glyphs across training images, including 1/2/3-digit and large coin examples. Keep the icon background context only where needed for local contrast; exclude icon frame and unrelated artwork using a deterministic mask. Do not infer pixel coordinates from expected values at runtime.
- **Calibration:** Freeze coordinates on training images before OOF numeric fitting. No per-image manual box changes during evaluation.
- **Forbidden:** Reuse the current full icon-overlap mask as numeric foreground; change warehouse scanner/template; use validation to tune boxes.
- **Tests:** reqAmount 1, 10, 20, 100, 200, 500; yield 1, 2, 3, 4, 100+; different icon backgrounds; clipped/empty/out-of-bounds crops; screenshot scale/layout rejection.
- **Done when:** Each crop is reproducible, includes the whole visible number, records coordinates, and excludes unrelated icon components well enough for the frozen segmentation/feature tests.

### T2. Open-set OCR and whole-token pixel candidates

- **Purpose:** Produce independent complete-integer candidates without forcing a trained/expected value.
- **Files:** Add tools/barter_scan/phase5_numeric.py and tools/barter_scan/test_phase5_numeric.py.
- **Input:** T1 crop, field name, OCR engine, training-fitted field/mode parameters.
- **Output:** Raw OCR text/confidence, parsed complete integer or null, whole-token pixel candidate, per-candidate score/gap, segmentation diagnostics, UNKNOWN/HOLD reason.
- **Algorithm:** Compare recognition-only OCR crop variants using training OOF only. Train whole-number visual prototypes from training rows, grouped by screenshot. Keep reqAmount/yield feature sets separate. Preserve leading/trailing digit count; never map an unknown token to the nearest trained integer.
- **Calibration:** Report top-1 and top-2 score distributions and full-integer exact accuracy separately for each field. Choose no cutoff unless it gives non-empty zero-error grouped OOF coverage.
- **Forbidden:** Read 정답.json during recognition; use training value frequency as a rule; silently trim 350 to 35 or 192 to 2; import warehouse templates as screenshot labels; add a deep learning package.
- **Tests:** Unicode-independent numeric parsing; blank, 0, 1/2/3 digits, 500/167/200/209/350, partial leading/trailing glyph, OCR “35” vs pixel “350”, high OCR confidence with wrong digit, out-of-training value→UNKNOWN.
- **Done when:** Every returned candidate preserves raw evidence and unknown values remain null/UNKNOWN rather than a nearest-class substitution.

### T3. Normal-yield / coin-yield mode

- **Purpose:** Calibrate distinct numeric appearances without using expected labels to choose a mode.
- **Files:** Extend phase5_numeric.py; add tests in test_phase5_numeric.py.
- **Input:** Confirmed screenshot-side toItem text/icon evidence plus T2 crop.
- **Output:** mode normal-yield, coin-yield or UNKNOWN, with the independent source and confidence.
- **Algorithm:** Enter coin-yield only when the recognized toItem is independently confirmed as “까마귀 주화” by safe OCR/catalog or safe icon evidence. Conflict, literal unverified text or unknown toItem yields UNKNOWN mode. Use independent per-mode parameters. Do not set numeric range boundaries as game rules.
- **Calibration:** Group training OOF by image and report normal and coin metrics separately.
- **Forbidden:** Use expected[field] or batch index to set mode; infer coin status from a value >=100 alone; route unresolved text to coin.
- **Tests:** confirmed coin text, icon-only coin, text/icon conflict, unknown item, normal high reqAmount, coin yield below/above training values.
- **Done when:** Every mode has a traceable non-oracle evidence source; unknown mode stays review.

### T4. Image-grouped calibration and frozen parameters

- **Purpose:** Keep model/cutoff selection honest and make zero-coverage cases visible.
- **Files:** Extend phase5_numeric.py and tests; create/update phase5-numeric-parameters.json.
- **Input:** T1/T2 training candidates, existing training split manifest.
- **Output:** per-field/mode parameters, digit/value coverage, cutoff rationale, code/model/data hashes.
- **Algorithm:** Leave one screenshot out at a time; compute distances, margins, confusion matrix, candidate coverage and accepted errors. Calibrate OCR, pixel and agreement gates by field/mode. If no non-empty zero-error cutoff exists, record NO_ZERO_ERROR_CUTOFF and abstain.
- **Threshold:** No fixed confidence threshold is presumed. Search and select using training folds only; require wrong confirmed = 0. Save actual selected numeric values and scoring convention.
- **Forbidden:** Pool reqAmount/yield, rows from the same PNG across train/validation, post-validation threshold change, default 1, impossible sentinel presented as learned calibration.
- **Tests:** Screenshot-level fold exclusion; absent digit; single-example class; no passing cutoff; tied nearest classes; determinism and hash changes.
- **Done when:** Parameters can be regenerated from training alone and their hashes reproduce the saved values.

### T5. Recognition fusion and safety status

- **Purpose:** Prevent high-confidence OCR from overriding conflicting numeric or icon evidence.
- **Files:** Integrate the frozen Phase 5 module through tools/barter_scan/phase4_pipeline.py only after T1–T4 tests pass; add targeted cases to test_phase4_pipeline.py and test_phase5_numeric.py.
- **Input:** T2 OCR/pixel candidates, T3 mode, existing text/tier/icon/count evidence.
- **Output:** numeric CONFIRMED only on exact full-integer agreement and locked quality gates; otherwise CANDIDATE/HOLD_CONFLICT/UNKNOWN with preserved raw evidence.
- **Algorithm:** Any parseable OCR/pixel disagreement is HOLD_CONFLICT regardless of confidence ordering. Candidate UNKNOWN with a retained disagreeing digit sequence is not equivalent to “no pixel evidence”. Count remains a separate field. Keep recognitionStatus and importabilityStatus independent.
- **Minimal item safety fix:** If toItem is UNVERIFIED_TEXT while a safe icon identifies a different item, return HOLD_CONFLICT. Do not let literal out-of-catalog text override the icon. Keep open-world recognition distinct from importer acceptance.
- **Forbidden:** Change trade-import.js, importer acceptance rules, expected JSON, scheduler/completion, production UI/API/launcher, protected reference or scanner.
- **Tests:** Yield 350 vs OCR 35; yield 192 vs OCR 2; icon-confirmed 해적의 열쇠 vs UNVERIFIED_TEXT 해적의열쇠오; open-world 0→1 input; expected importer unmatched rows 67/68 remain separately scored.
- **Done when:** No conflict path is automatically confirmed and recognized but rejected rows remain available as recognition successes with importability REJECTED.

### T6. Evaluator and acceptance report

- **Purpose:** Evaluate all 80 fields independently from importer outcomes and report coverage beside false confirmations.
- **Files:** Add tools/barter_scan/phase5_evaluate.py and tools/barter_scan/test_phase5_evaluate.py; create phase5-evaluation.json and phase5-validation-report.md.
- **Input:** Explicit --images, frozen parameters, model config, evaluator-only expected JSON, split manifest.
- **Output:** train OOF and one internal validation summary; per-field/per-mode precision, coverage, wrong-confirmed, unknown, score distributions, full-row gate, importability baseline, determinism and hashes.
- **Algorithm:** Match rows by screenshot SHA-256 plus row index. The recognition function must not receive expected JSON. Keep unmatched importer rows 67/68 in the recognition denominator.
- **Threshold:** Apply Section 9 gates as written. Zero wrong confirmed is mandatory; total-only coverage cannot hide reqAmount/coin undercoverage.
- **Forbidden:** Retune after validation, label HOLD 100% as PASS, use external screenshots before freeze, change test oracle to fit implementation.
- **Tests:** Missing/duplicate rows, 0 candidates, importable/unmatched rows, same filename in separate image dirs, false confirmation counters and repeat hash.
- **Done when:** Training fits are frozen before one validation pass and every gate prints PASS/FAIL/INCONCLUSIVE with denominators.

### T7. Freeze review and next-stage boundary

- **Purpose:** End Phase 5 with a reviewable prototype result before any external holdout or production integration.
- **Files:** Update only Phase 5 report/artifacts and code hashes; no production files.
- **Input:** T1–T6 artifacts.
- **Output:** frozen Phase 5 verdict, test commands/results, limitations, exact next recommendation.
- **Algorithm:** Recompute protected-source hashes and confirm Phase 4 importer/index behavior. External holdout stays PENDING until the owner supplies/frees a new untouched set after the parameter freeze.
- **Forbidden:** Start Phase 6/production integration, alter protected HTML/reference/scanner, send screenshots to an external OCR API, or consume a new holdout during tuning.
- **Tests:** Required Phase 5 unit/evaluator suite and determinism only; distinguish automated results from any browser/live inspection.
- **Done when:** Numeric gates, full-row gate and protected hashes are reported separately. If the gates fail, keep review/manual number entry and report the failure without lowering cutoffs.

## 11. Dependency and Final State

- NumPy and Pillow already appear in local_app/pyproject.toml; no dependency declaration change is needed for pixel masks/templates.
- RapidOCR is available in the disposable experimental environment used for this audit but is not declared in the current local_app runtime dependencies. Phase 5 may use the isolated OCR environment for prototype evaluation; production packaging requires a separate size/license/runtime review and is out of scope.
- No new dependency is recommended now. A small NumPy classifier should be assessed before considering scikit-learn or a deep-learning runtime.
- SPEC-000 protected files were not changed during the audit. The tracked/untracked working-tree state present at start was preserved.
- No Python unittest suite was run in this read-only audit. The reported numeric measurements are explicit TEMP diagnostic experiments, not a Phase 5 implementation test pass.

## 12. Final Recommendation

Phase 4 surviving structure:

- tier: 유지
- icon: 유지; known evidence conflict must remain HOLD
- text: 유지; retain raw text/canonical candidate and keep open-world recognition apart from importer acceptance
- count: 유지; separate from numeric quantity calibration

숫자 실패 핵심 원인:

1. Overlay 숫자 crop의 절반 이상이 아이콘 영역이고 neutral mask가 아이콘 highlight를 glyph로 포함한다.
2. 서로 다른 reqAmount/yield를 같은 glyph prototypes와 cutoff로 calibration한다. digit 4는 training에 없고 coin 숫자는 대부분 singleton이다.
3. Weak pixel candidate와 high-confidence OCR conflict를 결합 단계에서 놓쳐 350을 35로 자동 확정한다.

reqAmount:

- Current digit top-1 oracle: OOF 후보 25/43 정답, 18 오답; 후보 없는 crop 5/48.
- Whole-token diagnostics: training top-1 40/48; zero-error cutoff 34/48이나 validation 수용값 20개가 모두 1.
- Phase 4 confirmed: validation 4/32.
- 결론: 값 1만 맞추는 coverage는 불충분하다. representation을 고친 뒤 non-1 gate를 통과해야 한다.

yield:

- Current digit top-1 oracle: OOF 후보 22/44 정답, 22 오답; 후보 없는 crop 4/48.
- OCR mask OOF: training 26/48 at confidence 0.999 with zero training error, but internal validation 18/19 correct and one wrong.
- Phase 4 confirmed: validation 5/32, with one wrong.
- 결론: independent mode separation and agreement are necessary; current data does not support automated coin yield.

OOF accepted=0 원인: joint req/yield threshold search has no non-empty zero-error combination; fallback maxDistance=0/minGap=1 is a reject-all sentinel, not a trained optimum. Field-only exploration shows some reqAmount coverage, but yield remains without a zero-error digit cutoff.

Training fromItem mismatches: both are whitespace/canonical string discrepancies, one from an allowed 0→1 open-world text branch and one matching the application catalog’s canonical spelling. Preserve the evidence and do not relabel them as a different item identity or use them to loosen matching.

Validation toItem mismatch: unverified “해적의열쇠오” overrides a confirmed icon “해적의 열쇠”; fix the single fusion ordering/safety branch and add a regression.

Validation yield mismatch: 350 was present in pixel digit candidates but suppressed by the impossible minGap fallback; OCR 35 at 0.9993 confidence then became CONFIRMED_OCR. Require exact agreement or HOLD.

Recommended numeric architecture: isolated numeric overlay crop; separate reqAmount/normal-yield/coin-yield mode; open-set recognition-only OCR plus whole-token pixel corroboration; exact full-integer agreement; unknown remains review.

New dependency: none recommended for Phase 5 prototype. Pillow/NumPy are declared already; RapidOCR remains isolated and undeclared for production.

Phase 5 Luna implementation possible: **가능**, using the ordered T1–T7 specification above. Do not begin Phase 6 or production integration from this review.

External holdout: **계속 보존 / PENDING**.

Generated file: specs/100-barter-screenshot/phase5-digit-review.md

Next model: **Luna High**.
