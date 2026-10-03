# PRODUCT-CLEANUP-01 검증 보고

검증일: 2026-10-04 (Asia/Seoul). 대상: v2. 설치본: `D:\BDOBarterDev\app\BDO 물교 실행.exe`.

1. **시작 HEAD / 최종 HEAD**
   - 시작: `cfaf60e9d1a67ed5a03ecf6f8406d6407725c56d`. 로컬 및 origin/v2가 동일했고 두 checkout 모두 clean이었다.
   - 이 보고서를 포함한 cleanup 커밋의 정확한 최종 SHA와 원격 일치는 커밋 후 완료 응답에서 제공한다.
2. **삭제한 production architecture**
   - Master 관리 UI/API/SQLite/registry/bundle/provenance, RecognitionStore 및 Observation/CropTruth/FinalReview/FinalShadow/Evidence/session staging.
   - old trade-batch V1/raw V2, query mode, 501 endpoint, T010 experiment configuration/runtime/framework 및 warehouse shadow/candidate reader.
   - 과거 DB v1/v2/v3 호환 및 자동 migration. 전용 테스트와 찌꺼기 CSS/HTML도 제거했다.
3. **유지한 production architecture**
   - 화면·파일·붙여넣기 → PNG/ROI/capture queue → `/api/recognition/trade-live-list` → TradeBatchRuntime → thin worker → ONNX live OCR → selective review → 실제 working session.
   - 모델 해시 검증, subprocess timeout 120초, single-worker lock, packaged EXE worker mode, same-origin/PNG/frame/security validation.
   - 원래 importer, 생산용 창고 scanner, scheduler/completion 계산, 현재 회차·저장 슬롯, 설정·재고·지도·항로·화면 공유·launcher.
   - `scheduler-runtime.js`의 현재 state와 계산기 연결은 실제 스케줄 생성/완료에 필요하므로 보존했다. scanner와 계산식을 다시 설계하지 않았다.
   - live row detection에 필요한 기존 `_edge_profile`/`_separator_peaks` 두 함수만 `trade_live_ocr.py` 안으로 옮겼다. 별도 실험 모듈/JSON이 필요 없다.
4. **Master 최종 형태**
   - 번들 `frontend/data/trade-catalog.json`의 read-only item/island/tier 기준을 사용한다. 창고 재고 정본은 기존 `reference/barter_items.json`이다.
   - 제거 전 verified reference claims 87개의 canonical name이 모두 현재 catalog에 있음을 확인했다. 추가 이관이 필요한 검증된 canonical/alias 자료는 없었다. 기존 사용자 Master DB는 이관하지 않았다.
5. **새 DB 구조**
   - `%LOCALAPPDATA%/BDOBarter/data/bdo.sqlite3`, schema 4 하나만 생성한다.
   - 제품 상태 6 tables: `inventory`, `settings`, `app_meta`, `working_session`, `saved_schedule_slot`, `mutation_receipt`.
   - 인식 개선 데이터 3 tables: `trade_correction`, `warehouse_scan`, `warehouse_feedback`. 같은 SQLite 안에서 역할과 쓰기 경로를 구분한다.
   - 현재 schema만 허용한다. 옛 데이터를 migration하지 않는다. 기존 DB와 패키지는 실행 경로 밖의 백업 위치로 옮겼다.
6. **Recognition feedback 구조**
   - 사용자가 실제 값을 바꾼 trade 필드만 원본 PNG/capture metadata, row/field box, raw OCR, confidence, 최초 자동 corrected, final value, engine/model/worker version, timestamp와 함께 저장한다.
   - feedback ID와 payload hash로 재시도를 중복 저장하지 않는다. ID를 다른 값에 재사용하면 409. 저장 실패 시 입력과 review 상태를 유지한다. 제품 revision/재고/회차는 바꾸지 않는다.
   - 자동 확정 또는 값 변경 없는 trade 확인은 저장하지 않는다. 이미지는 실제 수정 필드가 있는 capture만 저장한다. model weight 자동 변경/학습은 없다.
   - 창고는 원본 이미지·scanner output·수정/명시 확인값·실제 적용 결과를 유지한다. 수정하지 않은 자동 MATCH를 human labels로 저장하지 않는다. feedback과 재고 적용은 한 transaction이며 retry/rollback을 검증했다. 현재 warehouse dataset export도 유지한다.
7. **삭제 파일 목록**
   - 이전 경로 101개 제거. `test_warehouse_evidence.py`는 현재 계약만 다루는 `test_warehouse_feedback.py`로 정리했다.

