# SPEC-002 검증 기록

판정: PASS (SPEC-002 범위만)

## 결과

- 기존 사용자 저장 의미를 `state-mapping.md`에 정리했다. 기존 HTML localStorage는 읽거나 자동 이관하지 않았다.
- 마스터 창고 70종의 stock/target 표시, 단계별 순서 저장, 설정 UI와 지도 snapshot 저장/명시적 불러오기, viewer 배율·panel 값 저장을 신규 앱에 연결했다.
- transient 회차/UI 값은 메모리에만 두고 API에 보내지 않는다. SPEC-001의 테이블·section·API는 변경하지 않았다.
- 빈 stock은 NULL로 표시하며 빈칸 편집으로 숫자 0 또는 다른 값으로 바뀌지 않는다. 숫자 0은 별도 값으로 저장한다.

## 실행한 검증

| 검증 | 결과 |
|---|---|
| `python -m compileall -q local_app` | PASS |
| `python -m unittest discover -s local_app/tests -v` | PASS, 15/15 |
| Frontend `.js` 및 browser test 구문 검사 | PASS |
| `node local_app/tests/browser_smoke.mjs` (격리 SQLite + Chrome headless) | PASS |
| 동일 임시 DB를 사용한 서버 프로세스 종료·재시작 및 브라우저 reload | PASS |
| inventory 70종, stock NULL/0/target, 순서 fallback/reorder 재시작 왕복 | PASS |
| tierRules, ship, presets, parley, 모든 tuning 필드, navigation, mapSlots/base, viewer 재시작 왕복 | PASS |
| mapBase 자동 적용 금지 및 슬롯/base 명시적 불러오기 | PASS |
| revision conflict 및 거부된 설정 저장의 UI 실패 표시/미반영 | PASS |
| SPEC-000 보호 파일·알고리즘 해시 | PASS, manifest와 동일 |

브라우저 테스트는 수동 화면 캡처 검토가 아닌 실제 설치 Chrome의 headless DOM 상호작용 검사다. 테스트 DB는 임시 디렉터리에 두었으며 실제 `%LOCALAPPDATA%` 사용자 DB를 열지 않았다.

## SPEC-000 보호 해시

```text
BDO_물교_v1.0.html                 7133AE0140D84DC284A53B7CAEEDAF5479270161038CA36DF4E094983AAF7B76
warehouse_patch.py                 AA72ED5763C76A030AB4C8FFBC00FB23BF8ED4C391F9D1DE8659395D76579FE8
reference/barter_items.json        E6E9786B1A8F671650DCA9FEB33B6137029620F5E17CCB2DCDF0957722028D9C
reference/SHA256SUMS.txt            4131F16ABDFF13889E98702E7A9C00325671349FDDAF7AC282E70B7E88AA2AE4
processParsedTrades                683f5b883645208b16712c4f463800ea98367f2e4317f24bad86f1d18e6d8273
scheduler/completion               0c64f7a542a028045a91b4b67b6721103ccfd76a646d74af0a894a9ee4f7be31
```

## 알려진 제한·기존 이슈

- SPEC-001의 `tests/warehouse_patch_regression.py`는 baseline 문서에도 기록된 과거 HTML SHA-256 기대값을 사용한다. 이 파일/기대값은 범위 밖이므로 변경하지 않았고 이번 테스트 명령에는 포함하지 않았다.
- 신규 앱에는 기존 지도 뷰어의 실제 floating panel 드래그/resize 화면이 아직 없다. SPEC-002에서는 기존 panel ID별 위치·크기 값의 편집, 저장, 재실행 복원을 검증했으며, 없는 지도 panel의 실제 배치 동작은 검증하지 않았다.
- Waitress 배포 기동은 SPEC-001 소유다. 이번 Chromium 검증은 격리 test app의 Flask 개발 서버를 이용했다.