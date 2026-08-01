@echo off
rem N4DU Studio - the technical way in.
rem
rem This is the console launcher. It exists BECAUSE it opens a console: it
rem runs the bridge with the full log on screen, so you can watch what the
rem server is doing behind the interface - every request, every token, every
rem byte written to disk - and it stays up when the window is closed.
rem
rem For the app on its own, double-click main.pyw instead. Nothing is hidden
rem there and nothing flashes: .pyw is handed to pythonw.exe, which Windows
rem never gives a console to. cmd.exe, on the other hand, is a console
rem program, so Windows creates this window before the first line here is
rem read - which is exactly the point of this file.
rem
rem No dependencies: the Python standard library is enough.
cd /d "%~dp0"

rem The console build, deliberately. pythonw.exe would leave nothing to read.
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

rem Run it in this window and wait: closing the app is not the same as being
rem finished reading. --console also stops the bridge shutting itself down
rem when the page goes away.
rem
rem No "||": if the program exits with an error it must not relaunch itself.
%PY% main.pyw --console %*

echo.
echo   The bridge has stopped.
pause
