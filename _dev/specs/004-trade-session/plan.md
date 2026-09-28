# Implementation Plan

## Existing Components Reused
processParsedTrades(), levenshtein(), getBestMatch(), getSafeUniqueItemMatch(), 현재 paste handler 계약, 기존 trade row editor와 render.

## Files to Add
local_app/frontend/js/trade-ui.js, domain/trade-import.js 및 회차 입력·동일성 테스트.

## Files to Modify
local_app/frontend/index.html, app.js, state.js와 trade UI wiring. 서버의 회차 CRUD는 추가하지 않는다. 기존 HTML·알고리즘·fixture는 수정하지 않는다.

## Implementation Sequence
1. 기존 JSON 배열 contract와 각 행의 보존 필드를 기준 manifest에 연결한다.
2. 기존 입력과 매칭 함수를 새 JS 파일로 이동한다.
3. 입력 parsing이 성공한 뒤 새 회차 또는 추가 동작을 적용한다.
4. 회차 생성·목록 수정 때 스케줄 무효화 경계를 연결한다.
5. 현재 교섭력을 durable default와 별도 session state로 둔다.
6. 이탈·재시작 시 회차 종료 안내를 연결한다.
7. 원본 HTML과 fixture 결과를 대조한다.

## Data Flow
JSON paste → parse/shape validation → 새 회차 또는 추가 선택 → processParsedTrades → session-only list → schedule invalidation.

## Test Strategy
기존 fixture를 사용해 정상·특수·중복·충돌·모호 후보·yield·land raw name 결과를 원본과 비교한다. parse 실패 후 기존 session 유지, 성공 후 새 회차 폐기, 목록 수정 후 schedule invalidation, 재실행 후 session 소실·영구값 보존을 확인한다.

## Rollback Boundary
Phase 4 신규 trade UI·session state 연결만 되돌린다. SPEC-001/002 영구 저장 계층과 원본 구현에는 영향이 없다.
