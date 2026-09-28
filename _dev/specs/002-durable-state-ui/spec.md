# SPEC-002 — Durable State & UI

> 2026-09-26 개정: [SPEC-007](../007-feature-restoration/spec.md)이 회차 비영속, 스케줄 슬롯 제외, DB 3-table 결정을 대체한다. 현재 회차와 5개 슬롯을 SQLite에 보관하고 완료 시 재고와 회차를 함께 커밋한다. 타이머 복원 제외와 계산 알고리즘 보호는 유지한다. 아래 내용과 기존 검증 기록은 개정 전 범위를 설명한다.

## Purpose
기존 영구 사용자 상태 UI와 저장 동작을 신규 저장 계층에 연결한다.

## User Outcome
창고와 지속 설정을 수정하면 저장되고 앱을 다시 열어도 같은 값이 복원된다.

## In Scope
- 마스터 창고 stock·target UI.
- 사용자 드래그 순서와 tierRules.
- ship settings·ship presets·기본 교섭력 설정.
- tuning·잉여 제외 설정.
- 사용자 좌표·route calibrations·route memos.
- map slots·map base.
- viewer panel 설정·UI zoom.
- 영구·회차·UI 임시 상태 구분과 UI 저장 표시.

## Out of Scope
- 현재 물교 목록·스케줄·완료 상태.
- 현재 회차의 남은 교섭력 저장.
- warehouse image scan.
- Gemini.
- scheduler·routing·completion 알고리즘 이관.
- session 복원 및 history.
- 후속 Spec 구현.

## Functional Requirements
- 1~5단 70종의 stock·target을 표시·편집한다.
- inventoryOrder의 기존 단계별 순서를 저장하고 사용한다.
- tierRules와 ship presets 기존 4슬롯을 유지한다.
- 적재량·속도·기본 모드·기본 교섭력 비용·모든 영구 tuning 설정을 저장한다.
- 사용자 좌표·항로 보정·메모·지도 슬롯·기본 지도·viewer 위치·zoom을 저장한다.
- bootstrap 값을 UI 초기화에 반영한다.
- map base는 시작 때 현재 좌표를 덮지 않으며 명시적인 불러오기에서 적용한다.
- 지도 snapshot 적용 시 관련 영구 상태를 저장한다.
- stock NULL 미입력과 0을 구분한다.

## Data / State Rules
영구·회차·UI 상태 분류는 ARCHITECTURE.md 2절을 그대로 따른다. 물교 목록·스케줄·완료·남은 교섭력·타이머는 회차 상태다. 모달·선택·drag·hover·입력 초안은 저장하지 않는다. map_measuredRoutes는 지도 slot/base 저장 때 해당 snapshot에 포함한다.

## Interfaces
SPEC-001의 bootstrap, inventory, inventory order, settings API만 사용한다. 신규 서버 API를 추가하지 않는다. 저장은 revision·mutation ID 계약을 따른다.

## Safety / Invariants
- 분류표를 임의로 축약하거나 회차 상태를 DB에 추가하지 않는다.
- 창고와 PATCH 검토가 같은 inventoryOrder를 사용한다.
- 미확정 재고를 0으로 바꾸지 않는다.
- 기존 기본값을 ARCHITECTURE.md의 계약대로 유지한다.
- 저장된 사용자 좌표가 앱 시작만으로 base에 덮이지 않는다.
- 계산 알고리즘을 변경하지 않는다.

## Acceptance Criteria
stock, target, 순서, tierRules, ship settings, presets, parley defaults, tuning, coordinates, route calibrations, memos, map slots/base, viewer panels, UI zoom 각각을 수정해 저장·종료·재실행 후 동일하게 복원한다. 회차·UI 임시 상태는 DB에 저장되지 않는다.

## Dependencies
SPEC-001 완료. SPEC-000 baseline. constitution.md와 ARCHITECTURE.md 2절 및 4~5절. 다음은 SPEC-003.
