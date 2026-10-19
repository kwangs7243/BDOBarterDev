# 03 · 실험 엔진과 기존 OCR 연결

## 1. 파일 구성

구현 위치는 아래로 제한한다. 별도 plugin/registry/service 계층을 만들지 않는다.

```text
_dev/local_app/experiments/trade_template_v1/
  __init__.py
  cli.py
  contracts.py
  baseline.py
  dataset.py
  bank.py
  matcher.py
  engine.py
  evaluate.py
  benchmark.py
  report.py
_dev/local_app/tests/experiments/trade_template_v1/
  test_dataset.py
  test_matcher.py
  test_engine.py
  test_evaluate.py
```

## 2. 고정 baseline 로드

baseline.py는 manifest root를 해석하고 frozen source를 importlib spec의 별도 module 이름으로 로드한다. `__file__`은 preparationRoot의 실제 frozen 파일 경로여야 한다. 설치 앱이나 현재 working tree의 OCR을 대신 import하지 않는다.

B0는 frozen `recognize_live(captures, model_dir, batch_id, on_progress=...)`를 그대로 호출한다. model_dir도 frozen baseline-model이다. 계측용 LocalReader subclass는 private 로드 모듈 안에서만 사용한다. 원래 session.run 결과를 그대로 반환하고 다른 모듈의 전역 함수를 바꾸지 않는다.

engine.py는 frozen recognize_live의 orchestration 함수만 기반으로 작성한다. read_*, apply_trade_rules, trade_stages, detector, LocalReader는 모두 frozen module에 위임한다. catalog는 frozen source의 frontend/data/trade-catalog.json을 명시적으로 읽는다. 새 engine.py의 __file__.parents로 catalog를 찾으면 안 된다.

## 3. 처리 순서

```text
reader = legacy.LocalReader(frozen_model_dir)
catalog = read_frozen_catalog()
for capture in original_order:
    boxes = legacy.detect_live_rows(original_rgb)
    layout = probe_layout(original_rgb, metadata)
    template_enabled = valid_layout_and_not_coverage_suspect
    for ordinal, rowBox in boxes:
        original_row와 유효할 때의 aligned_row 생성
        fields, field_offsets를 v13과 동일하게 초기화
        for field in island, fromItem, toItem, count, reqAmount, yield:
            이름:
                V3의 지원 대상이면 matcher 시도
                HIT가 아니면 원래 read_catalog_name
                toItem 단계가 1이면 원래 land-only fromItem 재판독
            count:
                원래 read_count
            reqAmount/yield:
                원래 apply_trade_rules를 먼저 실행
                TRADE_RULE이면 원래대로 continue
                yield이며 variant의 자격이 맞으면 aligned_row로 matcher 시도
                HIT가 아니면 original_row로 원래 read_yield/read_requirement
        원래 apply_trade_rules
        원래 offset 기반 불확실 숫자 재판독 branch
        원래 box 부착, rows append, progress
```

초기 모델 로드를 생략하는 최적화는 이번 범위 밖이다. matcher의 효과만 비교한다. 현재 순서·예외 처리·fallback crop·투표·충돌·outline 규칙을 바꾸지 않는다.

matcher HIT는 reviewRequired=false이므로 기존 불확실 재판독 대상에서 빠진다. primary ABSTAIN 후의 aligned legacy 재판독에는 template를 다시 넣지 않는다. V3 이름 HIT 이후에도 catalog와 apply_trade_rules를 그대로 사용하고 육지 fromItem 재판독을 유지한다.

## 4. 필드 결과 계약

HIT 필드는 다음 형식이다. 예시 값·좌표·id는 실제 fixture로 등록하지 않는다.

```json
{
  "rawOCR": "",
  "corrected": 3,
  "reviewRequired": false,
  "confidence": null,
  "variants": [],
  "valueSource": "VERIFIED_TEMPLATE",
  "templateEvidence": {
    "bankVersion": "sha256",
    "referenceIds": ["reference-id"],
    "method": "EXACT_RGB",
    "distance": 0.0,
    "margin": null,
    "sourceImageSha256": "CURRENT-input-image-hash",
    "guardBox": {"x": 0, "y": 0, "width": 1, "height": 1}
  },
  "box": {"x": 0, "y": 0, "width": 1, "height": 1}
}
```

숫자 corrected는 int, 이름은 canonical string이다. 이름 HIT는 masterMatch=RESOLVED를 추가하고, recognizedStage가 필요하면 catalog에서만 구한다. template 유사도를 OCR confidence에 넣거나 label을 OCR 원문으로 쓰지 않는다.

box는 현재 rowBox와 frozen field bounds로 계산하고 HIT에 사용한 offset을 더한다. guardBox는 넓은 비교 crop의 현재 좌표다. offset을 사용하면 field_offsets[field]=offset_x와 alignmentOffsetX를 기록해 마지막 box 부착에서 잃지 않도록 한다. 원본 이미지 밖이면 HIT를 취소하고 baseline으로 돌린다.

ABSTAIN/ERROR 필드는 legacy 결과 dict와 완전히 같아야 한다. fallback field의 confidence/rawOCR/variants에 matcher 진단을 섞지 않는다. 진단은 sidecar에 둔다.

## 5. 응답과 증거

version=3, batchId, captures 순서, rows의 captureId/ordinal/rowBox, 6 fields 키를 유지한다. rowDetector는 frozen 값을 유지하고 candidate.engine은 trade-template-experiment-v1로 한다. candidate를 production worker v13이 실행한 결과라고 표시하지 않는다.

별도 sidecar에는 specId, variant, executionMode(SHADOW/FAST), baseline hashes, bankVersion, captureId, imageSha256, ordinal, 현재 rowBox, field, status, reason, method, referenceIds, distance, margin, lookup time, legacy field calls, session.run calls를 넣는다.

실제 API에 실험 응답을 POST하지 않는다. UI 경계는 frozen prepareLiveTradeRows에 복제한 응답을 전달하는 로컬 Node 검사로만 확인한다. 적용·보정 저장은 호출하지 않는다.

## 6. SHADOW와 FAST

SHADOW는 baseline 결과를 바꾸지 않고 matcher의 제안만 sidecar에 기록한다. pin된 과거 baseline 응답을 재사용할 수 있지만, 먼저 대표 1장의 새 B0 결과와 응답 내용을 비교한다. 다르면 해당 입력 집합의 B0를 재생성한다. 과거 baseline 응답은 truth가 아니다.

FAST는 위 처리 순서로 실제 OCR을 생략한다. SHADOW의 제안 횟수·예상 절감량을 FAST 실측으로 보고하지 않는다. 모든 입력이 fallback이어도 구현 완료와 성능 개선 완료를 구분한다.

SHADOW는 B0 문맥에서의 단독 제안이다. V3에서 이름 HIT가 B0 이름을 바꾸면 후속 숫자의 자격은 FAST에서 다시 평가하고 `context_changed` trace로 남긴다. 같은 문맥에서의 matcher 결과는 SHADOW/FAST가 같아야 한다. 문맥 변화 사례를 억지로 동일 처리하지 않는다.

## 7. 재실행과 오류

동일 runId의 입력·config·source hashes가 같으면 완성된 stage 결과를 hash 검증 후 재사용한다. 다르면 덮어쓰지 않고 새 runId를 요구한다. 중간 파일은 임시 이름으로 저장 후 rename한다. 원본 자료나 baseline을 지우고 재시도하지 않는다.

bank 손상은 BANK_INVALID 진단 후 B0로 완주한다. baseline/model hash 불일치는 preflight FAIL이다. template 예외와 기존 OCR 실행 오류를 분리해서 보고한다.
