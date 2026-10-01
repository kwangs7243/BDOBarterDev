# 현재 승인 기준

## 개발 회귀

현재 backend suite와 review/DTO/staging/evaluation domain 및 browser 회귀가 통과해야 한다. 캡처·전용 검수 창·evidence save/retry·NEW durable commit/readback/reload를 임시 DB로 확인한다. 실제 DB와 sidecar를 테스트에 사용하지 않는다.

`local_app/tests/fixtures/recognition-v2/manifest.json`은 known replay 데이터다. 16개 과거 trade capture와 80 oracle row의 매핑은 UNRESOLVED/UNVERIFIED이며 정답으로 자동 승격하지 않는다. Warehouse 2 fixture는 지정된 105 item/quantity truth만 평가한다. 테스트 정답/원본 image bytes를 현재 결과에 맞추어 바꾸지 않는다. split/group/source hash를 보존한다.

## R011 live

새 BDO source → 실제 로컬 recognition → 전 행 six-field human review → immutable observation/export → R008 DTO → R009 NEW session → durable readback/reload → R010 independent metric을 실제 evidence로 검증한다. 원문/후보를 볼 수 있다는 owner 확인만으로 최종 usability PASS를 선언하지 않는다.

F/V/R/T 분모, pre-review correctness, six-field exact, user edit rate, 수정 행/필드, correction recovery/harm, unhighlighted error, Master disagreement, numeric review, unknown, explicit exclusion, final DTO success를 기록한다. 나쁜 결과를 버리거나 같은 화면을 튜닝 후 independent PASS로 재사용하지 않는다. ownerUsabilityDecision은 명시 승인 전 null이다.

## R012 release

source package recipe의 모든 path가 존재해야 한다. 별도로 clean-machine 설치, Python/ONNX ABI, 전용 OCR worker의 frozen import/model, 실제 앱 재시작과 기존 데이터 보존, rollback을 검증한다. 현재 model/별도 OCR env는 ignored 로컬 자산이다. source 회귀와 recipe dry-run만으로 배포 실행파일 검증을 주장하지 않는다.

## 보호 경계

Master authority 변경, 자동수락, DB migration, 자동 스크롤은 별도 task다. debug evidence budget 200 MiB/미검수 30일 정책은 명시 cleanup 실행 시 적용하고, 검증 crop·실사 자료·실사용 DB를 임의 정리하지 않는다.
