# SPEC-006 Release Audit

감사 방식: 문서·실제 source·onedir 산출물 검사. 1차 감사에서는 전체 regression을 재실행하지 않았다. 후속 수정에서는 package를 재빌드하고 package contents, 격리 startup 및 실제 packaged scanner API만 검증했다.

## Launcher / Single Instance

**PASS.**

- `local_app/backend/app.py`에서 `HOST = "127.0.0.1"`, `PORT = 18765`로 정하고, `local_app/launcher.py`가 `create_server(app, host=HOST, port=PORT, threads=4)`로 Waitress를 생성한다. production 경로에 `0.0.0.0` bind나 다른 port fallback은 없다.
- launcher 흐름은 named mutex 획득 → 기존 health probe → packaged resource에서 app 생성 → Waitress 생성/시작 → 최대 30초 health polling → browser open → 관리창이다. health 성공 전에는 새 instance가 browser를 열지 않는다.
- Windows named mutex `Local\BDOBarter-18765`의 생성 결과가 `ERROR_ALREADY_EXISTS`면 새 Waitress를 만들지 않고 기존 health를 최대 12초 확인해 기존 페이지를 연다. handle은 모든 return/exception 경로의 `finally`에서 `CloseHandle`로 닫힌다. 초기 소유권을 요청하지 않는 mutex이므로 handle 수명으로 instance 표식을 유지한다.
- mutex가 새로 생성됐으나 18765를 다른 일반 프로세스가 점유한 경우 health service 식별값이 다르면 기존 앱으로 취급하지 않고 고정 port bind 오류를 표시한다. `create_server`의 bind error를 사용자가 읽을 수 있는 충돌 메시지로 바꾸며 다른 port로 옮기지 않는다. 기존 SPEC-006 validation-report에는 실제 점유 listener에서 오류 창 및 exit 1을 관찰한 기록이 있다.
- 기존 instance 판정은 `/api/health`의 `ok=true`와 `service=bdo-barter-local` 응답을 기준으로 한다. 다른 로컬 서버가 의도적으로 동일 JSON을 흉내 내는 공격까지 구별하는 process 인증은 없다. 현재 고정 loopback 단일 사용자 계약에는 별도 IPC나 system service를 추가하지 않았다.

## Shutdown / Maintenance

**PASS.** `maintenance.py`에는 `POST /api/app/shutdown` 하나만 있다. 목적은 실행 관리창이 정상 종료하기 전에 신규 write/scan을 막고 진행 중 작업이 끝나기를 기다리도록 하는 것이다. 호출자는 launcher의 `[종료]` 동작이다. `GET` route는 없어 링크 방문이나 GET 요청만으로 종료되지 않는다.

- 전체 production request는 `app.py`에서 Host를 `127.0.0.1:18765` 또는 `localhost:18765`로 제한한다. Origin이 전달되면 동일 loopback origin만 허용한다. 따라서 외부 Host/Origin에서 shutdown 호출은 거부된다.
- inventory PATCH, inventory order PUT, settings PATCH, warehouse-scan POST를 활성 변경 작업으로 추적한다. 종료 요청은 stopping 상태를 세운 뒤 활성 작업 수가 0이 될 때까지 최대 30초 기다린다. 대기 중 새 변경 요청은 503으로 거절한다.
- 30초 안에 drain되지 않으면 stopping을 해제하고 503 `shutdown_busy`를 반환한다. launcher는 실패 메시지를 보이고 종료 버튼을 다시 활성화한다. 무기한 대기는 없다.
- endpoint 목록은 health/bootstrap/inventory/order/settings/warehouse-scan 및 위 shutdown뿐이다. backup, restore, restore preview, 자동 백업 또는 manual backup API는 없다. `tier7.js`의 `backupInventory`는 스케줄 계산 중 메모리 재고값을 되돌리는 지역 임시값으로, 사용자 백업 기능과 관계없다.

## Package Resources

**필수 resource는 포함되어 있다.** 후속 수정에서 `bdo-barter.spec`의 reference 복사를 `reference/barter_items.json`과 `reference/icons/`로 한정했다. scanner는 JSON의 `iconFile`을 따라 아이콘을 읽고 `QuantityReader`는 기존 경로의 `quantity_templates.npz`를 읽는다. scanner Python 코드와 template datas 설정은 유지했다.

- 개발 launcher에서 `resource_root()`는 `local_app/launcher.py` 기준 저장소 root를 반환한다.
- frozen 실행에서 `resource_root()`는 PyInstaller의 `sys._MEIPASS`를 반환한다. onedir 빌드에서는 resource가 실행 폴더의 `_internal` 아래 있으며, launcher와 scanner 경로 계산이 이 root를 사용한다.
- `D:\BDOBarterDev`, `C:\Users\kwang`, `.codex-runtimes` 또는 개발 site-packages의 절대경로 의존은 launcher/package config/runtime 경로에서 발견하지 못했다. package 경로는 build 때 `SPECPATH`로 계산되고 runtime에 source checkout을 요구하지 않는다.

## Package Contents

수정 후 `local_app/packaging/dist/BDO 물교 실행` 산출물은 254개 파일, 72,069,449 bytes다. 실행 파일, `_internal` runtime, frontend, scanner와 필수 data가 들어 있다. `reference/`에는 `barter_items.json` 및 WEBP 아이콘 70개만 있다.

