# SPEC-003 — Warehouse Scan & Patch Review

> 2026-09-26 개정: [SPEC-007](../007-feature-restoration/spec.md)이 회차 비영속, 스케줄 슬롯 제외, DB 3-table 결정을 대체한다. 현재 회차와 5개 슬롯을 SQLite에 보관하고 완료 시 재고와 회차를 함께 커밋한다. 타이머 복원 제외와 계산 알고리즘 보호는 유지한다. 아래 내용과 기존 검증 기록은 개정 전 범위를 설명한다.

## Purpose
현재 검증된 warehouse scanner를 사용자 업로드와 PATCH 검토 UX에 연결한다.

## User Outcome
사용자가 창고 화면 이미지를 선택해 판독 결과를 검토하고 명시적으로 적용한다. CLI나 JSON 파일을 다루지 않는다.

## In Scope
- [마스터 창고 스캔]의 큰 업로드 모달.
- PNG 파일 선택 또는 Drag & Drop.
- POST /api/warehouse-scan과 warehouse_patch.convert() adapter.
- master_inventory_patch version 1 반환.
- 대형 PATCH 검토 모달, 적용, 임시파일 정리.

## Out of Scope
- scanner 판독 알고리즘·임계값 변경.
- 미확정 품목 강제 보정·자동 합산.
- CLI, 파일 경로 입력, JSON 파일 생성·복사·붙여넣기.
- 물교 리스트 scan/OCR.
- 스케줄 자동 재계산 및 후속 Spec.

## Functional Requirements
- 흐름은 스캔 버튼 → PNG 선택/Drag & Drop → API 업로드 → 기존 convert() → patch 반환 → 검토 → 적용이다.
- 기존 convert()를 adapter에서 호출하고 임계값·분류를 변경하지 않는다.
- 초기 업로드는 PNG 한 장, 최대 20MiB·32메가픽셀이다.
- patch version 1, 정확한 programName, 1~4단, 0 이상의 정수 계약을 적용한다.
- 검토 모달은 기존보다 크게 한다.
- 4단→3단→2단→1단으로 보이며 단계 안에서는 inventoryOrder를 따른다.
- 각 행에 기존값→새값→차이를 표시한다.
- patch에 없는 품목은 표시·수정하지 않는다.
- UNKNOWN·duplicate·미확정·5단은 적용하지 않는다.
- 검토·취소 단계에서 영구 상태를 변경하지 않는다.
- 적용 시 patch 품목만 저장하고 저장 성공 후 UI를 갱신한다.
- scanner report의 로컬 임시 경로는 응답에 노출하지 않는다.

## Data / State Rules
업로드 파일·미리보기·검토안은 UI 임시 상태다. 적용된 inventory만 영구 상태다. scan report/history를 DB에 저장하지 않는다. scanner가 내보내지 않은 품목의 기존 재고는 유지한다.

## Interfaces
POST /api/warehouse-scan은 업로드 이미지에 대한 patch와 검토 근거를 돌려준다. 적용은 SPEC-001의 PATCH /api/inventory를 사용한다. 스캔 흐름은 ARCHITECTURE.md 10절, PATCH 계약은 5.2절, 검토창 정렬은 11절을 따른다.

## Safety / Invariants
- convert() 판정과 임계값을 바꾸지 않는다.
- 파일명을 경로로 사용하지 않고 업로드 크기·픽셀 수를 제한한다.
- 임시 파일은 성공·실패 모두 정리한다.
- UNKNOWN·duplicate·5단·미확정 항목을 추가하지 않는다.
- 적용 전 DB 변경은 0이며 부분 patch 밖 재고는 유지한다.
- 창고와 검토 모달이 같은 inventoryOrder를 쓴다.

## Acceptance Criteria
- 기존 직접 convert() 결과와 API patch items가 동일하다.
- 적용 전 DB 변경이 없다.
- 적용 후 patch에 있는 항목만 변경된다.
- 5단·UNKNOWN·duplicate·미확정 씨앗 항목은 제외되고 기존 재고가 유지된다.
- 단계 내 표시 순서가 창고 순서와 동일하다.
- 손상·과대 파일에서 DB와 reference가 바뀌지 않는다.
- 요청이 끝난 뒤 임시 업로드 파일이 남지 않는다.

## Dependencies
SPEC-002 완료. SPEC-001 inventory PATCH. SPEC-000 scanner/reference baseline. Constitution 및 ARCHITECTURE.md 5.2절, 10~11절. 다음은 SPEC-004.
