@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
if not exist ".venv\Scripts\python.exe" (
    where py.exe >nul 2>nul
    if errorlevel 1 (python -m venv .venv) else (py -3 -m venv .venv)
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" -m pip install -r bridge\requirements.txt
if errorlevel 1 goto failed
".venv\Scripts\python.exe" bridge\configure.py
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Cloud setup failed. Check that Python 3.10 or later and internet access are available.
pause
exit /b 1
