# Implementation Plan

## Existing Components Reused
기존 창고 렌더링·drag 순서, tierRules, APP_CONFIG tuning, ship preset, 좌표·route calibration·memo·map slot/base·viewer panel 동작, SPEC-001 저장 API.

## Files to Add
local_app/frontend/js/inventory-ui.js, settings-ui.js, map-ui.js, persistence.js, css/app.css, 영구 상태 비교 테스트.

## Files to Modify
local_app/frontend/index.html, app.js, state.js의 연결부만 수정한다. 기존 루트 HTML·SPEC-001 API 계약·후속 Spec 파일은 이 단계에서 수정하지 않는다.

## Implementation Sequence
1. 기존 영구 localStorage 상태를 ARCHITECTURE settings section에 대응시킨다.
2. bootstrap 값을 창고·설정·지도 UI에 연결한다.
3. stock·target·tierRules·순서 변경을 API에 연결한다.
4. ship·parley·preset·tuning 설정을 저장에 연결한다.
5. 좌표·calibration·memo·map snapshot 저장/불러오기를 연결한다.
6. viewer panel과 zoom 저장을 연결한다.
7. 회차·임시 상태가 영구 저장 경로로 전달되지 않는지 확인한다.
8. 각 영구 상태군의 재실행 보존을 검증한다.

## Data Flow
UI 변경 → 저장 adapter → revision 기반 SPEC-001 API → SQLite. 시작은 SQLite bootstrap → UI 초기화. 지도 snapshot은 사용자가 불러오기 동작을 했을 때만 현재 navigation에 적용한다.

## Test Strategy
각 영구 상태군을 수정·저장·종료·재실행한 뒤 값을 비교한다. 창고 UI 표시 순서가 저장된 inventoryOrder와 일치하는지 확인한다. NULL/0 및 잘못된 section·품목을 검사하고 회차·임시 상태 비영속도 확인한다. PATCH 검토 모달 정렬 검증은 SPEC-003에서 수행한다.

## Rollback Boundary
Phase 2 신규 UI·저장 adapter만 되돌린다. SPEC-001 schema/API 및 기준 파일은 영향받지 않는다.
