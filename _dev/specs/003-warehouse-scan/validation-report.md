# SPEC-003 Warehouse Scan & Patch Review — 검증 보고서

검증일: 2026-09-25  
판정: **PASS**  
범위: `POST /api/warehouse-scan`, scanner adapter, PNG 업로드/검토/적용 UI만.

## 구현 결과

- `/api/warehouse-scan`은 multipart PNG 한 장만 받고, 업로드 파일 20 MiB·해독 이미지 32메가픽셀 제한을 검사한다. 잘못된 PNG, 비지원 형식, 픽셀 초과, 파일 크기 초과, grid 실패, scanner 예외, 동시 scan을 서로 다른 오류로 응답한다.
- [warehouse_scan.py](../../local_app/backend/services/warehouse_scan.py)는 기존 `tools/warehouse_patch/warehouse_patch.py`의 `convert()`를 직접 호출한다. scanner 판정과 PATCH/report의 MATCH 항목이 정확히 일치하는지만 확인하며 결과를 보정하지 않는다. report의 임시 경로를 응답에서 제거한다.
- 임시 PNG와 multipart 업로드 stream은 성공·오류 경로에서 닫거나 삭제한다. scanner report/PATCH 파일은 생성하지 않는다.
- 화면에서 원본 PNG 파일 선택 또는 drop 후 판독하고, PATCH는 즉시 적용하지 않고 큰 검토창에 표시한다. 검토창은 기존 창고 UI와 같은 `inventoryDisplayOrder()`를 사용해 4→3→2→1단, 단계 내부 순서대로 PATCH 항목만 보인다.
- 적용 시 최신 bootstrap revision을 다시 확인한다. revision이 바뀌면 최신 재고로 검토를 갱신하고 사용자의 재확인을 기다린다. 저장은 기존 `/api/inventory`의 `kind: warehouse` 계약과 mutation/revision 처리를 이용한다.

## 자동 검증

실행 환경은 Codex 번들 Python 3.12(NumPy/Pillow)와 PC에 이미 설치된 Python 3.14 site-packages(Flask/Werkzeug)를 오프라인으로 함께 사용했다. 단순 시스템 `python`에는 Pillow가 없었고 번들 Python에는 Flask가 없어, import 경로 순서를 명시한 테스트 실행기를 사용했다. 사용자 DB는 사용하지 않았다.

| 검증 | 결과 |
|---|---|
| `python -m compileall -q local_app`에 해당하는 전체 앱 컴파일 | PASS |
| `python -m unittest discover -s local_app/tests -v`에 해당하는 전체 테스트 | PASS, 20/20 |
| Frontend 및 browser-test JavaScript syntax | PASS |
| `barter_only.png` 직접 `convert()` vs API | PATCH 완전 동일, 50 MATCH·5 TIER5_IGNORE·5 EMPTY·3 ICON_MATCH_UNKNOWN |
| `mixed.png` 직접 `convert()` vs API | PATCH 완전 동일, 49 MATCH·5 TIER5_IGNORE·1 EMPTY·8 ICON_MATCH_UNKNOWN |
| 비확정/비대상 상태 안전성 | MATCH 외 TIER5_IGNORE·ICON_MATCH_UNKNOWN·QUANTITY_UNKNOWN·DUPLICATE_ITEM_DETECTED 제외 확인. MATCH report와 PATCH가 다르면 API 실패 처리 |
| 업로드 오류 | 파일 누락·2장 업로드·비지원 형식·손상 이미지·20 MiB 초과·32MP 초과·Pillow decompression-bomb 헤더·grid 실패 확인 |
| scanner 예외·동시 scan | 각각 오류 응답, 두 경우 모두 임시 파일 잔류 없음 |
| 임시파일·내부 경로 | 성공·실패 테스트 디렉터리 비어 있음, report 응답에 임시 경로 없음 |

## Chrome headless 검증

[browser_warehouse_scan.mjs](../../local_app/tests/browser_warehouse_scan.mjs)를 실행했다. 격리된 임시 SQLite DB를 사용했다.

