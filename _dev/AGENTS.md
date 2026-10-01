# 현재 저장소 작업 규칙

- 구현 root는 `_dev/local_app`, 작업 브랜치는 사용자 지시에 따른다. 명시 요청 없는 commit/push/force 작업 금지.
- 현재 authority는 `specs/008-capture-recognition-v2`의 제품 계약·결정·로드맵·승인 기준이다. 과거 상태는 Git history에서 확인한다.
- REVIEW-FIRST: 모든 COMPLETE source를 logical row 또는 출처 membership으로 보존한다. 후보와 human truth를 분리하고 숫자 unknown을 기본값으로 채우지 않는다.
- Master/인식 threshold/배차 계산을 정리 작업에 섞어 변경하지 않는다. 직접·동적 import, runtime resource와 packaging 의존성을 먼저 확인한다.
- 검증에는 깨끗한 `recognition-local/r006-env-recovery/venv314/Scripts/python.exe`와 `-B`, `PYTHONDONTWRITEBYTECODE=1`을 사용한다. Node browser server의 `PYTHON`도 이 절대 경로로 지정한다.
- 실제 사용자 DB/sidecar 대신 임시 DB를 사용한다. `recognition-local`의 실사 증거와 모델은 로컬 자산이며 Git에 올리거나 임의 삭제하지 않는다.
- 테스트 입력은 `local_app/tests/fixtures`; 결과는 ignored `recognition-local` 또는 임시 디렉터리. build/dist/환경/cache를 추적하지 않는다.
- 자동 회귀, 실제 실사, 사용성 승인, package/release 승인을 구분해서 보고한다. 성공을 위해 기대값을 현재 출력으로 갱신하지 않는다.
