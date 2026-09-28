# 저장소 및 릴리스 운영 절차

## 목적

로컬에 이전 HTML과 백업 사본을 계속 쌓지 않고 Git 커밋, 작업 브랜치와 릴리스 태그로 버전별 검증 상태를 보존한다.

## 브랜치 구조

- `main`: 자동 회귀를 통과한 최신 정식 버전
- `release/vX.Y`: 다음 버전 개발·수정·검증 브랜치

기능별 임시 브랜치가 더 필요하면 `work/<짧은-이름>`을 사용할 수 있지만, 최종 버전 확정은 `release/vX.Y`에서 수행한다.

## 새 버전 작업 순서

1. `main`이 깨끗하고 원격과 동기화됐는지 확인한다.
2. 다음 버전 브랜치를 만든다.

   ```powershell
   git switch -c release/v1.1
   git push -u origin release/v1.1
   ```

3. 기존 버전에서 문제를 재현하고 수정 전 결과를 저장한다.
4. 필요한 최소 범위만 수정한다.
5. 필수 회귀를 모두 실행한다.
6. 실제 브라우저 검증을 실행하지 못했으면 보고서에 `BROWSER_NOT_RUN`을 남긴다.
7. 모든 필수 자동 검증이 통과한 뒤 다음 항목을 함께 갱신한다.
   - `VERSION`
   - 루트 HTML 파일명 `BDO_물교_vX.Y.html`
   - HTML 화면과 진단 정보의 표시 버전
   - `README.md`
   - `docs/VX.Y_BASELINE.md`
   - 현재 버전 보고서와 테스트 결과
8. 작업 브랜치를 푸시한다.
9. 검증 결과를 다시 확인한 뒤 `main`에 병합한다.

   ```powershell
   git switch main
   git merge --no-ff release/v1.1
   git tag -a v1.1 -m "BDO 물교 v1.1"
   git push origin main
   git push origin v1.1
   ```

10. 원격 `main`과 태그가 로컬 커밋을 가리키는지 확인한다.

## 필수 회귀

```powershell
node tests/regression_core.js --json-out test_results/regression_core.json
node tests/followup_regression.js --json-out test_results/followup_regression.json
node tests/regression_modes.js --json-out test_results/regression_modes.json
node tests/inventory_completion_diagnostics.js --json-out test_results/inventory_completion_diagnostics.json
node tests/tier7_completion_regression.js --json-out test_results/tier7_completion_regression.json
node tests/completion_no_hold_regression.js --json-out test_results/completion_no_hold_regression.json
node tests/tier7_threshold_diagnostics.js --json-out test_results/tier7_threshold_diagnostics.json
node tests/scenario_matrix.js --json-out test_results/scenario_matrix.json
node tests/scheduler_preservation_regression.js --json-out test_results/scheduler_preservation_regression.json
```

시나리오 행렬을 분할 실행할 때는 `--fixture A`, `B`, `C`, `D`를 사용하고 결과도 각각 구분해 저장한다.

## 루트 파일 정책

- 최신 `BDO_물교_vX.Y.html`만 둔다.
- 중간 사본, 이전 버전 HTML과 날짜별 작업 폴더를 두지 않는다.
- GPT 검토 ZIP은 로컬 전달용으로만 생성하며 `.gitignore`에 따라 원격에 올리지 않는다.
- 이전 버전 복구는 `git switch --detach vX.Y` 또는 별도 작업 브랜치로 수행한다.

## 커밋 분리

- 규칙·문서와 저장소 초기화
- 제품 HTML 변경
- 테스트 및 검증 결과
- 릴리스 버전 확정

목적이 다른 변경을 가능한 한 별도 커밋으로 유지한다. 사용자의 다른 작업을 임의로 스테이징하거나 되돌리지 않는다.

## 비밀정보

- 토큰, API 키, `.env`, 인증서와 개인 키는 커밋하지 않는다.
- HTML의 로컬 저장 데이터와 백업 내보내기에는 API 키를 포함하지 않는다.
- 푸시 전 `git status`, staged diff와 추적 대상 파일을 확인한다.
