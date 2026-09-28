# SPEC-100 Phase 4 Architecture Review

> 범위: SPEC-100의 물교목록 스크린샷 인식 설계 검토. 2026-09-26 현재 저장소의 Phase 1~3 코드, 평가 JSON, 16장 PNG와 정답 80행, 70개 WebP를 대조했다. 이 문서는 Phase 4 구현이나 제품 통합 결과가 아니다. 아래의 추가 수치는 기존 자료에 대한 읽기 전용 재계산이며, 전부 같은 80행에서 얻은 **진단치**다.

## 1. Executive Verdict

**RETRY_LOCAL_WITH_NEW_ARCHITECTURE**

- Phase 3의 `0/80 confirmed`는 현재 결합 방식의 실패를 보여준다. 로컬 인식 자체가 불가능하다는 증거는 아니다.
- 숫자 템플릿의 정답 후보 30건 중 28건이 OCR 동의 조건 때문에 확정되지 않았다. 다만 후보가 나온 행 자체가 입력 20/80, 출력 12/80에 불과하여 동의 조건만 없애도 완성되지 않는다.
- 아이콘 reference의 투명도를 버리고 RGB 절대오차를 계산한 것이 큰 문제다. 동일 80행을 대상으로 WebP를 어두운 배경에 합성하는 **한 가지** 진단 변경만 적용하면, reference가 있는 행의 top1은 입력 29/64→49/64, 출력 22/50→40/50이 된다. 아직 독립 검증 성능이나 안전한 자동 확정률은 아니다.
- tier를 독립적으로 읽어 후보 70개를 해당 tier 14개로 줄일 수 있다. 정답 tier를 제공한 진단적 상한 실험에서는 기존 MAE top1이 입력 41/64, 출력 28/50이고, 배경 합성까지 적용하면 입력 54/64, 출력 43/50이다. 정답 tier를 실서비스 입력으로 사용할 수는 없다.
- 권장 방향은 **단계·교환 종류 먼저 판별 → 필드별 인식 → 행 단위 검증 → 확정/검토 분리**다. 목표 제품 형태는 사용자가 HOLD만 교정하는 **HYBRID LOCAL REVIEW**다.
- 새 촬영분을 보지 않고 파라미터를 고정한 뒤 평가해야 한다. 그 전에는 로컬 자동 입력의 안전성이나 GPT보다 높은 정확도를 주장할 수 없다.

## 2. Phase 2/3 Failure Root Causes

| 원인 | 근거 | 영향 | confidence |
|---|---|---|---|
| 숫자 인식기가 OCR의 승인을 받아야만 확정됨 | `digit_reader.py:48-56`에서 템플릿 후보, OCR 값 일치, OCR confidence ≥0.88을 모두 요구한다. 후보는 입력 20건 중 18건 정답, 출력 12건 중 12건 정답이었다. 정답 후보 중 OCR 동의는 각각 2건, 0건이었다. | OCR 실패를 구제하려는 독립 경로가 OCR 실패 시 차단된다. Phase 3의 숫자 정확도가 Phase 2와 같아진 직접 원인이다. | HIGH |
| 기존 창고 숫자 template과 물교 숫자의 좌표 계약이 다름 | `digit_reader.py:20-39`는 40×44 아이콘 영역을 전달한다. 창고 `quantity_cell_feature()`는 그 안의 고정 `y=28:40`, 우측부터 8px 셀을 읽는다(`warehouse_patch.py:213-217`). 실제 물교 PNG에서 1·2·3자리 숫자는 아이콘 하단 우측에 겹쳐 있고, 창고 샘플과 세로 배치·테두리가 다르다. | 입력 60/80, 출력 68/80에서 후보조차 없음. 템플릿을 무조건 독립 확정해도 해결되지 않는다. | HIGH(coverage), MEDIUM(정확한 픽셀 원인) |
| 아이콘 reference의 alpha 정보 손실 및 잘못된 도메인 비교 | `icon_match.py:30-36`은 RGBA WebP를 바로 RGB로 바꾸며, `:50-69`는 중앙 RGB MAE와 절대 cutoff 18을 쓴다. 70개 reference의 픽셀 중 완전 투명 38.35%, 반투명 23.30%이다. 실제 화면은 어두운 바탕이다. 창고 scanner는 이미 alpha 합성을 쓴다(`warehouse_patch.py:176-180`). | reference가 있는 입력 top1 29/64→배경 합성만으로 49/64, 출력 22/50→40/50. 원래 정답 top1 중 28/29, 22/22가 cutoff 때문에 거절됐다. | HIGH |
| 전체 70개 후보를 같은 공간에서 경쟁시킴 | `barter_scan.py:115-118`은 `[n단계]`를 제거하고, `icon_match.py`는 전부 비교한다. reference는 tier 1~5 각 14개다. 정답 tier를 사용한 *상한* 실험에서 기존 MAE는 입력 29→41/64, 출력 22→28/50으로 증가했다. | 같은 색·형태의 다른 단계 아이콘이 오선택된다. tier detector가 잘못되면 정답 후보를 제거할 수 있으므로 독립 판독과 abstain이 필수다. | HIGH(현재 손실), MEDIUM(실제 detector 성능) |
| 후보 범위와 평가 분모가 섞임 | 입력 정답은 64/80, 출력 정답은 50/80만 70개 reference에 있다. 출력의 나머지 30행 중 까마귀 주화 11행, tier 6/7 및 특수·기타 19행이다. | `29/80`, `22/80`은 reference matcher의 covered-subset 성능을 과소표현한다. 동시에 reference 밖 46개 필드에 대한 경로 부재를 가린다. | HIGH |
| 전체 화면 OCR detection과 열별 선택의 혼입 | `barter_scan.py:147-206`은 전체 이미지 OCR box를 row와 `x0` 대역으로 나눈다. Phase 2의 입력 텍스트에 `0송`, 숫자 등이 섞인 사례가 있고, 이름과 숫자 위치가 인접한다. | 입력 정확도 36/80의 일부가 field mixing일 가능성. OCR 엔진 품질만의 문제로 분리할 수 없다. | MEDIUM |

