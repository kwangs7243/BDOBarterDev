# SPEC-001 — Local Runtime & Persistent Storage

> 2026-09-26 개정: [SPEC-007](../007-feature-restoration/spec.md)이 회차 비영속, 스케줄 슬롯 제외, DB 3-table 결정을 대체한다. 현재 회차와 5개 슬롯을 SQLite에 보관하고 완료 시 재고와 회차를 함께 커밋한다. 타이머 복원 제외와 계산 알고리즘 보호는 유지한다. 아래 내용과 기존 검증 기록은 개정 전 범위를 설명한다.

## Purpose
동일 origin localhost 실행 기반과 영구 저장 계층을 구축한다.

## User Outcome
사용자가 localhost에 접속해 영구 상태를 저장하고 서버 재시작 후 같은 값을 다시 불러올 수 있다.

## In Scope
- Python localhost server, Flask, Waitress.
- 동일 origin 정적 Frontend.
- SQLite 초기화 및 inventory, settings, app_meta.
- schema_version, revision, mutation ID 및 transaction.
- health, bootstrap, inventory, order, settings API.

## Out of Scope
- 마스터 창고 전체 UI 이관.
- warehouse scan.
- 물교 JSON·현재 회차 처리.
- scheduler, routing, completion.
- launcher packaging.
- schedule history.
- 백업·복원 API/UI, 자동 백업·보존 및 스키마 변경 전 복구 지점.
- 후속 Spec 구현.

## Functional Requirements
- 서버는 127.0.0.1의 고정 포트 18765 후보에 bind한다.
- Frontend와 API는 동일 origin으로 제공한다.
- Flask 앱을 Windows 지원 Waitress로 실행한다.
- SQLite 파일은 실행 패키지와 분리된 사용자 데이터 위치에 둔다.
- inventory는 program_name, nullable stock, target을 저장하고 허용 품목명을 검증한다.
- settings는 허용 section과 JSON payload를 저장한다.
- app_meta는 schema_version, revision, 마지막 mutation ID·hash를 저장한다.
- bootstrap은 영구 상태와 revision을 돌려준다.
- inventory/order/settings API는 각 데이터 경계를 지킨다.
- 재고 변경과 revision 증가는 하나의 transaction으로 처리한다.
- 오래된 revision을 거부한다.
- 동일 mutation ID·본문은 안전하게 재응답하고, 같은 ID의 다른 본문은 거부한다.
- 일부 PATCH만 반영되는 상황을 허용하지 않는다.

## Data / State Rules
SQLite에는 영구 상태만 둔다. 현재 목록·스케줄·완료·남은 교섭력·UI 상태·schedule history는 저장하지 않는다. stock NULL은 미입력, 0은 확인된 실제 수량이다. inventory 대상은 1~5단 70종이다.

## Interfaces
GET /api/health, GET /api/bootstrap, GET/PATCH /api/inventory, GET/PUT /api/inventory/order, GET/PATCH /api/settings. 모든 mutation은 revision과 mutation ID를 사용한다. 백업·복원 endpoint는 제공하지 않는다. 세부 구조는 docs/ARCHITECTURE.md 4~5절을 따른다.

## Safety / Invariants
- 127.0.0.1 이외로 bind하지 않는다.
- CORS를 열지 않고 허용 Host·Origin만 받는다.
- DB 오류 때 빈 DB로 바꾸거나 기존 데이터를 덮지 않는다.
- 잘못된 revision은 conflict로 처리한다.
- 게임 계산을 서버에 구현하지 않는다.
- schedule history 테이블을 만들지 않는다.

## Acceptance Criteria
- localhost 접속 가능.
- 영구 값을 저장하고 서버를 종료·재실행한 뒤 같은 값을 복원.
- 부분 PATCH 성공.
- transaction rollback.
- 잘못된 revision 거부.
- 중복 mutation 안전 처리.
- 잘못된 요청으로 데이터 일부가 변경되지 않음.
- 회차·schedule history 테이블이 없음.

## Dependencies
SPEC-000 baseline. .specify/memory/constitution.md. docs/ARCHITECTURE.md 4~6절. 다음은 SPEC-002.
