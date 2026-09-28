# Migration / Rollback

## State boundaries

main DB schema 3과 70개 inventory, settings, working_session, saved_schedule_slot, mutation_receipt, 기존 warehouse evidence를 유지한다. 신규 recognition sidecar schema 1은 별도 파일이며 main DB를 migration하지 않는다. 기존 export의 오래된 feedback 형식도 유지한다.

capture stream, batch, 열린 dialog, timers, raw 임시 입력은 UI/runtime state다. sidecar는 profile/flags/policy scope/불변 prediction/verified labels/pending intents를 담고 main DB는 기존 stock/session/slot을 담는다. sidecar에 schedule history를 넣지 않는다.

## Deployment sequence

1. 현재 app/main DB의 hash와 semantic snapshot, schema 3, 기존 변경을 확인한다. 검증은 copy DB, 격리 LOCALAPPDATA, staging package에서 한다.
2. 기존 scanner/PNG/JSON regression과 보호 본문의 equivalence를 확인한다.
3. 새 package는 recognitionV2=false/auto=false로 시작하고 sidecar만 생성한다. 초기화는 멱등적이며 Early Evidence Store/budget도 함께 준비한다.
4. capture 실사 후 shadow를 켠다. unknown profile은 auto를 허용하지 않는다.
5. U0~U3를 통과한 usableReviewApproved 정책으로 HIGH 상세 생략·예외 확인·사용자 전체 patch 적용을 제공한다. auto는 OFF이고 이 usable 배포는 T009/G5 완료를 기다리지 않는다.
6. 후속 G0~G5를 통과한 별도 releaseApproved 정책만 사용자 설정으로 auto를 켠다. 승인된 policy 밖의 입력을 허용하지 않는다. 배포 후 7 wrong MATCH 재현 세트와 새 holdout을 다시 검증한다.

이는 후속 구현/릴리스 절차이며 이번 작업에서는 main DB, flags, app을 변경하지 않았다.

## Immediate fallback

recognitionV2/auto를 끄면 새로운 V2 apply가 중단된다. 기존 PNG upload/manual PATCH와 external GPT→JSON import는 계속 사용할 수 있다. active browser tracks를 해제하고 draft 보류/폐기 선택을 제공한다. 진행 중 저장은 기존 shutdown drain/receipt로 결과를 확인하며 저장 성공이 취소됐다고 표시하지 않는다.

파일 rollback은 같은 schema 3을 읽을 수 있는 현행 package로 돌아간다. schema 1/2 전용 구형 exe로 main DB를 열지 않는다. sidecar를 모르는 이전 package는 sidecar를 무시한다. main DB를 과거 snapshot으로 되돌리는 것은 범위 밖이며 이후의 정상 변경을 지울 수 있으므로 자동 실행하지 않는다.

## Incorrect auto-apply response

해당 scope의 auto를 끄고 run/policy/profile/label/hash와 mutation receipt를 보존한다. 현재 stock과 이후 mutation을 다시 읽는다. stock이 스캔 직전과 다르다는 이유로 자동 undo하지 않는다. endpoint는 stock 절대값 갱신이며 이후 completion/manual update가 있을 수 있다. 정정은 대상 품목을 명시한 정상 review의 새 mutation으로 수행한다. 다른 policy로 같은 capture를 조용히 재적용하지 않는다.

## Failure/reconciliation tests

main 성공→sidecar 실패, sidecar 성공→main 409, HTTP 응답 유실, receipt 만료, 동일 run 동시 요청, 다른 mutationId로 동일 run 요청, config/profile 변경, pending completion, 앱 종료, label만 저장 성공, NULL/0/target/slots 보존을 copy/mock에서 검증한다. 읽기 전용 export는 BEGIN snapshot을 사용한다. 운영 DB에서 부하/파괴/경합 테스트를 하지 않는다.

## Feature resource rollback

model/profile/policy artifact는 hash와 version을 갱신해 함께 배포한다. policyHash가 다르면 새 HIGH 숨김/auto authority를 부여하지 않으며(VALID 입력은 REVIEW, 구조 실패는 CAPTURE_INVALID) 이전 파일의 경로명만 재사용하지 않는다. 기존 reference/quantity_templates는 baseline hash를 보존하므로 V1이 독립적으로 동작한다. cache/artifact budget 부족은 새로운 artifact 저장을 중단하는 이유이며 main DB/release 데이터를 삭제하는 이유가 아니다.

## Milestone fallback / invalid input

CAPTURE_INVALID에는 적용 버튼/수십 REVIEW rows를 만들지 않고 정상 화면 재캡처를 한 번 안내한다. 5단 존재는 정상 SKIP이며 invalid 원인이 아니다. audit에서 wrong HIGH가 확인되면 해당 scope의 usable HIGH 생략과 auto 권한을 모두 중단하고 예외 전수 표시 또는 V1 review로 fallback한다. HIGH 감사 빈도 변경은 sidecar 정책 version/초기 자료로 승인하고 main schema는 유지한다. 필수 evidence 누락은 evidenceIncomplete로 같은 fallback을 제공한다. 예외 수정 label과 main 수동 적용의 성공/실패는 분리한다.
