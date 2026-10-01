# 현재 남은 로드맵

현재 구현은 로컬 인식 → correction/reconciliation → 전 행 검수 → immutable evidence → reviewed DTO → staged working session → 버전 평가까지 연결되어 있다. 전용 큰 검수 창도 구현되었고 owner가 결과·원문·후보를 볼 수 있음을 확인했다. 이는 R011 최종 사용성 승인과 다르다.

1. **ACTIVE_NEXT — R011 independent live review-first gate**: 사용자 지시로 새 화면을 수집한다. 실제 수정 부담, unknown/exclusion, DTO 성공, NEW commit/readback/reload와 원본 lineage를 기록한다. 이미 tuning에 사용한 화면은 independent로 재사용하지 않는다.
2. **조건부 개선**: R010 평가에서 드러난 실제 오류만 별도 범위로 수정한다. Master curation 및 fromItem geometry 재설계는 별도 승인 전 보류한다. 성능이 나쁜 source도 evidence로 남긴다.
3. **R012 package/release**: 깨끗한 PC의 Python/전용 OCR dependency와 모델 공급, frozen worker import, 설치·재시작·DB 보호·rollback을 검증한다. 현재 source recipe 검사는 release PASS가 아니다.
4. **Future automation gate**: 무인 승인·자동 적용은 독립 safety/coverage 기준을 별도 확정하기 전 활성화하지 않는다.

Warehouse 확장, 자동 스크롤, 원격 OCR은 현재 trade review-first 완료 범위에 섞지 않는다. 다음 기능 구현은 명시된 새 task 지시 후 착수한다.

Deferred unrelated issue: internal app zoom 130% can overflow the main panel in a legacy restoration scenario; pre-existing before repository cleanup. 배율 설정·저장 회귀는 유지하며 layout 수정은 별도 task다.
