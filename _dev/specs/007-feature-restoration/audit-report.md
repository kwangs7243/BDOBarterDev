# 원본 기능 보존 감사

기준: 사용자 2026-09-26 요청 > 같은 날 충돌 확인 답변 > 기존 승인 문서 > 원본 behavior > 개편본. 실제 코드 읽기 기준이며 이전 PASS 보고서는 이번 실행 결과가 아니다.

읽은 정본: AGENTS.md, README, docs 전체, constitution, SPEC-000~006 spec/plan/tasks/state-mapping/comparison/validation/audit, SPEC-100 ABANDONED 및 역사 문서의 상태·경계, 현재 backend schema/API/contracts/persistence/state/UI/domain, 원본 UI·저장 슬롯·튜닝·자유항로·지도 함수와 기존 테스트 계약. 별도 DECISIONS/handoff 파일은 발견되지 않았다. docs/ARCHITECTURE.md와 constitution이 결정 근거다. SPEC-100 역사 인식 실험은 이번 제품 복구 범위 밖이며 재실행하지 않는다.

시작 시 원본 SHA256: 7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76. scanner aa72ed5763c76a030ab4c8ffbc00fb23bf8ed4c391f9d1de8659395d76579fe8. reference e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c. 현재 폴더에는 .git이 없어 기존 변경을 Git diff로 판별할 수 없다. 현재 파일을 기준으로 보호하며 Git 작업을 하지 않는다.

