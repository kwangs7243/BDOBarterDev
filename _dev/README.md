# BDO 물교 도우미

Windows에서 실행하는 로컬 물교 도우미다. 현재 회차와 창고 재고, 출항 스케줄·지도, 수동 F10 캡처와 물교/창고 인식·검수·적용을 제공한다. 구현은 `local_app/` 하나이며 승인된 charcoal/blue desktop UI와 현재 계산 결과를 유지한다.

현재 동작은 [CURRENT-PRODUCT-CONTRACT.md](CURRENT-PRODUCT-CONTRACT.md), 회귀·실사·패키지 명령은 [TESTING.md](TESTING.md)를 기준으로 한다. 미래 architecture와 지난 개발 보고서는 현재 tree의 authority가 아니다.

## 실행

사용자 앱: `D:\BDOBarterDev\app\BDO 물교 실행.exe`.

개발 실행은 `_dev`에서 한다:

```powershell
$env:PYTHON='D:/BDOBarterDev/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
$env:PYTHONDONTWRITEBYTECODE='1'
$env:BDO_TRADE_OCR_PYTHON='D:/BDOBarterDev/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe'
$env:BDO_TRADE_OCR_MODEL_DIR='D:/BDOBarterDev/_dev/recognition-local/models/t010b1/official_models/korean_PP-OCRv5_mobile_rec_onnx'
& $env:PYTHON -B -m local_app.launcher
```

주소는 `http://localhost:18765`. Main DB와 물교/창고 ROI는 `%LOCALAPPDATA%\BDOBarter\data`에 저장된다. 작업 회차·재고·설정은 앱 재시작 후 복원된다. 새 환경은 `local_app/pyproject.toml`의 기본/test/package 의존성을 해당 Python 환경에 설치하며, OCR 모델과 검증된 calibrated template는 별도 로컬 빌드 입력이다.

## 현재 폴더

| 경로 | 필요한 이유 |
|---|---|
| `local_app/backend` | API 계약, revision/idempotency, SQLite 상태와 개선 history 저장 |
| `local_app/frontend` | 승인 UI, 입력·검수·설정, 현재 스케줄/완료/지도 계산 |
| `local_app/native_*.py`, `launcher.py` | Windows 창/ROI/F10, frame ACK, 진단, 단일 실행과 정상 종료 |
| `local_app/tools` | 실제 trade OCR worker/reader와 checked warehouse feedback calibration |
| `local_app/packaging` | 현재 모듈·모델·template·frontend의 PyInstaller 빌드 |
| `local_app/tests` | 현재 자동 회귀, 사용 중인 golden fixture, 별도 `live/` 수동 검사 |
| `reference` | 창고 70종 catalog/icon, 실제 판독과 package 입력 |
| `tools/warehouse_patch` | 현재 창고 판독기, 원래 template와 재생성 도구 |
| `recognition-local` | Git 제외 현재 Python 환경·trade 모델·calibrated warehouse template만 |

현재 물교/창고 화면의 다른 입력 방법과 JSON 수동 입력도 지원한다. 인식 결과를 자동 적용하지 않는다. 성공한 인식은 대기 이미지를 비우고 검수 출처를 유지하며, 저장 성공 후 적용 모달을 닫는다.

평소 테스트는 실제 사용자 DB를 사용하지 않는다. 수정/피드백 history는 새 실사 개선 자료이며, 초기화는 사용자 요청과 검증된 외부 백업 이후에만 한다. 외부 archive의 과거 자료를 현재 정답이나 현재 실행 결과로 취급하지 않는다.
