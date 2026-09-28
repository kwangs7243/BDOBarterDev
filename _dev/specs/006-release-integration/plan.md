# Implementation Plan

## Existing Components Reused
SPEC-000~005에서 검증된 local_app, Waitress·Flask server, SQLite 저장·API, scanner adapter, UI와 기존 필수 regression·fixture.

## Files to Add
local_app/launcher.py, packaging/bdo-barter.spec, browser tests, package validation instructions, release integration evidence.

## Files to Modify
local_app/pyproject.toml, frontend static asset references, app shutdown integration 및 패키지 설정만 수정한다. 루트 reference HTML·기존 regression expectations는 수정하지 않는다.

## Implementation Sequence
1. 전체 acceptance 흐름 및 필요한 배포 자원을 고정한다.
2. Tailwind CDN 대신 local CSS를 구성하고 동적 utility class를 보존한다.
3. launcher 단일 instance·고정 port·health readiness를 구현한다.
4. 기본 브라우저 열기, 실행창의 화면 열기·종료를 연결한다.
5. data directory를 패키지·임시 추출 위치 밖으로 유지한다.
6. folder-based package에 Python/runtime/reference/template을 포함한다.
7. Python 미설치·오프라인 환경에서 Windows smoke test를 수행한다.
8. 실제 Chrome에서 저장·스캔·목록·스케줄·완료·재실행 흐름을 검증한다.
9. 전체 기존 회귀와 결과 비교를 확인하고 BROWSER_NOT_RUN 여부를 기록한다.

## Data Flow
Double-click launcher → single-instance claim → DB/schema check → Waitress bind → /api/health → browser. 종료 요청 → 저장·스캔 대기 → server shutdown. 재실행은 durable DB만 로드한다.

## Test Strategy
기존 필수 regression, 원본 대조, localhost Chrome 사용자 흐름, 중복 instance·port conflict·종료·relaunch, Python 미설치·offline package 검사를 수행한다. 기능별 이전 Spec의 acceptance를 다시 확인하고 자동·브라우저 결과를 분리한다.

## Rollback Boundary
배포 package·launcher 변경만 비활성화한다. 검증 실패 시 정식 사용 전환을 중단하고 마지막 정상 앱 상태와 DB를 보존한다. 기존 HTML을 자동으로 교체하지 않는다.
