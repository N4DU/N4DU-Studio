@echo off
rem N4DU Studio - launcher for Windows (double-click).
rem No dependencies: the Python standard library is enough.
cd /d "%~dp0"

rem Find Python. pythonw.exe comes first on purpose: it is the build with no
rem console attached, so double-clicking this file leaves no black window
rem sitting behind the app. python.exe is only a fallback for an installation
rem that somehow has no windowed build - and even then main.py hides the
rem console itself when it turns out to be the only thing using it.
set "PY="
where pythonw >nul 2>&1 && set "PY=pythonw"
if not defined PY (
  where pyw >nul 2>&1 && set "PY=pyw"
)
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)
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

rem "start" and not a plain call: the app becomes a process of its own, so
rem this launcher exits immediately instead of sitting there for as long as
rem the app runs - which is what kept a console on screen the whole time.
rem
rem Deliberately no /b. With /b the app would share this window's console and
rem be killed the moment the launcher's window closed. Under pythonw no
rem window is created at all; under the python.exe fallback the new console
rem belongs to the app alone, and main.py hides it on startup.
rem
rem To watch what the bridge is doing, run it yourself instead:
rem     python main.py --console
start "" %PY% main.py %*
exit /b 0