- 파일 선택과 drop 이벤트를 통해 원본 PNG 업로드 및 검토창 열기 확인.
- 기본 inventoryOrder와 사용자 드래그 변경 후의 단계별 순서 확인. 부분 PATCH에서도 창고 순서의 부분수열과 일치.
- 검토 후 취소하면 재고와 revision 변경 없음.
- 외부 영구 변경으로 revision을 올린 뒤 첫 적용 시 PATCH 미적용, 최신값 표시 및 재확인 요구.
- 저장 실패를 브라우저에서 주입했을 때 검토창을 유지하고 DB/revision 변경 없음.
- 서버 저장은 커밋됐지만 직후 bootstrap 재조회가 한 번 실패하는 경우, 재조회 복구 후 화면을 닫고 PATCH를 중복 전송하지 않음.
- 재확인 후 적용하면 PATCH 대상 stock만 변경, target·inventoryOrder·settings 보존.

기존 [browser_smoke.mjs](../../local_app/tests/browser_smoke.mjs)도 다시 실행해 SPEC-002 창고·순서·설정·지도·viewer 저장 및 서버 재시작 복원을 PASS했다.

## SPEC-000 보호 기준

작업 후 직접 확인한 SHA-256은 baseline manifest와 모두 일치한다.

| 보호 대상 | 현재 SHA-256 | 결과 |
|---|---|---|
| `BDO_물교_v1.0.html` | `7133AE0140D84DC284A53B7CAEEDAF5479270161038CA36DF4E094983AAF7B76` | 동일 |
| `tools/warehouse_patch/warehouse_patch.py` | `AA72ED5763C76A030AB4C8FFBC00FB23BF8ED4C391F9D1DE8659395D76579FE8` | 동일 |
| `reference/barter_items.json` | `e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c` | 동일 |
| `reference/SHA256SUMS.txt` | `4131f16abdff13889e98702e7a9c00325671349fddaf7ac282e70b7e88aa2ae4` | 동일 |
| `processParsedTrades` 보호 구간(원본 CRLF bytes) | `683f5b883645208b16712c4f463800ea98367f2e4317f24bad86f1d18e6d8273` | 동일 |
| scheduler/completion 보호 구간(원본 CRLF bytes) | `0c64f7a542a028045a91b4b67b6721103ccfd76a646d74af0a894a9ee4f7be31` | 동일 |

## 미검증 및 남은 위험

- Chrome은 headless 자동화로 검증했다. 사용자의 대화형 데스크톱 세션에서 직접 끌어 놓는 물리 입력은 별도 실사하지 않았다. drop 이벤트는 Chrome `DataTransfer`로 재현했다.
- Chrome 테스트 서버는 Flask 테스트용 WSGI 서버로 실행했다. Waitress는 기존 SPEC-001 테스트처럼 고정 loopback/port 위임을 확인했으나 실제 Waitress 프로세스로 스캔 UI를 반복 시험하지 않았다.
- 테스트 런타임은 오프라인 PC 패키지를 조합해 사용했다. 새 PC에서 `local_app/pyproject.toml`만으로 의존성 설치·패키징되는 과정은 SPEC-003 범위 밖이며 별도 배포 단계에서 검증해야 한다.
- 전체 테스트 종료 시 Werkzeug test client가 만든 대용량 multipart 요청 본문 임시 stream에 비치명적 `ResourceWarning` 1건이 남을 수 있다. scanner가 지정 임시 디렉터리에 생성한 업로드 PNG는 테스트마다 비어 있음을 확인했고, DB 상태도 변하지 않는다.
- scanner 인식 임계값·알고리즘, 지원 배율, fixture 밖 화면 인식은 변경하거나 확장 검증하지 않았다.

## Acceptance Criteria

| 기준 | 판정 |
|---|---|
| 직접 convert와 API patch.items 동일 | PASS |
| 적용 전 DB 변경 0 | PASS |
| 적용 뒤 PATCH 품목만 변경 | PASS |
| 5단·UNKNOWN·duplicate·미확정 항목 자동 제외 | PASS |
| inventoryOrder 기준 단계별 표시 | PASS |
| 손상·과대 파일 거부 및 DB/reference 무변경 | PASS |
| 요청 종료 후 임시 업로드 파일 미잔류 | PASS |

**SPEC-003: PASS. SPEC-004 진행 가능.**
