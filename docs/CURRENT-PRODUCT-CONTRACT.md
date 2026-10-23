# 현재 제품 계약

이 문서는 2026-10-19 현재 승인된 desktop 앱의 유지보수 기준이다. 미래 아키텍처나 미구현 기능을 현재 계약으로 취급하지 않는다. 이전 설계·실사·보고서는 Git history와 저장소 외부 archive에 보관한다.

2026-10-23 소스는 사용자 지시서에 따라 BDO Suite로 확장되었다. `/`는 통합 메인, `/barter/`는 기존 물교, `/alchemy/`는 독립 연금 앱이다. 아래 물교 계약은 계속 유지하며 설치 실행 파일을 소스 변경만으로 교체하지 않는다. 연금의 별도 DB·계산·제작 트랜잭션·검증 범위는 [ALCHEMY.md](ALCHEMY.md), 사용자 요구 원문은 [BDO-SUITE-SPEC.md](BDO-SUITE-SPEC.md)에 있다.

## 제품과 입력

- Windows localhost 앱이며 실행 파일은 `D:\BDO\app\BDO 실행.exe`, 주소는 `http://localhost:18765`다. 단일 실행, health 준비 후 브라우저 열기, 정상 종료를 지원한다.
- charcoal/blue UI, sidebar의 현재 회차·창고 재고·출항 브리핑·지도, 출항/검수/설정 dialog의 승인된 구조와 정보 밀도를 유지한다.
- 주 캡처는 native Windows 창 선택·물교/창고 별 persistent ROI·수동 F10이다. 게임 입력 자동화와 자동 스크롤을 하지 않는다.
- 파일·붙여넣기와 native 캡처를 사용할 수 없을 때 표시되는 ‘다른 방법 · 화면 공유로 캡처’를 지원한다. 화면 공유는 명시 연결/재연결, 별도 ROI, PNG 캡처를 지원하며 native 캡처와 독립적이다. 연결이 끝나도 이미 받은 대기 프레임을 임의 폐기하지 않는다.
- native 프레임은 context/generation과 capture ID로 중복·stale 주입을 막고 ACK한다. 브라우저 freeze/resume, 물교/창고 전환, 명시 중지를 지원한다.

## 물교 인식과 회차

- 검증된 전체 필드 정답 특징이 일치하면 OCR을 생략하고, 나머지는 로컬 Korean PP-OCRv5 mobile ONNX CPU 모델과 현재 deterministic 보정 규칙을 사용한다. runtime availability/integrity를 확인하며 모델·threshold·매핑·검수 기준은 cleanup이나 성능 작업으로 바꾸지 않는다.
- 섬, 요구 품목, 요구 수량, 결과 품목, 남은 횟수, 결과 수량의 원문·보정값·confidence·검수 사유·이미지 출처를 유지한다. 검수되지 않은 candidate를 독립 정답으로 승격하지 않는다.
- 미사용 처리는 확인된 획득품을 기준으로 한다. 대양 위치만으로 까마귀주화를 제외하지 않는다. 정상 보정된 행은 전체 목록에서 접근 가능하다. 문제가 있는 필드는 원본 crop 옆에서 수정하고, 미등록 묶음은 포함/제외를 명시 선택한다. 숫자 unknown과 실제 0은 구별한다. 자동 회차 적용은 없다.
- 성공한 인식은 스크린샷 대기열을 비우고 검수에 필요한 출처를 유지한다. 실패/빈 응답은 입력을 보존한다. 현재 회차 새로 적용/추가는 저장 성공 후 모달을 닫는다. 저장 실패 시 수정 내용과 재시도 가능 상태를 유지한다.
- JSON 수동 입력은 별도 호환 경로다. 잘못된 JSON/검증 실패가 기존 회차를 먼저 지우면 안 된다. 중복·충돌·모호한 이름은 기존 importer 의미대로 처리한다.
- 사용/제외/삭제/복원, 수량·횟수 편집, 검색·표시 필터, 남은 교섭력, 새 회차/추가, 작업 회차 저장과 재시작 복원을 유지한다.

## 재고·스케줄·지도

