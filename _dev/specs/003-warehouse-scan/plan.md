# Implementation Plan

## Existing Components Reused
tools/warehouse_patch/warehouse_patch.py의 convert(), reference/barter_items.json과 icons/, quantity_templates.npz, 기존 scanner 회귀·fixture, SPEC-001 inventory PATCH, SPEC-002 inventoryOrder.

## Files to Add
local_app/backend/api/scan.py, backend/services/warehouse_scan.py, frontend/js/warehouse-scan-ui.js, frontend/js/patch-review.js 및 scanner API·browser 테스트.

## Files to Modify
local_app/frontend/index.html, app.js, inventory-ui.js에서 UI 연결; backend/app.py에서 scan API 등록. 기존 scanner·reference·fixture·기준 HTML은 수정하지 않는다.

## Implementation Sequence
1. 업로드 byte·PNG 해독 형식·해상도 제한을 검사한다.
2. 서버 관리 임시 경로에 저장하고 사용자 파일명을 경로에서 분리한다.
3. adapter에서 기존 convert(image_path, reference_json, templates_path)를 호출한다.
4. patch와 검토 근거를 반환하고 서버 경로를 제거한다.
5. 모든 성공·오류 경로에서 임시파일을 정리한다.
6. 업로드·판독 UI를 연결한다.
7. patch를 inventoryOrder에 따라 4→1단으로 표시한다.
8. 취소·적용·저장 실패를 연결한다.
9. 직접 convert 결과와 API 반환을 대조한다.

## Data Flow
Browser File → multipart POST → 검증 → 임시파일 → convert() → 메모리 patch/report → review modal → PATCH /api/inventory → SQLite transaction → 응답 뒤 UI 갱신.

## Test Strategy
기존 scanner 회귀와 API PATCH 동일성, 파일 크기·해독 거부, 임시파일 정리를 검사한다. 적용 전 DB가 동일하고 적용 뒤 patch item만 달라야 한다. UNKNOWN·5단·duplicate·순서·취소·저장 실패를 확인한다. 새 threshold는 도입하지 않는다.

## Rollback Boundary
Phase 3의 scan API·adapter·UI만 되돌릴 수 있게 둔다. 독립 scanner와 기준 자료는 변경하지 않는다.
