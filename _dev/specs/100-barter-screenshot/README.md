# SPEC-100 — Barter Screenshot Recognition (후속)

이 문서는 구현 Spec이 아니다. SPEC-000부터 SPEC-006까지 완료한 뒤 착수한다.

후속 연구의 목적은 물교 리스트 스크린샷 여러 장을 로컬에서 판독해 trade session으로 전달할 수 있는지 검토하는 것이다.

향후 검토 항목:

- 여러 스크린샷 입력.
- 겹치는 화면에서 중복 교환 제거.
- 기존 JSON 입력 계약과 같은 trade session 생성.
- 로컬 판독 접근과 Gemini 대체 가능성 검증.
- 판독 불확실성 및 사용자 검토 흐름.

이번 문서는 README만 제공한다. spec.md, plan.md, tasks.md를 만들지 않는다. OCR 알고리즘을 설계하거나 구현하지 않는다.

선행 조건: SPEC-000 → SPEC-001 → SPEC-002 → SPEC-003 → SPEC-004 → SPEC-005 → SPEC-006 완료.
