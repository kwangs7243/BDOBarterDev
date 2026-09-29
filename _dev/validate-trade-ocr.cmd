@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=%~dp0recognition-local\envs\t010b1-ocr\Scripts\python.exe"
if not exist "%PYTHON%" set "PYTHON=%~dp0local_app\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo T010B1 isolated Python environment was not found.
  echo Restore the existing T010B1 environment before starting validation.
  exit /b 2
)
set "PYTHONDONTWRITEBYTECODE=1"
"%PYTHON%" -B "%~dp0local_app\tools\trade_human_validation.py"
exit /b %ERRORLEVEL%
