# SPEC-007 완료·검증 보고서

검증일: 2026-09-26. 구현, 자동 테스트, 실제 Chrome UI·지도, 새 실행 파일 및 승인된 교체·재시작 검증을 완료했다. 아래 PASS는 해당 검사에 한정하며 미실행 항목은 14절에 구분한다.

## 1. 읽은 spec/decision 문서

AGENTS.md, README, docs 전체, constitution, SPEC-000~006의 spec/plan/tasks/state mapping/comparison/validation/audit, SPEC-100의 ABANDONED 및 역사 기록을 확인했다. 별도 DECISIONS/handoff 파일은 발견되지 않았다. 원본 HTML의 UI·저장 슬롯·튜닝·지도·자유항로·완료 함수와 현재 backend/frontend/tests를 대조했다. 과거 검증 보고서는 이번 PASS 근거로 재사용하지 않았다.

사용자는 기존 회차 저장 금지·스케줄 슬롯 제거 결정을 이번 요청으로 대체하도록 승인했다. 타이머 복원 제외는 유지했다. 기존 앱 회차 종료, 실행 폴더 보관, 검증 후 교체·재시작도 승인했다.

## 2. 원본 기능 감사표

전체 분류와 함수·문서 근거는 [audit-report.md](audit-report.md)에 있다. KEEP/REMOVE/REPLACED를 명시하고 삭제 결정이 없는 창고 보조 조작, 슬롯, 임시 튜닝, 자유항로, 실제 지도 기능을 복구 대상으로 확정했다.

## 3. 명시적으로 제거한 기능과 근거

Gemini 키·모델·API·이미지 파싱, 물교 화면 캡처·붙여넣기·크롭은 사용자 요청 및 constitution/SPEC-100 ABANDONED에 따라 제거 상태를 유지했다. 전체 프로그램 JSON 백업·복원은 기존 제외 결정과 이번 요청에 따라 추가하지 않았다. 지도 소스 치환 문자열 REPLACEMENT_CODE도 제외했다. 지도 전용 JSON은 전체 백업과 구분하여 복구했다. 타이머는 실행 중 제공하며 복원 시 초기화한다.

## 4. 복구한 기능

원본 navy/gray·작은 버튼·compact 상단·좌측 창고/우측 회차 배치, 내부 스크롤, 창고 +/- 및 단계별 일괄 목표를 제공한다. JSON 입력, 큰 출항 브리핑, 별도 계산 튜닝을 dialog로 분리했다. 브리핑에서 쾌속/균형/둘 다, 교역 모드 변경과 재계산, 경유지, 수동 순서·횟수, 재료·완료·타이머, 결정 근거를 사용할 수 있다.

스케줄 슬롯 1~5는 당시 회차·목록·완료 상태·설정·튜닝·진단 맥락을 저장한다. 임시 튜닝과 영구 기본값을 분리하고 기본값 복귀 시 재계산한다. 선박 프리셋 4개를 유지한다. 자유항로 거리·시간·출항·취소와 실제 SVG 지도, 팬/줌·노드·좌표·원호·되돌리기·거리 측정·방향 보정·메모·지도 슬롯/기본 지도·패널 조작·지도 JSON을 연결했다.

## 5. 현재도 보류한 UNKNOWN 기능

기능을 제거할지에 관한 UNKNOWN은 사용자 답변과 원본 대조로 해소했다. SPEC-100 이미지 인식 실험은 명시적 제외이며 UNKNOWN이 아니다. 실제 게임 운영 및 사람이 듣는 알람 소리 검증은 자동 검증으로 대체하지 않았다.

## 6. DB 변경사항

schemaVersion 2. 기존 inventory/settings/app_meta를 유지하고 단일 working_session, 슬롯 1~5의 saved_schedule_slot, 중복 요청 확인용 mutation_receipt를 추가했다. receipt는 최대 128개로 제한하며 스케줄 이력을 누적하지 않는다. NULL 재고와 실제 0은 구분한다. bootstrap은 동일 read transaction에서 일관된 상태를 반환한다.