진단 실험의 경계: alpha 합성은 reference RGBA를 창고 scanner의 어두운 RGB `(23,24,27)`에 합성하고, 나머지 Phase 3의 44×44 crop 및 `[3:38,3:41]` MAE는 그대로 둔 비교다. 정답이 reference에 있을 때만 top1을 계산했다. 새 threshold를 학습하거나 held-out PNG를 사용하지 않았다. 이 단일 실험으로 원인 A(현 구현 실패)와 B(로컬 방식 불가능)를 구분할 수 있지만, 제품 성능을 증명하지는 못한다. 합성 후에도 기존 cutoff `score≤18, gap≥6` 통과는 covered subset에서 입력 5건·출력 3건뿐이었다(관찰된 오확정 0건). cutoff는 재보정이 필요하다.

## 3. Instruction Problems

1. **OCR/template 완전 일치 요구**: 잘못된 템플릿의 자동 확정을 막았지만 OCR 누락을 구제하지 못하게 했다. 숫자 경로는 독립적인 화소 증거와 별도 보정된 오확정 한계로 확정해야 한다. OCR은 동의하면 가산 증거, 불일치하면 HOLD의 원인으로 사용한다. 단지 이번 데이터의 `gap≥0.1`에서 입력 14/14·출력 10/10이 맞았다는 사후 관찰을 안전 threshold로 바로 채택하지 않는다.
2. **정답 JSON을 calibration에서 전면 금지**: leakage 예방 목적은 타당하나 16장·80행에서 crop 보정, 화면 도메인 템플릿, threshold 학습을 못 하게 했다. 이미지 단위로 미리 분리한 *training* 정답은 사용하고, validation 및 신규 external 정답은 모델·template·threshold 생성에 사용하지 않는다. 이미 전량을 살펴본 현재 80행의 internal validation은 진정한 미공개 데이터가 아니다.
3. **70개 아이콘을 무제한 비교**: 화면에 독립적으로 보이는 단계 라벨을 후보 제한에 쓰지 않았다. tier를 먼저 확인하면 tier 1~5에서 70→14개로 줄일 수 있다. 라벨이 불확실할 때는 임의 tier로 강제하지 않는다.
4. **창고 템플릿의 무변형 재사용**: 기존 자산 재활용은 출발점으로 적절했지만 물교 숫자의 bbox·렌더링 동등성을 먼저 검증하지 않았다. 물교 전용 템플릿/분할 실험이 필요하다.
5. **`>=60/80 confirmed` 단일 목표**: 잘못 확정된 행과 전부 HOLD인 상태를 모두 오판할 수 있다. 필드 precision·coverage, 행 precision·coverage, 실제 importer 동등성을 분리한다.

## 4. Implementation Problems

| 위치 | 확인한 결함 또는 한계 | Phase 4 조치 |
|---|---|---|
| `phase3_evaluate.py:155-162`, `:130-133` | `--images`는 OCR에만 전달된다. `recognize_phase3(phase2)`와 `determinism(phase2)`는 기본 `SAMPLE_DIR`에서 픽셀을 다시 읽는다. 새 파일명이 없으면 실패하고 같은 이름이면 과거 픽셀과 새 OCR이 결합된다. | 단일 명시 `image_dir`를 recognition과 반복 검사까지 전달하고 경로·파일 순서 검증 테스트를 만든다. 이번 검토에서는 수정하지 않는다. |
| `phase3_evaluate.py:56-59` | `UNVERIFIED_TEXT`인 입력을 confidence≥0.88이면 교환 종류와 무관하게 `CONFIRMED_OCR`로 승격한다. | 독립적으로 **to-tier=1이며 from-tier 라벨이 없는 0→1**임이 확인된 경우에만 open-world 입력으로 허용한다. |
| `barter_scan.py:248-255` | 입력 `UNVERIFIED_TEXT` 판정의 `elif`가 출력 OCR confidence 분기에 매달려 있다. 입력 자신에 대한 분기처럼 보이나 실제 적용이 출력 confidence에 따라 달라진다. | 필드별 상태 전이를 명시하고 입력·출력 confidence를 분리한다. |
| `icon_match.py:30-36`, `:50-69` | WebP alpha 손실, 정렬·배경·프레임·숫자 overlay에 민감한 무정규화 MAE, 고정 cutoff. | RGBA 합성→숫자/테두리 mask→±2px 정렬→정규화 구조 점수 순서로 ablation. 작은 아이콘이므로 복잡한 embedding은 이 단계를 통과한 뒤에만 고려한다. |
| `digit_reader.py:20-39` | 40×44 crop을 창고 고정 셀에 그대로 넣어 glyph 위치를 찾지 않는다. | row 내 숫자 bbox를 먼저 추출해 물교 전용 glyph/whole-number 분류에 넣는다. |
| `test_phase3.py` | 합성 아이콘 self-match와 숫자 동의 정책 위주. 실제 PNG의 alpha·오정렬·숫자 경계·잘못된 holdout 경로를 검증하지 않는다. | training/validation 실화면의 정답·거절 예와 CLI 경로 회귀를 추가한다. |

현재 matcher의 정답 top1 점수와 오답 top1 점수는 겹친다. 원본 MAE 정답/오답 score 범위는 입력 `15.30~58.60 / 23.85~60.87`, 출력 `26.28~60.11 / 24.96~60.64`다. cutoff만 올리는 변경은 오확정을 늘릴 수 있다. alpha 합성 뒤에도 정답·오답의 score/gap 분포를 training 이미지에서 다시 보정해야 한다. normalized cross correlation 또는 zero-mean cosine은 밝기 변화에 강한 1차 후보, masked MAE는 색 정보를 보존하는 기준선이다. SSIM·edge/gradient는 2차 ablation, perceptual hash는 작은 유사 아이콘을 구분할 정보가 부족할 수 있으므로 단독 확정기로 삼지 않는다. 작은 평행이동과 1~2가지 resize는 비교 가치가 있다. 무제한 위치·scale 탐색은 오매칭 가능성을 높이므로 금지한다.

