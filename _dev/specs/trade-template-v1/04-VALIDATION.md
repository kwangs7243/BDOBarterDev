# 04 · 검증과 판정

## 1. 필수 시험

새 실험 시험은 기존 OCR Python 3.12의 표준 unittest를 사용한다. 기존 backend 시험은 TESTING.md의 Python 3.14를 사용한다. 새 의존성을 설치하지 않는다.

| 사례 | 필수 결과 |
|---|---|
| 같은 label·RGB·context | EXACT HIT |
| 같은 crop, 서로 다른 확인 label | quarantine, HIT 없음 |
| label 2만 등록한 근사 비교 | disabled/ABSTAIN. EXACT 2는 가능 |
| bank/model/catalog/config hash 오류 | bank 무효→B0, baseline/model 오류는 preflight FAIL |
| native 아님, 크기 변경, rescaled, anchor 불명 | ABSTAIN→원래 OCR |
| 행 부족 의심, crop 잘림, 이미지 밖 padding | ABSTAIN, 원본 행·입력 유지 |
| 2/3, 12/23/32, 앞자리 1, 잘린 3 | 틀린 2/3 HIT 0 |
| 블랙스톤 미등록 수량, 12/129/1229/0 | 다른 label로 맞추지 않고 ABSTAIN |
| icon의 흰 그림, 커서, 선택 glow, 추가 글자 | 올바른 HIT 또는 ABSTAIN, 틀린 HIT 0 |
| 섬 이름 prefix 중복, 말줄임, 미등록 품목 | 강제 마스터 매칭 없음 |
| dx/dy ±1,±2,±4와 경계 자름 | 올바른 HIT 또는 ABSTAIN |
| matcher 예외·bank 파일 누락 | fallback, unknown·검수를 성공으로 변경하지 않음 |
| count=0, numeric None, 고정 TRADE_RULE | 원래 의미 유지 |
| fallback field 전체·source membership·progress | baseline과 동일 |
| 육지 fromItem 재판독·import conflict/duplicate | frozen frontend 동작과 동일 |
| 기존 129→1229 후보 사례 | baseline의 확인 필요 유지, 기대값 변경 금지 |

파생·합성 사례는 원본 group을 상속하고 실사와 분리한다. 숫자를 추가한 합성 이미지의 label은 생성 규칙에서 정하되 실이미지 정답 수와 섞지 않는다.

## 2. corpus와 품질 지표

필수 corpus는 legacy16장/80행, native77장, 최근15장, S1의 지원 크기 USER_CORRECTION/USER_CONFIRMED_FIELD 전부다. unsupported는 frame/sourceType별 hash 최소 1장을 fallback 회귀에 넣는다.

B0를 pin한 후 모든 variant의 SHADOW를 평가한다. FAST는 대표6장과 SHADOW의 HIT/충돌/불명 context별 hash 최소 1장을 실행해 실제 경로를 확인한다. 최종 후보만 나머지 전체 FAST를 실행한다. baseline 응답 재사용은 03의 조건을 지킨다.

같은 문맥에서는 SHADOW와 FAST 제안이 일치해야 한다. V3 이름 변경으로 후속 문맥이 달라진 경우는 03의 context_changed trace와 최종 truth로 검증한다.

지표는 다음 의미를 고정한다.

- verified_field_accuracy: truth가 있는 필드만의 정확도.
- verifiedWrongAutoAccept: truth와 다른 값을 reviewRequired=false로 반환한 수.
- newVerifiedWrongAutoAccept: B0에는 없고 candidate에 생긴 위 오류.
- review_required_wrong_candidate: 값은 틀렸지만 검수로 차단된 수.
- baseline_parity: truth가 없는 필드의 corrected/reviewRequired 일치. 정확도가 아니다.
- unverifiedReviewRelaxations: truth 없이 B0 true→candidate false가 된 수.
- row_missing/row_extra: oracle 등 독립 기대 행 수가 있을 때만 계산, 없으면 null.
- raw_source_membership_lost: 원본 capture/row 출처를 잃은 수.

HIT의 rawOCR/confidence/valueSource 차이는 의도된 provenance 차이로 별도 보고한다. fallback은 field dict 전체로 비교한다. 전체 자료에 truth가 없으면 wrongAutoAcceptAllFields=null이고, 확인된 부분의 count만 따로 제시한다.

기존 fixture에는 yield 후보 오독 1건이 남아 있다. B0 yield=79/80을 80/80으로 꾸미려고 oracle·기대값을 바꾸지 않는다. 이름 정규화는 01에 명시한 규칙만 사용한다.

## 3. 품질 판정

다음 중 하나면 NO_GO_QUALITY다.

1. newVerifiedWrongAutoAccept>0.
2. B0에서 맞았던 확인 필드가 틀리거나 검수 요청이 새로 늘어남.
3. 원본 행·출처 membership·unsupported/fallback 동작이 깨짐.
4. truth 무단 추가, TEST를 bank/튜닝에 사용, 모델·규칙·기대값 변경.

다음은 HOLD_DATA다.

아래 표본 수 기준은 B0가 아니라 candidate에서 활성화된 kind에 적용한다. truth 없는 필드가 B0와 같은 경우는 parity 자료로 남기되 확인된 HIT 수에 더하지 않는다. config.quality의 unverifiedChangedFields와 unverifiedReviewRelaxations 허용값은 모두 0이다.

