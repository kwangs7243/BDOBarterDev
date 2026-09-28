# SPEC-005 Scheduler / Routing / Completion Validation

검증일: 2026-09-25  
판정: **PASS**

## 구현 범위

- 원본 `BDO_물교_v1.0.html`의 보호 상수와 계산/편집/완료 함수 42개의 선택된 정의를 `local_app/frontend/js/domain/`의 classic script로 옮겼다. 이동된 함수 본문은 정규화 SHA-256으로 대조했다.
- `index.html`에 원본 실행 순서에 맞춰 classic script를 배치하고 스케줄 생성·경로 편집·timer·waypoint를 연결했다. 신규 session/schedule 데이터는 브라우저 메모리에만 둔다.
- 완료 함수는 한 번 실행한 결과를 adapter에 넘긴다. 재고 변경만 `kind: completion` inventory PATCH에 보내며 PATCH 응답을 잃으면 같은 mutation ID와 body로 재시도한다. 409이면 최신 재고를 다시 읽고 차이를 재계산해 재적용한다.
- `local_app/pyproject.toml`의 Pillow/NumPy/Flask runtime dependency 선언은 이미 포함되어 있어 변경하지 않았다.
- SPEC-006은 시작하지 않았다.
- 작업 시작 전 이미 변경/추가 상태였던 `BDO_물교_v1.0.html`, 기존 테스트와 `test_results/`, 기존 SPEC-001~004 작업 파일은 보존했다. 아래 금지 파일은 이번 SPEC-005 작업에서 수정하지 않았다.

## 실행 환경

- Python: Codex bundle Python 3.12.14
- Pillow: 12.3.0; NumPy: 2.3.5
- Flask/Werkzeug: 3.1.3 / 3.1.7 (Python 3.14.2 site-packages 경로를 해당 테스트 프로세스에서만 추가)
- Node.js: 24.18.1
- 브라우저: Chrome headless
- 전체 unittest와 브라우저 서버는 테스트용 임시 SQLite DB를 사용했다. 사용자 DB, global Python 설치, PATH는 변경하지 않았다.

## 검증 결과

| 검증 | 결과 |
|---|---|
| `python -m compileall -q local_app` (Python 3.12.14) | PASS |
| `python -m unittest discover -s local_app/tests -v` | PASS, 20/20; 실제 Pillow·NumPy·`warehouse_patch.convert()` 포함 |
| Frontend JS 구문 검사 | PASS, `local_app/frontend`의 JS/MJS 전체 |
| SPEC-002 Chrome smoke | PASS |
| SPEC-003 scanner regression | PASS, 실제 Pillow·NumPy scanner 사용 |
| SPEC-003 Chrome warehouse scan | PASS |
| SPEC-004 trade import regression | PASS, fixture 3개 / 행 86개 |
| SPEC-004 Chrome trade session | PASS |
| SPEC-005 Chrome scheduler | PASS: 원본/신규 결과 정확 비교, inner·crow coin·tier 7 시나리오, timer, 수동 횟수 조정·경로 재정렬, 재료 waypoint 완료, 완료 후 trade/parley/재고, 중복 차단, 응답 유실 후 동일 요청 재시도, 새로고침 시 session 소실·영구 재고 유지 |
| `tests/regression_core.js` | PASS, 11/11 |
| `tests/followup_regression.js` | PASS, 4/4 |
| `tests/regression_modes.js` | PASS, 7/7 |
| `tests/inventory_completion_diagnostics.js` | PASS, 정상 종료 및 진단 산출 |
| `tests/tier7_completion_regression.js` | PASS, 10/10 |
| `tests/completion_no_hold_regression.js` | PASS, 6/6 |
| `tests/tier7_threshold_diagnostics.js` | PASS, 5개 진단 시나리오; reserve/target 변경에도 tier 6/7 스케줄 동등 |
| `tests/scenario_matrix.js` | PASS, 32 조합; `unexpectedReserveViolations = 0` |
| `tests/scheduler_preservation_regression.js` | PASS, 3/3 |

프로젝트 회귀 JSON 출력은 기존 변경 파일을 덮어쓰지 않도록 `%TEMP%`에 기록한 뒤 결과를 확인했다. 저장소의 기존 `test_results/` 파일은 그대로 두었다.

전체 unittest 중 corrupt upload 테스트가 비치명적 `ResourceWarning` 1건을 출력했지만 20개 테스트는 모두 통과했다.

## 동등성 및 보호 해시

- 원본 HTML SHA-256: `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76`
- 원본 대비 선택된 함수 본문 해시: 42/42 일치
- 보호 상수 선언: 6/6 일치
- 1초 timer tick 본문 및 SPEC-000 보호 구간: 일치
- 브라우저 동일 입력 산출물: inner 일반 교환, 까마귀 주화, 7단 연쇄에서 쾌속/균형 결과 객체를 정확 비교해 일치
- SPEC-000 보호 파일 및 fixture 해시: 15/15 일치
- `BDO_물교_v1.0.html`, `tools/warehouse_patch/warehouse_patch.py`, `reference/`, regression 기대값은 수정하지 않았다.

## 최종 판정

**SPEC-005: PASS**  
**SPEC-006: 미착수**