## 5. Data Problems

- 이미지 16장, 정답 80행, 동일 UI scale, 대략 75px 주기다. 16장 모두 읽어 row crop을 비교했다. 대표 행은 0(0→1), 10(1→2), 20(2→3), 31·40(4단계), 42(4→5), 50(5→6), 69·74(까마귀 주화), 47·76(아이템 말줄임), 73(섬 말줄임)이다. 44px 아이콘의 하단 우측에 숫자가 포개지고, 3자리 숫자는 그림 일부를 가린다. 단계는 이름 앞의 괄호·색으로 표시된다. 40번 행처럼 긴 이름은 줄바꿈된다.
- PNG와 Phase 2 JSON을 매칭하면 이미지 0~15의 행 수는 `6,4,6,4,6,5,6,5,6,2,6,6,6,1,6,5`다. 이미지 0~1은 출력 tier1, 2~3 tier2, 4~5 tier3, 6~7 tier4, 8~9 tier5, 10~13 tier6/7·특수, 14~15 까마귀 주화에 집중된다. 무작위 행 분할은 같은 이미지의 렌더링과 아이템 반복을 양쪽에 넣어 누출된다.
- 정답 입력 중 reference coverage는 **64/80**, 해당 구간 기존 top1 **29/64=45.3%**다. 출력 coverage는 **50/80**, top1 **22/50=44.0%**다. `29/80`과 `22/80`은 전체 시스템 지표로는 의미가 있지만 **covered icon matcher** 정확도 분모로 쓰면 안 된다.
- app catalog에는 tier 1~5 각 14개에 더해 tier6 24개·tier7 24개·special 9개가 있다. 70 WebP로는 그 밖의 출력을 시각 비교할 수 없다. 정답의 reference 외 출력 30행 중 까마귀 주화 11행, 나머지 19행에는 tier6/7, 특수 아이템, 현재 catalog에 없는 이름도 있다. catalog 밖 이름을 임의로 `special`로 분류하거나 import 가능하다고 간주하지 않는다.
- 까마귀 주화는 11행 모두 OCR 이름이 맞았으나 icon reference가 없다. 양 화면에서 같은 금색 동전 그림이 보인다. 전용 시각 class를 training 스크린샷에서 만들 수 있지만 그 이미지를 다시 테스트에 쓰면 자가 검증이다.
- 현재 expected JSON에는 화면 말줄임의 원형을 따로 보존한 정답이 있다. 아이템 `[4단계] 금주화가 담긴 낡은 ...`는 canonical `금주화가 담긴 낡은 상자`; 섬 `까마귀 상단 소유의 ...`는 출력 display string을 유지하고 내부 후보만 `까마귀 상단 소유의 선박`이다. Phase 2의 OCR raw는 점을 놓칠 수 있다. 이 계약과 정답 JSON은 유지한다.
- 기존 80행은 모든 가설 검토에 이미 사용되었다. 여기서 나온 0 wrong이나 최적 cutoff는 독립 일반화 증거가 아니다. 새 UI scale, 언어·화질·촬영 방식은 별도 failure mode다.

## 6. Numeric Recognition Design

**태스크 정의:** `reqAmount`와 `yield`는 짧은 게임 UI glyph 분류다. 일반 문장 OCR과 분리한다. `count`는 현재 80/80이므로 기존 텍스트 경로를 기준으로 유지하고 교차 점검만 한다.

1. `detect_layout`으로 row top·scale을 얻는다. 입력/출력 아이콘의 현재 관찰된 44×44 박스 `(278,19,322,63)`, `(653,19,697,63)`을 row 상대좌표로 시작하되, 숫자가 아래 경계에 닿는지 training PNG에서 검증해 2~4px 여유를 포함한 ROI를 확정한다. crop 좌표를 하드코딩된 진실로 간주하지 않는다. 화면 scale·row period가 허용 범위 밖이면 숫자도 HOLD한다.
2. ROI의 하단부에서 RGB 채도 낮음·밝음·어두운 외곽선 같은 학습 화면의 실제 glyph 특성을 측정한다. 색 mask 이후 작은 잡음 성분을 제거하고 연속된 x 투영/connected component를 만든다. `1`처럼 분리되기 쉬운 glyph와 `200`처럼 닿는 glyph를 위한 병합·분할 규칙은 training의 정답 bbox로 결정한다. icon의 밝은 부분과 국경선이 숫자로 선택되면 HOLD한다. bbox 및 이진 마스크를 감사 자료로 남긴다.
3. 우측 정렬된 1~3자리(필요하면 4자리) 후보로 자른 뒤 glyph를 동일 canvas에 중심 맞춤한다. training 행에서만 0~9 템플릿을 만들고, 0·5·7 등 실제 등장하지 않은 glyph는 기존 오픈 데이터나 다음 회차 **training**이 생기기 전까지 해당 값 확정을 보류한다. 단일 숫자 template의 top1 거리, top2 다른 숫자와의 gap, blank 대비 margin, 분할 안정성을 산출한다. 동시에 값 전체의 고정 crop template을 학습해 단일/다자리 보조 후보로 쓴다.
4. 실제 분포: `reqAmount`는 `1×70, 10×4, 20×1, 100×3, 200×1, 500×1`이다. `yield`는 `1×34, 2×27, 3×6, 4×1`, 그 외 `100,127,129,161,167,173,188,192,198,200,209,350` 각 1행이다. `count`는 `1×11,2×2,3×1,4×4,5×12,6×8,10×42`다. whole-number 후보는 이 **관찰 집합의 prior**이지 게임 규칙이 아니다. 집합 밖 숫자를 `1` 등으로 고치지 않는다.
5. glyph 결과와 whole-number/숫자 OCR이 같으면 근거가 강해진다. 불일치, bbox 다중 후보, 비양수, 불완전 glyph는 `HOLD_CONFLICT` 또는 `UNKNOWN`. 독립 glyph가 매우 강한 경우만 OCR 부재를 구제할 수 있으며, threshold는 training의 이미지 단위 out-of-fold 결과로 정한다. 현재 창고 gap 0.1 사후 실험(입력 14/14·출력 10/10 정답)은 후보 선택 가설일 뿐 채택 기준이 아니다. 원본 창고 reader의 후보율 20/80·12/80과 오답 2/20도 baseline으로 유지한다.

