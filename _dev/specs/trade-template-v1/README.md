# TRADE-TEMPLATE-V1 · 구현 인계 문서

작성일: 2026-10-16 (Asia/Seoul). 상태: **설계·오프라인 구현·비교 완료 / 표본 부족으로 개선 판정 보류 / 현재 앱 적용 미승인**.

목표는 현재 물교 인식 정확도와 검수 흐름을 유지하면서, 확인된 기준 이미지로 해결할 수 있는 필드의 OCR 실행을 생략하는 것이다. 구현자는 아래 결정과 계약을 그대로 구현하고 독립 실험 결과를 제출한다. 배포 여부는 결과를 본 사용자가 결정한다.

## 읽는 순서

1. [00-DECISIONS.md](00-DECISIONS.md): 변경 범위와 이미 결정한 설계.
2. [01-DATA-AND-TRUTH.md](01-DATA-AND-TRUTH.md): 자료 추출, 정답 자격, 중복·충돌·분할.
3. [02-MATCHER.md](02-MATCHER.md): 정답 이미지 생성과 판독 알고리즘.
4. [03-ENGINE.md](03-ENGINE.md): 기존 OCR 연결 지점, 결과 계약, 변형 버전.
5. [04-VALIDATION.md](04-VALIDATION.md): 실행 비교, 오류 지표, 판정 규칙.
6. [05-IMPLEMENTATION-HANDOFF.md](05-IMPLEMENTATION-HANDOFF.md): 단계별 산출물·명령·최종 보고.
7. [experiment-config.json](experiment-config.json), [BASELINE-MANIFEST.json](BASELINE-MANIFEST.json), [report.schema.json](report.schema.json): 실행 설정·고정 입력·보고서 계약.

현재 제품의 권한은 여전히 [CURRENT-PRODUCT-CONTRACT.md](../../CURRENT-PRODUCT-CONTRACT.md), [TESTING.md](../../TESTING.md)에 있다. 이 문서는 별도 실험의 권한이며, 현재 제품 계약이 개정됐다는 뜻이 아니다.

## 고정된 실험 순서

| 단계 | 구현할 것 | 끝났다고 판단할 근거 |
|---|---|---|
| S0 | preflight와 고정 baseline 로더 | hash 일치, 기존 미커밋 변경 보존, 앱에 대한 쓰기 0 |
| S1 | 자료 inventory·정답 추출·분할 | 출처별 수·제외 사유·충돌·truth coverage 보고 |
| S2 | 기준 이미지 bank와 matcher | EXACT 동작, 불확실 시 ABSTAIN, 음성 사례 시험 |
| S3 | V1: 2/3 결과 수량 | shadow 비교와 독립 FAST 실행, fallback 동일성 |
| S4 | V2: V1 + 파도의 블랙스톤 수량 | 관측·검증된 수량만 EXACT로 처리 |
| S5 | V3: V2 + 품목·섬 이름 | 검증된 전체 이름만 EXACT, 육지품은 OCR 유지 |
| S6 | 품질·속도 비교와 사용자 보고 | 판정·한계·실행 근거와 확인 가능한 이미지 |

단계의 구현을 끝냈다는 것과 그 단계의 개선이 합격했다는 것은 다르다. 자료 부족이면 기능은 fallback으로 완성하고 `HOLD_DATA`를 보고한다. 검수 기준을 풀거나 정답을 생성해 합격시키지 않는다. 단계 실패가 다른 안전한 단계의 자료 수집·검증을 막지는 않는다.

## 이번 인계의 중요한 경계

- 현재 설치 앱, 18765 서버, 실제 AppData DB·ROI, 재고·회차·배차 계산은 변경하지 않는다.
- 배포·설치 파일 교체·서버 재시작·실게임 캡처·F10·자동 스크롤을 하지 않는다.
- 새 구현 위치는 `_dev/local_app/experiments/trade_template_v1/`, 새 시험은 `_dev/local_app/tests/experiments/trade_template_v1/`뿐이다. 기존 제품 파일에 import·flag·hook를 추가하지 않는다.
- 이미지·DB·모델·bank·결과는 Git 밖의 `runRoot`에 둔다. 이 문서 작성 시점의 모델·인식 소스 사본은 `preparationRoot`에 고정했다.
- HEAD만 checkout해서 baseline으로 쓰면 안 된다. 현재 baseline에는 **기존 미커밋 제품 변경 12개**가 들어 있다. 정확한 hash는 manifest에 있다.
- commit/push/새 채팅 생성/다른 채팅에 메시지 전송은 이번 구현 인계만으로 승인되지 않는다.
- 모델 학습, GPU 전환, 회차 간 runtime cache, 창고 엔진 변경은 범위 밖이다.

## 실행 위치와 자료

`BASELINE-MANIFEST.json.roots`의 규칙으로 로컬 경로를 해석한다. `artifactRoot`는 `USERPROFILE` 아래의 기존 자료 폴더, `preparationRoot`는 그 아래 `trade-template-v1-preparation`, 산출물 `runRoot`는 `trade-template-v1-runs`다. 사용자 이름이 들어간 절대 경로와 게임 이미지·라벨은 저장소에 추가하지 않는다.

모든 새 실행은 `runRoot/<runId>/`를 사용한다. 이 문서에는 아직 구현되지 않은 CLI 명령을 적었다. 명령 예시를 이미 실행된 검증 결과로 인용하지 않는다.

인계 시작 프롬프트는 [05-IMPLEMENTATION-HANDOFF.md](05-IMPLEMENTATION-HANDOFF.md)의 마지막 절을 그대로 사용한다.