## 7. migration

schema 1→2는 기존 테이블/값을 보존하는 추가 transaction이다. 반복 초기화는 안전하며 미래 schema는 거부한다. 임시 schema 1 DB의 보존·반복 migration을 backend 테스트에서 확인했다. 실제 사용자 DB도 전환 완료: 창고 70행, 창고·순서·설정의 정규화 SHA-256 및 revision 51이 전환 전과 동일하다. 구버전의 메모리 회차는 승인에 따라 종료했고 최초 workingSession과 슬롯은 비어 있다. [전환 전 해시](evidence/installed-before.json), [전환 후 검증](evidence/installed-upgrade.json).

## 8. API 변경사항

PUT/DELETE `/api/working-session`, PUT/DELETE `/api/schedule-slots/<1..5>`, POST `/api/working-session/completion`을 추가했다. baseRevision/mutationId, 유효성 검사, Origin 검증, 종료 시 mutation drain을 적용한다. 완료는 재고 최종값과 회차를 같은 transaction에 커밋한다. 서버에서 게임 계산을 재실행하지 않는다. 응답 유실은 동일 body/ID 재시도, 확인된 409는 동일 회차·sessionRevision일 때 기존 재고 차이만 합산한다. 변경된 회차는 거부한다.

## 9. Frontend 변경사항

기존 모듈 구조를 유지했다. state의 작업 사본, persistence의 저장 큐, runtime의 snapshot/restore, UI의 렌더링을 분리한다. 원본 계산 함수 본문을 수정하지 않고 연결부에서 session config와 저장 이벤트를 처리한다. 완료 저장 대기 중 재변경을 차단하며 저장 오류를 성공으로 표시하지 않는다. 지도는 native dialog의 top layer와 실제 포인터 조작을 사용한다.

## 10. persistence lifecycle

| 데이터 | 새로고침/앱 재시작 | 회차 초기화 | 슬롯 불러오기 |
|---|---|---|---|
| 창고·목표·순서·영구 설정·프리셋·지도/UI 설정 | 복원 | 유지 | 유지 |
| 현재 물교·스케줄·완료·교섭력·임시 튜닝·진단 | 복원 | 삭제 | 당시 맥락의 독립 사본으로 교체 |
| 스케줄 슬롯 1~5 | 복원 | 유지 | 원본 슬롯 유지 |
| 타이머·열린 dialog·drag·입력 초안 | 초기화 | 초기화 | 초기화 |

개별 슬롯 삭제는 다른 슬롯과 영구 데이터를 유지한다. 새 회차·불러오기·초기화의 대체 동작은 명시적 사용자 조작을 따른다. 일반 durable 재조회는 현재 작업 사본을 덮지 않는다.

## 11. 수정 파일

경로는 `_dev` 기준이다. Git 저장소가 없어 Git diff 목록이 아니라 실제 담당 파일 목록이다.

- backend: `local_app/backend/storage.py`, `session_contracts.py`, `app.py`, `api/session.py`, `api/state.py`.
- frontend: `index.html`, `css/{app,trade,schedule,map-viewer}.css`, `js/{api,state,persistence,app,modal-ui,settings-ui,inventory-ui,trade-ui,schedule-ui,diagnostics-ui,map-ui,map-viewer}.js`, `js/domain/scheduler-runtime.js`의 비보호 연결부.
- 검증: `local_app/tests/backend/test_working_session.py`와 기존 schema/API 계약 테스트, launcher 테스트, `browser_{smoke,warehouse_scan,trade_session,scheduler,restoration,map_restoration}.mjs`. 기존 계산 기대값·입력 fixture는 유지했다.
- 스크립트: `scripts/run-restoration-regressions.ps1`, `audit-restoration-package.py`, `verify-restoration-runtime.py`, `check-installed-restoration.py`.
- 문서: 루트 사용법.md, _dev의 README, constitution, ARCHITECTURE, SPEC-001~006의 현행 계약 안내, SPEC-007 spec/audit/validation/evidence. 과거 보고서를 덮지 않았다.
- 배포: 별도 `업데이트_검증판/app`에 빌드·검증한 패키지로 루트 `app`을 교체하고 재시작했다. 원본 HTML/scanner/reference 및 보호 fixture·계산 본문은 수정하지 않았다.