## 7. Item Recognition Design

**단계 먼저**: 입력/출력 이름 앞의 `[n단계]` ROI를 이름 본문과 분리한다. OCR 패턴 `\[\s*([1-7])\s*단계\s*\]`과 관찰된 색/위치 증거가 일치할 때 tier를 `CONFIRMED`; 충돌하면 `HOLD_TIER`; 읽히지 않으면 `UNKNOWN_TIER`다. 출력 이름을 catalog에 맞췄다는 이유만으로 tier를 역산해 독립 증거인 것처럼 쓰지 않는다. tier 1~5가 확인된 아이콘 후보는 정확히 해당 14개로 제한한다. 정답 tier를 넣어 얻은 54/64·43/50은 upper bound일 뿐 detector 포함 성능은 아직 모른다.

**reference가 있는 closed-world(tier 1~5)**: RGBA WebP를 측정된 화면 배경에 합성한다. 테두리와 하단 숫자 overlay를 mask한다. ±2px 평행이동과 작은 고정 scale 후보만 비교한다. masked color error + zero-mean normalized correlation(또는 cosine)의 점수를 training 이미지로만 보정하고, 동일 tier 내 top1/top2 gap과 absolute quality를 함께 요구한다. OCR canonical exact/unique-safe match를 별도 증거로 두고 둘이 충돌하면 **무조건 HOLD**한다. OCR이 없더라도 icon을 확정할 수 있는지는 독립 validation에서 영(0) 오확정 기준으로 판정한다. reference 외 tier6/7에는 icon 근거가 없으므로 catalog 내 OCR exact 또는 충분히 검증된 unique-safe match만 허용한다.

**open-world 입력**: 출력의 `[1단계]`를 독립 확인하고 입력에 단계 라벨이 없어서 0→1 경로임이 확인된 경우에만 land material 원문을 사용할 수 있다. 입력 OCR은 별도 field crop으로 읽고, 숫자·교섭력 등 주변 텍스트 혼입과 말줄임을 검사한다. 단순 `UNVERIFIED_TEXT + confidence≥0.88`은 확정 조건이 아니다. 읽힌 이름을 임의의 다른 물교품으로 고치지 않고 불확실하면 검토로 보낸다.

**special 및 까마귀 주화**: known special은 app catalog의 실제 명칭과 importer의 `mat`/`coin` 구분을 사용한다. 70-icon matcher의 `UNKNOWN`을 특수품 부재의 증거로 삼지 않는다. 까마귀 주화는 텍스트 OCR이 이번 11/11인 기준선을 유지하면서 별도 output-lane 시각 class를 비교한다. 전용 동전 template은 training PNG의 정답 6행에서만 추출하고, validation의 다른 스크린샷 및 신규 외부 PNG에 대해 동전 대 비동전의 precision/false positive를 평가한다. 공식 canonical 아이콘을 추가로 확보할 수 있으면 provenance와 동일 화면 합성·검증을 거친 뒤에만 대체한다. 텍스트/아이콘 불일치는 HOLD다.

## 8. Island Recognition Design

현재 island 70/80과 count 80/80을 기준선으로 유지한다. row의 섬 이름 고정 lane만 crop하고, full-image detector가 다른 열 box를 끌어오지 않게 한다. 먼저 정확한 OCR 또는 기존 `_match`의 보수적 unique-safe 후보를 적용한다. 낮은 OCR confidence를 dictionary 유사도로 무조건 올리지 않는다. recognition-only `use_det=False`를 crop에 적용하는 실험과 기존 full-image 결과를 같은 training/validation 이미지에서 비교한다. 섬 후보 vocabulary는 앱의 `islands`, `t6Islands`, `t7Islands`와 실제 출력 종류에 따라 제한하되, 출력 종류가 미확정이면 후보 범위를 좁히지 않는다. 문자열이 동일하게 시작하는 섬이 여럿이거나 표시 말줄임의 유일성이 확인되지 않으면 HOLD한다. `까마귀 상단 소유의 ...`는 출력 그대로 두고 내부 canonical candidate만 선박 이름으로 사용한다. 기존 importer의 최종 섬 매칭을 우회하지 않는다.

## 9. Row Semantic Validation

| 조건 | 출처와 판정 | 실패 시 |
|---|---|
| 출력이 catalog tier 1이면 입력 자유 이름 허용 | `trade-import.js:115-133`의 0→1 처리. 화면의 출력 tier와 catalog 결과가 서로 맞아야 한다. | 충돌/HOLD |
| 출력 tier 2~5이면 입력 catalog tier `toTier-1` | 같은 importer의 `fromCandidates = masterData[toTier - 1]`와 화면 단계 표시. | 충돌/HOLD |
| 출력 tier 6/7이면 입력 5/6 및 해당 섬 집합 | importer의 분기·실제 catalog. 아이콘은 tier 1~5 범위 밖일 수 있다. | 충돌/HOLD |
| `mat`/`coin`이면 출력 exact known special이며 입력은 catalog 후보 | importer는 이 경우 넓은 `allItems`를 허용한다. 예시 4→coin은 데이터 관찰일 뿐 일반 법칙이 아니다. | 충돌/HOLD |
| 아이콘·이름·단계 | 서로 다른 독립 증거가 양립해야 한다. icon이 reference 밖이면 icon 근거 없음으로 둔다. | 충돌/HOLD |
| 숫자와 행 필드 | `reqAmount`, `yield`는 관찰된 양의 정수, `count`는 화면에서 읽은 정수. importer의 `reqAmount` 기본 1·`count` 기본 0을 인식 실패 대체값으로 쓰지 않는다. | 누락/HOLD |
| 섬 이름 | 출력 종류에 맞는 현행 importer 후보 집합과 호환되어야 한다. | review/HOLD |

