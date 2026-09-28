# SPEC-006 Validation Report

검증일: 2026-09-25

## 결과 요약

SPEC-006 통합 검증은 PASS다. 변경은 launcher와 shutdown 연결, package 설정, 해당 동작·계측을 확인하는 테스트 및 SPEC-006 문서에 한정했다. 루트 원본 HTML, warehouse scanner 구현, reference 데이터와 보호 알고리즘은 수정하지 않았다.

## Runtime 및 package

- 빌드 환경: 격리 venv, Python 3.12.14, PyInstaller 6.22.3.
- bundled runtime: PyInstaller onedir 패키지의 Python 3.12 runtime (`python312.dll`). 최종 실행에 Python·Node.js·CLI 설치나 개발 Python 경로가 필요하지 않았다.
- 동일 빌드 환경 dependency: Flask 3.1.3, Werkzeug 3.1.8, Waitress 3.0.2, Pillow 12.3.0, NumPy 2.5.3.
- 산출물: `local_app/packaging/dist/BDO 물교 실행/BDO 물교 실행.exe`와 `_internal/` 폴더. frontend, `reference/barter_items.json`, scanner 코드와 `quantity_templates.npz`가 포함됐다. 2026-09-25 release-audit 후속 재빌드 결과는 254개 파일, 72,069,449 bytes이며 reference 데이터는 JSON과 아이콘 70개만 포함한다.
- package를 공백이 포함된 source-tree 외부 경로에서 실행했다. 실행 cwd가 package 경로나 저장소 경로가 아닌 경우도 health와 frontend가 정상 응답했다.
- `PATH`를 Windows `System32`만 남기고 `PYTHONHOME`/`PYTHONPATH`를 제거한 상태에서 package를 두 번 실행했다. Waitress health와 inventory/settings API가 동작하고 두 프로세스 모두 정상 종료했다.
- 첫 실행에서 변경한 재고 `43`과 `settings.ship.speed=181`은 종료 후 재실행에서 그대로 복원됐다. SQLite 파일은 임시 `LOCALAPPDATA/BDOBarter/data/bdo.sqlite3`에 생성됐고 package 내부 SQLite 파일은 0개였다. 실사용 DB는 사용하지 않았다.
- schema 회귀에서 사용자 테이블이 `inventory`, `settings`, `app_meta` 세 개로 유지됨을 확인했다. session 상태는 Chrome trade-session 및 scheduler reload 검증에서 복원되지 않았다.

## Launcher / Waitress

- packaged launcher가 Waitress를 `127.0.0.1:18765`에 시작했고 `/api/health`, `/api/bootstrap`, frontend, inventory/settings 및 warehouse scan 경로가 정상 동작했다.
- browser-open controller 기록에서 URL은 `http://127.0.0.1:18765/`, 호출 시점 health는 `true`였다. launcher 코드도 health polling 성공 다음에 브라우저를 호출한다.
- Windows native manager 창과 `화면 열기`/`종료` 버튼을 확인했다. 실제 종료 버튼을 눌러 pending-write drain이 끝난 뒤 launcher가 exit code 0으로 종료했다. drain 중 신규 write 거부 및 활성 write 대기는 unittest에서 확인했다.
- 같은 package를 두 번 실행했을 때 두 번째 launcher는 exit code 0으로 종료했고, 첫 Waitress instance는 계속 health 응답했다. named mutex 단위 테스트도 통과했다.
- 다른 임시 listener가 18765를 점유한 경우 launcher가 `BDO 물교 시작 실패` 오류 창을 표시하고 exit code 1로 종료했다. 다른 port로 옮기거나 기존 프로세스를 종료하지 않았다.

## Offline 및 runtime 참조

