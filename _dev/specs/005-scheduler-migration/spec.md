# SPEC-005 — Scheduler / Routing / Completion Migration

> 2026-09-26 개정: [SPEC-007](../007-feature-restoration/spec.md)이 회차 비영속, 스케줄 슬롯 제외, DB 3-table 결정을 대체한다. 현재 회차와 5개 슬롯을 SQLite에 보관하고 완료 시 재고와 회차를 함께 커밋한다. 타이머 복원 제외와 계산 알고리즘 보호는 유지한다. 아래 내용과 기존 검증 기록은 개정 전 범위를 설명한다.

## Purpose
최고 위험도 Spec. 신규 알고리즘을 만드는 것이 아니라 검증된 JavaScript 계산 로직을 신규 파일 구조로 이동한다.

## User Outcome
새 앱에서도 현재 정상 실행본과 같은 목록 판단·쾌속/균형 스케줄·7단·경로·완료 결과를 얻는다.

## In Scope
- scheduler와 tier7 생성 로직.
- 까마귀주화 관련 생성 로직.
- routing·region·distance/time·weight simulation.
- schedule editing·recompute·duplicate merge.
- 일반 completion·waypoint completion·timer 연동.
- 저장 adapter를 계산 바깥에서 연결.
- 동일 입력 원본 비교 및 보호 해시 확인.

## Out of Scope
- 알고리즘 개선·정리 목적의 내부 재작성.
- Python으로 계산 로직 이전.
- 점수·threshold·조건·정렬·지역·우선순위 변경.
- 최소보존 조건 재도입 또는 완료 조건 변경.
- 새로운 서버 schedule API·history·회차 복원.
- 후속 Spec 기능.

## Functional Requirements
- 기존 함수의 본문·계산 의미를 별도 JS 파일로 이동한다.
- 권장 경로는 frontend/js/domain/constants.js, scheduler.js, tier7.js, routing.js, schedule-edit.js, completion.js다.
- runAlgorithmAllModes, buildSorties, buildTier7Sorties, 까마귀주화, 고정경로, 지역조건, 적재 계산, 편집·완료·경유지 완료를 보존한다.
- processParsedTrades는 SPEC-004에서 이관된 구현을 입력 의존성으로 사용한다. SPEC-005에서 다시 이동·재작성·수정하지 않는다.
- 파일 로딩 순서·DOM·저장 adapter는 계산 바깥에서 연결한다.
- 보호 함수별 원문 해시 및 동일 입력 결과를 기록한다.
- 날짜·random ID 등 본질적으로 비결정적인 값만 비교에서 정규화한다.

## Data / State Rules
스케줄·완료·현재 교섭력은 SPEC-004의 회차 메모리에 둔다. 완료가 바꾼 영구 stock 최종값만 inventory API에 저장한다. 스케줄·완료 이력은 DB에 누적하지 않는다.

## Interfaces
계산은 브라우저에서 수행한다. 서버는 계산 endpoint를 제공하지 않는다. 영구 재고 PATCH는 기존 JS 완료 함수 계산 바깥의 adapter가 저장한다. 회차 상태는 ARCHITECTURE.md 9절, 알고리즘 보호 기준은 8절을 따른다.

## Safety / Invariants
- 점수·임계값·조건문·정렬·호출 순서 변경 금지.
- 까마귀주화 우선순위·7단 연결·지역 제한 변경 금지.
- 완료 보류·최소보존 재검사를 재도입하지 않는다.
- 원본 대비 계산 차이를 tolerance로 숨기지 않는다.
- 보호 구간 해시가 달라지면 허용 UI/storage 예외만 별도 입증하고 계산 변경은 실패로 처리한다.

## Acceptance Criteria
원본과 신규 앱에 동일 입력을 주어 허용 물교 행, 쾌속/균형 출항 수, 방문 순서, 품목, 요구량, 실행횟수, yield/mult, 적재, 교섭력, 시간, 7단, 까마귀주화, 완료 후 재고·물교 횟수·deleted, 중복 완료, waypoint, 수동 순서 조정이 일치한다. 저장 응답 유실에도 완료 계산을 재실행하지 않는다.

## Dependencies
SPEC-004 완료. SPEC-000 baseline과 SPEC-001 저장 adapter. Constitution 및 ARCHITECTURE.md 8~9절. 다음은 SPEC-006.
