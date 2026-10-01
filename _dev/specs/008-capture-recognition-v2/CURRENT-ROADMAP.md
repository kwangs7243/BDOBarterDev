# 현재 로드맵 — Architecture Migration

기준: ARCH-RESET-01 / 2026-10-01. 현재 코드는 기존 전 행 검수 → R006 evidence → R008 DTO → R009 session → R010 평가까지 연결되어 있다. 새 최종 보정·문제 행 중심 구조는 **설계 완료, 구현 전**이다.

**ACTIVE_NEXT — architecture owner 검토 후 ARCH-M1 Master Registry vNext read-only foundation.** 이번 문서 commit은 구현 착수나 배포 승인이 아니다.

## 단계와 순서

| Task | 목표 | 의존 / 완료 조건 |
|---|---|---|
| M1 | Master bundle2 / read-only legacy adapter | architecture 승인, 241 source / 230 legacy 보존, 자동 verified·ID0, hash vectors |
| M2 | 제품 내부 Master curation draft UI | M1, 편집·명시 확인, 저장 미연결 표시 |
| M3 | verified bundle save/version/hash | M3a 임시 store → M3b API/UI, owner 확인, CAS/idempotency, batch pin 불변 |
| C1 | 단일 correction pipeline interface | M1, stage trace, pure/parity, production 통합 전 |
| C2 | V1/V2 rule consolidation | C1/M3, safe helper 재사용, defaults·이중 보정 없음, manual fallback 회귀 |
| C3 | final classifier | C2, 4states, source accounting, crop quality, 충돌 보존 |
| U1 | final/problem review workspace | C3/U2b/M2, 모든 행 접근, 문제 우선, 한 번 확인, stale guard |
| U2 | 원본 row/field/capture 비교 | O1/C3 → U2a raw crop contract → U2b Blob cache/pixel test |
| E1 | evidence3 / DTO / 통합 | E1a sidecar3 compatibility → E1b DTO → E1c client/API/UI version activation |
| O1 | current OCR text/numeric adapter | C1, Master 접근·engine 변경 없음, current parity, worker 환경 분리 |
| O2 | human-labeled crop benchmark | M3/U2/E1, owner label, source hash, split, coverage |
| O3 | current/candidate 비교 | O1/O2, 평가 전 수치 gate 승인·freeze, paired metrics, local budget |
| O4 | numeric reader 결정·한정 구현 | O3 결과, 채택 gate PASS 또는 current 유지, rollback, pinned quality policy |
| L1 | 새 final-result independent live | M–E 통합/O4 결정, evaluator·harness dry-run 후 code freeze·새 fresh source |

O1과 U2는 U1 완료 전에 필요하다. 번호 순서로 미완료 의존을 건너뛰지 않는다. UI preview는 E1 통합 gate 전 live primary path로 활성화하지 않는다. L1은 준비 작업과 실사 실행을 분리하고 실사 중 코드를 변경하지 않는다.

작은 구현 Task의 권장 모델은 **Luna High**다. M3/U2/E1/L1은 substep별 작업으로 나눈다. 정확한 신규·기존 파일 scope와 계약·negative tests는 [아키텍처12절](UNIFIED-RECOGNITION-ARCHITECTURE.md)에 있다. 각 Task 지시에서 base와 현재 환경을 다시 고정한다.

## 보류와 보호

- **현재 R011 ACTIVE_NEXT 중단.** 기존 실사 source는 향후 DEVELOPMENT_ARCHITECTURE_EVIDENCE로만 사용하고 기존 case/cohort/hash는 다시 쓰지 않는다. 새 architecture freeze 전 새 independent source를 소비하지 않는다.
- **R012 package/release 중단.** 새 구현·offline quality·L1·owner usability 이후 별도 clean-machine/ABI/package lifecycle 검증을 한다.
- Future automation은 별도 안전 승인 전 보류한다. FINAL_READY나 batch confirmation으로 unattended autoaccept를 허용하지 않는다.
- manual JSON/capture/session/scheduler/Warehouse/Main DB 보호를 유지한다. Master 전용 store와 sidecar3 migration은 미래 M3/E1의 명시 scope다. 이번에는 DB 접근0이다.
- 이전 일반 layout finding: internal app zoom130%에서 legacy main panel overflow 가능성은 별도 범위다. 본 설계로 수정 완료된 것이 아니다.

## 후속 승인

즉시 추가 제품 방향 선택은 필요 없다. 구현 전 architecture 승인, 실제 Master identity/alias owner curation, O3의 평가 전 수치 threshold/resource gate 승인은 남아 있다. 코드·fixture 정답을 결과에 맞춰 바꾸지 않는다. scope나 authority 충돌은 해당 Task를 멈추고 보고한다.