```text
_dev/local_app/backend/api/master.py
_dev/local_app/backend/catalog_provenance.py
_dev/local_app/backend/master_store.py
_dev/local_app/backend/recognition_store.py
_dev/local_app/backend/services/capture_normalization.py
_dev/local_app/backend/services/trade_recognition.py
_dev/local_app/backend/services/warehouse_candidate_readers.py
_dev/local_app/backend/services/warehouse_recognition.py
_dev/local_app/backend/warehouse_evidence.py
_dev/local_app/frontend/css/trade-final-review.css
_dev/local_app/frontend/css/trade-master.css
_dev/local_app/frontend/css/trade-recognition-review.css
_dev/local_app/frontend/data/trade-master-reference-manifest-v2.json
_dev/local_app/frontend/data/trade-master-reference-manifest.json
_dev/local_app/frontend/js/domain/reviewed-trade-dto.js
_dev/local_app/frontend/js/domain/trade-batch-reconciliation.js
_dev/local_app/frontend/js/domain/trade-catalog-provenance.js
_dev/local_app/frontend/js/domain/trade-final-classification.js
_dev/local_app/frontend/js/domain/trade-final-correction.js
_dev/local_app/frontend/js/domain/trade-final-evidence.js
_dev/local_app/frontend/js/domain/trade-final-pipeline.js
_dev/local_app/frontend/js/domain/trade-master-bundle.js
_dev/local_app/frontend/js/domain/trade-master-registry.js
_dev/local_app/frontend/js/domain/trade-review-projection.js
_dev/local_app/frontend/js/domain/trade-session-staging.js
_dev/local_app/frontend/js/trade-final-review.js
_dev/local_app/frontend/js/trade-final-shadow.js
_dev/local_app/frontend/js/trade-master-ui.js
_dev/local_app/frontend/js/trade-recognition-review.js
_dev/local_app/frontend/js/trade-source-evidence.js
_dev/local_app/recognition_data/anchors.npz
_dev/local_app/recognition_data/model-manifest.json
_dev/local_app/recognition_data/policy.json
_dev/local_app/recognition_data/profiles.json
_dev/local_app/recognition_data/t005a1_measurements.json
_dev/local_app/recognition_data/trade-t010a-experiment.json
_dev/local_app/recognition_data/trade-t010a2-experiment.json
_dev/local_app/recognition_data/trade-t010b1-experiment.json
_dev/local_app/recognition_data/trade-t010p3a-experiment.json
_dev/local_app/tests/backend/test_capture_normalization.py
_dev/local_app/tests/backend/test_catalog_provenance.py
_dev/local_app/tests/backend/test_final_review_observations.py
_dev/local_app/tests/backend/test_master_api.py
_dev/local_app/tests/backend/test_master_store.py
_dev/local_app/tests/backend/test_recognition_artifacts.py
_dev/local_app/tests/backend/test_recognition_benchmark.py
_dev/local_app/tests/backend/test_recognition_security.py
_dev/local_app/tests/backend/test_recognition_store.py
_dev/local_app/tests/backend/test_trade_batch_contract_hash.py
_dev/local_app/tests/backend/test_trade_batch_draft_experiment.py
_dev/local_app/tests/backend/test_trade_crop_contract.py
_dev/local_app/tests/backend/test_trade_ocr_adapter.py
_dev/local_app/tests/backend/test_trade_ocr_experiment.py
_dev/local_app/tests/backend/test_trade_recognition_v2.py
_dev/local_app/tests/backend/test_trade_review_observations.py
_dev/local_app/tests/backend/test_warehouse_candidate_readers.py
_dev/local_app/tests/backend/test_warehouse_evidence.py
_dev/local_app/tests/backend/test_warehouse_recognition_v2.py
_dev/local_app/tests/browser_hotfix_ocr.mjs
_dev/local_app/tests/browser_recognition_security.mjs
_dev/local_app/tests/browser_trade_batch_recognition.mjs
_dev/local_app/tests/browser_trade_final_flow.mjs
_dev/local_app/tests/browser_trade_final_review.mjs
_dev/local_app/tests/browser_trade_master.mjs
_dev/local_app/tests/browser_trade_review.mjs
_dev/local_app/tests/browser_trade_review_live.mjs
_dev/local_app/tests/browser_trade_review_persistence.mjs
_dev/local_app/tests/browser_trade_review_session.mjs
_dev/local_app/tests/fixtures/catalog-provenance-v2-vectors.json
_dev/local_app/tests/fixtures/recognition-v2/manifest.json
_dev/local_app/tests/fixtures/recognition-v2/warehouse-barter-only.expected.json
_dev/local_app/tests/fixtures/recognition-v2/warehouse-mixed.expected.json
_dev/local_app/tests/reviewed_trade_dto_regression.mjs
_dev/local_app/tests/reviewed_trade_dto_v3_regression.mjs
_dev/local_app/tests/trade_batch_reconciliation_regression.mjs
_dev/local_app/tests/trade_catalog_audit_regression.mjs
_dev/local_app/tests/trade_catalog_provenance_regression.mjs
_dev/local_app/tests/trade_catalog_provenance_v2_baseline_regression.mjs
_dev/local_app/tests/trade_catalog_reference_manifest_migration_regression.mjs
_dev/local_app/tests/trade_final_classification_regression.mjs
_dev/local_app/tests/trade_final_correction_regression.mjs
_dev/local_app/tests/trade_final_evaluation_regression.mjs
_dev/local_app/tests/trade_final_evidence_regression.mjs
_dev/local_app/tests/trade_final_live_harness_regression.mjs
_dev/local_app/tests/trade_final_pipeline_regression.mjs
_dev/local_app/tests/trade_master_bundle_regression.mjs
_dev/local_app/tests/trade_master_registry_regression.mjs
_dev/local_app/tests/trade_review_evaluation_regression.mjs
_dev/local_app/tests/trade_review_projection_regression.mjs
_dev/local_app/tests/trade_session_staging_regression.mjs
_dev/local_app/tests/trade_source_evidence_regression.mjs
_dev/local_app/tools/audit_trade_catalog.mjs
_dev/local_app/tools/measure_capture_normalization.py
_dev/local_app/tools/migrate_trade_master_reference_manifest.mjs
_dev/local_app/tools/recognition_experiments.py
_dev/local_app/tools/trade_batch_draft_experiment.py
_dev/local_app/tools/trade_ocr_adapter.py
_dev/local_app/tools/trade_ocr_experiment.py
_dev/local_app/tools/trade_recognition_experiments.py
_dev/local_app/tools/trade_review_evaluation.mjs
_dev/tools/recognition_benchmark.py
```

