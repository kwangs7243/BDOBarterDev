# Tasks

- [x] T001 SPEC-000~005 acceptance 및 release input을 확인한다.
- [x] T002 runtime Tailwind CDN을 제거하고 필요한 CSS를 로컬로 묶는다. (기존 index가 local CSS만 참조하고 외부 CDN/font/API 참조가 없음을 확인)
- [x] T003 고정 port·single instance·port conflict 처리를 구현한다. (named mutex 중복 실행 및 실제 18765 충돌 대화상자 확인)
- [x] T004 Waitress start, health readiness와 browser open을 launcher에 연결한다. (패키지 실행, health 이후 browser controller 호출 확인)
- [x] T005 화면 열기·정상 종료 및 pending write·scan 대기를 구현한다. (native manager Exit 및 shutdown drain 단위 검증)
- [x] T006 user data가 package·temporary extraction 경로 밖에 저장되는지 보장한다. (이동한 package와 임시 LOCALAPPDATA로 확인)
- [x] T007 Python runtime·NumPy·Pillow·reference·templates를 package에 포함한다. (PyInstaller folder package 실제 scanner 흐름 포함)
- [x] T008 Python 미설치 Windows 및 offline package smoke test를 추가하고 실행한다. (격리 package에서 Python 경로 제거; runtime 외부 참조 정적 검사)
- [x] T009 Chrome localhost에서 저장·scan·JSON·schedule·completion·relaunch 흐름을 검증한다. (각 업무 흐름을 packaged Waitress 대상으로 Chrome headless 검증)
- [x] T010 전체 필수 regression과 동일 입력 결과 비교를 실행한다. (필수 Node 회귀, Python unittest 및 SPEC-005 동등성 검증)
- [x] T011 자동 결과와 browser 결과를 분리해 기록하고 BROWSER_NOT_RUN 여부를 명시한다. (validation-report.md)
- [x] T012 SPEC-006 acceptance 확인.