데이터에서 본 0→1, 1→2, 2→3, 3→4, 4→5, 4→coin은 설명 사례다. 임의의 `reqAmount`/`yield` 환산 공식, 중복 화면 제거 규칙, 특정 특수 출력의 추가 경로를 추측해서 확정하지 않는다. 행의 `CONFIRMED`는 여섯 필드가 모두 확정되고 위 검증과 기존 `processParsedTrades`의 *동일 데이터에 대한* 결과가 수용 가능한 경우에만 만든다. importer가 미등록 출력 이름 등으로 거절하는 경우는 recognition 성공으로 집계하지 않는다. 원본 정답 기준 80행 중 2행(인덱스 67·68)의 출력 이름은 현재 catalog에 없어 direct import에서도 거절되므로 인식 오류와 importer 계약 거절을 따로 센다.

## 10. Training / Validation / Holdout Protocol

1. **파일 단위 고정 분할**: Phase 2 `rows`에서의 첫 등장 순서로 PNG 인덱스 0~15를 정의한다. training = `0,2,4,6,8,10,11,13,15` (9장, 48행); internal validation = `1,3,5,7,9,12,14` (7장, 32행). 각 출력 tier1~5, reference 밖, coin이 양쪽에 들어간다. index와 실제 파일명·SHA-256을 새 평가 manifest에 고정한다. screenshot 인덱스를 새 파일에 재할당하지 않는다.
2. training의 정답만 crop 위치 보정, 숫자 glyph/whole template, 까마귀 주화 template, 스크린샷 도메인 보정, threshold 선택에 쓴다. threshold는 training screenshot 단위 leave-one-image-out의 out-of-fold 예측에서 선택한다. 각 후보 `(quality cutoff, top1-top2 gap, OCR 정책)` 중 **오확정 0**을 만족하며 coverage가 최대인 것을 고르고 동률이면 더 엄격한 후보를 택한다. 표본이 부족한 class는 cutoff를 만들지 말고 HOLD한다. 선택 절차와 seed/순서를 manifest에 기록한다.
3. internal validation 7장은 **모든 파라미터가 동결된 뒤 한 번** 평가한다. validation을 본 뒤 고친다면 해당 수치는 개발 피드백으로 격하하고 다음 신규 PNG로 다시 검증한다. 이 80행 전체는 이번 리뷰에서 이미 열람했으므로 완전한 미공개 validation이라고 부르지 않는다.
4. 같은 아이템 그림이 train/validation에 반복될 수 있다. 별도로 item-disjoint 또는 leave-one-item-out 스트레스 결과를 작성해 screenshot-domain 템플릿이 동일 아이템 반복에 의존하는지 본다. 이 검사는 정본 reference만 사용하는 경로와 train-screen template 경로를 분리해 보고한다.
5. **신규 회차 PNG는 true external holdout**으로 잠근다. 새 PNG와 별도 정답을 수집·해시하고, 단일 동결 모델·threshold·catalog snapshot·코드 해시로 첫 실행을 기록한다. 외부 정답으로 템플릿 추가, threshold 조정, 오류별 예외 추가, 여러 설정을 시도해 최선 결과 선택, 예시 이미지 수동 선별을 하지 않는다. 수정 후 재평가는 새 개발 버전이며 같은 PNG를 재사용한 결과를 신규 holdout PASS라고 부르지 않는다.
6. `--images` 버그를 먼저 고치고 두 폴더의 동명이인·서로 다른 픽셀을 사용한 경로 테스트를 통과시켜야 신규 평가는 유효하다. 정답과 PNG는 `(image file, row)`로 결합해 순서 착오를 검출한다.

## 11. Proposed Phase 4 Pipeline

| 순서 | 입력 → 출력 | 상태 및 실패 처리 |
|---|---|---|
| 1. Image gate | PNG path → 파일 hash, 크기, scale 후보, row layout | 형식·scale·row count 불확실 시 이미지 전체 `HOLD_LAYOUT`; OCR 결과를 다른 폴더 픽셀과 결합하지 않는다. |
| 2. Row crop | image+row top → island/count, 단계 라벨, 이름, 두 icon/숫자 ROI | 각 crop의 절대좌표·정규화 좌표를 provenance로 보존; box 경계 실패 `HOLD_CROP`. |
| 3. Tier/exchange type | 양쪽 단계 라벨 crop·special text/icon → `toTier`, `fromTier`, `type`, 근거 | `CONFIRMED_TIER`, `UNKNOWN_TIER`, `HOLD_TIER_CONFLICT`; 미확정 tier를 아이템 정답에서 역산하지 않는다. |
| 4. Candidate restriction | tier/type + 앱 catalog/reference snapshot → 후보 집합 | 1~5는 해당 14개 icon, 6/7·special은 catalog OCR, 0→1 입력만 open text. 집합 밖은 `OUT_OF_CATALOG`/review. |
| 5. Field readers | 필드별 crop + 제한 후보 → top-k 값, score, OCR raw, 원인 | 숫자 glyph/whole, 이름 crop OCR, alpha 합성 icon matcher, 섬/횟수 reader를 독립 실행. 값 없는 경우 null을 유지. |
| 6. Evidence fusion | 같은 field의 icon/OCR/template → `CONFIRMED`, `CANDIDATE`, `HOLD_CONFLICT`, `UNKNOWN` | 높은 단일 confidence가 충돌을 덮지 않는다. cutoff는 train에서 고정된 것만 사용. |
| 7. Row validation | 6개 field+type+catalog → confirmed row 또는 review row | 계약·단계·양의 숫자·ellipsis·importer 호환 검사. 모든 상태/근거/원문/파일 좌표를 보존. |
| 8. Export/evaluate | confirmed rows → SPEC-004 `{island,fromItem,reqAmount,toItem,count,yield}` JSON; held rows → review 항목 | 자동 export에는 여섯 키만 넣고 불확실 행을 섞지 않는다. 평가 시만 expected JSON을 읽는다. review에서 사용자가 승인한 행은 원본 근거와 수정값을 구별한다. |

