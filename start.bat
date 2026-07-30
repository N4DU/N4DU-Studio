@echo off
rem N4DU Studio - launcher for Windows (double-click).
rem No dependencies: the Python standard library is enough.
cd /d "%~dp0"

rem Find Python: try "python" first, then the "py" launcher.
set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY (
  where py >nul 2>&1 && set "PY=py"
)
if not defined PY (
  echo.
  echo   Python was not found on this machine.
  echo   Install it from https://www.python.org/downloads/
  echo   ^(tick "Add Python to PATH" during setup^)
  echo.
  pause
  exit /b 1
)

rem No "||": if the program exits with an error it must not relaunch itself.
%PY% main.py
pause
