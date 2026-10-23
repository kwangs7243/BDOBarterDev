# 구조와 데이터 흐름

## 실행과 화면

`python -m local_app.launcher` → Windows 단일 실행 검사 → Waitress/Flask 서버 → `/suite-health` 확인 → 브라우저와 관리 창 순서로 실행합니다. 고정 주소는 `http://localhost:18765`입니다. `/`에서 `/barter/`와 `/alchemy/`를 선택합니다. 공통 서버는 `local_app/backend/app.py`, 물교 저장은 `barter/backend/storage.py`, 연금 저장은 `alchemy/storage.py`입니다.

앱 간 이동은 독립 문서 전환입니다. 물교 Storage는 최초 물교 데이터 요청에서 초기화합니다. 연금 Storage는 레시피 전체를 인스턴스에 보관하지 않고 요청별로 읽으며, 클라이언트 상세 캐시는 최대 32개 품목입니다. 연금 기록은 페이지 단위로 조회합니다. 카탈로그 전체 편집·내보내기는 해당 기능을 요청할 때만 불러옵니다.

순수 `alchemy.engine.plan_goals`는 DAG 상위에서 하위로 필요량을 합산하고 우선순위별 실제 재고를 한 번만 할당합니다. 예상 산출은 실제 재고에 추가하지 않습니다. SQLite `BEGIN IMMEDIATE` 안에서 revision·영수증·재료 차감·작업·원장을 함께 저장합니다. 취소·부분 완료는 미수행 회차의 재료만 반환하고 완료는 실제 산출을 추가합니다. 상세 계약은 [연금 안내](ALCHEMY.md)에 있습니다.

화면은 `barter/frontend/`의 HTML/CSS/JavaScript로 구성합니다. 별도 frontend 빌드나 npm 런타임 패키지가 없습니다. `js/domain/`의 계산 모듈을 UI에서 사용하고 고정 입력 회귀로 결과를 비교합니다.

## 캡처와 인식

물교/창고 영역 설정 → Windows 창 선택과 수동 F10 → 원본 PNG·영역 메타데이터·capture ID → 인식 → 검수 → 사용자의 현재 회차/창고 적용 순서입니다. 성공한 인식은 대기열을 비우지만 검수에 필요한 출처는 유지합니다.

물교는 `TradeBatchRuntime`이 하나의 bounded subprocess worker를 실행합니다. worker는 행을 찾고 필드를 나눠 정답 특징 대조 후 미일치 필드를 CPU OCR로 읽습니다. 검수 여부는 필드별 원문·보정값·출처와 함께 반환합니다. 진행률 조회는 결과 처리와 독립적입니다.

창고는 `tools/warehouse_patch/warehouse_patch.py`가 격자·아이콘·숫자를 판독하고 `backend/services/warehouse_scan.py`가 API 결과와 검수 PATCH로 연결합니다. 원래 표본과 설치 앱에 적용한 보정 표본을 구별합니다.

## 저장과 계산

SQLite의 `inventory`, `settings`, `working_session`, `saved_schedule_slot`, `app_meta`, `mutation_receipt`는 운영 상태입니다. revision/CAS와 재시도 식별자로 중복 저장·차감을 방지합니다. 서버 저장이 성공한 뒤 UI 상태에 반영합니다.

`trade_correction`, `warehouse_scan`, `warehouse_feedback`는 개선 이력입니다. 사용 중 이력에 새 자료가 생겼다는 이유만으로 런타임 정답 사전을 자동 변경하지 않습니다. 정답 등록은 별도 대조·분할·회귀 후 명시적으로 배포합니다.

`frontend/js/domain/`의 importer·scheduler·tier7·completion·routing이 계산의 기준입니다. UI 정리나 인식 성능 개선을 이유로 교섭력·재고·우선순위 의미를 바꾸지 않습니다.

## 저장소와 실행 파일

소스의 `local_app/`, `barter/`, `alchemy/`, `reference/`, `tools/` 관계는 PyInstaller `_internal/` 안에서도 유지합니다. 모델과 보정 표본·frontend·연금 카탈로그는 빌드 입력입니다. `local_app/packaging/bdo-suite.spec`가 포함 목록을 정의합니다.

`local_app/tests/`는 제품 옆에 유지한 회귀·고정 입력입니다. `tools/experiments/`와 `docs/archive/`는 제품 실행 경로에서 분리합니다. 실행 파일·가상환경·개인 DB·전체 캡처·실험 출력은 Git 소스에 포함하지 않습니다.

공통 실행 책임은 `launcher.py`(단일 실행·준비 확인·서버/캡처 종료), `desktop.py`(네이티브 준비·상태 화면), `config.py`(제품 버전·loopback 설정)로 분리합니다. 실행 창은 서버 준비 확인 뒤 브라우저를 열며, 물교 전용 과거 실행 서버를 통합 서버로 오인하지 않도록 별도 suite health 신원을 확인합니다.
