# SPEC-007 — 원본 기능 회복과 작업 회차 보존

2026-09-26 사용자 요청 및 충돌 확인 답변이 SPEC-001~006의 회차 비영속·슬롯 제거 결정을 대체한다. 타이머 복원 제외는 유지한다. 기존 검증 기록은 해당 시점의 역사로 보존한다.

## 확정 범위

- 원본 HTML/scanner/reference/fixture와 보호된 계산 함수는 수정하지 않는다.
- 원본 dark navy/gray, 작은 버튼, compact 상단, 좌측 창고·우측 목록을 계승한다. 1920×1080, UI 130%에서 각 패널 내부 스크롤을 검증한다.
- JSON 입력은 별도 dialog, 스케줄은 큰 briefing dialog, tuning은 별도 dialog다.
- 영구 설정은 기존 SQLite inventory/settings/app_meta를 유지한다.
- 단일 working_session과 5개 saved_schedule_slot을 추가한다. schema 1→2는 기존 값을 유지하는 추가 migration이다.
- 저장은 기존 baseRevision/mutationId 큐를 사용한다. 중복 응답 유실 방어용 mutation_receipt를 최대 128개 보존한다. 회차 이력을 누적하지 않는다.
- bootstrap은 일관된 DB read transaction에서 durable/workingSession/scheduleSlots를 반환한다.
- PUT/DELETE /api/working-session, PUT/DELETE /api/schedule-slots/<1..5>를 추가한다. 완료는 POST /api/working-session/completion으로 재고 최종값과 회차 snapshot을 단일 transaction에 커밋한다. 서버가 게임 계산을 재실행하지 않는다.

## 회차 payload v1

`{version:1,id,scannedTrades,schedule,completed,remainingParley,config,selection,diagnostics}`. schedule은 null 또는 `{speed,balance}`이고 originalIndex와 남은 목록 횟수 및 completed를 보존한다. config는 당시 `{ship,parley,tuning}` 전체 snapshot이다. diagnostics는 생성 시각·ENGINE_DEBUG 등 JSON 근거다. selection은 briefMode와 selectedScheduleSlot 등 회차 복원에 필요한 선택만 포함한다. DOM/drag/interval/열린 dialog/업로드/타이머는 저장하지 않는다. schedule의 timerActive/timerEnd/alarmPlayed도 저장 경계에서 제거한다.

슬롯은 `{version:1,createdAt,session}`이며 독립 깊은 복사다. 저장 결과와 해당 trade 목록·모드·튜닝·설정·진단·완료 맥락을 함께 보관한다. 불러오기는 durable inventory/settings를 덮지 않고 working session을 교체한다. 이전 회차를 대체하는 동작은 확인한다.

## 저장 수명 주기

| 데이터 | 새로고침/앱 재시작 | 회차 초기화 | 삭제 |
|---|---|---|---|
| inventory/settings | 복원 | 유지 | 해당 값의 명시적 변경만 |
| working_session | 복원 | 삭제 | 확인된 회차 초기화/새 회차 대체 |
| saved_schedule_slot | 복원 | 유지 | 선택 슬롯의 명시적 삭제 |
| 타이머/drag/열린 모달/초안 | 초기화 | 초기화 | 실행 수명 종료 |

## Frontend 연결 계약

- state.session은 사용자 작업 사본, DB가 저장 정본이다. state.scheduleSlots는 bootstrap 결과다.
- persistence의 `saveWorkingSession()`, `resetWorkingSession()`, `saveScheduleSlot(slot)`, `loadScheduleSlot(slot)`, `deleteScheduleSlot(slot)`, `whenPersistenceIdle()`을 UI에서 await한다. `bdo:session-changed`는 즉시 snapshot을 캡처해 저장 큐에 넣는다.
- runtime의 `snapshotWorkingSession(state)`/`restoreWorkingSession(state,payload)`는 protected engine 밖에서 변환한다. session.config가 존재하면 durable 기본값보다 우선하며 새 회차는 durable 설정의 깊은 복사로 시작한다.
- 일반 reload/refreshPersistentState는 UI 작업 사본을 임의 덮지 않는다. 첫 앱 시작과 명시적 복원만 restore한다.
- pending completion 중 다른 회차/slot/state 변경은 막고 동일 요청 body 재시도를 허용한다. 실제 409 응답이고 저장된 회차 id/sessionRevision이 동일할 때만 원본 완료 계산의 재고 차이를 최신 재고에 합산해 새 요청으로 보낸다. 회차 자체가 변경됐으면 거부한다. 응답 유실 때는 mutationId와 body를 바꾸지 않고 재시도하며 원본 완료 계산을 재실행하지 않는다.
- 튜닝 임시 적용은 session.config.tuning, 영구 저장은 settings.tuning에 반영한다. 영구 기본값 불러오기와 실시간 재계산을 제공한다.

## 검증

기존 함수 본문 42개/상수 6개 동등성, 9개 원본 회귀, backend/frontend 검증과 임시 SQLite의 실제 프로세스 재시작을 수행한다. A~K 사용자 시나리오, atomic completion rollback/응답 유실/409, 슬롯 독립성 및 타이머 초기화를 검증한다. mock/DOM/build만으로 UI PASS를 선언하지 않는다. 화면 PNG를 직접 검토한다.
