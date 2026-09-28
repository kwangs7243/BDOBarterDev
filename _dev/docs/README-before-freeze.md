# BDO 물교

검은사막 물물교환 목록, 마스터 창고 재고와 선박 설정을 이용해 교환 스케줄을 만드는 단일 HTML 도구다.

## 현재 정식 버전

- 버전: `v1.0`
- 실행 파일: `BDO_물교_v1.0.html`
- 상태: 자동 회귀 통과
- 실제 브라우저 자동 검증: `BROWSER_NOT_RUN`

사용할 때는 루트의 `BDO_물교_v1.0.html`만 열면 된다.

## 현재 확인된 주요 동작

- JSON 붙여넣기의 정확 일치 및 고신뢰 단일 후보 자동 보정
- 행별 교환 수율 보존
- 수동 입력 수율 편집
- 기존 백업 복원 시 충돌 행 보류
- 완료 버튼에 따른 재고·교환 목록·교섭력 갱신
- 스케줄에 표시된 일반·특수·까마귀주화·7단 교환의 완료 보류 제거
- 완료 시 부족한 입력 재고는 0에서 멈추고 목록·교섭력·완료 상태는 항상 갱신
- 현재 사용자 데이터의 3지역 7단 17개와 충분 재고의 30개 조건 검증

## 폴더

- `docs`: 저장소와 릴리스 운영 문서
- `reports`: v1.0 조사·검증 보고서
- `tests`: 자동 회귀 코드
- `test_results`: 자동 회귀 실행 결과
- `fixtures`: 테스트 전용 입력
- `inputs`: 수정하지 않는 원본 HTML과 사용자 백업

## 개발 및 검증

작업자는 먼저 `AGENTS.md`와 `docs/REPOSITORY_WORKFLOW.md`를 읽어야 한다.

간단한 필수 검증:

```powershell
node tests/regression_core.js
node tests/followup_regression.js
node tests/regression_modes.js
node tests/tier7_completion_regression.js
node tests/completion_no_hold_regression.js
node tests/scheduler_preservation_regression.js
```

전체 검증과 릴리스 절차는 `docs/REPOSITORY_WORKFLOW.md`에 있다.
