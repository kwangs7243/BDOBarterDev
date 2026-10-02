# 승인 기준 — 최종 보정 결과 중심 migration

ARCH-RESET-01은 **architecture/docs acceptance**다. runtime/test/live/release acceptance와 분리한다. 현재 코드는 기존 전 행 검수이며 새 workspace/classifier/Master curation은 미구현이다.

## 1. 이번 문서 gate

- 시작 v2/HEAD와 origin/v2는 `1e178e831ae73ef16d0a0248bbb2d683fadb7259`, main은 `f13b8e15af392f167d153c873448a4b2abec5a0c`, working tree clean.
- 수정은 CURRENT-PRODUCT-CONTRACT / CURRENT-ROADMAP / DECISION-REGISTER / ACCEPTANCE와 신규 UNIFIED-RECOGNITION-ARCHITECTURE뿐이다.
- current dependency graph, V1 inventory, Master counts, 숫자 crop→reader→parser→UI trace와 목표 Stage0–8, 4states, crop/curation/evidence version, Task scope를 구분한다.
- 이전 decision과 superseding IDs를 보존한다. R011/R012를 보류하고 일곱 설계 질문에 답한다. 계획 기능을 구현 완료로 표시하지 않는다.
- `git diff --check`, 허용 경로, 문서 links/current paths를 검사한다. production/test/fixture/DB/evidence 변경0, OCR/live 실행0.
- 문서 commit1회, v2 push, remote SHA 검증, main 불변. 설계 완료 status는 UNIFIED_RECOGNITION_ARCHITECTURE_READY다.

## 2. 미래 구현 regression gate

각 Luna Task는 [아키텍처12절](UNIFIED-RECOGNITION-ARCHITECTURE.md)의 작은 scope로 실행한다. unit/contract부터 시작하고 관련 browser·임시 DB 통합으로 확장한다. 최종 E1 통합은 기존 domain/import/registry/reconciliation/DTO/staging/evaluation/backend/capture/batch/review/persistence와 new flow 회귀가 필요하다. legacy records의 hash/read/export와 manual JSON/session/Warehouse 기능을 보존한다.

환경은 clean `recognition-local/r006-env-recovery/venv314/Scripts/python.exe`를 import probe 후 사용한다. `-B`, `PYTHONDONTWRITEBYTECODE=1`을 사용하고 Node browser의 PYTHON도 같은 경로로 고정한다. OCR worker 환경은 별도로 검증한다. real Pillow를 사용하고 stub PASS·ABI 혼합을 금지한다. DB tests는 temp Main/Master/sidecar만 사용한다.

M3는 immutable bundle, owner explicit approval, opaque ID, CAS/retry, 자동 verified 없음, pinned batch, rollback을 검증한다. E1은 additive migration/backup/rollback/future version, retry/body conflict, real crop/export/integrity, old bytes 보존을 검증한다. Master와 recognition stores를 Main DB에 섞지 않는다.

## 3. Final workflow functional gate

- 모든 보정 후 4states로 분류한다. source를 exactly once 보존하고 edge는 별도로 추적한다.
- 기본 문제 행 queue와 전체 final tab, 원본 crop 옆 final6, conflict별 출처·대안·이유를 제공한다.
- clipped 또는 critical pixels unavailable은 READY 금지, 재capture 안내. raw JSON은 접힌 diagnostic이다.
- 실제 count0 보존, missing0/req1/yield 추측 금지, open-world 보존, 자동 Master 수정·near-name 강제 merge 금지.
- user edit/unknown/exclusion/recapture로 해결하고 한 번 확인을 immutable hash에 bind한다. per-field 확인은 요구하지 않는다.
- retained candidate와 independently verified crop truth를 분리한다. 자동 truth/session 적용 없음.
- evidence → versioned DTO → NEW/APPEND intent → DB-first commit/readback/render/reload, retry/source coverage를 검증한다.

## 4. 데이터와 평가 gate

기존 `local_app/tests/fixtures/recognition-v2/manifest.json`은 known replay다. 과거 trade16 captures/80 oracle rows의 mapping은 UNRESOLVED/UNVERIFIED이며 truth로 자동 승격하지 않는다. Warehouse2 fixture는 지정된105 item/quantity truth만 평가한다. fixtures/truth/source hash/split을 출력에 맞춰 변경하지 않는다.

