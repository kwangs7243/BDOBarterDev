# Implementation Plan

## Existing Components Reused
SPEC-004가 이관한 processParsedTrades를 입력 계약 의존성으로 사용하며 다시 이동·재작성·수정하지 않는다. 원본 HTML의 scheduler·tier7·routing·schedule-edit·completion 함수, engine_harness.js, 기존 9개 필수 회귀와 추가 fixture를 재사용한다.

## Files to Add
local_app/frontend/js/domain/constants.js, scheduler.js, tier7.js, routing.js, schedule-edit.js, completion.js, schedule-ui.js, timer-ui.js, diagnostics-ui.js; 동일 입력 equivalence tests.

## Files to Modify
local_app/frontend/index.html과 app.js의 script 순서, api/persistence adapter 및 SPEC-004 session state 연결점만 변경한다. 기준 HTML과 기존 알고리즘·기대값은 수정하지 않는다.

## Implementation Sequence
1. 보호 함수 경계·기준 해시·동일 입력 fixture를 확인한다.
2. 도메인 파일을 만들고 계산 본문을 변경 없이 이동한다.
3. 이전과 같은 로딩 순서·DOM 의존을 연결한다.
4. 생성·수동 편집·재계산·렌더 호출을 연결한다.
5. 완료 함수 바깥에 재고 snapshot·mutation adapter를 연결한다.
6. 저장 pending·응답 유실에서 완료 계산을 재실행하지 않도록 연결한다.
7. 원본과 결과 구조를 비교한다.
8. 각 허용 변경을 목록에 남기고 계산 구간 차이를 조사한다.

## Data Flow
session trades + persistent inventory/settings → 기존 JS scheduler/routing → in-memory schedule. 완료 클릭 → 기존 completion 1회 → 계산된 최종 재고 patch → inventory API. 서버는 엔진 계산을 수행하지 않는다.

## Test Strategy
허용 행, 쾌속·균형, route, 7단, 까마귀주화, 적재·시간, completion, waypoint, 수동 편집을 동일 입력으로 대조한다. 보호 함수 해시·동일 결과 및 DB update 대상을 확인한다. tolerance를 쓰지 않고 기존 필수 회귀를 그대로 적용한다.

## Rollback Boundary
Phase 5 domain-file 이동과 저장 연결만 되돌린다. 결과 차이는 분리해 원인을 찾고 계산 의미 변경으로 맞추지 않는다. 원본 reference와 기존 fixture는 복구 대상으로 만들지 않는다.
