# 05 · 구현 순서와 인계 프롬프트

## S0 · 경로·baseline·보호 확인

새 experiment/test 디렉터리와 CLI preflight부터 구현한다. manifest roots 해석, 입력 path containment, 모든 source/model hash, frozen catalog, Python 환경·의존성, 출력 경로를 검증한다. 현재 작업 트리와 설치본의 baseline drift를 읽기 전용으로 기록한다. drift가 있어도 frozen 실험은 할 수 있지만 현재 제품에 대한 추천은 HOLD_BASELINE_DRIFT로 표시한다.

working-tree 비교는 manifest.snapshotFiles의 해당 repoPath만 대상으로 하고, 새 spec/experiments 파일은 drift에 포함하지 않는다. 설치본은 installedReadOnlyChecks만 읽는다. roots의 baseEnvironment/relativeTo/absoluteDefault를 명시적으로 처리하며, read-only root를 출력 root로 재지정하지 못하게 한다.

허용 쓰기는 두 새 코드 디렉터리와 runRoot 아래뿐이다. preparationRoot·source archive·설치 D:\BDOBarterDev·실제 AppData·다른 worktree에는 쓰지 않는다. recursive 삭제, git reset/stash/rebase/commit/push, live API 쓰기, localhost 서버 실행은 하지 않는다.

산출물: preflight.json, source-hashes.json. exit code 2=실행/입력 실패, 0=명령 정상 완료. 명령 정상 완료와 성능 합격은 별개다.

## S1 · 데이터

01에 따라 inventory, captures, truth, quarantine, split을 구현한다. fixture 정답·DB metadata·사용자 수정 entry를 임의 보정하지 않는다. 자료 부족은 라벨을 발명하지 않고 수치로 보고한다.

산출물: data/ 파일 전체와 data-summary.md. synthetic unit test로 중복 병합·필드 truth·충돌 격리·분할 고정·잘못된 row 매핑을 확인한다. 원본 이미지의 시각 판독을 하위 모델의 추가 과제로 삼지 않는다.

## S2 · bank와 matcher

02에 따라 먼저 EXACT를 구현한다. 그 뒤 V1의 고정 calibration 조건을 만족할 때만 glyph 비교를 켠다. 은근히 threshold를 완화하거나 새 renderer·font·CNN 학습을 추가하지 않는다.

산출물: bank/bank.json, references, calibration.json, bank-summary.md, matcher 단위 시험. bank에 원본 truthId를 역추적할 수 있어야 한다.

## S3/S4/S5 · 변형 엔진

03의 순서로 B0/V1/V2/V3를 구현한다. fallback 전용 실행 결과를 먼저 B0와 비교한다. 불일치는 다음 variant로 진행하기 전에 수정한다. 현재 제품의 OCR 함수를 직접 수정해 hook를 만들지 않는다.

variant별 SHADOW와 FAST 결과·trace를 저장한다. 해당 bank가 비어도 fallback과 NOT_COVERED를 구현해 단계를 마친다. 현재 legacy helper·frontend domain에 실험 import를 추가하지 않는다.

## S6 · 비교·보고

04의 품질 비교, 대표6장 screening, 선택된 최종 후보의 전체 FAST와 paired benchmark를 순서대로 실행한다. 부하가 높으면 정해진 BENCH_CONTENDED로 마치고 속도를 부풀리지 않는다. 전체 자동 회귀를 습관적으로 돌리지 않는다.

필수 기존 경계 회귀:

```powershell
# cwd: repository/_dev
$backendPython='D:/BDOBarterDev/_dev/recognition-local/r006-env-recovery/venv314/Scripts/python.exe'
$env:PYTHONDONTWRITEBYTECODE='1'
& $backendPython -B -m pytest -q -p no:cacheprovider local_app/tests/backend/test_trade_live_list.py local_app/tests/backend/test_recognition_contracts.py
& 'C:/Program Files/nodejs/node.exe' local_app/tests/trade_live_rules.mjs
& 'C:/Program Files/nodejs/node.exe' local_app/tests/trade_import_regression.mjs
& 'C:/Program Files/nodejs/node.exe' local_app/tests/trade_recognition_client.mjs
```

위 명령은 existing product 경계 검사용이다. 앱을 시작하는 browser test·package smoke·실게임 test는 이 단계에서 실행하지 않는다. 새 코드의 unittest도 별도로 실행한다. 테스트 fixture/기대값은 수정하지 않는다.

## CLI 계약과 실행 예시

아래 CLI는 이 스펙으로 **새로 구현할 인터페이스**다. 문서 작성 시점에 이미 존재하거나 실행 완료된 것으로 취급하지 않는다.

모든 subcommand에 `--spec-dir`, `--run-id`를 받는다. spec-dir의 config/manifest만 authority다. 임의 threshold override·deploy·live-db 옵션은 만들지 않는다. 선택적인 root-map은 같은 hash의 입력 위치 이동만 허용하고 보호 경로 정책을 바꿀 수 없다.