8. **주요 수정/추가 파일 목록**

```text
_dev/local_app/backend/api/recognition.py
_dev/local_app/backend/api/scan.py
_dev/local_app/backend/app.py
_dev/local_app/backend/recognition_contracts.py
_dev/local_app/backend/services/trade_batch_runtime.py
_dev/local_app/backend/storage.py
_dev/local_app/frontend/css/app.css
_dev/local_app/frontend/css/trade-recognition.css
_dev/local_app/frontend/index.html
_dev/local_app/frontend/js/app.js
_dev/local_app/frontend/js/recognition-ui.js
_dev/local_app/frontend/js/trade-recognition-client.js
_dev/local_app/packaging/bdo-barter.spec
_dev/local_app/tests/backend/test_durable_state_ui.py
_dev/local_app/tests/backend/test_recognition_contracts.py
_dev/local_app/tests/backend/test_storage_api.py
_dev/local_app/tests/backend/test_trade_batch_api.py
_dev/local_app/tests/backend/test_trade_batch_runtime.py
_dev/local_app/tests/backend/test_warehouse_feedback_v2.py
_dev/local_app/tests/backend/test_working_session.py
_dev/local_app/tests/browser_app_workspace.mjs
_dev/local_app/tests/browser_release_ui_audit.mjs
_dev/local_app/tests/browser_scheduler.mjs
_dev/local_app/tests/browser_secondary_tools.mjs
_dev/local_app/tests/browser_trade_live_list.mjs
_dev/local_app/tests/browser_trade_roi_capture.mjs
_dev/local_app/tests/browser_warehouse_scan.mjs
_dev/local_app/tests/package_live_smoke.py
_dev/local_app/tests/trade_domain_contract.mjs
_dev/local_app/tests/trade_live_list_accuracy.py
_dev/local_app/tests/trade_recognition_client.mjs
_dev/local_app/tools/trade_batch_worker.py
_dev/local_app/tools/trade_live_ocr.py
_dev/local_app/backend/warehouse_feedback.py
_dev/local_app/tests/backend/test_warehouse_feedback.py
```

9. **물교 16장/80행 최종 정확도**
   - cleanup 전/후: 누락 0, 추가 0, reqAmount 80/80, count 80/80, yield 80/80 = 숫자 240/240, 완전 일치 76/80.
   - source corpus와 rebuilt EXE의 실제 16장 단일 요청 모두 통과. EXE OCR 측정 103.5초. threshold/고정 수량 규칙/모델 변경 없음.
   - 실제 Chrome 1920×1080, 130%에서 5개 이미지의 표/고정 수량/선택 검수/새 회차/추가/reload를 검증했다. 오답 수정 1 capture의 feedback도 DB에 저장되고 EXE 재시작 후 유지됨을 확인했다.