- 재고 70종, 단계별 14종의 현재 재고·목표·표시 순서가 SQLite에 저장된다. stock null은 미확인이고 0은 확인된 0이다. 단계/품목/부족 필터는 재렌더 후에도 유지한다.
- 창고 판독 대상은 1–4단이며 5단은 차감/갱신하지 않는다. 정상 MATCH와 확인 필요 슬롯을 구분하고, 검수 PATCH 미리보기·취소·명시 단일 적용을 제공한다. 확인한 수정/일치 여부와 원본 판독값은 별도로 기록한다.
- scheduler/routing/완료 계산의 authority는 현재 `frontend/js/domain/` 구현과 frozen `import-expected.json`/`scheduler-expected.json`, 정책 회귀다. ranking, supplier feasibility, 중복 섬/대표명, T5 no-split, T7 target stock, 무게·교섭력·출항 인과 순서를 유지한다.
- 완료는 서버 저장 후 재고/교섭력/session에 반영한다. 중복 클릭·응답 유실 재시도·409 충돌에서 한 번만 차감하며, 해결되지 않은 완료 저장은 후속 변경을 막는다.
- saved schedule 1–5 슬롯과 ship/parley/tuning/navigation/map/viewer 설정을 유지한다. 타이머는 저장된 재고 계산과 구분하고 재시작에 따른 현재 동작을 회귀로 검증한다.
- 지도 좌표·경로·거리·시간 보정, 경유지, free route, 메모, 슬롯과 패널 저장을 유지한다. 축소 시 라벨을 우선순위와 충돌에 따라 숨기고 hover/focus로 표시하는 것은 시각 계층이며 계산 결과를 바꾸지 않는다.

## 저장·개선 데이터

- Main DB는 `%LOCALAPPDATA%\BDOBarter\data\bdo.sqlite3`, schema 4다. inventory/settings/working_session/saved_schedule_slot/app_meta/mutation_receipt는 운영 상태다. 기존 값과 CAS/idempotency 의미를 유지한다.
- `trade_correction`, `warehouse_scan`, `warehouse_feedback`는 개선용 history다. 현재 인식은 이 테이블을 학습 없이 자동 읽어 결과를 바꾸지 않는다. 현재 정답 사전·창고 보정 표본은 `barter/recognition_data/`에서 명시적으로 버전 관리한다. 창고 calibrated template는 별도 검증된 NPZ이며 package에 포함된다.
- 개선 history 초기화는 명시 사용자 요청, 외부 백업·행 수/해시·ZIP 검증 이후에만 한다. schema, 운영 상태, native ROI 프로필을 유지한다. 평소 테스트는 실제 사용자 DB를 수정하지 않는다.
- legacy feedback payload의 읽기/검증은 현재 호환 계약에 필요한 경우 유지한다. 과거 stage/spec라는 이유만으로 유효한 데이터 호환을 없애지 않는다.

## 검증과 변경 범위

자동 기능 회귀, known fixture replay, 실제 BDO pixels/F10, 사용자 실사용 승인을 구분한다. fixture 정확도 지표를 현재 게임 정확도나 independent 평가로 표현하지 않는다. native/브라우저/mock 성공도 실제 BDO 성공으로 바꾸지 않는다.

회귀 및 package 기준과 실제 명령은 [TESTING.md](TESTING.md)에 있다. 개선은 실사에서 발견한 좁은 문제→현재 회귀→별도 커밋 순서로 진행한다. 승인 UI를 재설계하거나 계산·OCR 의미를 자의적으로 확장하지 않는다.

## 저장소 구조

실행·개발 기준은 저장소 루트다. `local_app/`는 공통 실행기·서버·native·통합 메인·검증·패키징, `barter/`는 물교, `alchemy/`는 연금이다. `reference/`, `tools/`, `docs/`는 기준 자료·창고 도구·문서를 보관한다. 설치 앱·실제 AppData는 Git 구조와 별개다. 과거 실험 계약은 `docs/archive/`에 보존한다. 물교 ML·숫자 단위 조합은 현재 제품에 적용하지 않았다.


## 2026-10-24 연금 수율 보완

가변 산출 계획은 완료 작업의 누적 실제 산출량/실제 수행 횟수를 기본으로 사용한다. 취소와 진행 중 작업을 제외하고 정정된 작업은 최신 결과 한 번만 집계한다. 제작식·실제 투입 재료별로 분리하며 고정 제작식의 공식 산출량은 변경하지 않는다. 수동 수율은 명시적 목표 설정일 때만 우선한다. 기록이 없으면 산출 가정을 표시하며 실제 재고에는 실제 완료 입력만 반영한다. 부족한 중간재와 직접 제작 진입점을 상세 화면 앞부분에 제공한다. 기존 DB 스키마·재고·목표·기록과 이전 아이콘 URL의 호환을 유지한다.
