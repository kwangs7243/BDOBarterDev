# 현재 회귀와 패키지 기준

모든 자동 검사는 임시 DB·임시 Chrome profile을 사용한다. 출력도 OS 임시 폴더 또는 명시한 저장소 외부 경로에 둔다. 모델/템플릿과 fixture 정답을 테스트 출력으로 덮어쓰지 않는다.

## 환경과 자동 회귀

현재 검증 환경은 다음 두 개다. 실행 파일/모델의 기본 경로는 `D:\BDOBarterDev\_dev\recognition-local` 아래이며 설치 위치가 다르면 환경변수로 지정한다.

- backend/pytest: `r006-env-recovery/venv314/Scripts/python.exe` (Python 3.14, Flask/Waitress/NumPy/Pillow/pytest).
- local OCR/package: `envs/t010b1-ocr/Scripts/python.exe` (Python 3.12, ONNX Runtime/OpenCV/PyInstaller).

저장소 root에서:

```powershell
$env:PYTHON='D:/BDOBarterDev/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
$env:PYTHONDONTWRITEBYTECODE='1'
$env:BDO_TRADE_OCR_PYTHON='D:/BDOBarterDev/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe'
$env:BDO_TRADE_OCR_MODEL_DIR='D:/BDOBarterDev/_dev/recognition-local/models/t010b1/official_models/korean_PP-OCRv5_mobile_rec_onnx'
Push-Location _dev
& $env:PYTHON -B -m pytest local_app/tests -p no:cacheprovider -q
Pop-Location
node _dev/local_app/tests/run_current.mjs
git diff --check
```

`run_current.mjs`는 현재 domain entrypoint와 browser entrypoint를 순차 실행하고 실패 시 nonzero로 종료한다. `--domain`, `--browser`, `--out <외부 또는 임시 경로>`로 범위를 제한할 수 있다. 게임/실사 evidence를 요구하는 `tests/live/`는 포함하지 않는다.

현재 UI 검사는 100% 배율의 1920×1080, 1440×900, 2560×1440을 사용한다. 기존 map/native 회귀의 130%는 사용자 설정 호환 검사이며 디자인 목표가 아니다. UI 기준 파일은 `fixtures/ui-actions.json`과 `fixtures/ui-schedule.json`이며 구현 결과로 자동 갱신하지 않는다.

Windows GDI/ROI 임시 창 검사는 desktop 접근이 필요하다. 제한된 실행 환경의 screen-grab 오류는 제품 실패와 구분해 실제 desktop에서 재검사한다. `BDO_OS_INPUT_PREFLIGHT=1`의 SendInput 검사는 명시적 interactive opt-in이며 실제 BDO 검사가 아니다. 실제 hardware/desktop/game 부재만 SKIP 사유로 허용한다.

창고 화면 공유 검사는 native unavailable 응답과 canvas stream을 명시적으로 모의한다. 설치 패키지에서 native available이면 fallback 영역을 숨기는 현재 동작은 native 회귀가 검증한다. 실제 화면 공유 선택 권한이나 BDO pixels의 검증으로 보고하지 않는다.

## 실사와 이미지 품질

- `tests/live/browser_departure_causality.mjs`: `BDO_CAUSALITY_EVIDENCE_DIR`의 두 실사 snapshot으로 조사한다. 입력이 없으면 서버 시작 전 SKIP한다. 일반 자동 회귀는 synthetic `scheduler_departure_causality.mjs`가 담당한다.
- `tests/live/trade_live_list_accuracy.py`: 기존 16장/80행 정답과 결과를 비교하는 수동 품질 보고다. 정확도와 row omission을 출력하며, 실패를 자동 기능 회귀 성공으로 숨기지 않는다.
- warehouse `barter_only.png`/`mixed.png`와 `warehouse-oracle.json`, calibration 이미지/manifest는 정답 자료로 유지한다. trade mapping·정답·모든 PNG는 known replay이며 새 실사 독립 truth가 아니다.

실제 BDO foreground physical F10, 실제 pixels, 현재 물교/창고 인식 정확도와 실사용 UX는 게임에서 별도로 확인한다. 코드 freeze 이후의 새 실사에서만 그 범위의 PASS를 선언한다.

## Package

빌드 입력은 현재 frontend/backend/native/launcher, trade catalog, 70개 warehouse icon/reference, trade ONNX/YAML, calibrated warehouse NPZ다. 원래 template 생성과 checked-feedback calibration 도구는 새로운 검증 데이터의 명시 적용에 사용한다.

```powershell
$packagePython='D:/BDOBarterDev/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe'
$env:BDO_PACKAGE_TRADE_MODEL_DIR=$env:BDO_TRADE_OCR_MODEL_DIR
$env:BDO_PACKAGE_WAREHOUSE_TEMPLATES='D:/BDOBarterDev/_dev/recognition-local/models/warehouse/quantity_templates.npz'
& _dev/local_app/packaging/build.ps1 -Python $packagePython -OutputRoot "$env:TEMP/bdo-package-release"
```

배포 gate는 자동 회귀 0 FAIL, 모델/현재 OCR 보정 및 review/mapping 동일, source/package asset hash 일치, 임시 AppData의 실제 executable startup/workflows/restart/shutdown, 실제 설치본의 사용자 운영 상태/ROI 보존이다. package smoke의 OCR 비교는 검증된 이전 설치본 baseline을 명시해야 한다. 현재 fixture의 알려진 인식 오차를 정답 변경으로 숨기지 않는다.

실제 app 갱신 전 정상 종료·외부 backup, 갱신 후 모든 배포 file hash·health·browser UI·정상 종료를 확인한다. build/dist와 이전 package는 current repository에 쌓아두지 않는다. commit/push는 해당 작업에서 명시 승인된 경우에만 한다.