## 12. 1920×1080 / 130% 화면 검증

실제 Google Chrome CDP, 1920×1080, UI 전체 배율 130%로 검증했다. 실제 마우스 입력의 hit-test를 확인했다. 메인 좌우 패널은 화면 안에 있고 창고는 scrollHeight/clientHeight 2976/702, 물교 목록은 1125/576으로 내부 스크롤한다. 브리핑·튜닝·지도는 별도 dialog로 열리며 generated card와 복원 후 카드/완료 버튼 상태도 확인했다. 브리핑 실제 이동 +24/+18px, 실제 크기 변경 +37/+32px도 통과했다. 페이지 예외는 0개다.

지도는 저장된 스케줄 슬롯 2의 쾌속·균형·1차 출항 선택을 검증했다. 캔버스 1069×850px, grid 레이아웃과 청록 항로 3개의 화면 교차 및 PNG를 확인했다. 지도 편집 패널은 실제 handle drag로 317×102→323×113px가 되었고, 접기 상태를 저장하여 새 backend process에서 접힘/펼친 높이 113px를 복원했다. [편집 화면](evidence/map-edit130.png)을 직접 확인했다.

[메인](evidence/main130.png), [출항 브리핑](evidence/briefing130.png), [계산 튜닝](evidence/tuning130.png), [지도](evidence/map130.png) PNG를 직접 열어 확인했다. 메인 캡처 전에 실제 서버 저장·회차 ID 일치·저장 대기 0·완료 문구와 스크롤 0을 확인했다. [원본](evidence/original130.png)은 초기 DOM 70품목·제목·배경을 확인하여 캡처했으나 Tailwind CDN 스타일이 로드되지 않아 완성된 원본 레이아웃과의 시각적 동등성은 미검증이다. 소스의 구조·색상·기능 대조와 신규 실제 UI 검증은 이 한계와 별개다. headless Chrome의 실제 렌더링 검증이며 사람의 장시간 게임 사용 검증은 아니다.

## 13. 실행한 테스트와 결과

| 검사 | 실제 결과·근거 |
|---|---|
| Python backend/launcher/scanner 계약 | 35 PASS, [backend.log](evidence/backend.log). 임시 SQLite·새 subprocess 복원·원자 rollback·중복 완료·409·migration·NULL/0·receipt 제한 포함 |
| 원본 동등성 | PASS, [equivalence.log](evidence/equivalence.log): 함수 42개, 상수 6개, timer tick, 보호 영역 2개, 파일 15개 |
| 물교 JSON 원본 회귀 | PASS, [trade-import.log](evidence/trade-import.log): fixture 3개·86행, 보류/오류/중복/육지·특수 이름 |
| 원본 필수 회귀 9종 | 모두 PASS. [scenario_matrix.json](evidence/scenario_matrix.json) 32개 시나리오·unexpectedReserveViolations 0, [scheduler_preservation_regression.json](evidence/scheduler_preservation_regression.json) 3/3 동일 |
| 기존 Chrome smoke/warehouse/trade/scheduler | 모두 PASS, evidence의 browser-smoke/warehouse/trade/scheduler.log. 실제 scanner 입력·취소·충돌·완료/타이머·원본 결과 비교 포함 |
| 신규 A~K 회복·영속화 Chrome | PASS, [browser_restoration.json](evidence/browser_restoration.json). 격리 DB 실제 서버 재시작·슬롯 독립·타이머 초기화·응답 유실 완료 재시도·reset 보존 |
| 신규 지도 Chrome | PASS, [map-restoration-results.json](evidence/map-restoration-results.json). 실제 포인터 팬/줌·좌표/undo/원복·원호 반경·240초 사용자 시간/보정·메모 추가/수정/삭제·지도 슬롯/base·패널 이동/resize/접기/재시작·JSON 잘못된 입력 보호/왕복·자유항로 출항/리셋/취소. pending 지도 guard는 getter 주입으로 확인했으며 실제 통신 응답 유실은 A~K에서 별도 확인 |
| JavaScript 문법 | 모든 frontend 파일을 stdin `node --input-type=module --check`로 PASS. 이 환경의 파일 직접 `node --check`는 충분한 검사로 취급하지 않음 |
| PyInstaller 패키지 자원 감사 | PASS, [package-audit.json](evidence/package-audit.json): 254파일·103자원 동일·신규 API 모듈 포함·사용자 DB 미포함 |
| 새 실행 파일 실제 실행 | PASS, [packaged-runtime.json](evidence/packaged-runtime.json). Python 없는 PATH에서 실행, Chrome 자동 열기·70행 UI, 실제 창고 PNG scanner/원본 convert 일치·적용 전 DB 불변, 현재 회차/슬롯 프로세스 재시작 복원, 완료 동일 요청 replay, reset 보존 |
| 실제 사용자 설치·migration | PASS, [installed-upgrade.json](evidence/installed-upgrade.json). schema 1→2, 창고 70행·창고/순서/설정 해시·revision 51 보존. [deployment.json](evidence/deployment.json)의 설치 254파일 해시가 검증 패키지와 전부 동일 |

