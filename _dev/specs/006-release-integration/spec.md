# SPEC-006 — Integration / Browser Validation / Packaging

> 2026-09-26 개정: [SPEC-007](../007-feature-restoration/spec.md)이 회차 비영속, 스케줄 슬롯 제외, DB 3-table 결정을 대체한다. 현재 회차와 5개 슬롯을 SQLite에 보관하고 완료 시 재고와 회차를 함께 커밋한다. 타이머 복원 제외와 계산 알고리즘 보호는 유지한다. 아래 내용과 기존 검증 기록은 개정 전 범위를 설명한다.

## Purpose
기능 범위를 늘리지 않고 전체 앱을 실제 Windows localhost 프로그램으로 통합·검증·패키징한다.

## User Outcome
사용자가 실행 파일을 더블클릭해 서버·브라우저를 열고, 영구 데이터·스캔·입력·스케줄·완료를 사용한 뒤 재실행해도 영구 데이터가 유지된다.

## In Scope
- 전체 자동 회귀와 원본 비교.
- 실제 Chrome localhost 검증.
- 실제 scanner 업무 흐름.
- launcher, Waitress 시작, health check, 브라우저 자동 열기.
- 단일 instance, 고정 port, port conflict, 정상 종료.
- 영구 DB 유지·사용자 데이터 위치.
- Windows 폴더형 packaging 및 Python 미설치 환경 시험.
- 외부 인터넷 없이 실행.
- Tailwind CDN 제거와 로컬 CSS 사용.

## Out of Scope
- 새로운 앱 기능·저장 범위·API.
- Spec 순서 변경이나 병렬 미완성 단계 구현.
- OCR 연구 구현.
- 알고리즘·기대값 변경.
- Gemini 의존성.
- 네트워크 자동 업데이트.
- 백업·복원 API/UI, 자동 백업·보존 및 스키마 변경 전 복구 지점. 이는 별도 Spec 승인 전까지 후속 선택 기능이다.

## Functional Requirements
- 통합은 SPEC-000~005 승인 결과만 포함한다.
- 더블클릭하면 서버가 health check를 통과한 뒤 브라우저를 연다.
- 서버는 127.0.0.1:18765 후보 고정 포트와 단일 instance 원칙을 따른다.
- port conflict 때 기존 process를 종료하거나 조용히 다른 포트를 고르지 않고 사용자에게 알린다.
- 사용자가 실행창에서 화면 열기·종료를 할 수 있고 정상 종료는 진행 중 저장·스캔을 기다린다.
- folder-based Windows 패키지에 Python·NumPy·Pillow·reference·숫자 템플릿을 포함한다.
- Python 미설치 환경에서 실행 가능하고 인터넷 연결 없이 앱 기능이 동작한다.
- runtime Tailwind CDN 의존을 제거하고 로컬 CSS를 제공한다.
- 종료 후 재실행하면 모든 영구 상태가 유지되고 회차 상태는 복원되지 않는다.
- 기존 필수 regression과 브라우저 업무 흐름을 통과해야 한다.

## Data / State Rules
SQLite 영구 상태만 재실행 후 복원한다. 회차 목록·스케줄·완료·현재 교섭력과 UI 임시값을 저장·복원하지 않는다. 초기 릴리스에 백업·복원 동작은 포함하지 않는다.

## Interfaces
launcher → health 확인 → 같은 origin의 localhost UI. 앱 API는 SPEC-001~003 계약만 통합한다. 새 업무 endpoint를 추가하지 않는다.

## Safety / Invariants
- bind 주소·Host를 localhost에 제한한다.
- 데이터베이스를 실행 파일 임시 추출 경로에 두지 않는다.
- 단일 instance와 port conflict를 안전하게 처리한다.
- debug/reload 및 외부 network dependency 없이 실행한다.
- 기존 regression 기대값·알고리즘을 수정해 release를 통과시키지 않는다.
- 자동 PASS와 실제 Chrome 검증을 구분한다. 미실행은 BROWSER_NOT_RUN이다.

## Acceptance Criteria
더블클릭 → 서버 시작 → 브라우저 열기 → 영구 데이터 로드 → 창고 스캔·검토·적용 → JSON 목록 입력 → 스케줄 생성 → 완료 → 종료 → 재실행 뒤 영구 데이터 유지가 확인된다. Python 미설치 Windows 및 외부 인터넷 차단 상태에서 동작한다. 고정 port 충돌과 중복 실행이 안전하게 안내된다. 기존 필수 regression 및 동일 입력 비교가 PASS하고 실제 Chrome localhost 검증을 완료한다.

## Dependencies
SPEC-005까지 순차 완료. SPEC-000 baseline. Constitution 및 ARCHITECTURE.md 11~14절. 후속은 SPEC-100.
