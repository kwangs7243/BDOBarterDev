# BDO 물교 도우미 — 현재 V2

검은사막 물교 화면을 로컬 인식하고, 사용자가 모든 행의 여섯 필드를 검수한 뒤 회차에 적용하는 Windows localhost 앱이다. 수동 JSON 입력, 창고 인식, 배차와 경로 계산도 제공한다. 구현은 `local_app/` 하나를 기준으로 한다.

## 개발 실행 (PowerShell)

저장소의 `_dev`에서 실행한다. uv와 설치된 Python 3.14가 필요하다.

```powershell
uv venv recognition-local/r006-env-recovery/venv314 --python 3.14
$env:PYTHON = "$PWD\recognition-local\r006-env-recovery\venv314\Scripts\python.exe"
uv pip install --python $env:PYTHON -r local_app/pyproject.toml --extra test
$env:PYTHONDONTWRITEBYTECODE = '1'
& $env:PYTHON -B -m local_app.launcher
```

이미 검증된 환경이 있으면 생성·설치를 반복하지 않고 `PYTHON`만 지정한다. 앱 주소는 **http://localhost:18765/**. 실제 데이터는 `%LOCALAPPDATA%/BDOBarter` 아래에 저장된다. 테스트는 임시 SQLite와 별도 sidecar만 사용한다.

로컬 OCR은 별도 Python/ONNX 모델을 요구한다. 현재 설치 경로는 `recognition-local/envs/t010b1-ocr/Scripts/python.exe`와 `recognition-local/models/t010b1/official_models/korean_PP-OCRv5_mobile_rec_onnx`다. 다른 설치에서는 `BDO_TRADE_OCR_PYTHON`, `BDO_TRADE_OCR_MODEL_DIR`를 지정한다. 모델/전용 OCR 환경 배포와 새 PC 설치 검증은 R012의 미완료 항목이다. 위 pyproject 설치만으로 OCR 모델까지 설치되지는 않는다.

## 실사 검증

```powershell
node local_app/tests/browser_trade_review_live.mjs --help
node local_app/tests/browser_trade_review_live.mjs --preflight
node local_app/tests/browser_trade_review_live.mjs --live --run-dir "$PWD\recognition-local\live-validation\r011\new-independent-run" --case-id fresh-stream-01 --input-mode STREAM --cohort INDEPENDENT
```

실사는 새 source/run/case를 사용한다. 열린 Chrome에서 직접 화면 공유→ROI→캡처→로컬 인식→전 행 검수→증거 저장→새 회차 적용을 수행한다. 평소 Windows 배율/Chrome zoom을 그대로 사용하며, 재사용 화면을 independent로 부르지 않는다. 검수 창에서 원문·후보·위험·출처를 확인할 수 있다. preflight는 실제 게임 캡처를 소비하지 않는다.

## 검증과 패키지

```powershell
& $env:PYTHON -B -m pytest local_app/tests/backend -p no:cacheprovider
node local_app/tests/trade_review_evaluation_regression.mjs
node local_app/tests/reviewed_trade_dto_regression.mjs
node local_app/tests/trade_session_staging_regression.mjs
node local_app/tests/browser_trade_review.mjs
node local_app/tests/browser_trade_review_session.mjs
node local_app/tests/browser_trade_batch_recognition.mjs
```

현재 core suite는 다음 목록이다. 삭제한 복원 mega-test의 고유 검사는 아래 JSON 회차·배차·창고·회차 제어 검사로 이식했다.

- Backend: `tests/backend/` 전체와 `tests/test_launcher.py`. real Pillow, 임시 Main DB/sidecar만 사용한다.
- Domain (13 entrypoints): `capture_input_regression`, `reviewed_trade_dto_regression`, `screen_capture_regression`, `trade_batch_reconciliation_regression`, `trade_catalog_audit_regression`, `trade_domain_contract`, `trade_import_regression`, `trade_master_registry_regression`, `trade_recognition_client`, `trade_review_evaluation_regression`, `trade_review_projection_regression`, `trade_roi_capture_regression`, `trade_session_staging_regression`.
- Browser (14 entrypoints): `browser_capture_input`, `browser_map_restoration`, `browser_recognition_security`, `browser_scheduler`, `browser_screen_capture`, `browser_session_controls`, `browser_smoke`, `browser_trade_batch_recognition`, `browser_trade_review`, `browser_trade_review_persistence`, `browser_trade_review_session`, `browser_trade_roi_capture`, `browser_trade_session`, `browser_warehouse_scan`.
- Live harness: `browser_trade_review_live --help/--preflight`. 실제 게임 capture는 별도 owner 실사다.

모든 JS entrypoint는 `local_app/tests/<이름>.mjs`다. domain 검사는 저장소 root에서 `node _dev/local_app/tests/<이름>.mjs`, browser 검사는 `_dev`에서 `node local_app/tests/<이름>.mjs`로 실행한다. 고정 임시 서버 포트를 공유하는 browser 검사는 순차 실행한다. 내부 앱 배율 130%의 기존 main panel overflow는 roadmap의 별도 미해결 항목이며, 설정 저장 검사는 유지한다.

브라우저 테스트는 `PYTHON`의 절대 경로와 설치된 Chrome을 사용한다. 배포 빌드 환경에 `pyproject.toml`의 `package` extra를 설치한 뒤 `local_app/packaging/build.ps1 -Python $env:PYTHON`을 실행한다. 산출물은 `local_app/dist/app/`이다. 이 recipe의 존재는 packaged OCR/릴리스 승인을 뜻하지 않는다.

## 파일 경계

- `local_app/backend`, `frontend`, `recognition_data`: 현재 앱과 인식 계약/데이터.
- `reference/barter_items.json`, `reference/icons`, `tools/warehouse_patch`: 현재 창고 인식의 직접 runtime dependency. 삭제하면 스캔이 깨진다.
- `local_app/tests/fixtures`: 현재 회귀가 읽는 입력/정답. 과거 캡처를 재사용하는 테스트는 known replay이며 independent 평가가 아니다.
- `tools/recognition_benchmark.py`, `recognition_dataset.py`, `local_app/tools`: 현재 인식 회귀/데이터 검증 및 live 평가 도구. `trade_*experiment.py` 일부는 실제 worker가 import하므로 이름만 보고 제거하지 않는다.
- `specs/008-capture-recognition-v2`: [제품 계약](specs/008-capture-recognition-v2/CURRENT-PRODUCT-CONTRACT.md), 결정, 남은 로드맵, 승인 기준.
- `recognition-local/`: Git 제외 환경·모델·실사 evidence·로컬 결과. 실사 승인 전 증거를 임의 삭제하지 않는다. cache 안에도 재생 evidence가 있으므로 이름만 보고 지우지 않는다.

옛 구현과 배포물은 Git history 및 `pre-root-cleanup-20261001-0338` 태그에서 복구한다. 테스트의 frozen JSON expected는 삭제 전 V1 실행 결과로 생성했고 현재 코드 출력으로 덮어쓰지 않는다.