- `local_app/frontend`, backend 및 package 설정에서 외부 CDN, font, image, API, Google/Gemini 및 Tailwind CDN 참조를 찾지 못했다. frontend/backend는 reference의 `iconUrl`/`sourcePage` 필드를 소비하지 않아 해당 메타데이터 URL을 요청하지 않는다.
- Chrome 테스트는 외부 background networking 비활성화 옵션으로 packaged localhost UI를 검증했다. 앱만을 대상으로 OS outbound network를 완전히 차단하는 방화벽 검증은 수행하지 않았다. 따라서 확인 결과는 isolated offline-capable runtime 및 외부 runtime 참조 부재이며, 별도 네트워크 차단 PC 실사는 아니다.
- launcher, backend, frontend와 package를 지정된 개발 경로 패턴으로 검사했고 `D:\BDOBarterDev`, `D:\Codex_`, `C:\Users\kwang`, `.codex-runtimes` 의존 흔적은 발견하지 못했다. package 실행 경로는 `_MEIPASS` 기준이며 DB 경로는 `%LOCALAPPDATA%` 기준이다.
- `reference/barter_items.json`에는 출처·아이콘 URL metadata가 있지만 runtime code에서 사용하지 않는다. reference 데이터의 기존 해시는 유지됐다.

## 자동 회귀

- `python -m compileall -q local_app`: PASS.
- `python -m unittest discover -s local_app/tests -v`: 25/25 PASS. corrupt multipart test에서 기존 비치명적 `ResourceWarning` 1건이 출력됐지만 임시 업로드 정리 assertion과 테스트는 통과했다.
- frontend 및 browser-test JavaScript syntax: 52개 `.js`/`.mjs` 파일 PASS.
- `node local_app/tests/equivalence/verify-migration.mjs`: PASS — baseline HTML SHA-256 `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76`, 보호 함수 42/42, 상수 6/6, 보호 영역 2개 및 보호 파일 15개 일치.
- `node local_app/tests/trade_import_regression.mjs`: PASS — 86행 및 import 오류·중복·모호 후보 회귀.
- 기존 필수 Node 회귀 9종: 모두 PASS. 결과 JSON은 기존 `test_results/`를 덮지 않고 임시 결과 폴더에 저장했다. 요약: core 11/11, followup 4/4, modes 7/7, tier7 completion 10/10, no-hold completion 6/6, scheduler preservation 3/3, scenario matrix 32개 및 reserve violation 0개. Inventory completion 및 tier7 threshold diagnostic도 exit code 0.
- 전체 SPEC-005 scheduler equivalence 결과에서 inner 일반 교환, 까마귀 주화, 7단 chain의 쾌속/균형 출력 비교가 포함됐다.

## Packaged Chrome regression

아래 모든 browser test는 source-tree 서버가 아닌 이동된 folder package의 `127.0.0.1:18765`를 대상으로 Chrome headless에서 수행했다. 각 업무 흐름은 격리 `LOCALAPPDATA`로 실행했다.

`BROWSER_NOT_RUN`: 없음. 아래에 기록한 SPEC-002~005 Chrome 시나리오를 실행했다.

- SPEC-002 durable state: 70개 행 표시, 재고/order/settings/viewer round-trip, stale revision 및 invalid save 처리 PASS.
- SPEC-003 scanner: 실제 PNG upload, 50개 검토 행, 취소 시 무변경, stale revision 재확인, 실패 저장 보존, 적용 후 재고 PATCH 및 targets/order/settings 보존 PASS. scanner는 패키지에 포함된 Pillow/NumPy, `warehouse_patch.convert()`와 template을 사용했다.
- SPEC-004 trade session: JSON 목록 입력, 새 session/default parley, 중복·충돌, session만의 parley, 새로고침 시 session 폐기 및 durable settings 복원 PASS.
- SPEC-005 scheduler/completion: reference와 동일 입력 출력 비교(inner, crow coin, tier 7), route 편집, waypoint 및 trade 완료, persistence 응답 유실, duplicate click, 실제 HTTP 409 conflict rebase PASS.
- completion invocation counter: waypoint 1회, response-loss 후 duplicate click을 포함한 trade completion 1회, 실제 409 rebase 경로 1회. 409 뒤 최신 재고에 delta를 재적용했고 inventory 결과는 source 197, target 19; 완료 상태와 parley는 이중 적용되지 않았다.
- browser reload 후 현재 회차는 사라지고 persistent inventory는 유지됐다.

