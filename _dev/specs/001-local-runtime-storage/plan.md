# Implementation Plan

## Existing Components Reused
기존 품목 정의·기본 설정의 출처, ARCHITECTURE.md의 SQLite 3-table 구조와 API 계약, SPEC-000 baseline.

## Files to Add
local_app/backend/app.py, storage.py, contracts.py, api/state.py; local_app/frontend/index.html 및 js/api.js, js/state.js; pyproject.toml; backend 저장 테스트.

## Files to Modify
기준 HTML, 기존 회귀·fixture, warehouse scanner, reference는 수정하지 않는다. Phase 1은 신규 skeleton과 저장 계층에 한정한다.

## Implementation Sequence
1. 사용자 데이터 위치와 schema version을 설정한다.
2. SQLite 초기화·inventory/settings/app_meta 저장을 구현한다.
3. transaction, revision, mutation ID 처리를 구현한다.
4. 허용 입력 계약을 검증한다.
5. Flask 정적 제공과 Waitress 시작을 구성한다.
6. health·bootstrap·inventory·order·settings API를 연결한다.
7. 저장·재기동 복원·rollback·충돌·중복 요청을 검증한다.

## Data Flow
Browser bootstrap → API → SQLite. Mutation → 입력 검증 → revision 확인 → 단일 transaction → commit → 새 revision 응답.

## Test Strategy
API 수준에서 저장·재시작 복원, 부분 PATCH, rollback, 오래된 revision, 동일 mutation 재전송 및 본문 불일치, 잘못된 값·품목명을 검사한다. Scheduler·scanner는 이 Spec에서 검사하지 않는다.

## Rollback Boundary
Phase 1 신규 서버·저장 파일과 신규 개발 DB만 경계다. 기존 HTML·사용자 데이터·기존 회귀 출력은 수정하거나 제거하지 않는다.
