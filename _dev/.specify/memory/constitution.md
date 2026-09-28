# BDO 물교 재구성 Constitution

상위 근거는 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)다. 모든 SPEC-000~SPEC-007에 공통 적용한다. 2026-09-26 사용자 확정 답변에 따른 SPEC-007이 종전 회차·슬롯 제외를 대체한다.

## I. 로컬 실행 경계
- 한 사용자의 Windows PC에서 실행하는 localhost 웹앱이다.
- 서버는 127.0.0.1에만 bind한다.
- Frontend와 API는 동일 origin으로 제공한다.
- 최종 사용자는 터미널이나 Python 명령어를 직접 입력하지 않는다.
- 더블클릭 가능한 launcher로 시작한다.

## II. Gemini 기능 완전 제거
신규 앱에는 Gemini API, API Key, 모델 선택, prompt, Gemini 이미지 처리·응답 parsing을 이관하지 않는다. 전용 UI·상태·CSS·함수·변수·도움말·오류 문구도 신규 앱 코드에 두지 않는다.

## III. 검증된 알고리즘 보존
다음 계산 의미를 변경하지 않는다: processParsedTrades, runAlgorithmAllModes, buildSorties, buildTier7Sorties, 까마귀주화 생성 로직, routing, 지역 조건, 적재 계산, schedule edit, completion, waypoint completion.
점수·임계값·조건·정렬·호출 순서를 바꾸거나 성능을 이유로 다시 작성하지 않는다.

## IV. Warehouse scanner 보호
warehouse_patch.py의 검증된 판독 알고리즘은 수정하지 않는다. 신규 앱은 adapter를 통해 convert()를 호출한다. 미확정 결과를 강제 보정하지 않는다.

## V. 상태 저장 경계
- 영구 상태, 단일 현재 회차, 명시적으로 저장한 스케줄 슬롯 5개를 SQLite에 저장한다.
- 현재 물교 목록·스케줄·완료 상태·남은 교섭력·당시 선박/교섭/튜닝/진단을 단일 working_session에 보관한다. 회차 history를 누적하지 않는다. 슬롯은 별도 깊은 복사다.
- UI 임시 상태와 타이머는 저장하지 않는다. 회차 복원 시 타이머는 초기화한다. 완료 결과는 재고와 회차를 단일 트랜잭션으로 저장한다.
- 현재 상태 분류는 SPEC-007과 ARCHITECTURE.md의 개정 표를 따른다.

## VI. 기준 소스 보존
BDO_물교_v1.0.html, reference/, warehouse_patch.py, 기존 회귀 fixture를 reference implementation 및 비교 기준으로 보존한다. 보호 계산 테스트 기대값을 변경해 신규 구현을 PASS시키지 않는다. 명시적으로 승인된 API/schema/회차 수명 계약 변경에 해당하는 기존 검증만 새 계약으로 갱신한다. 결과가 다르면 실패로 보고 원인을 조사한다.

## VII. SPEC 범위와 순서
각 Spec은 자기 범위만 구현하고 후속 Spec을 미리 구현하지 않는다. 순서는 SPEC-000 → 001 → 002 → 003 → 004 → 005 → 006이다. SPEC-007은 승인된 기능 복구 작업이다. SPEC-100은 ABANDONED / DEFERRED_INDEFINITELY이며 별도 승인 없이 재개하지 않는다. 병렬 구현으로 순서를 바꾸지 않는다.

## VIII. 결과 검증
계산 차이를 tolerance로 숨기지 않는다. 날짜·random ID처럼 본질적으로 비결정적인 값만 정규화한다. 자동 회귀와 실제 브라우저 검증을 구분한다. 브라우저 검증을 못 하면 BROWSER_NOT_RUN로 기록한다.
