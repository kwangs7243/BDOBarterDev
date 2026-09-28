# SPEC-100 — ABANDONED

- 최종 상태: **ABANDONED / DEFERRED_INDEFINITELY**
- 중단일: 2026-09-26
- External holdout: **NOT_RUN / ABANDONED_BEFORE_EXTERNAL_VALIDATION**
- 제품 통합: **미실행**. SPEC-000~006의 창고 scanner와 JSON importer는 유지한다.

## 중단 이유

로컬 인식이 기술적으로 불가능하다고 판정한 것은 아니다. 현재 방식의 개발·유지 비용에 비해 실사용 편익이 부족하고, 기존 GPT 이미지 인식 → JSON 입력 방식을 사용할 수 있다. Phase 5는 내부 검증에서 오확정 0이었으나 사용할 수 있는 숫자 확정 결과도 0이었다. 이는 실사용 정확도를 입증한 결과가 아니다.

## Phase 1~5 결과

| 단계 | 기존 기록에 근거한 결과 |
|---|---|
| 1 | 16장, 80행의 구조를 검출했다. 실제 필드 인식은 하지 않았으며 불확실 필드는 HOLD했다. |
| 2 | 80행에서 island 70, fromItem 36, reqAmount 8, toItem 67, count 80, yield 10개가 정답과 일치했다. 완전한 행 인식은 0/80이었다. |
| 3 | OCR·아이콘·창고 숫자 template 결합으로 Phase 2 필드 점수가 개선되지 않았다. 확정 행 0/80, 전부 HOLD였다. |
| 4 | 내부 validation 32행 중 완전 확정 0. reqAmount 4개 정답 확정, yield는 4개 정답·1개 오확정, toItem도 1개 오확정이었다. |
| 5 | reqAmount 0/32, normal yield 0/26, coin yield 0/6, 완전 행 0/32 확정. wrong-confirmed 0이지만 모든 실용성 gate 실패: PHASE5_FAILED. |

근거: [feasibility-report.md](feasibility-report.md), [phase4-design-review.md](phase4-design-review.md), [phase4-validation-report.md](phase4-validation-report.md), [phase5-digit-review.md](phase5-digit-review.md), [phase5-validation-report.md](phase5-validation-report.md).

Phase 5 training OOF에서 reqAmount는 48행 중 후보 9개·정답 확정 3개였으나, normal-yield 36행과 coin-yield 5행에서는 결합 후보 0개로 nonempty zero-error cutoff를 얻지 못했다. 내부 validation 숫자 coverage도 0으로 떨어졌다. 이미 관찰했던 데이터의 내부 결과이며 외부 일반화 성능을 입증하지 않는다.

## 보존과 제거

이 폴더에는 사람이 읽는 Markdown만 보존한다. 이전 문서의 PENDING과 실행 명령은 실험 당시 역사이며 **이 문서의 중단 상태가 우선**한다. 문서가 언급하는 prototype 코드·JSON·NPZ·OCR 모델은 이번 동결 과정에서 제거했으므로 해당 명령은 더 이상 실행할 수 없다.

원본 PNG 16장과 변경하지 않은 정답 JSON은 [_dev/archive/spec100-original-data](../../archive/spec100-original-data/)에 보존한다. 제품 app에는 포함하지 않는다. 외부 holdout은 실행하지 않았으며 이번 중단 후에도 실행하지 않는다.

## 향후 재도전

검토 후보는 전용 digit classifier, 다른 OCR/VLM, 새로운 local vision model, 충분한 데이터가 확보된 supervised approach다. 어느 접근도 현재 성능이 검증되었다고 주장하지 않는다.

재도전은 production과 분리된 **새 experiment**로 시작한다. 원본 자료, 기존 실패 원인, 데이터 분할과 오확정·coverage 기준을 먼저 검토하고 별도 승인된 평가 계획을 세운다. 기존 production scanner·scheduler·completion을 실험 대상으로 변경하지 않는다.
