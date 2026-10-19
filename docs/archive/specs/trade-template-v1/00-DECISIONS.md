# 00 · 설계 결정과 보호 범위

## D01 · 최적화 단위

기준 이미지는 `이전 회차 결과`가 아니라, 원본 이미지와 별도로 확인된 정답을 연결한 자료다. 서버를 재시작해도 읽을 수 있는 버전이 있는 bank로 만든다. 과거 재고·교환 횟수·회차·스케줄·사용자 수정 상태를 재사용하지 않는다.

v1에서 학습 모델을 새로 만들지 않는다. 현재 설치 환경의 NumPy/Pillow/OpenCV만 사용한다. 현재 한국어 ONNX 모델은 fallback으로 유지한다. 외부 AI/API·새 패키지·GPU 의존성을 추가하지 않는다.

## D02 · 변형 버전

| 이름 | 빠르게 처리할 필드 | 나머지 |
|---|---|---|
| B0 | 없음. 고정 v13 그대로 | 원래 동작 |
| V1 | 1→2단, 2→3단 교환의 `yield` 2/3 | v13 |
| V2 | V1 + 목적 품목이 정확히 `파도의 블랙스톤`인 `yield` | v13 |
| V3 | V2 + 확인된 `island/fromItem/toItem` 전체 이름 | v13 |

`count`, 육지품 `reqAmount`, 까마귀 주화 `yield`는 v1 전체에서 기존 OCR을 사용한다. 3→4단의 결과 2, 5/6/7단의 결과 1 등 기존 `TRADE_RULE`은 먼저 적용하고 matcher를 호출하지 않는다. 규칙으로 정해진 값을 template 성과에 포함하지 않는다.

블랙스톤이 게임에서 항상 특정 수량만 준다고 가정하지 않는다. 검증된 정수별 이미지가 있는 경우만 처리한다. 그 밖의 수량은 정상적인 OCR 대상이다.

V3에서도 마스터 0단 육지품은 빠른 경로에서 제외한다. 기존 마스터 1~7단과 `specialItems`, 현재 섬 목록만 이름 bank의 후보가 된다. 미지원·미등록 품목은 기존 검수 흐름을 유지한다.

## D03 · 지원 화면

자동 template 판독은 원본 native-screen, rescaled=false, frame 987×456에 한정한다. 외부 파일·985×444·987×458 등 과거 화면은 자료 audit와 fallback 회귀에 사용하고 자동 template 판독에는 넣지 않는다. 지원 크기를 구현자가 추가하지 않는다.

위치는 절대 화면 좌표가 아니라 현재 캡처 안의 두 경계선으로 확인한다. v13의 x anchor 6,271을 ±8px 안에서 찾고 두 이동량이 같으며 각각 support≥0.75일 때만 layout이 유효하다. `fixed_layout_offset()==0`만으로 유효하다고 판단하지 않는다. 실제 0 이동과 anchor 검출 실패를 구분하는 `LayoutProbe`가 필요하다.

행 검출은 frozen v13 `detect_live_rows` 그대로 사용한다. 부족한 행을 만들어 채우거나 6행으로 강제하지 않는다. 지원 native 프레임에서 검출 행이 6개 미만이면 `coverage_suspect` 진단을 기록하고 그 캡처의 template 판독을 끈다. 기존 OCR 결과 자체는 유지한다. 행 누락 문제를 해결했다고 보고하지 않는다.

## D04 · 정답과 증거

기준 이미지로 승격할 수 있는 것은 기존 사용자 정답 oracle, 실제 사용자 수정 entry, 해당 필드에 남은 `USER_REVIEW` 확인이다. `snapshot.phase=reviewed`, OCR confidence가 높음, 여러 번 같은 값이 나옴, 마스터에 그 이름이 존재함은 각각 정답 증거가 아니다.

자료 충돌·라벨 부족은 HOLD/ABSTAIN으로 끝낸다. 하위 모델이 이미지 숫자를 추측하거나 새로운 라벨을 만들어 넣지 않는다. 독립 정답이 없는 오답률은 null로 보고한다.

