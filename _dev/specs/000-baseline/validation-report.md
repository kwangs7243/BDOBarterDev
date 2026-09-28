# SPEC-000 기준선 검증 결과

- 확인일: 2026-09-25
- 필수 문서: `docs/ARCHITECTURE.md`, `.specify/memory/constitution.md`, `specs/000-baseline/spec.md`, `specs/000-baseline/plan.md`, `specs/000-baseline/tasks.md` 확인.
- 기준 파일: HTML, scanner, reference JSON, reference checksum 목록 해시가 `baseline-manifest.json`과 일치.
- Reference: 70종(단계별 14종), inventoryTarget 56종, 식별 전용 14종. 아이콘 70개 존재, 고유 SHA-256 70개, 선언 해시 불일치 0개.
- 보호 구간: `processParsedTrades` 및 scheduler/completion raw UTF-8 구간 해시가 manifest 값과 일치.
- Fixture: manifest에 기록한 12개 fixture/입력 해시가 모두 저장소 현행 파일과 일치. 개인 백업은 식별자와 해시만 기록하고 내용을 포함하지 않음.
- Known issue: `tests/warehouse_patch_regression.py`의 `EXPECTED_HTML_SHA256`은 현재 HTML과 다른 과거 해시다. 테스트는 HTML 해시 가드에서 선행 실패할 수 있다. SPEC-000에서는 코드·기대값을 수정하지 않았다.
- 자동 테스트: baseline 무결성 확인만 수행. 기존 동작 회귀 suite는 실행하지 않음(기준선 작업 범위와 기존 결과 파일 보호). 해당 stale-hash 테스트도 실행하지 않음.
- 브라우저: `BROWSER_NOT_RUN` (SPEC-000 기준선 산출 단계에서는 실행하지 않음).
- 변경 범위: SPEC-000 산출물 및 task 체크만 기록; 기준 HTML/scanner/reference/fixtures/기대값은 수정하지 않음.

## Acceptance Criteria

- 비교 기준 출처와 보호 대상이 명확함: PASS.
- 허용 변경과 계산 변경 금지가 분리됨: PASS.
- 동일 입력 비교 절차와 제한적 정규화가 재현 가능하게 명시됨: PASS.
- 기존 코드·데이터 미수정: PASS (해시·fixture 대조).
