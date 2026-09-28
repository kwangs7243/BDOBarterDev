# BDO 물교 저장소 작업 규칙

이 문서는 이 저장소에서 작업하는 모든 에이전트와 작업자가 따라야 하는 정본 규칙이다.

## 1. 현재 버전과 사용본

- 현재 정식 버전은 루트 `VERSION` 파일을 기준으로 한다.
- 사용자가 실행하는 파일은 루트의 `BDO_물교_v{VERSION}.html` 하나다.
- 루트에는 최신 사용 HTML만 배치한다. GPT 검토 ZIP은 필요할 때 만들 수 있지만 Git에는 포함하지 않는다.
- 이전 버전 HTML, 중간 사본, 날짜별 복제 폴더를 로컬에 누적하지 않는다. 이전 상태는 Git 커밋, 릴리스 태그와 원격 브랜치로 보존한다.

## 2. 보호 대상

- `inputs/ORIGINAL_v14_1.html`과 `inputs/ORIGINAL_user_backup_20260923.json`은 비교용 원본이다. 수정하지 않는다.
- 경로 설정, 씨앗 선정, 지역 분류, 까마귀주화 동선과 배차 알고리즘은 사용자의 명시적 요청 없이 수정하지 않는다.
- 스케줄에 표시된 정상 교환 카드는 완료 단계에서 최소보존, 재고 부족, 선행 교환 순서 또는 교환 종류를 이유로 보류하지 않는다. 중복 클릭 방지만 유지한다.
- 범위 밖 문제는 `reports/`에 기록하고 임의로 수정하지 않는다.
- JSON 아이템 마스터와 고신뢰 단일 후보 유사도 보정 기능을 제거하지 않는다. 모호한 후보는 사용자 확인 대상으로 남긴다.

## 3. 수정 원칙

1. 원본 또는 현재 버전에서 먼저 재현한다.
2. 원인을 확정한다.
3. 작업 브랜치에서 필요한 최소 코드만 수정한다.
4. 수정 전후 동일 데이터로 비교한다.
5. 자동 테스트와 가능한 실제 브라우저 검증을 분리해 기록한다.
6. 실제 브라우저를 실행하지 못했으면 `BROWSER_NOT_RUN`으로 명시한다.

## 4. 버전과 브랜치 절차

- `main`은 검증을 통과한 최신 정식 버전만 유지한다.
- 새 버전 작업은 `release/vX.Y` 브랜치를 `main`에서 생성해 진행한다.
- 작업 중에는 기존 `VERSION`과 사용 HTML 이름을 유지한다.
- 모든 필수 검증이 통과한 뒤에만 `VERSION`과 HTML 파일명을 새 버전으로 올린다.
- 검증 실패 상태는 정식 버전으로 병합하거나 태그하지 않는다.
- 작업 브랜치를 원격에 먼저 푸시한 뒤 `main`에 `--no-ff` 병합하고 `vX.Y` 태그를 만든다.
- 병합 후 작업 브랜치는 삭제할 수 있지만 릴리스 태그는 유지한다.

세부 절차는 `docs/REPOSITORY_WORKFLOW.md`를 따른다.

## 5. 필수 자동 검증

다음 테스트는 최신 HTML을 기본 대상으로 실행되어야 한다.

```powershell
node tests/regression_core.js
node tests/followup_regression.js
node tests/regression_modes.js
node tests/inventory_completion_diagnostics.js
node tests/tier7_completion_regression.js
node tests/completion_no_hold_regression.js
node tests/tier7_threshold_diagnostics.js
node tests/scenario_matrix.js
node tests/scheduler_preservation_regression.js
```

- 핵심, 후속, 모드, 완료 차단 제거, 스케줄러 보존과 7단 완료 테스트에 실패가 없어야 한다.
- 시나리오 행렬의 `unexpectedReserveViolations`는 0이어야 한다.
- 결과 JSON은 `test_results/`에 저장하고 버전 기준 보고서와 일치시킨다.

## 6. 저장소 정리 규칙

- 루트: 최신 HTML, `VERSION`, `README.md`, `AGENTS.md`와 저장소 설정 파일만 둔다.
- `docs/`: 장기 유지할 운영·버전 문서
- `reports/`: 현재 버전의 검증 및 조사 보고서
- `tests/`: 회귀 코드
- `test_results/`: 현재 버전의 검증 결과
- `fixtures/`: 테스트 입력
- `inputs/`: 변경 금지 원본
- `archive/`, 날짜별 사본 폴더와 압축 해제용 임시 폴더는 만들지 않는다.

## 7. Git 포함 금지

- GPT 검토용 ZIP과 기타 압축 파일
- 인증정보와 환경변수 파일
- OS·편집기 임시 파일
- 로그, 캐시, 의존성 폴더와 임시 백업

정확한 패턴은 `.gitignore`를 따른다.
