# Windows 패키징

제품 배포는 PyInstaller 폴더 패키지입니다. 가상환경·빌드 출력·개인 운영 DB는 Git에 포함하지 않습니다. 모든 명령은 저장소 루트에서 실행합니다.

```powershell
.venv/Scripts/python.exe -m pip install -e ".[package]"
$env:BDO_PACKAGE_TRADE_MODEL_DIR=(Resolve-Path .local/models/trade).Path
& local_app/packaging/build.ps1 -Python .venv/Scripts/python.exe -OutputRoot "$env:TEMP/bdo-package-release"
```

결과는 지정 출력 폴더의 `dist/app/BDO 물교 실행.exe`와 그 옆 `_internal/` 전체입니다. exe만 복사하지 않습니다. ONNX 모델은 [개발 안내](DEVELOPMENT.md)의 검증된 모델이어야 합니다.

| 빌드 입력 | 기본 위치/설정 |
|---|---|
| frontend·backend·native·worker | 저장소의 `local_app/` |
| 품목·아이콘 | `reference/` |
| 물교 ONNX/YAML | `.local/models/trade/` 또는 `BDO_PACKAGE_TRADE_MODEL_DIR` |
| 물교 정답 사전 | `local_app/recognition_data/trade-templates.json` 또는 `BDO_PACKAGE_TRADE_TEMPLATES` |
| 창고 보정 표본 | `local_app/recognition_data/warehouse-templates.npz` 또는 `BDO_PACKAGE_WAREHOUSE_TEMPLATES` |

물교 사전은 reader의 SHA-256과 일치해야 합니다. 창고 표본은 `feedback_slots`, 검증 행 수, 수량·품목·출처가 일치해야 합니다. 원본 숫자 사전만으로 보정된 배포 자료를 대신하지 않습니다. 일반 빌드에서도 현재 정답 사전이 포함되므로 별도 환경변수를 빠뜨려 인식 가속이 누락되지 않습니다.

## 배포 검증

1. [자동 회귀](TESTING.md)와 모델·정답 사전 무결성을 확인합니다.
2. 임시 AppData에서 실제 실행 파일의 시작·health·기본 흐름·종료·재시작을 검사합니다. 저장 이미지 재생은 알려진 입력 비교로 기록합니다.
3. 설치를 요청받은 경우에만 기존 설치 파일과 사용자 DB·ROI를 별도 백업합니다. 정상 종료 후 해시와 복구 경로를 확보하고 파일을 교체합니다.
4. 새 설치 파일 해시와 health, 운영 상태·설정·ROI 보존을 확인합니다. 새 게임 화면/F10 검증 여부는 별도로 기록합니다.

저장소 정리나 메인 병합만으로 실행 중 앱을 교체하거나 사용자 DB를 초기화하지 않습니다. `package_live_smoke.py`는 임시 데이터의 실제 패키지를 검사하는 수동 실행 도구이며 기본 테스트의 모의 성공과 구별합니다.
