@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
if not exist ".venv\Scripts\python.exe" (
    echo Run setup-cloud.cmd first.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" bridge\server.py
if errorlevel 1 pause
