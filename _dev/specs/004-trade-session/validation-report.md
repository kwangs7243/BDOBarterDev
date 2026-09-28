# SPEC-004 최종 회귀 검증 보고서

검증일: 2026-09-25  
판정: **PASS**

## Python 환경

- 실행 Python: Codex 번들 Python 3.12.14
- 발견 실행기: `python`은 PC Python 3.14.2, `py -0p`에는 설치 등록 Python 없음, 번들 `python.exe`는 3.12.14. WindowsApps `python3.exe` 별칭은 시작이 거부되어 사용할 수 없었다. `uv`는 설치되어 있으나 기존 uv cache 접근 거부 때문에 Python 실행기로 사용할 수 없었다.
- Pillow: 12.3.0 (번들 Python 3.12에서 `PIL.Image` 실제 import 확인)
- NumPy: 2.3.5 (번들 Python 3.12에서 실제 import 확인)
- Flask/Werkzeug: 3.1.3 / 3.1.7 (PC Python 3.14.2의 기존 site-packages를 임시 import 경로로 사용)
- 두 Python 패키지 경로는 해당 테스트 프로세스에만 적용했다. 번들 Python 경로를 우선해 Pillow와 NumPy가 호환되는 Python 3.12 바이너리로 로드되도록 했다.
- Python 3.14의 Pillow 부재와 번들 Python의 Flask 부재를 확인했다. 호환되지 않는 바이너리 강제 로드, shim 기반 scanner 검증, 사용자 DB 사용, 전역 설치 변경, PATH 변경은 하지 않았다.
- `local_app/pyproject.toml`에 `Flask`, `waitress`, `numpy`, `Pillow` runtime dependency가 이미 선언되어 있어 dependency 선언은 수정하지 않았다.
- 전체 unittest는 `python -m unittest discover -s local_app/tests -v`와 같은 discovery를 수행하되, 시작 직후 Python 3.14 site-packages를 경로 끝으로 옮기는 짧은 `runpy` 실행기를 사용했다. 이로써 Python 3.12용 NumPy/Pillow가 우선 로드됐다.

## 실행 결과

| 검증 | 결과 |
|---|---|
| `python -m compileall -q local_app` (Python 3.12.14) | PASS |
| `python -m unittest discover -s local_app/tests -v` (실제 Pillow/NumPy/`warehouse_patch.convert()`) | PASS, 20/20 |
| Frontend JavaScript 및 브라우저 테스트 구문 (`node --check`) | PASS, frontend 12개 + 테스트 스크립트 4개 |
| SPEC-002 Chrome headless smoke | PASS; 렌더링, inventoryOrder, 저장·복원, revision/저장 오류 처리 확인 |
| SPEC-003 scanner regression | PASS; `barter_only.png`·`mixed.png`의 실제 직접 `convert()`와 API 결과 일치, 업로드 오류·scanner 오류·동시 요청·임시 파일 정리 확인 |
| SPEC-003 Chrome headless | PASS; PNG 선택/drop, inventoryOrder 검토 순서, 취소 시 무변경, revision 충돌 후 재확인, 저장 실패/복구, PATCH 대상 재고만 변경 확인 |
| SPEC-004 trade import regression | PASS; 3 fixtures / 86행, 원본 대비 accepted rows 및 held counts 일치, parse 오류·모호 후보·특수/land 원문·수율·중복/충돌 확인 |
| SPEC-004 Chrome headless trade-session | PASS; 새 회차, malformed JSON 세션 보존, 추가 중복/충돌 처리, 편집 후 schedule 무효화, session-only parley, 새로고침 시 회차 폐기 확인 |

Chrome 검증은 테스트용 임시 SQLite DB를 사용했다. SPEC-004 browser 테스트 코드에 있는 이미지 import stub은 해당 trade-session 서버 초기화용이며 scanner 경로를 호출하지 않았다. SPEC-003 단위 및 Chrome 검증은 실제 Pillow, NumPy, `warehouse_patch.convert()`를 사용했다.

전체 unittest에는 Werkzeug 테스트 클라이언트의 multipart stream 관련 비치명적 `ResourceWarning` 1건이 출력됐으나 테스트 20개는 모두 통과했다. scanner 지정 임시 디렉터리는 테스트 후 비어 있음을 확인했다.

## SPEC-000 보호 해시

| 보호 대상 | SHA-256 | 결과 |
|---|---|---|
| `BDO_물교_v1.0.html` | `7133AE0140D84DC284A53B7CAEEDAF5479270161038CA36DF4E094983AAF7B76` | 일치 |
| `tools/warehouse_patch/warehouse_patch.py` | `AA72ED5763C76A030AB4C8FFBC00FB23BF8ED4C391F9D1DE8659395D76579FE8` | 일치 |
| `reference/barter_items.json` | `e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c` | 일치 |
| `reference/SHA256SUMS.txt` | `4131f16abdff13889e98702e7a9c00325671349fddaf7ac282e70b7e88aa2ae4` | 일치 |
| `processParsedTrades` 보호 구간 | `683f5b883645208b16712c4f463800ea98367f2e4317f24bad86f1d18e6d8273` | 일치 |
| scheduler/completion 보호 구간 | `0c64f7a542a028045a91b4b67b6721103ccfd76a646d74af0a894a9ee4f7be31` | 일치 |

**SPEC-004 최종 판정: PASS. SPEC-005는 시작하지 않았다.**
