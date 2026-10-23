# 개발 환경

모든 명령은 저장소 루트에서 실행합니다. Python 3.12와 Windows를 권장합니다. Python 기본 의존성은 Flask·Waitress·NumPy·Pillow이며 JavaScript는 빌드 없이 제공됩니다. Node 테스트는 22 이상을 사용합니다. 대부분 기본 모듈로 동작하며 일부 UI 검사는 개발 의존성 Playwright를 사용합니다. `npm ci`로 lockfile에 고정한 버전을 설치합니다. Chrome은 별도 설치된 실행 파일을 사용하므로 Playwright 브라우저 다운로드는 필요하지 않습니다.

## 기본 앱과 물교 OCR

```powershell
py -3.12 -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[test,ocr]"
$env:PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path
$env:PYTHONDONTWRITEBYTECODE='1'
& $env:PYTHON -B -m local_app.launcher
```

물교 OCR은 `onnxruntime`, OpenCV, PyYAML과 별도의 검증된 모델을 사용합니다. 기본 위치는 `.local/models/trade/inference.onnx`와 `inference.yml`입니다. 다른 위치는 `BDO_TRADE_OCR_MODEL_DIR`, 별도 OCR Python은 `BDO_TRADE_OCR_PYTHON`으로 지정합니다. 지정하지 않으면 현재 Python으로 worker를 실행합니다.

모델 원본 파일은 Git에 포함하지 않습니다. 기존 물교 설치본의 `app/_internal/local_app/recognition_data/trade-model/`에 있는 검증된 파일을 재사용할 수 있습니다. Suite 새 빌드는 `app/_internal/barter/recognition_data/trade-model/`에 포함합니다. 임의 모델로 바꾸면 런타임 해시 검사를 통과하지 못합니다. 모델이 준비되지 않아도 기본 화면·수동 입력·창고·연금 기능을 개발할 수 있지만 물교 OCR 사용 가능 상태는 충족되지 않습니다.

모델 고정 해시의 기준은 `barter/backend/services/trade_batch_runtime.py`입니다. ONNX SHA-256은 `92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08`, 설정 파일은 `f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998`입니다.

## 기존 설치 환경 재사용

기존 PC의 `D:/BDOBarterDev/_dev/recognition-local/`은 소스 저장소와 별개인 환경입니다. 이번 구조 정리로 이동하지 않습니다. 해당 환경을 재사용한다면 다음 변수만 지정합니다.

```powershell
$env:PYTHON='D:/BDOBarterDev/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
$env:BDO_TRADE_OCR_PYTHON='D:/BDOBarterDev/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe'
$env:BDO_TRADE_OCR_MODEL_DIR='D:/BDOBarterDev/_dev/recognition-local/models/t010b1/official_models/korean_PP-OCRv5_mobile_rec_onnx'
$env:PYTHONDONTWRITEBYTECODE='1'
& $env:PYTHON -B -m local_app.launcher
```

## 경로와 의존성

| 경로 | 용도 |
|---|---|
| `local_app/backend` | API와 저장·검증·worker 연결 |
| `barter/frontend/js/domain` | 재고·교섭력·배차·완료·지도 계산 |
| `barter/recognition_data/trade-templates.json` | 현재 881개 물교 정답 reference와 특징 해시 |
| `barter/recognition_data/warehouse-templates.npz` | 설치 앱과 동일한 창고 숫자·검증 표본 |
| `tools/warehouse_patch/quantity_templates.npz` | 재생성·회귀 비교용 원본 자료, 배포 보정 자료와 구별 |
| `reference` | 판독과 앱 초기화에 사용하는 70종 품목·아이콘 |
| `tools/experiments` | 제품이 import하지 않는 별도 실험 도구 |
| `.local`, `.venv` | Git에서 제외하는 개인 환경과 큰 모델 |

루트 `pyproject.toml`은 개발용 editable 설치와 의존성 관리에 사용합니다. 배포 단위는 [PyInstaller 폴더 패키지](PACKAGING.md)입니다. 일반 wheel을 Windows 앱 배포물로 취급하지 않습니다.

[검증 방법](TESTING.md), [현재 제품 계약](CURRENT-PRODUCT-CONTRACT.md)을 함께 확인하세요.