`processParsedTrades`, safe item matching, 0→1 land good, island matching과 미등록 출력 필터는 현행 importer의 최종 방어선으로 유지한다. recognizer는 그것을 조용히 우회하거나 필드 기본값을 채우지 않는다. 중복 스크린샷의 동일 교환 판별은 별도 SPEC-100 후속 범위이며 Phase 4 인식 점수에 숨겨 넣지 않는다.

## 12. Success Gates

각 field에 대해 `precision = 정답 확정/전체 확정`, `coverage = 전체 확정/평가 대상`, icon의 경우 별도로 **reference-covered subset의 top1·accept precision**을 보고한다. 행에 대해 `row precision = 정답 자동 확정/자동 확정`, `row coverage = 자동 확정/전체 감지`, `wrong-confirmed count`, `HOLD rate`, `import-equivalent = 현재 importer가 같은 정답 행과 같은 수용·거절 판정을 낸 수`를 보고한다. 분모 0이면 precision을 `N/A`로 쓴다. 정답 없는 실사용 데이터의 wrong-confirmed는 `UNKNOWN`이다.

| Gate | 고정 기준 | 의미 |
|---|---|---|
| 기초 기능 | 고정 16장 row detection 80/80 유지, 경로 전달·determinism·명시된 six-key JSON과 ellipsis 테스트 PASS | 구성 자체의 정상 동작 |
| 필드 검증 | internal validation와 신규 external에서 자동 확정된 `reqAmount`·`yield`·item·island 각각 관찰 오답 **0**. 정확도와 coverage를 함께 공개. Phase 2 기준선 대비 숫자 coverage 상승이 없으면 숫자 설계 실패. | 0은 표본 내 관찰치이며 통계적 무오류 증명이 아니다. |
| 검토용 제품 후보 | internal validation 32행 중 **최소 8행**(25%) 자동 완성, 신규 external은 최소 30행일 때 **≥25%** 자동 완성; 양쪽 wrong-confirmed 0, 나머지 행의 raw/candidate/reason이 전부 표시 가능. | 0 HOLD만으로 통과하지 못한다. 작은 external은 `INCONCLUSIVE`. |
| 자동 import 확대 후보 | internal validation **≥13/32행**(40%), 신규 external **≥40%** 자동 완성 및 양쪽 wrong-confirmed 0; 자동 완성 행의 `import-equivalent` 전부 일치. | 별도 제품 통합 심사가 필요하다. 이 리뷰가 자동 import 승인인 것은 아니다. |
| 실패 시 | 오확정 1건 이상이면 해당 class 자동 확정을 즉시 중지·원인 분석. external coverage <25%면 local review usefulness 미달. | 외부 데이터로 threshold를 즉석 변경하지 않는다. |

`import-equivalent`는 단순 필드 정답과 다르다. 현행 importer가 reject하는 catalog 밖 행은 인식이 정확해도 자동 import 성공 행으로 세지 않는다. 검토를 거친 행의 수와 자동 확정 행의 수를 따로 보고한다. exactness는 공백 정규화나 OCR raw와 구별하여 기존 JSON 계약 기준으로 비교한다.

## 13. Dependency and Packaging

Phase 4 **오프라인 프로토타입**은 이미 사용 중인 Pillow·NumPy, RapidOCR Korean model/ONNX Runtime을 우선 사용한다. Alpha 합성·mask·상관계수·±2px 탐색·connected component의 작은 ROI 처리는 Pillow/NumPy로 구현 가능하므로 OpenCV와 ML embedding을 즉시 추가할 근거가 없다. OpenCV가 training/validation에서 명확한 증분 성능을 줄 때만 패키지 비용을 계측해 재결정한다. 창고 scanner 코드·템플릿은 변경하지 않고 비교 기준으로만 둔다. Phase 4 설계/평가 동안 production `local_app/pyproject.toml`, launcher, 프런트엔드에는 의존성을 추가하지 않는다. 실사용 패키징 판단 시 모델 파일 bytes, runtime wheel bytes, 초기화 시간, 한 이미지 처리 시간, Windows offline 설치 여부를 함께 기록한다. 예상 추가 production dependency는 **미결정**이며, 우선안은 기존 모델·런타임 재사용과 작은 자체 템플릿 파일이다.

## 14. Product Strategy

| 전략 | 정확도/false confident | 사용자 조작 | 크기·의존성 | 유지보수/개발 | 오프라인 |
|---|---|---|---|---|---|
| FULL LOCAL | Phase 3은 0/80 confirmed. Phase 4 외부 검증 전 자동 입력 안전성 미입증. | 성공 시 적음; HOLD가 많으면 큼 | OCR 모델과 NumPy/Pillow 필요 | 모든 class와 UI 변형 지원 부담 큼 | 가능 |
| **HYBRID LOCAL REVIEW** | 확정 기준은 엄격히, HOLD는 raw·후보·이유를 보여 사용자가 수정. 오확정을 검토로 이월할 수 있다. | 불확실 행/필드만 교정. 실제 교정량은 신규 데이터로 측정해야 함 | 위 로컬 의존성; GPT 추가 없음 | UI 검토 흐름은 후속 과제. 인식기 범위를 작게 유지 가능 | 가능 |
| GPT FALLBACK | 기존 방식은 계속 사용할 수 있으나 이 80행과 동일한 검증·오류율 자료가 없어 우위 주장 불가 | 외부 JSON 생성·검토·붙여넣기 | 로컬 모델 대신 외부 서비스/연결 | 프롬프트·응답 포맷·서비스 변화 관리 | 불가 |
| LOCAL FIRST + GPT FALLBACK | 로컬 확정과 외부 결과의 충돌 해결 정책이 추가로 필요. GPT 결과도 importer 검토 필수 | 가장 적을 가능성은 있으나 미측정 | 로컬+외부 두 경로 | 비용·개인정보·충돌 처리 복잡성 최대 | 일부만 가능 |

