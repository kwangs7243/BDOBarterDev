@echo off
chcp 65001 >nul
if not exist "%~dp0app\BDO 물교 실행.exe" (
  echo 앱 파일을 찾을 수 없습니다. 실행하기.cmd와 app 폴더를 함께 두세요.
  pause
  exit /b 1
)
start "" "%~dp0app\BDO 물교 실행.exe"
if errorlevel 1 (
  echo 앱 실행에 실패했습니다. app 폴더와 실행 권한을 확인하세요.
  pause
  exit /b 1
)
exit /b 0
