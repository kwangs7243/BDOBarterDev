# 회귀와 실사 검증

모든 자동 검사는 임시 DB·별도 Chrome 프로필을 사용합니다. 결과는 OS 임시 폴더 또는 저장소 밖으로 출력합니다. 인식 모델·정답·fixture 기대값을 현재 출력으로 덮어쓰지 않습니다. 명령은 저장소 루트 기준입니다.

## Python과 JavaScript

```powershell
$env:PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path
$env:PYTHONDONTWRITEBYTECODE='1'
& $env:PYTHON -B -m pytest
npm ci
npm run test:domain
npm run test:browser
```

기존 검증 환경은 [개발 안내](DEVELOPMENT.md)의 `PYTHON`, `BDO_TRADE_OCR_PYTHON`, `BDO_TRADE_OCR_MODEL_DIR` 변수를 지정해 재사용합니다. OCR과 package 작업은 ONNX/OpenCV가 설치된 별도 Python을 쓸 수 있습니다.

- Python: `local_app/tests/`의 저장·API·인식 계약·native·실험 도구 회귀.
- Domain: `local_app/tests/*.mjs`의 순수 계산·입력·타이머·클라이언트 계약.
- Browser: `browser_*.mjs`가 임시 서버와 headless Chrome을 시작해 화면과 저장 흐름을 검사.
- 일반 전체 Node 실행: `npm test`. Domain과 브라우저를 순차 실행합니다.

브라우저 검사는 `npm ci`로 Playwright 개발 의존성을 설치합니다. 기존 도구 환경을 사용하는 경우에만 `BDO_NODE_MODULES`로 해당 node_modules 경로를 지정할 수 있습니다. 개인 PC의 Codex 캐시 경로를 코드 기본값으로 사용하지 않습니다.

Chrome 기본 위치는 `C:/Program Files/Google/Chrome/Application/chrome.exe`이고 다른 경로는 `BDO_CHROME`으로 지정합니다. UI 기본 검사는 100% 배율의 1920×1080, 1440×900, 2560×1440을 사용합니다. 기존 130% 사례는 호환 검사이며 디자인 목표가 아닙니다.

특정 검사와 출력 위치를 지정할 수 있습니다.

```powershell
& $env:PYTHON -B -m pytest local_app/tests/backend/test_trade_template_reader.py -q
node local_app/tests/trade_unused_policy.mjs
node local_app/tests/run_current.mjs --domain --out "$env:TEMP/bdo-domain-results"
node local_app/tests/run_current.mjs --browser --out "$env:TEMP/bdo-browser-results"
git diff --check
```

무거운 OCR·브라우저 검사는 동시에 돌리지 않습니다. Windows GDI/실제 입력 검사는 desktop 접근이 필요합니다. 환경 접근 실패와 제품 실패를 구분하고, 실패를 건너뛰거나 기대값을 바꿔 PASS로 만들지 않습니다.

## 고정 입력과 실사

`local_app/tests/fixtures/`의 importer·scheduler·UI·warehouse oracle과 캡처는 고정된 회귀 입력입니다. `tools/warehouse_patch/quantity_templates.npz`는 원본 숫자 표본, 제품의 `recognition_data/warehouse-templates.npz`는 현재 보정 표본입니다.

`local_app/tests/live/`는 별도 게임/실사 검증 도구입니다. 일반 Node 실행에서 분리합니다. 저장된 16장·80행 판독 결과는 기존 입력 재생이며 새 게임 화면 정확도로 표현하지 않습니다. 실게임 foreground/F10·새 픽셀·사용자 실제 적용은 별도 실행했을 때만 완료로 기록합니다.

과거 도구의 frozen baseline은 `docs/archive/specs/trade-template-v1/BASELINE-MANIFEST.json`과 원래 외부 사본의 계약을 사용합니다. 현재 파일 위치가 바뀌었다고 이전 snapshot hash를 바꾸지 않습니다.

## 패키지

입력 리소스·무결성 및 실제 패키지 검사 방법은 [패키징 안내](PACKAGING.md)에 있습니다. 임시 AppData에서 실행한 모의/패키지 검사를 실제 사용자 앱 설치·실게임 성공과 구별합니다.
