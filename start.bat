@echo off
rem N4DU Studio - lanzador para Windows (doble clic). Sin dependencias.
cd /d "%~dp0"

rem Buscar Python: primero "python", si no el lanzador "py".
set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY (
  where py >nul 2>&1 && set "PY=py"
)
if not defined PY (
  echo.
  echo   No se encontro Python en este equipo.
  echo   Instalalo desde https://www.python.org/downloads/
  echo   ^(marca "Add Python to PATH" durante la instalacion^)
  echo.
  pause
  exit /b 1
)

rem Sin "||": si el programa termina con error no debe relanzarse solo.
%PY% main.py
pause
