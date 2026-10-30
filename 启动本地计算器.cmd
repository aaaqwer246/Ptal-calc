@echo off
setlocal
set PYTHONUTF8=1
cd /d "%~dp0"
python "%~dp0serve.py"
if errorlevel 1 pause