첫 통합 browser 시도는 SPEC-002가 바꾼 parley 설정을 뒤이어 실행한 SPEC-004의 초기 기본값 assertion이 읽어 실패했다. 같은 package 테스트를 새 격리 `LOCALAPPDATA`와 독립 기본값에서 순차 실행했고 전체 4개 browser 흐름이 모두 통과했다. 구현 실패는 아니며 공유 테스트 데이터 격리 문제였다.

## SPEC-000 보호 상태

- `BDO_물교_v1.0.html`: SPEC-000 baseline SHA-256 동일.
- `tools/warehouse_patch/warehouse_patch.py`, `reference/barter_items.json`, reference checksum 및 regression fixture 해시: migration verifier에서 보호 파일 일치.
- `processParsedTrades` 보호 구간 및 scheduler/completion 보호 구간: 2/2 일치.
- SPEC-005 이관 함수: verifier의 42개 보호 함수 본문 해시 모두 일치.

## 판정

필수 SPEC-006 acceptance와 실제 packaged Chrome 흐름을 확인했다. 제한 사항은 physical fresh-PC 시험이나 OS 수준 네트워크 차단 시험을 하지 않았다는 점이다. isolated packaged runtime에서 Python 경로 제거, 외부 runtime 참조 검사 및 로컬 업무 흐름을 검증했으며, 실제 사용자 DB는 접근하지 않았다.

**SPEC-006: PASS**

**SPEC-100: 시작하지 않음**

## Release audit follow-up (2026-09-25)

SPEC-006 audit에서 발견된 package 내 미사용 reference 파일 8개를 제거하기 위해 `local_app/packaging/bdo-barter.spec`의 datas 목록을 `reference/barter_items.json`과 `reference/icons/`로 좁혔다. scanner Python 코드와 `tools/warehouse_patch/quantity_templates.npz` 항목은 유지했다.

- Python 3.12.14 임시 가상환경으로 재빌드했다. build dependency 조합: Flask 3.1.3, Werkzeug 3.1.8, Waitress 3.0.2, Pillow 12.3.0, NumPy 2.5.3, PyInstaller 6.22.3. 전역 Python 환경은 변경하지 않았다.
- 재빌드 onedir package: 254개 파일, 72,069,449 bytes. 실행 파일, frontend, `barter_items.json`, scanner 코드, `quantity_templates.npz`, WEBP 아이콘 70개가 있다.
- 제거 확인: `barter_tier1_reference.png`~`barter_tier5_reference.png`, `icon_similarity_report.json`, `SHA256SUMS.txt`, `STAGE3_VALIDATION.md` 모두 package에 없다. DB, `tests/`, `test_results/`, `specs/`, `.git/`, `.codex/`, 개발 로그, secret/key 및 screenshot 파일도 없다.
- 저장소 밖 cwd에서 package를 실행해 `/api/health` 및 frontend HTTP 200을 확인했다. 격리 임시 `LOCALAPPDATA`에 SQLite DB가 만들어졌다.
- `barter_only.png`를 packaged `/api/warehouse-scan`에 POST했다. bundled Pillow/NumPy를 사용하는 scanner 경로가 정상 PATCH를 반환했고 50개 MATCH 행을 검출했다. 임시 upload PNG 정리, shutdown endpoint와 launcher exit code 0을 확인했다. 실제 사용자 DB는 사용하지 않았다.
- launcher/backend/frontend/package 설정의 개발 절대경로 검색 결과가 없었다. 패키지 실행 자체도 source tree 밖 cwd와 임시 사용자 데이터 위치에서 성공했다.
- 보호 SHA-256은 SPEC-000 baseline과 일치했다: HTML `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76`, scanner `aa72ed5763c76a030ab4c8ffbc00fb23bf8ed4c391f9d1de8659395d76579fe8`, `barter_items.json` `e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c`, `SHA256SUMS.txt` `4131f16abdff13889e98702e7a9c00325671349fddaf7ac282e70b7e88aa2ae4`. HTML baseline SHA 동일로 SPEC-005 보호 함수 42개가 변경되지 않았음을 확인했다.
- 이 후속 작업에서는 전체 unittest, SPEC-002~005 회귀 또는 Chrome 테스트를 재실행하지 않았다.

**Release package follow-up: PASS**