| 원본 기능 | 현재 상태 | 분류 | 근거 문서 | 최종 처리 |
|---|---|---|---|---|
| 창고 70종 현재/목표 수량·NULL/0 | 존재 | KEEP | SPEC-002 | 유지 |
| 창고 단계별 순서·drag reorder | 존재 | KEEP | SPEC-002 | 유지 |
| 창고 수량 +/- 보조 | 누락 | KEEP | 원본 adjustStock, 삭제 결정 없음 | 복구 |
| 단계별 일괄 목표·단계 규칙 | 존재, 별도 대형 패널 | KEEP | SPEC-002, 이번 11항 | 창고 안 compact 통합 |
| 마스터 창고 이미지 스캔·검토·부분 적용 | 존재 | REPLACED | SPEC-003 | backend convert 경로 유지 |
| Gemini key/model/API/이미지 parsing | 제거 | REMOVE | constitution II, 이번 4항 | 제거 유지 |
| 물교 이미지 paste/화면 캡처/크롭 | 제거 | REMOVE | 이번 4항, SPEC-100 ABANDONED | 제거 유지 |
| 전체 프로그램 JSON 백업 import/export | 제거 | REMOVE | 이번 4항, ARCHITECTURE 12.4 | 상단 복구 안 함 |
| 물교 JSON paste/새 회차/추가/오류·보류 | 존재, 상시 textarea | KEEP | SPEC-004, 이번 12항 | dialog로 이동 |
| 수동 행·수율·count 편집 | 존재 | KEEP | SPEC-004 | 유지 |
| 행 활성/비활성·삭제/복원 | 존재 | KEEP | SPEC-004 | 유지 |
| 전체 활성/비활성 전환 | 누락 | KEEP | 원본 toggleAllTrades, 이번 13항 | 원본 toggle 의미 복구 |
| 회차 초기화 | 누락 | KEEP | 이번 26항 | 확인 후 working session만 삭제 |
| 현재 목록/남은 교섭력 복원 | 메모리만 존재 | REPLACED | 이번 23항, 충돌 답변 | SQLite 단일 회차 |
| 선박·교섭력 설정 | 존재, 세로 카드 | KEEP | SPEC-002, 이번 10항 | compact 상단 |
| 선박 프리셋 4개 | 존재 | KEEP | SPEC-002 | 장기 유지 |
| 쾌속/균형·일반/7단/까주 계산 | 존재 | KEEP | SPEC-005 | protected body 불변 |
| 출항 카드/교섭/적재/시간/주화 | 존재 | KEEP | SPEC-005, 원본 renderModeColumn | 큰 briefing로 이동 |
| 경유지·재료·삭제·완료 | 존재 | KEEP | SPEC-005 | 유지 |
| sortie/route reorder·count 조정 | 존재 | KEEP | SPEC-005 | 유지, 회차 저장 |
| 일반/귀환 타이머·알람 | 존재 | KEEP | SPEC-005 | 실행 중 유지 |
| 타이머 새로고침/재시작 복원 | 제외 | REMOVE | ARCHITECTURE 2.2, 사용자 충돌 답변 | 회차 복원 시 초기화 |
| 완료 재고/목록/count/교섭력·중복 방지 | 존재, 재고만 DB | REPLACED | SPEC-005, 이번 23항 | 재고+회차 원자 커밋 |
| 브리핑 modal/이동·resize | 누락 | KEEP | ARCHITECTURE 6, 원본 resultModal | 복구 |
| 브리핑 교역 모드/자동 재계산 | 누락 | KEEP | 원본 saveOceanConfig, 이번 18항 | 기존 runtime 재사용 |
| 스케줄 슬롯 1~5 저장/불러오기/삭제 | 명시 제거 | REPLACED | 이번 20/29항, 충돌 답변 | SQLite snapshot, 회차와 독립 |
| 슬롯 당시 튜닝·모드·ENGINE_DEBUG | 누락 | KEEP | 원본 saveSchedule/loadSchedule | snapshot 함께 복원 |
| 튜닝 16값·티어 가중치·잉여 제외 | 영구 편집만 존재 | KEEP | SPEC-002, 원본 tuning | 별도 modal |
| 임시 튜닝/실시간 재계산/영구 기본값 복귀 | 누락 | KEEP | 원본 runtime dashboard/loadDefaultTuning | session config와 durable 분리 |
| 자유항로 검색/거리·시간/출발·취소/알람 | 누락 | KEEP | 원본 freeRoute, 삭제 결정 없음 | routing 함수 재사용 |
| 항로 결정 과정·진단 복사 | 요약 JSON만 존재 | KEEP | 원본 openRoutingViewer/copyDiagnostics | 근거 기반 보기 복구 |
| 실제 지도·노드·팬/줌·이름 표시 | JSON 편집만 존재 | KEEP | SPEC-002 계획, 원본 map | 실제 viewer 복구 |
| 지도 항로 브리핑·쾌속/균형·출항 필터 | 누락 | KEEP | 원본 briefing, 삭제 결정 없음 | 스케줄 참조 |
| 좌표 관리·drag·원호·undo·원좌표 복귀 | 좌표 JSON만 존재 | KEEP | SPEC-002, 원본 map | 시각 편집 연결 |
| 거리 측정·항로 시간·방향별 보정 | JSON 편집만 존재 | KEEP | SPEC-002, 원본 map | viewer와 DB 연결 |
| 메모 추가·편집·삭제·전체 삭제 | JSON 편집만 존재 | KEEP | SPEC-002, 원본 map | viewer와 DB 연결 |
| 지도 슬롯 3개·기본 지도 | 저장 UI 존재 | REPLACED | SPEC-002 | SQLite 유지, viewer 연결 |
| 지도 전용 좌표 JSON import/export | 누락 | KEEP | 원본 exportCoordsToFile/importCoordsFromFile | 전체 프로그램 백업과 구분 |
| 지도 소스 REPLACEMENT_CODE | 제외 | REMOVE | ARCHITECTURE 4/15 | 소스 치환 문자열 제외 |
| UI 배율 | 저장/적용 존재 | KEEP | SPEC-002, 이번 8항 | 130% 실사 |
| viewer 패널 위치·크기·접기 | 숫자 편집만 존재 | KEEP | SPEC-002 계획/validation 제한 | 실제 이동/resize/저장 |
| 스케줄 대시보드 배치/접기 | 누락 | KEEP | 원본 toggleLayout/togglePanel | 접근 기능 유지, tab도 허용 |
| 미사용 sortiesBulk·구버전 이관 표식 | 제거 | REMOVE | ARCHITECTURE 2.2/2.4 | 제거 유지 |

UNKNOWN: 위 기능군의 삭제 여부는 이번 우선순위로 해소했다. 세부 원호 조작·뷰어 되돌리기 등은 원본과 직접 비교하며 추측 구현하지 않는다. 최종 구현·검증 결과는 별도 validation-report에 기록한다.

저장 수명주기와 API/payload/revision/migration/파일 책임은 spec.md가 정본이다. 요청이 요구한 회차 복구는 과거 스케줄 history 누적과 구분한다.