- truth 없는 HIT에서 corrected/reviewRequired가 B0와 달라 안전성을 판단할 수 없음.
- TEST의 확인된 HIT가 kind별 20필드 미만 또는 source group 2개 미만. 23은 label2/3 각각 5필드 이상도 필요.
- 블랙스톤의 확인된 HIT 값이 2종 미만.
- V3의 island/fromItem/toItem은 HIT가 있는 kind별로 평가한다. bank가 빈 kind는 NOT_COVERED로 표시하고 전체 마스터 대응으로 보고하지 않는다.

HOLD_DATA에서도 안전한 구현·계산량·속도 연구 비교는 할 수 있다. 0/0을 오류 0%로 쓰지 않는다. 확인된 표본에서 오류가 없다는 사실을 미래 오답률 0으로 일반화하지 않는다.

## 4. 성능 환경

B0/candidate는 동일 입력·순서·frozen source/model, ONNX 1thread, OpenCV 1thread를 사용한다. GPU·회차 간 runtime cache는 쓰지 않는다. bank 로드·hash 검증을 포함하고 각 arm에서 reader cache를 비운다.

기존 앱에 OCR 요청을 보내거나 실게임 캡처·F10·서버 재시작을 하지 않는다. 다른 무거운 시험과 동시에 돌리지 않는다.

Win32 GetCurrentProcess.restype=c_void_p, SetPriorityClass.argtypes=[c_void_p,c_ulong], GetPriorityClass도 명시한다. 반환값과 실제 class=64(IDLE)를 검사한다. 실패하면 BENCH_ENV_INVALID로 보고한다.

각 arm은 새 자식 Python으로 실행하고 LOCALAPPDATA는 해당 run의 sandbox로 설정한다. import·초기화를 포함한 process wall, recognize 함수 wall, process CPU를 분리한다. B0/candidate의 계측 부담을 동일하게 한다.

## 5. screening과 전체 비교

최근15장 index의 0-based [0,3,6,8,11,14] 6장을 B0,V1,V2,V3 각각 한 번 순차 실행한다. 이 TEST 자료를 보고 matcher parameter를 바꾸지 않는다.

NO_GO가 아니고 HIT>0이며 모델 호출이 줄어든 variant 중, **modelCalls 감소 수 최대 → lookup 시간 최소 → 작은 variant 번호** 순서로 최종 C를 고른다. 이 선택은 실험 대상 선택이며 사용자 승인이 아니다.

최근15장 전체에서 paired blocks [B0,C], [C,B0], [B0,C]를 순차 실행한다. arm 사이 reader/cache를 공유하지 않는다. 모든 variant가 fallback이면 full 측정 없이 NO_OP를 보고한다.

CPU 이용률을 1초 간격으로 기록한다. CPU 중앙값>85%, arm군 CPU 중앙값 차이>15포인트, 같은 arm 시간 CV>0.15 중 하나면 BENCH_CONTENDED다. 확정 개선율로 쓰지 않고 같은 작업 중 자동 반복하지 않는다. 계산량·품질 결과는 별도 보고한다. idle과 게임 부하 측정을 한 묶음으로 합치지 않는다.

성능 arm 시작 전 5초 동안 CPU를 먼저 표집한다. 중앙값>85%면 benchmark를 실행하지 않고 BENCH_CONTENDED로 마친다. 기능 검증까지 성공한 것으로 표시하지 않는다. CPU 표집은 typed Win32 GetSystemTimes의 `1 - deltaIdle/(deltaKernel+deltaUser)`를 사용한다(kernel에 idle 포함). GetProcessTimes나 Python process_time을 시스템 CPU 부하로 대신 쓰지 않는다. 각 자식 arm timeout은 300초, timeout 후 자기 자식만 종료하고 EXECUTION_FAILED로 보고한다.

필수 성능 항목:

```text
processWallSeconds, recognitionWallSeconds, processCpuSeconds,
modelInitSeconds, modelCalls, modelSeconds,
templateLookupSeconds, templateHits, templateAbstentions,
fallbackFieldCalls, peakWorkingSetBytes, cpuLoadSamples,
priorityClassObserved, bankReferencesLoaded,
input/source/model/bank/config hashes
```

median gain은 `1-median(candidate process wall)/median(B0 process wall)`이다. 추천 기준은 **중앙값 10% 이상 단축 + modelCalls 10% 이상 감소**다. 미달이면 HOLD_PERFORMANCE. 가장 빠른 1회나 특정 필드의 절감만으로 전체를 합격시키지 않는다.

## 6. 최종 상태

우선순위는 EXECUTION_FAILED > NO_GO_QUALITY > HOLD_BASELINE_DRIFT > HOLD_DATA > BENCH_CONTENDED > HOLD_PERFORMANCE > OFFLINE_REVIEW_READY다. 모든 variant의 HIT가 0인 경우 performance=NO_OP이며, 자료 gate도 미달이면 overall=HOLD_DATA다. 설치본 또는 working tree의 고정 baseline 비교 대상이 변경됐거나 설치본 확인이 불가하면 HOLD_BASELINE_DRIFT로 표시하고 frozen 결과만 보고한다.

OFFLINE_REVIEW_READY는 안전·품질·자료·성능 gate를 통과해 사용자가 판단할 수 있는 상태다. 실게임 품질 PASS, package PASS, 앱 적용 승인과 구분한다. 실제 앱 변경 0·운영 DB 쓰기 0을 보고한다.