**권장: HYBRID LOCAL REVIEW**, 위 검토용 gate를 신규 holdout까지 통과한다는 조건이다. Phase 4는 인식 결과와 review 후보를 산출하는 격리된 프로토타입에 머물고, 실제 UI 연결은 별도 승인·Spec에서 판단한다. gate가 실패하면 현재 GPT JSON 입력 흐름을 유지하며 로컬 결과를 검토 보조로만 쓴다. GPT가 더 정확하다는 근거는 아직 없으므로 `GPT_FALLBACK_RECOMMENDED`를 로컬 방식 전체의 불가능 판정으로 사용하지 않는다.

## 15. Luna Implementation Specification

아래 task는 의존 순서다. 모든 파일은 `tools/barter_scan/` 및 `specs/100-barter-screenshot/` 아래의 **프로토타입/평가 파일**로 한정한다. production `local_app`/루트 HTML/warehouse scanner/reference 원본/expected JSON/기존 importer/scheduler/completion은 수정하지 않는다. 제시한 파일명은 신규 Phase 4 산출물 계약이며, 동등한 작은 모듈로 합치는 경우 import 경로와 평가 manifest를 먼저 갱신한다. 각 task의 단위 테스트와 실화면 평가를 분리한다.

### T1. 경로·데이터 분할·평가 계약

- **목적:** 오늘 데이터와 신규 holdout을 혼동하지 않는 재현 가능한 실행기.
- **파일:** `tools/barter_scan/phase4_evaluate.py`, `tools/barter_scan/test_phase4_paths.py`, `specs/100-barter-screenshot/phase4-split-manifest.json` 생성. 기존 Phase 3 CLI를 직접 재사용한다면 `phase3_evaluate.py`의 `image_dir` 누락만 최소 수정하고 회귀 테스트를 붙인다.
- **입력/출력:** `--images`, `--expected`(평가 시만), `--split-manifest`, `--model-dir` → 행별 `(image,row)`·raw·상태·근거 JSON 및 집계 JSON. PNG 파일명/sha256, 코드·catalog·템플릿 해시 기록.
- **알고리즘/보정:** 본 문서의 train/validation 인덱스를 실제 파일명에 매핑하고 중복·누락·순서 오류를 실패 처리. 모든 단계에 같은 `images` 경로 전달. threshold 조정은 training out-of-fold 결과만.
- **금지:** 폴더 기본값으로 픽셀을 몰래 읽기, 정답을 inference 함수에 전달, validation/external에 맞추어 설정 재선택.
- **테스트/완료:** 동명 PNG를 서로 다른 픽셀로 두 폴더에 만들어 경로가 끝까지 전파됨을 확인; 파일명 누락 시 명시 오류; 실화면 80행 매핑과 결정론을 재현. 새 폴더 평가가 과거 픽셀과 섞이지 않으면 완료.

### T2. 이미지·row·필드 ROI 및 단계 판독

- **목적:** full-image OCR 혼입을 줄이고 독립적인 단계 근거를 얻는다.
- **파일:** `tools/barter_scan/phase4_layout.py`, `tools/barter_scan/phase4_tier.py`, `tools/barter_scan/test_phase4_layout_tier.py` 생성.
- **입력/출력:** PNG+row index → field별 pixel ROI/좌표, scale 상태, `fromTier/toTier/type`와 근거/status.
- **알고리즘/보정:** 현재 75px 반복 및 lane 좌표를 baseline으로 train 이미지에서 이름·단계·icon·하단 숫자 ROI를 계측. `[n단계]`를 OCR 독립 crop과 색/위치 cue로 확인하고 충돌 시 HOLD. 출력에 라벨 없는 special/coin은 텍스트 또는 전용 시각 class가 확인될 때만 구분. bbox/scale 허용 범위를 training만으로 고정.
- **금지:** 정답 item의 catalog tier를 화면에서 판독한 tier처럼 사용, catalog 밖 출력의 tier 추측, 신규 scale 강제 맞춤.
- **테스트/완료:** 0→1, 일반 1~5, 5→6, coin, 긴 2줄 이름, item/island 말줄임의 실제 crop을 점검; 라벨 충돌·잘린 이미지 HOLD. 독립 단계의 validation precision/coverage를 별도 제시.

### T3. 물교 전용 숫자 분리·인식

- **목적:** `reqAmount/yield`의 8/80·10/80 baseline을 실제 glyph 근거로 넘는다.
- **파일:** `tools/barter_scan/phase4_digits.py`, `tools/barter_scan/test_phase4_digits.py`, `specs/100-barter-screenshot/phase4-digit-templates.npz` 생성. warehouse 파일은 읽기만 한다.
- **입력/출력:** T2 숫자 ROI → `value|null`, bbox, glyph 후보/거리/gap, whole 후보, OCR 원문, `CONFIRMED/CANDIDATE/HOLD_CONFLICT/UNKNOWN`.
- **알고리즘/보정:** training 정답으로 밝은 glyph mask와 연결 성분/가로 투영 분할을 교정. 정규화 glyph 0~9 및 whole-number 템플릿을 training에서 생성. 수치 후보/blank 대비 margin/second-digit gap/분할 안정성을 training 이미지 단위 out-of-fold에서 cutoff 선택. OCR 동의는 보조 신호; 충돌은 HOLD. 미학습 glyph나 집합 밖 값은 강제 치환하지 않는다.
- **금지:** 현 expected JSON을 infer 시 로드, 숫자 1 기본값, 실제 숫자를 삭제하는 mask, 창고 template을 새 UI ground truth로 간주.
- **테스트/완료:** 1·2·3자리, `500`, `167`, `200`, `209`, icon 배경의 흰 영역, 빈칸, outline, OCR 불일치, bbox 경계 테스트. train/validation 양쪽 필드 precision·coverage, wrong-confirmed를 보고하고 validation 자동 확정 오답 0.

### T4. reference icon 매칭 및 특수 출력