10. **창고 검증**
   - 생산용 scanner 원본 보존. 화면 ROI 이동·크기 변경·캡처·연결 종료, 50개 자동 MATCH와 3개 미확정 슬롯만 수정, 단일 재고 적용·reload·human feedback 검증 통과.
   - EXE에서 scan 4회, feedback 적용 2회 검증. 정상 seed MATCH도 자동으로 포함된다. 미확정 사례의 UI/storage 검증에서는 통제된 review fixture를 사용했다.
11. **스케줄 regression**
   - 기존 same-input fixture: 일반 물교/주화/7단계 결과 일치. 남은 횟수, 입력 교섭력, 일반/주화 비용×실행 횟수, 재고 차감/증가, 저장 슬롯·reload 통과.
   - 응답 유실 시 동일 요청 재시도/중복 완료 방지, 실제 409 충돌 후 재고 delta 재계산, 현재 교섭력 부족 시 완료 차단, 4→5 남은 횟수 보존 통과.
   - source와 EXE의 실제 Chrome에서 동일한 regression을 통과했다. 게임 공식을 새로 만들지 않았다.
12. **Fresh install**
   - 임시 완전 fresh AppData와 실제 사용자 AppData 모두 schema 4의 위 9 tables만 생성. Master/Recognition legacy DB 생성 없음.
   - 실제 설치본: 재고 70개 unknown, revision 0, working session 없음. 두 번째 실행 bootstrap 동일, 번들 OCR 5행 성공 후 회차/재고 변경 없음, 정상 종료.
   - 풍부한 수정/재고/회차/스케줄 데이터의 두 번째 실행 재로드는 격리된 EXE lifecycle에서 전체 SQLite dump까지 동일함을 확인했다.
13. **Packaged EXE**
   - PyInstaller onedir rebuild, 내장 model/worker 사용(개발 OCR 환경 변수 제외). 실제 EXE→Chrome 물교/창고/스케줄 flow, 단일 인스턴스, 회차 저장, 재실행, 종료 PASS.
   - 현재 설치/바로가기: `D:\BDOBarterDev\app`, `D:\BDOBarterDev\BDO 물교 실행.lnk`. 279개 파일 모두 build와 동일 해시.
   - EXE SHA-256: `0d4837eee050353526f3da6eec8b72910582710e7923d38605e349b1f27d9159`.
14. **Package old files 부재**
   - onedir 전체 file manifest와 EXE PYZ 내부 module inventory를 검사했다. old Master Store/RecognitionStore/FinalReview/실험/warehouse shadow/candidate 코드 및 T010 JSON 없음.
   - 현재 source asset 43개 hash와 compiled module 17개의 code object가 package와 일치. model directory는 inference.onnx/inference.yml 두 파일뿐이며 기존 model hashes 동일.
   - production import graph/route map/정적 search에서 죽은 compatibility 의존성 없음. 테스트의 제거된 UI/API 부재 검사는 의도적으로 유지했다. 과거 문서와 보호된 reference 원본은 실행 의존성이 아니다.
15. **알려진 한계 / 검증 구분**
   - 문자 표기 4필드는 기존 corpus와 동일하게 완전 일치 기준에 남는다(띄어쓰기 3, 축약된 섬명 1). 숫자 오답은 없다.
   - 실제 게임 창의 권한 선택기 및 실시간 게임 화면은 사용자 실사가 남아 있다. 화면 연결 lifecycle/ROI는 실제 Chrome의 통제된 canvas stream으로 검증했다.
   - 모델 자동 학습은 수행하지 않는다. 저장된 correction은 향후 분석/오프라인 개선 자료다. 120초 worker 제한 유지.
   - 초기 병행 package 검증의 client 120초 timeout과 테스트 SQLite 연결 미종료, dialog-close event 검사 race를 해결했다. 제품 동작과 구분하여 client 대기 150초/connection closing/event wait로 harness를 수정한 뒤 단독 최종 검증 PASS.
   - backend 62 tests + launcher 5 tests, Node importer 86행/capture/client/rules, Chrome 물교·창고·스케줄·지도·설정·workspace·ROI·release UI audit PASS. `git diff --check` PASS.
   - 실제 프로세스 및 포트를 마지막 확인하여 프로젝트 EXE/worker/test server가 남아 있지 않다.
16. **Commit / push / clean**
   - 요청한 v2로 이 구현과 보고를 commit/push한다. 커밋 후 로컬/원격 SHA와 두 checkout clean 여부는 최종 완료 응답에 기재한다.
