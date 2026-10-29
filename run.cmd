@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0.venv312\Scripts\python.exe" (
    echo Missing Python 3.12 environment. See the Windows setup in README.md.
    exit /b 1
)
"%~dp0.venv312\Scripts\python.exe" -B "%~dp0app.py" %*
exit /b %errorlevel%