subcommands: preflight, inventory, build-bank, shadow, fast-check, benchmark, report, run. shadow/fast-check는 `--variant B0|V1|V2|V3|ALL`을 받는다. benchmark는 04의 고정 선택 규칙을 사용한다. run은 S0→S6를 순차 실행하고 완료된 동일 stage를 hash 검증 후 재사용한다.

`--root-map`은 선택적인 JSON 파일이며 허용 key는 artifactRoot, installedAppReadOnly의 절대 경로 문자열뿐이다. preparationRoot/runRoot는 manifest의 상대 규칙으로만 파생한다. protected 설치/AppData 경로 아래로 출력이 향하면 거절한다. jsonschema 패키지가 없으면 설치하지 않고 report.py에서 이 스키마의 필수 필드·enum·타입·hash 형식을 검사하는 전용 validator를 구현한다.

```powershell
# cwd: repository/_dev. runId는 새 실행마다 새 값으로 정한다.
$ocrPython='D:/BDOBarterDev/_dev/recognition-local/envs/t010b1-ocr/Scripts/python.exe'
$env:PYTHONDONTWRITEBYTECODE='1'
& $ocrPython -B -m unittest discover -s local_app/tests/experiments/trade_template_v1 -p 'test_*.py'
& $ocrPython -B -m local_app.experiments.trade_template_v1.cli run --spec-dir specs/trade-template-v1 --run-id template-v1-run-001
```

run에서 품질 NO_GO가 나오면 그 variant의 추가 고비용 benchmark는 생략한다. 다른 안전한 variant의 구현·평가는 진행한다. source hash/입력 계약이 틀린 경우는 즉시 실패한다. 단계별 상태와 품질·성능 상태를 구분한다.

## 필수 최종 산출물

1. `report.json`: report.schema.json 계약 충족, 모든 수치와 입력/engine/bank hashes.
2. `REPORT.md`: 한국어 사용자 보고. 후보별 이득·회귀·자료 부족·미실행·추천을 한 표로 제시.
3. `review.html`: 외부 JS/CDN/서버 없는 정적 비교 화면. 오류/검수 변경을 먼저, 그 뒤 HIT 예시를 보여 준다. 원본 crop·B0·candidate·truthClass·reference source를 함께 표시한다. image는 run 상대 경로를 사용한다.
4. 원본 응답·sidecar·benchmark 각 arm 로그·파일 hash index.

report.json의 artifactFiles는 runRoot 내부 파일만 가리킨다. REPORT.md에는 모든 corpus를 새 실사로 표현하지 않는다. 실제 앱/DB 변경, commit/push가 없었음을 기록한다. 실험 CLI만 있고 앱 버전업이 끝났다고 보고하지 않는다.

HTML에는 모든 OCR·이름 문자열을 escape해서 넣고, 외부 URL이나 경로 traversal을 image source로 허용하지 않는다. report.json 파일 자기 자신의 hash는 artifactFiles에 넣지 않는다(자기참조 방지).

## 구현자가 판단하지 않아도 되는 사항

| 상황 | 이미 정한 처리 |
|---|---|
| 확인된 표본 부족 | EXACT 가능한 부분만 구현, 나머지 ABSTAIN/HOLD_DATA |
| 근사 비교 calibration 부족/실패 | 근사 비교 disabled, EXACT 유지 |
| TEST에서 오답 자동 통과 증가 | NO_GO_QUALITY. TEST로 재튜닝 금지 |
| baseline과 다르지만 truth 없음 | HOLD_DATA, 원본과 차이를 보고 |
| 속도 이득 미미 | HOLD_PERFORMANCE. 목표 수치를 낮추지 않음 |
| CPU 부하 변동 | BENCH_CONTENDED. 같은 작업에서 자동 반복 금지 |
| 현재 앱/working tree가 변경됨 | frozen으로 실험 지속 가능, 현재 제품 추천은 HOLD_BASELINE_DRIFT |
| package/app 적용 | 구현하지 않고 사용자 판단을 기다림 |

## 하위 구현 모델에 전달할 프롬프트

> `_dev/specs/trade-template-v1/README.md`와 연결된 스펙·config·manifest·report schema 전체를 읽고 TRADE-TEMPLATE-V1의 S0~S6를 구현·검증해 주세요. 설계와 판정은 문서대로 따르고 현재 제품 파일·실제 설치 앱·사용자 DB·ROI·스케줄 계산은 변경하지 마세요. 기존 미커밋 12개 파일은 frozen baseline의 일부이므로 보존하세요. 새 코드는 지정한 experiments/tests 경로, 모든 데이터·결과는 외부 runRoot에만 저장하세요. 정답·threshold·분할·기대값을 임의 변경하지 마세요. 자료 부족은 HOLD_DATA, 부하로 불확실한 시간은 BENCH_CONTENDED로 정확히 보고하세요. 최종 산출물은 한국어 REPORT.md, report.json, 원본을 확인할 수 있는 review.html과 검증 로그입니다. commit/push/서버 재시작/실제 앱 적용은 하지 마세요. 결과를 본 사용자가 적용 여부를 결정합니다.
