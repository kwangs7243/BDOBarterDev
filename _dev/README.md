# BDO 물교 개발 안내 — SPEC-007 기능 회복

기존 SPEC-006 동결 기록: [docs/FROZEN_VERSION.md](docs/FROZEN_VERSION.md). 현재 SPEC-007 저장 계약은 [spec](specs/007-feature-restoration/spec.md), 기능 분류 근거는 [감사표](specs/007-feature-restoration/audit-report.md)를 따른다. 구현·실행 파일 교체·데이터 보존 결과와 미검증 항목은 [완료 보고서](specs/007-feature-restoration/validation-report.md)에 기록했다.
사용자 실행 파일은 상위 폴더의 app/BDO 물교 실행.exe이며 실행하기.cmd가 이를 실행한다.

## 구조

- local_app: Flask/Waitress, 브라우저 UI, launcher, PyInstaller 설정과 SPEC-001~007 테스트
- tools/warehouse_patch, reference: 보호된 창고 scanner·템플릿·품목·아이콘
- specs: SPEC-000~007 및 SPEC-100 역사
- tests, fixtures, test_results: 원본 HTML 회귀·입력·기존 결과
- reports/freeze-20260926: 정리 전후 실행 로그·해시·패키지 감사
- BDO_물교_v1.0.html, inputs: 수정 금지 비교 원본
- archive/spec100-original-data: 제품에서 사용하지 않는 원본 PNG와 정답 JSON
- review-packages: 이전 검토 ZIP, 제품 배포 대상 아님

과거 문서의 저장소 루트 상대경로는 이제 _dev를 기준으로 읽는다. 이전 루트 README는 docs/README-before-freeze.md에 그대로 보존했다. 기존 AGENTS.md의 HTML 단일 배포/루트 규칙은 이번 사용자의 명시적인 패키지 동결 지시로 대체되며 보호 알고리즘 규칙은 유지된다.

## 개발 실행

아래 명령은 _dev를 작업 디렉터리로 사용한다. 실제 사용자 DB 대신 반드시 격리 LOCALAPPDATA를 지정한다.

```powershell
$env:LOCALAPPDATA = Join-Path $env:TEMP ('BDOBarterDev-' + [guid]::NewGuid().ToString('N'))
python -m local_app.launcher
```

의존성 계약은 local_app/pyproject.toml을 따른다. 테스트/빌드에는 호환 Python 3.11 이상과 실제 Pillow·NumPy가 필요하다. 가짜 Pillow 또는 다른 Python 버전의 바이너리 강제 사용은 금지한다.

## 검증

```powershell
python -m compileall -q local_app
python -m unittest discover -s local_app/tests -v
node local_app/tests/equivalence/verify-migration.mjs
node local_app/tests/trade_import_regression.mjs
$env:PYTHON = (Get-Command python).Source
node local_app/tests/browser_smoke.mjs
node local_app/tests/browser_warehouse_scan.mjs
node local_app/tests/browser_trade_session.mjs
node local_app/tests/browser_scheduler.mjs
node local_app/tests/browser_restoration.mjs
node local_app/tests/browser_map_restoration.mjs
```

Chrome 테스트는 Google Chrome과 WebSocket을 지원하는 Node가 필요하다. 기본값은 C:\Program Files\Google\Chrome\Application\chrome.exe이며 BDO_CHROME으로 변경 가능하다. 기본 실행은 임시 DB를 만든다. BDO_TEST_URL을 지정하면 대상 서버를 수정하므로 실제 사용자 앱을 대상으로 실행하지 않는다.

원본 HTML 필수 회귀는 다음 9종이다. 각각 node tests/<이름>.js --json-out <새 결과 경로>로 실행한다.

- regression_core, followup_regression, regression_modes
- inventory_completion_diagnostics, tier7_completion_regression, completion_no_hold_regression
- tier7_threshold_diagnostics, scenario_matrix, scheduler_preservation_regression

scenario_matrix의 unexpectedReserveViolations는 0이어야 한다. 이 전체 행렬은 몇 분 이상 걸릴 수 있다. scanner 실제 API·직접 convert·review/apply·충돌·임시 파일 정리는 Python/Chrome SPEC-003 테스트에서 검증한다. 오래된 tests/warehouse_patch_regression.py의 main은 이전 HTML 해시를 고정하므로 현재 SPEC-000 기준과 불일치한다. 기대값을 바꾸지 않았고, 동결 검증에서는 그 파일의 두 evaluate_fixture 함수를 그대로 호출하여 고정 정답을 별도로 확인했다.

## 패키지 빌드

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -Python '<호환 Python 실행기>'
```

기존 PyInstaller onedir 설정을 사용한다. package extra의 PyInstaller가 설치되어 있어야 한다. 출력은 **상위 루트 app**이며 재빌드 시 기존 app을 교체하므로 실행 중인 앱을 먼저 종료한다. 빌드 작업 파일은 별도의 Temp 폴더에 생성한다. 최종 배포에는 Python 설치가 필요 없다.

## 보호 및 연구 상태

원본 HTML, warehouse_patch.py, reference, fixture, processParsedTrades 및 scheduler/completion 보호 본문과 테스트 기대값을 임의 수정하지 않는다. 현재 API/DB schema 2 계약은 [SPEC-007](specs/007-feature-restoration/spec.md)을 따른다. 단일 회차와 슬롯 5개를 영구 설정과 분리하고 완료 재고·회차는 원자적으로 저장한다. 타이머는 복원하지 않는다. 변경 전후 SHA-256과 같은 입력 회귀로 확인한다.

SPEC-100은 **ABANDONED / DEFERRED_INDEFINITELY**다. [ABANDONED.md](specs/100-barter-screenshot/ABANDONED.md)부터 읽고, 재도전은 별도 승인된 새 experiment로만 시작한다. 보존 문서의 과거 실행 명령·PENDING 상태는 현재 지시가 아니다.
