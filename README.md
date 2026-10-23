# BDO Suite — 물교·연금 작업실

하나의 Windows 로컬 서버에서 물교와 연금을 선택합니다. `/`는 통합 메인, `/barter/`는 물교, `/alchemy/`는 연금입니다. 별도 프런트엔드 빌드나 외부 서비스 연결이 필요하지 않습니다.

연금은 공통 재고, 목표별 재료 예약, 하위 제작 트리, 제작 시작 시 재료 차감, 실제 산출량 추가, 부분 완료·취소·정정, 기록·백업을 제공합니다. 사용법과 출처·검증 범위는 [연금 안내](docs/ALCHEMY.md)에 있습니다.

검은사막 물물교환을 위한 **Windows 로컬 데스크톱 도우미**입니다. 현재 회차와 창고 재고를 관리하고, 교환 순서·적재·출항 브리핑과 지도 동선을 계산합니다. 서버는 PC의 `127.0.0.1:18765`에서 실행됩니다.

## 물교 기능

- 창을 선택하고 저장한 영역에서 수동 **F10 캡처**. 물교·창고 영역을 각각 보관하고 재시작 후 복원합니다.
- 물교 목록의 섬·품목·수량·횟수를 로컬에서 인식하고, 확인이 필요한 값은 원본 이미지와 함께 검수합니다.
- 검증된 정답 모양이 일치하면 OCR을 생략하고, 일치하지 않으면 기존 OCR로 처리합니다.
- 창고 재고·목표량·표시 순서, 현재 회차와 스케줄 슬롯을 저장합니다.
- 5단·7단·까마귀주화 모드, 교섭력·무게·재고를 반영한 스케줄, 경유지 자동완성, 출항 적재·결산을 제공합니다.

인식 결과는 사용자가 적용합니다. 게임 입력·자동 스크롤은 하지 않습니다. 외부 AI API나 GPU는 필요하지 않습니다.

## 소스에서 시작하기

Windows, Python **3.12 권장**(기본 앱은 3.11 이상), Node.js **22 이상**(JavaScript/브라우저 테스트용)이 필요합니다.

```powershell
py -3.12 -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[test]"
.venv/Scripts/python.exe -B -m local_app.launcher
```

물교 OCR은 추가 의존성과 검증된 ONNX 모델이 필요합니다. 준비 방법과 기존 설치 환경 재사용은 [개발 안내](docs/DEVELOPMENT.md), Windows 실행 파일 빌드는 [패키징 안내](docs/PACKAGING.md)를 참고하세요. 개발 실행도 기본적으로 실제 사용자 AppData를 사용하므로 자동 검증은 별도 임시 DB에서 수행합니다.

일반 실행은 루트의 `BDO 실행.lnk` 또는 `app/BDO 실행.exe`를 사용합니다. 준비 화면에서 로컬 서비스를 시작한 뒤 통합 메인이 자동으로 열립니다. 실행 창의 `통합 앱 열기`로 다시 열고 `서버 종료`로 저장·캡처를 마무리한 뒤 종료합니다. 브라우저만 닫으면 서버는 유지됩니다. 개발 환경·빌드 산출물과 운영 데이터는 Git 소스와 분리합니다.

## 프로젝트 구조

```text
local_app/                 공통 실행기·Flask 서버·native 캡처
  frontend/                통합 메인
  backend/app.py           공통 서버 조립, origin/종료 보호
  packaging/               PyInstaller 빌드
  tests/                   자동 회귀와 고정 입력, 별도 실사 도구
barter/                    물교 전용 API·화면·인식 서비스·보정 자료
alchemy/                   연금 앱
  data/catalog.json        버전·출처를 가진 품목·제작식
  engine.py                순수 DAG 계산과 목표별 예약
  storage.py               독립 SQLite·원장·제작 트랜잭션
  frontend/                연금 전용 화면
reference/                 창고 품목 70종과 아이콘
tools/                    창고 판독기와 개발 도구
  warehouse_patch/         창고 인식·원본 숫자 표본 생성
  experiments/             제품과 분리한 과거 인식 실험 코드
docs/                      현재 사용·개발·인식·검증 문서
  archive/                 과거 설계와 frozen baseline 계약
pyproject.toml             Python 의존성·실행 진입점·테스트 설정
package.json               Node 테스트 명령·Playwright 개발 의존성
```

`_dev/`는 과거 설치 앱과 개발 소스를 분리할 때 사용했던 폴더입니다. 현재 소스는 저장소 루트로 옮겼고, 설치 실행 파일·개인 DB·로컬 모델·실험 결과는 소스와 분리합니다.

## 문서와 검증

- [사용 안내](docs/USAGE.md): 캡처·검수·회차 적용·재고와 데이터 위치
- [연금 안내](docs/ALCHEMY.md): 제작·재고·복구·데이터 출처
- [BDO Suite 구현 지시서](docs/BDO-SUITE-SPEC.md): 사용자 제공 원문
- [개발 안내](docs/DEVELOPMENT.md): 환경 구성과 런타임 리소스
- [구조와 데이터 흐름](docs/ARCHITECTURE.md)
- [현재 제품 계약](docs/CURRENT-PRODUCT-CONTRACT.md)
- [인식 구조와 개선 방향](docs/RECOGNITION.md)
- [회귀·실사 검증](docs/TESTING.md)
- [패키징과 설치 파일 검증](docs/PACKAGING.md)
- [과거 실험 자료](docs/archive/README.md)

```powershell
$env:PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path
$env:PYTHONDONTWRITEBYTECODE='1'
& $env:PYTHON -B -m pytest
npm ci
npm run test:domain
npm run test:browser
```

검증 결과가 새 게임 화면의 인식 정확도까지 보장하는 것은 아닙니다. 검사 범위와 실제 실행 여부는 결과에 구분해 기록합니다.