새 crop dataset은 owner가 pixels를 검증한 labels다. Master는 identity/correction authority이며 OCR truth가 아니다. source-family/capture/session/bitmap group의 split을 고정하고 train/development/evaluation을 분리한다. tuning에 노출된 source는 independent로 재사용하지 않는다. unknown/disputed/omission coverage를 보고한다.

raw exact/normalized exact/numeric exact/empty/wrong-confident/latency는 correction 전에 측정한다. correction recovery/harm과 final accuracy/ready rate/user edit burden은 별 계층이다. 새 V에는 independently known crop labels만 포함하며 batch retained를 추가하지 않는다. READY도 quality 평가에 포함한다. 구 R010 분모와 record 의미는 바꾸지 않는다.

핵심 지표는 FULLY_CORRECTED_ROW_READY_RATE, USER_EDIT_RATE_AFTER_FULL_CORRECTION, NUMERIC_FAILURE_RATE, MASTER_UNRESOLVED_RATE다. F/V/R/T/S/B/E와 unknown/exclusion/conflict/recapture/source coverage, wrong-ready, DTO/session 결과를 함께 기록한다. 분모0은 N/A다. all-HOLD 오류0·문제 행만의 높은 정확도는 PASS가 아니다.

O3 독립 evaluation 전에 minimum improvement, wrong-confident margin, confidence calibration/threshold, latency/resource budget, minimum sample, uncertainty gate를 owner 승인·freeze한다. 근거 없는 수치를 이번 설계에서 발명하지 않는다. gate PASS일 때만 O4 교체, 아니면 current 유지 또는 새 측정 계획이다. text/numeric 별 engine을 허용하되 conflict를 숨기지 않는다.

## 5. Live / owner usability / release

**현재 R011 independent live와 R012는 보류**한다. 기존 live evidence를 보존하고 향후 DEVELOPMENT_ARCHITECTURE_EVIDENCE로만 사용한다. 기존 cohort/hash를 다시 쓰지 않는다. 새 E1/O4 decision과 offline quality 이후 L1 준비 harness/evaluator → code freeze → 새 fresh BDO 화면으로 independent validation을 진행한다.

L1은 수정 field/행 부담, READY coverage/오답, unknown/exclusion/recapture/edge, 원본 비교 UX, Master proposal, pinned versions, evidence/DTO/NEW durable/readback/reload를 실제 자료로 보고한다. 나쁜 결과 삭제나 튜닝 후 같은 source의 independent PASS 주장은 금지한다. 사용자 Windows 환경과 CDP DPR을 구분한다. ownerUsabilityDecision은 명시 승인 전 null이다. 기술 성공만으로 USABLE/release/autoaccept를 선언하지 않는다.

R012는 이후 clean-machine Python/ONNX ABI/model 공급/frozen worker imports/앱 재시작/DB 보존/rollback을 별도 검증한다. local models/OCR env는 ignored 자산이다. source 회귀/dry-run만으로 packaged executable PASS를 주장하지 않는다.

## 6. 보존·삭제 경계

Main/user DB/session/scheduler/Warehouse와 legacy import 계산을 재설계하지 않는다. artifact budget200MiB/미검수 debug30일은 명시 cleanup 정책이다. verified crops/실사 자료/사용자 DB를 무단 삭제하지 않는다. full screenshot 무제한 저장, remote OCR, 자동 scroll/apply는 범위 밖이다. 이번 Task의 DB access/migration/OCR/browser/live는 모두0이다.

## ARCH-E1-DESIGN 문서 gate (2026-10-02)

[EVIDENCE-V3-CONTRACT](EVIDENCE-V3-CONTRACT.md) 기준으로5개 JSON실례/정확한키와enum/hashbasis/SQL DDL/migration/dispatch/truth위치/DTO/evaluation분모 및 Luna단계를 확정한다. MASTER-REFERENCE-AUDIT.md의48확인/1충돌/181미조사를partial evidence로 보존하며 추가조사나runtime gate를 실행하지 않는다.

구현acceptance는 계약10/11절: old evidence hash/receipt/export 불변, retained/edited/batch≠truth, source6→logical4 accounting, realPillow/rollback/retry, 필수unknown/conflictDTOheld, Main/session schema변경0. 이번 docs PASS는 해당runtime gates의 PASS가 아니다. 기존역사적 acceptance 수치/실사결과는 다시 쓰지 않는다.
