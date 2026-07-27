@echo off
rem N4DU Studio - lanzador para Windows (doble clic).
cd /d "%~dp0"

rem Busca Python (python o py).
where python >nul 2>&1 && (set "PY=python") || (set "PY=py")

rem Instala Pillow si falta.
%PY% -c "import PIL" >nul 2>&1 || (
  echo Instalando Pillow por unica vez...
  %PY% -m pip install Pillow
)

%PY% server.py
pause