## D05 · 판독 강도

EXACT 전체 crop 비교가 기본이다. V1의 2/3만 독립 calibration이 충분한 경우 제한된 glyph 근사 비교를 추가할 수 있다. 그 선택은 고정된 grid 탐색으로 결정한다. 블랙스톤·이름의 근사 비교는 v1에서 구현하지 않는다.

EXACT도 crop만 똑같으면 무조건 적용하는 것이 아니다. source layout, 원본 row, 현재 문맥, bank version, 정답 충돌, 해당 단계의 자격을 모두 통과해야 한다. 부분 문자열이나 마지막 숫자만의 일치로 전체 수량을 정하지 않는다.

## D06 · fallback과 검수

matcher는 `HIT/ABSTAIN/ERROR`를 반환한다. ABSTAIN/ERROR는 frozen 함수로 돌린다. 템플릿 실패가 입력 삭제, 행 제외, 숫자 0/1 채우기 또는 검수 생략으로 이어져서는 안 된다.

새 판독은 OCR confidence를 만들지 않는다. `confidence=null`, `rawOCR=""`, `valueSource="VERIFIED_TEMPLATE"`와 별도 template evidence를 사용한다. 기존 OCR을 실행하지 않았는데 OCR 원문이나 투표 variant를 꾸며 쓰지 않는다.

필드의 검수가 줄어드는 변경은 숨기지 않는다. 독립 truth가 있고 새 값이 맞는 경우는 `truth_supported_review_resolution`, 독립 truth가 없는 경우는 `UNVERIFIED_REVIEW_RELAXATION`으로 분류한다. 후자는 자동 도입 추천을 막는다.

## D07 · 데이터와 운용

현재 살아 있는 사용자 DB를 실험 입력으로 사용하지 않는다. manifest로 고정한 백업을 SQLite `mode=ro`로만 읽는다. 현재 앱의 shutdown·recognition·correction·session API는 호출하지 않는다. 포트도 열지 않는다.

실험은 CPU 1 thread, OpenCV 1 thread, 순차 실행이다. IDLE 우선순위는 올바른 64-bit Win32 함수 선언 후 적용값까지 검증한다. 설정 실패 시 잘못된 우선순위로 측정을 계속하지 않고 `BENCH_ENV_INVALID`를 보고한다.

## D08 · 도입 권한

이 작업의 마지막 산출물은 사용자 판단용 보고서다. 실험의 GO도 실제 앱 설치·변경 승인이 아니다. 현재 앱 적용에는 별도 사용자 지시와 실제 패키지 검증이 필요하다. 기존 12개 제품 변경을 임의 commit·삭제·되돌리기 하지 않는다.

## 확인된 기준 사실

- baseline HEAD `0ad7c8fec637a4183c810916e62b75816e4eaded` + manifest의 미커밋 변경 12개.
- 현재 OCR 소스 SHA-256 `87cf2d1a9f6f24a8e2823506cb0a4fec25d01a9d085bc5ca18d8d3ad67d0dfab`, worker v13.
- 고정 소스 40파일, ONNX/YAML 사본 2파일을 외부 preparationRoot에 보관했다.
- 정리 전 DB: 1,393 history records / 468 capture IDs / 창고 15 scans. recent DB: 263 records / 서로 다른 이미지 hash 77개. 별도 PNG 77+15장은 내용 hash 기준 92개다. 이 수를 합쳐 서로 다른 전체 이미지 수라고 쓰지 않는다.
- 현재 마스터 명칭 213종, 고유 섬 이름 103종, 창고용 기준 icon 70종. 마스터 목록은 이미지 정답 bank의 완성 여부를 뜻하지 않는다.
- 이전 전체 저장본 비교의 122.9→96.0초는 단일 offline 재실행 결과다. 새 template 엔진의 실측 결과가 아니며 목표값·성공 기준으로 재사용하지 않는다.
