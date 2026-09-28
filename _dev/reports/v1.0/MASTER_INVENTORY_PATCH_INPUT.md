# `master_inventory_patch` JSON 입력 계약 추가 보고서

검증일: 2026-09-25  
결론: **자동 회귀 PASS / BROWSER_NOT_RUN**

## 변경 범위

수정 파일은 실제 사용 HTML `BDO_물교_v1.0.html`의 JSON 붙여넣기 분기와 기존 재고 검토 모달뿐이다.

추가된 흐름:

```text
JSON 붙여넣기
→ Array이면 기존 processParsedTrades() 그대로 사용
→ master_inventory_patch이면 엄격 검증
→ 기존값/새값 검토창 표시
→ 사용자가 적용
→ 허용된 1~4단 품목만 재고와 bdoInventoryState에 저장
```

Python 스캐너, `reference/`, OCR, 아이콘 임계값, 스케줄러, 7단, 까마귀주화, 완료 처리, 경로·지역·배차 로직은 수정하지 않았다.

## 입력 검증

- 최상위 `type`은 정확히 `master_inventory_patch`
- `version`은 숫자 `1`
- `items`는 객체이며 비어 있지 않아야 함
- 키는 현재 HTML `masterData[1]`~`masterData[4]`의 정확한 `name`만 허용
- 5·6·7단과 알 수 없는 이름은 거부
- `롬타스 그물`은 허용하고 `롭타스 그물`은 자동 보정 없이 거부
- 값은 `Number.isInteger(value) && value >= 0`만 허용
- 오류가 하나라도 있으면 적용 버튼을 비활성화하고 전체 PATCH를 적용하지 않음
- 오류 메시지에 포함되는 외부 키는 HTML 이스케이프 처리

## 적용 안전성

- 검토창을 여는 동안 `inventory`, localStorage, 스케줄, 교섭력, 교역 횟수 무변경
- 취소 시 상태 변화 없음
- 적용 시 PATCH에 들어 있는 허용 품목의 `stock`만 변경
- JSON에 없는 품목은 기존 재고 유지
- 적용 직전에 같은 계약으로 다시 검증
- 동일 품목 입력 DOM과 `bdoInventoryState`만 갱신
- 스케줄 재계산 함수는 호출하지 않음

## 신규 PATCH 전용 회귀

테스트: `tests/master_inventory_patch_regression.js`  
결과: `test_results/master_inventory_patch_regression.json`

| 검사 | 결과 |
|---|---|
| 기존 Array JSON paste 결과 수정 전과 동일 | PASS |
| 정상 1~4단 다중 PATCH | PASS |
| 입력되지 않은 재고 유지 | PASS |
| 수량 0 허용 | PASS |
| 5단 포함 시 전체 차단 | PASS |
| 6·7단 차단 | PASS |
| 알 수 없는 이름 차단 | PASS |
| `롭타스 그물` 자동 보정 금지 | PASS |
| 음수·문자열·소수·NaN 차단 | PASS |
| 검토창 취소 시 상태 변화 0 | PASS |
| 잘못된 version/items 및 미지원 객체 안내 | PASS |
| 적용 시 재고 저장 외 물교·스케줄·설정 무변경 | PASS |

합계: **10/10 PASS**

## 기존 기능 회귀

| 회귀 | 결과 |
|---|---:|
| 기존 핵심 물교 입력·수율·저장/복원 | 11/11 PASS |
| 기존 후속 입력 회귀 | 4/4 PASS |
| 모드 회귀 | 7/7 PASS |
| 32개 재고·모드 시나리오 | 32/32 PASS |
| 7단 완료 회귀 | 10/10 PASS |
| 완료 보류 제거 회귀 | 6/6 PASS |
| 스케줄러 보존 회귀 | 3/3 PASS |

`processParsedTrades()` 구간 SHA-256은 수정 전과 동일한 `683f5b883645208b16712c4f463800ea98367f2e4317f24bad86f1d18e6d8273`이다.

`runAlgorithmAllModes()`부터 완료 처리 직전까지 스케줄러 핵심 구간 SHA-256은 수정 전과 동일한 `0c64f7a542a028045a91b4b67b6721103ccfd76a646d74af0a894a9ee4f7be31`이다.

## 수정 전후 보존 및 해시

- 수정 전 보존본: `inputs/BEFORE_master_inventory_patch_v1.0_20260924.html`
- 수정 전 HTML SHA-256: `b5f29bfec3c3ebbd4257a42c1e311c28ce8e38d78dfb7a55279bd455a59e6598`
- 수정 후 HTML SHA-256: `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76`

## 브라우저 검증

`BROWSER_NOT_RUN`

Codex 브라우저 보안 정책이 로컬 `file:///` HTML 접근과 이미 열린 로컬 파일 탭 연결을 모두 차단했다. 사용자 실제 Chrome의 저장 재고를 우회 조작하지 않았으며, 브라우저 검증을 실행한 것으로 간주하지 않는다.
