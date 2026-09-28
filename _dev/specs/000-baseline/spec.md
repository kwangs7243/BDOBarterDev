# SPEC-000 — Baseline & Guardrails

## Purpose
신규 앱 구현 전에 현재 정상 동작의 비교 기준과 보호 경계를 고정한다.

## User Outcome
이후 구현 결과를 현재 BDO 물교 reference implementation 및 기존 검증 입력과 대조할 수 있다.

## In Scope
- 현재 HTML reference와 HTML·warehouse scanner SHA-256 확정.
- reference item/icon 기준 확정.
- 보호 함수·알고리즘과 기존 regression fixture 목록 작성.
- 허용 변경과 금지 변경 구분.
- 동일 입력 비교 체계 정의.

## Out of Scope
- 서버·Frontend·DB 구현.
- 기존 HTML·scanner·reference·fixture 수정.
- 알고리즘 변경 또는 기존 기대값 변경.
- 후속 Spec 구현.

## Functional Requirements
- 현재 BDO_물교_v1.0.html을 비교 기준으로 기록한다.
- 조사 시점 HTML 해시는 7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76, warehouse_patch.py 해시는 aa72ed5763c76a030ab4c8ffbc00fb23bf8ed4c391f9d1de8659395d76579fe8이다.
- reference/barter_items.json 해시는 e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c이며 item 70종, icon 70개를 기준으로 고정한다.
- 보호 함수와 기존 regression fixture를 식별한다.
- UI·storage adapter 변경과 계산 변경을 구분한다.
- 원본과 신규 앱에 같은 입력을 전달할 비교 방법을 둔다.

## Data / State Rules
Baseline manifest에는 참조 경로·해시·날짜·fixture 식별자만 둔다. 사용자 재고와 개인 백업은 복사하지 않는다.

## Interfaces
이후 SPEC-001~SPEC-006의 구현과 회귀에서 참조한다. Manifest 및 comparator 산출물은 구현 계획에 따른다.

## Safety / Invariants
- 기준 HTML·scanner·reference·fixture는 수정하지 않는다.
- 기대값을 변경해 신규 결과를 통과시키지 않는다.
- 알고리즘·상수·호출 순서를 보호한다.
- BROWSER_NOT_RUN을 자동 PASS로 취급하지 않는다.

## Acceptance Criteria
- 비교 기준의 출처와 보호 대상이 명확하다.
- 허용 변경이 계산 변경과 구분된다.
- 동일 입력으로 신규 앱 결과를 비교할 수 있다.
- 기존 코드·데이터는 수정되지 않는다.

## Dependencies
docs/ARCHITECTURE.md, .specify/memory/constitution.md. 다음 순서는 SPEC-001 → SPEC-002 → SPEC-003 → SPEC-004 → SPEC-005 → SPEC-006이다.
