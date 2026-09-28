# SPEC-004 — Trade Session & JSON Import

> 2026-09-26 개정: [SPEC-007](../007-feature-restoration/spec.md)이 회차 비영속, 스케줄 슬롯 제외, DB 3-table 결정을 대체한다. 현재 회차와 5개 슬롯을 SQLite에 보관하고 완료 시 재고와 회차를 함께 커밋한다. 타이머 복원 제외와 계산 알고리즘 보호는 유지한다. 아래 내용과 기존 검증 기록은 개정 전 범위를 설명한다.

## Purpose
기존 JSON 계약으로 한 회차의 물교 목록을 입력하고 회차 상태를 관리한다.

## User Outcome
사용자가 기존 GPT 등에서 받은 물교 JSON을 붙여넣고, 새 회차를 시작하거나 현재 목록에 추가해 스케줄을 준비한다.

## In Scope
- 물교 JSON paste와 기존 JSON 입력 계약.
- processParsedTrades 및 기존 품목 matching.
- 행별 yield, count, disabled, deleted.
- 새 회차와 현재 목록 추가의 구분.
- 회차 중 현재 교섭력.
- 목록 변경 때 현재 스케줄 무효화.

## Out of Scope
- current-trades DB 저장.
- schedule DB 저장·복원.
- 과거 회차 history.
- 새로고침 후 session 복원.
- Gemini 및 물교리스트 scanner/OCR.
- scheduler 알고리즘 이관과 후속 Spec.

## Functional Requirements
- 기존 입력 JSON 배열을 받는 UI 계약을 유지한다.
- processParsedTrades와 기존 매칭·모호 후보 처리 의미를 보존한다.
- JSON 붙여넣기와 지원 형식 오류 안내를 제공한다.
- 새 회차 적용은 JSON 검증 성공 후 기존 회차를 폐기한다.
- 검증·parsing 실패는 기존 회차를 유지한다.
- 현재 목록에 추가는 기존 중복·충돌 처리를 따른다.
- 목록의 유효 변경은 현 스케줄을 무효화한다.
- 회차 중 남은 교섭력은 session memory에만 둔다.
- 현재 회차 상태를 재시작 뒤 복원하지 않는다.

## Data / State Rules
목록과 모든 행 필드, count 감소, deleted, 스케줄, 완료 상태, 현재 교섭력은 회차성 메모리다. 새 회차·새로고침·재실행 시 폐기한다. DB에는 저장하거나 history를 만들지 않는다. 저장 불가/새로고침 경고를 제공한다.

## Interfaces
Browser JSON paste → 기존 입력 contract → processParsedTrades → session state. 서버 current-trades API는 만들지 않는다. 회차 상태와 새 회차 규칙은 ARCHITECTURE.md 2.2절 및 9절을 따른다.

## Safety / Invariants
- yield와 품목 이름·프로그램명 의미를 바꾸지 않는다.
- 모호 후보를 강제로 자동 선택하지 않는다.
- 새 회차 입력 검증이 끝나기 전 기존 회차를 지우지 않는다.
- parsing 실패 때 기존 목록과 스케줄을 유지한다.
- 입력 목록·세션을 영구 DB나 history에 넣지 않는다.

## Acceptance Criteria
기존 fixture를 사용해 정상 행·중복·충돌·모호 후보·수율·특수품·원문 처리 결과가 원본과 동일하다. 새 회차 정상 적용은 이전 세션을 폐기한다. malformed 입력은 현재 세션을 유지한다. 현재 목록 추가는 기존 규칙을 따른다. session 상태는 재실행 후 복원되지 않고 영구 상태는 보존된다.

## Dependencies
SPEC-003 완료. SPEC-000 baseline. SPEC-001 API 및 SPEC-002 inventory UI. Constitution과 ARCHITECTURE.md 2.2절 및 9절. 다음은 SPEC-005.
