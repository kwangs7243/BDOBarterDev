# GPT 검토팩 안내

## 가장 먼저 볼 파일

1. `BDO_물교_v1.0.html`
   - 실제 사용 가능한 최종 통합 HTML
2. `reports/v1.0/VERIFICATION.md`
   - 완료 보류 기능 제거, 스케줄러 보존, 7단 30개 임계치, 검증 결과, 미수정 위험
3. `reports/v1.0/COMPLETION_NO_HOLD.md`
   - 완료 차단 제거 범위와 까마귀의 둥지 재발 사례 전용 보고
4. `test_results/tier7_completion_regression.json`
   - 최종 HTML 대상으로 수행한 7단 완료 전용 10개 회귀 결과
5. `test_results/tier7_threshold_diagnostics.json`
   - 현재 재고 17개와 가상 재고 30개 비교, 품목별 임계치

## 회귀 묶음

- `tests/regression_core.js`: 기존 핵심 오류와 저장·새로고침·복원
- `tests/followup_regression.js`: 수동 입력 수율과 기존 백업 충돌
- `tests/regression_modes.js`: 일반/내해/7단 모드 보존
- `tests/scenario_matrix.js`: 32개 재고·모드 조합
- `tests/tier7_completion_regression.js`: 이번 완료 오류 전용
- `tests/completion_no_hold_regression.js`: 일반·특수·까마귀주화·7단 완료 차단 제거 전용
- `tests/tier7_threshold_diagnostics.js`: 3지역 30개 임계치 전용
- `tests/scheduler_preservation_regression.js`: 기존 스케줄러 소스와 최소보존 영향 보존 전용

## 상태 표기

- 자동 회귀: PASS
- 실제 브라우저: `BROWSER_NOT_RUN`
  - 로컬 `file://` 페이지가 브라우저 자동화 보안 정책에 의해 차단됨
- `inputs/` 원본 HTML과 사용자 백업: 변경 없음
- 경로·씨앗·까마귀주화·배차 알고리즘: 변경 없음
