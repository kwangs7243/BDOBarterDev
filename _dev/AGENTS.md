# 현재 저장소 작업 규칙

- 구현 root는 `_dev/local_app`, 작업 브랜치는 사용자 지시에 따른다. 명시 요청 없는 commit/push/force 작업 금지.
- 현재 authority는 `CURRENT-PRODUCT-CONTRACT.md`와 `TESTING.md`, 승인된 현재 제품 동작이다. 과거 architecture/specs와 개발 산출물은 Git history 또는 저장소 외부 archive에서 확인한다.
- REVIEW-FIRST: 모든 COMPLETE source를 logical row 또는 출처 membership으로 보존한다. 후보와 human truth를 분리하고 숫자 unknown을 기본값으로 채우지 않는다.
- Master/인식 threshold/배차 계산을 정리 작업에 섞어 변경하지 않는다. 직접·동적 import, runtime resource와 packaging 의존성을 먼저 확인한다.
- 검증에는 깨끗한 `recognition-local/r006-env-recovery/venv314/Scripts/python.exe`와 `-B`, `PYTHONDONTWRITEBYTECODE=1`을 사용한다. Node browser server의 `PYTHON`도 이 절대 경로로 지정한다.
- 실제 사용자 DB 대신 임시 DB를 사용한다. 실사/개선 history 정리는 명시 사용자 요청과 외부 archive 검증 후에만 한다. inventory/settings/session/slots/app metadata/ROI와 현재 모델·calibrated template를 보존한다.
- 테스트 입력은 `local_app/tests/fixtures`; 결과는 OS 임시 디렉터리 또는 명시한 저장소 외부 경로. 일반 회귀는 `local_app/tests/run_current.mjs`, 실사 전용 명령은 `local_app/tests/live`. build/dist/환경/cache를 추적하거나 current tree에 쌓지 않는다.
- 자동 회귀, 실제 실사, 사용성 승인, package/release 승인을 구분해서 보고한다. 성공을 위해 기대값을 현재 출력으로 갱신하지 않는다.
