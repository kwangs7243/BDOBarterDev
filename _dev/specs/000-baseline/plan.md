# Implementation Plan

## Existing Components Reused
현재 BDO_물교_v1.0.html, tools/warehouse_patch/warehouse_patch.py, reference/barter_items.json 및 icons/, 기존 tests/와 fixtures/, 기존 회귀 결과·보호 해시 검사.

## Files to Add
Baseline manifest, 동일 입력 comparator 또는 실행 절차, 허용 변경·금지 변경 목록, 신규 앱 baseline 검증 산출물.

## Files to Modify
기준 HTML, scanner, reference, fixture와 기존 regression 구현·기대값은 수정하지 않는다. 다른 Spec 파일도 이 단계에서 추가하지 않는다.

## Implementation Sequence
1. 기준 경로·해시·날짜를 수집한다.
2. reference 품목 수·아이콘 수·아이콘 해시를 대조한다.
3. 보호 함수 경계와 알고리즘 목록을 기록한다.
4. 기존 regression fixture 및 결과의 식별 목록을 기록한다.
5. 허용 변경과 계산 변경 금지를 명시한다.
6. 같은 입력 비교와 비결정적 값 정규화 방법을 기록한다.
7. Manifest의 경로와 해시를 재확인한다.

## Data Flow
읽기 전용 기준 파일·fixture → baseline manifest 및 비교 절차. 사용자 운영 데이터는 포함하지 않는다.

## Test Strategy
Manifest 경로·해시, reference item 70종·icon 70개·아이콘 해시 일치, 보호 구간 및 fixture 경로를 기계적으로 확인한다. 허용 오차를 추가하지 않는다.

## Rollback Boundary
신규 manifest·비교 산출물만 되돌릴 수 있다. 기준 파일은 쓰기 대상이 아니다.