- **목적:** 70 WebP의 covered 구간과 reference 밖 출력을 구별해 안전한 후보를 낸다.
- **파일:** `tools/barter_scan/phase4_icons.py`, `tools/barter_scan/test_phase4_icons.py`, `specs/100-barter-screenshot/phase4-coin-templates.npz` 생성.
- **입력/출력:** T2 icon crop+독립 tier+reference/catalog snapshot → top-k canonical item, 품질·gap·정렬량, `IN_REFERENCE/OUT_OF_REFERENCE`, `CONFIRMED/CANDIDATE/UNKNOWN`.
- **알고리즘/보정:** RGBA를 배경에 합성; frame·숫자 overlay mask; tier 1~5는 14개씩 비교; ±2px 및 고정 scale만 허용. masked MAE를 기준선으로 zero-mean NCC/cosine을 training out-of-fold에서 ablation, 최소 복잡도의 우세 방식을 고정한다. 점수와 top1-top2 gap cutoff는 training만. coin은 train 이미지 15의 5행에서 전용 icon template을 만들고 validation 이미지 14의 6행 및 비coin 행에서 평가한다. tier6/7·special은 icon reference 부재를 `UNKNOWN_ICON`으로 반환한다.
- **금지:** 정답 tier 입력, raw RGB WebP에 Phase 3 cutoff 18을 그대로 사용, icon top1을 무조건 확정, validation coin에서 template 생성.
- **테스트/완료:** alpha=0/중간/1 합성, border/숫자 가림/±2px, 같은 색의 다른 item, tier 오판과 coin false positive 테스트. covered-subset top1/accept precision과 전체 시스템 coverage를 각각 보고한다. validation 자동 확정 오답 0.

### T5. 필드별 OCR·catalog·ellipsis

- **목적:** 섬 70/80·입력 36/80·출력 67/80을 오확정 없이 개선한다.
- **파일:** `tools/barter_scan/phase4_text.py`, `tools/barter_scan/test_phase4_text.py` 생성; `barter_scan.py`의 `_match`/`_clean_item`은 가능한 한 호출해 중복 정책을 피한다.
- **입력/출력:** T2 text ROI, 단계/type, 현행 catalog → OCR raw/confidence, canonical 후보, display 값, 상태와 review reason.
- **알고리즘/보정:** field ROI에서 RapidOCR `use_det=False`와 기존 detection 경로를 비교해 training에서 필드별 선택. tier 확정 시 해당 catalog로 안전 일치; tier6/7·special은 현행 catalog 제한. 섬은 적합한 island 집합만 사용. 0→1 input만 자유 텍스트 보존. item ellipsis는 유일한 canonical 후보가 있을 때만 확정하고 island contracted string은 display 그대로 출력.
- **금지:** 입력 이름에 붙은 숫자/교섭력 혼입을 그대로 확정, `UNVERIFIED_TEXT`를 교환 종류 없이 승격, 낮은 OCR confidence를 단순 문자열 유사도로 확정, importer matching 계약 변경.
- **테스트/완료:** `금주화가 담긴 낡은 ...`, `까마귀 상단 소유의 ...`, 중복 접두사, 줄바꿈, `0송` 혼입, land good, 미등록 출력 테스트. 각 필드 validation precision·coverage 및 HOLD 이유를 보고한다.

### T6. 근거 결합·행 검증·SPEC-004 JSON 변환

- **목적:** 높은 단일 field score 때문에 잘못된 물교 행이 자동 입력되지 않게 한다.
- **파일:** `tools/barter_scan/phase4_pipeline.py`, `tools/barter_scan/test_phase4_pipeline.py` 생성. 기존 importer 코드는 변경하지 않는다.
- **입력/출력:** T1~T5의 각 상태 → 6키 확정 JSON 배열과 별도 review 배열(원문, 후보, 점수, 좌표, 실패 이유 포함).
- **알고리즘/보정:** 섹션 9의 현재 importer 관계만 적용. `CONFIRMED` field 6개+단계 호환+숫자 양수+섬 후보+icon/text 무충돌이면 행 확정. catalog 밖 출력은 importer-equivalent 불가로 review. training에서 정한 field cutoff를 그대로 사용; 행 판정에 정답을 사용하지 않는다.
- **금지:** null을 1/0으로 채움, 다른 열 증거로 conflict 덮기, 0→1이 아닌 입력 자유 텍스트 허용, `processParsedTrades` 변경, scheduler/completion 호출.
- **테스트/완료:** 0→1 정상, 일반 교환, 6/7, special/coin, 단계 충돌, icon/OCR 충돌, 섬 충돌, 미등록 출력 67·68, 숫자 누락을 synthetic+실화면으로 확인. 자동 JSON은 정확히 여섯 키, review에는 불확실 행 전체가 남고 기존 importer와 수용/거절 비교를 기록.

### T7. 평가·ablation·동결 및 결정 보고

- **목적:** 개선이 실제 외부 데이터에 일반화되는지 구분한다.
- **파일:** `tools/barter_scan/phase4_evaluate.py` 완성, `tools/barter_scan/test_phase4_evaluate.py`, `specs/100-barter-screenshot/phase4-evaluation.json`, `specs/100-barter-screenshot/phase4-validation-report.md` 생성. 신규 회차 자료는 별도 입력 경로·manifest로만 참조한다.
- **입력/출력:** train/validation/external 이미지와 별도 정답 → 섹션 12의 필드·행 지표, 오확정 사례, latency/size, alpha·tier·metric·OCR ablation, 코드/설정 해시.
- **알고리즘/보정:** train 내부 OOF로 한 번 선택하고 lock; internal validation 한 번, 신규 external 첫 평가 한 번. 정답 매칭은 `(PNG sha256, row)`; precision 분모 0은 N/A. reference-covered와 out-of-reference를 분리한다. 같은 이미지 반복·동일 item 반복 영향도 따로 집계.
- **금지:** external 정답으로 threshold/template 갱신, 외부 결과를 본 뒤 동일 세트를 새로운 holdout이라고 보고, HOLD 100%를 PASS, GPT의 미측정 정확도를 숫자로 추정.
- **테스트/완료:** 평가기 분모·누락·중복·0 confirmed·wrong-confirmed의 단위 테스트와 경로 회귀. 검토용 gate와 자동 import 후보 gate 각각 PASS/FAIL/INCONCLUSIVE를 근거와 함께 보고한다. 이 단계가 끝나기 전까지 production UI/API/launcher/package 작업은 시작하지 않는다.