- SQLite DB 0개, `tests/`, `test_results/`, `specs/`, `.git/`, `.codex/`, 로그, `.env`·key/secret 및 screenshot 파일이 없다.
- 최초 package에서 확인한 tier reference PNG 5개, `icon_similarity_report.json`, `SHA256SUMS.txt`, `STAGE3_VALIDATION.md`는 재빌드 package에 모두 없다.
- 아이콘 70개는 불필요 fixture가 아니다. `warehouse_patch.load_reference()`가 JSON의 `iconFile` 경로를 따라 각 파일을 실제로 연다.

### Follow-up verification

- Python 3.12.14 임시 가상환경과 SPEC-006 검증 당시 버전(Flask 3.1.3, Werkzeug 3.1.8, Waitress 3.0.2, Pillow 12.3.0, NumPy 2.5.3, PyInstaller 6.22.3)으로 onedir를 재빌드했다. 전역 Python 설치는 변경하지 않았다.
- package를 저장소 밖 작업 디렉터리에서 시작했다. `/api/health`와 frontend가 HTTP 200으로 응답했다.
- 격리 `LOCALAPPDATA`로 정상 PNG `barter_only.png`를 `/api/warehouse-scan`에 업로드했다. packaged scanner가 실제 PATCH를 반환했고 50개 MATCH 행을 보고했다. scan 임시 PNG는 요청 후 정리됐으며 SQLite DB는 격리 `LOCALAPPDATA`에만 생성됐다. 종료 API 및 launcher 종료도 정상 응답했다.
- 새 package에서 필수 executable/frontend/JSON/scanner/template 및 아이콘 70개를 확인했고 제거 대상 8개는 모두 없었다. 금지 디렉터리·DB·secret/key·screenshot도 없었다.
- launcher/backend/frontend/spec의 개발 절대경로 검색 결과가 없고, package는 저장소 밖 cwd 및 임시 user data 경로에서 실제 실행됐다.
- 보호 SHA-256은 SPEC-000 baseline과 다시 대조했다. HTML `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76`, scanner `aa72ed5763c76a030ab4c8ffbc00fb23bf8ed4c391f9d1de8659395d76579fe8`, JSON `e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c`, checksum file `4131f16abdff13889e98702e7a9c00325671349fddaf7ac282e70b7e88aa2ae4`가 모두 일치한다. HTML 전체 baseline 해시 동일로 SPEC-005 보호 함수 42개도 변경되지 않았다.
- 전체 unittest, SPEC-002~005 regression 및 Chrome 검증은 재실행하지 않았다. 이번 후속 작업은 package 범위로 제한했다.

## Offline Runtime

**PASS.** production frontend/backend/launcher/package config 검사에서 외부 CDN, Google/Gemini API, Tailwind CDN, 외부 font, JavaScript/CSS CDN 또는 외부 이미지 요청을 찾지 못했다. 검색된 `http://`는 localhost URL과 Host/Origin 허용값뿐이다. scanner는 local JSON·아이콘 파일·NumPy template을 사용한다. `iconUrl`과 `sourcePage` JSON metadata는 frontend/backend에서 사용되지 않는다. `URL.createObjectURL` 호출은 선택한 local PNG 미리보기 용도다.

## Fresh Environment Claim

validation-report는 실제 별도 fresh PC나 별도 새 Windows 사용자 실사를 했다고 주장하지 않는다. 격리 package를 source-tree 밖에서 실행하고 `PATH`에서 Python을 제외했으며 `PYTHONHOME`과 `PYTHONPATH`를 제거한 isolated packaged runtime 검증이라고 정확히 한정한다. packaged Python runtime은 Python 3.12 DLL과 bundled dependencies다.

별도 물리 PC, 완전히 새 Windows 사용자 환경, OS firewall 수준 outbound 차단은 검증하지 않았다고 validation-report에 기록되어 있다. `tasks.md`의 T008 제목은 “Python 미설치 Windows … smoke test”로 축약돼 있지만 괄호 설명과 validation-report가 실제 절차를 한정하므로 fresh PC 완료로 과장한 증거는 찾지 못했다.

## Scope Integrity

**SPEC-006 wiring 범위는 준수했다.** 이번 SPEC 관련 실제 변경은 launcher/package/lifecycle wiring, completion invocation 계측 지점, 테스트 및 SPEC-006 문서다.

- scheduler-runtime의 completion observer는 계산 함수 호출 직전에 optional test counter를 알리는 hook이다. scheduler/completion 알고리즘 계산 본문은 바꾸지 않는다.
- SPEC-006에서 새 history/current-session 저장은 없다. 현재 schema 선언은 `inventory`, `settings`, `app_meta` 세 테이블뿐이다.
- scanner implementation은 SPEC-003 validation report에 baseline SHA-256 동일로 기록되어 있고 SPEC-006 package wiring만 scanner 경로를 포함한다. `processParsedTrades`, backup/restore 기능, SPEC-100/OCR 경로를 추가한 흔적은 없다.
- 현재 `git diff`에는 root `BDO_물교_v1.0.html` 변경이 보인다. 이 변경은 SPEC-006 시작 전 작업 상태에도 존재했고 master-inventory PATCH 검토·paste 입력 경로에 관한 이전 변경이다. SPEC-006에서 만든 것으로 간주하지 않았다. SPEC-006 validation-report는 baseline/protected checks가 일치했다고 기록한다.

## Final Verdict

**PASS**

기존 NEEDS_FIX 원인이었던 미사용 reference PNG 5개와 검증용 산출물 3개를 spec의 datas 목록에서 제외했다. 재빌드 package의 내용 검사, 외부 경로 startup, 격리 DB, 실제 packaged warehouse scanner API 흐름이 모두 통과했다. 전체 regression은 요청 범위에 따라 재실행하지 않았다.