검증 도중 잘못된 테스트 fixture·reload 대기·과거 schema 기대값은 현행 계약에 맞춰 고쳤다. 지도 template 문법 오류, viewer 생성 전 닫기 예외, 복사된 항로의 사용자 지정 시간 누락, pending 중 좌표 선변경, 잘못된 JSON 선반영을 수정했다. native resize가 사용자 handle을 가로채는 문제는 별도 pointer handle과 body 내부 scroll로 해결했다. 접힘 상태에도 펼친 높이를 보존한다. 검증 중 CSS 추가가 기존 스타일을 대체한 오류는 보관된 동일 자원에서 복원하여 실제 PNG와 style/grid/경로 교차 검사로 다시 확인했다. 빈·부분 자유항로 이름을 임의 좌표로 취급하지 않으며 기존 alarm 함수를 재사용한다. protected 알고리즘 기대값을 바꾸어 PASS시키지 않았다. backend 로그의 기존 ResourceWarning은 실패가 아니며 숨기지 않았다.

## 14. 회귀 위험과 검증 한계

추가 테이블을 사용하는 schema 2 DB는 구버전 실행 파일로 되돌려 사용할 수 없다. 기존 실행 폴더 보관은 이전 파일 보존이며 DB rollback 기능을 의미하지 않는다. 진행 중 타이머는 의도적으로 복원하지 않는다. 긴급 종료로 저장 완료 전 프로세스가 사라지는 경우를 저장 성공으로 보장하지 않으며 대기·오류 상태를 표시한다. 다중 사용자의 동시 운영은 이 개인 localhost 앱의 범위 밖이다.

모바일·다른 브라우저·실제 게임에서의 장시간 운영·사람이 듣는 알람 검증은 미실행이다. 원본 계산 동등성과 임시 환경의 자동·Chrome·실제 실행 파일 검사, 실제 사용자 migration 보존 검사는 각각 별개의 근거로 기록한다.

## 15. 다음 단계

요청된 구현·검증·교체·재시작은 완료했다. 현재 실행 파일은 `D:\BDOBarterDev\app\BDO 물교 실행.exe`이며 기존 `실행하기.cmd`로 실행할 수 있다. 이전 실행 폴더는 `D:\BDOBarterDev\app_교체전_20260926_8f013499`에 보관했다. 새 앱은 정상 실행 상태로 유지했다.

14절의 수동 운영·소리·원본 완성 스타일 비교는 미검증이며 추가 기능 작업이 아니다. 기능 추가·전체 백업/복원·SPEC-100 이미지 인식 재개는 이번 범위에 포함하지 않는다. 정상 운영에서 사용자 입력에 따른 불편이나 회귀가 발견되면 해당 동작을 원본과 재현하여 최소 범위로 수정한다.
