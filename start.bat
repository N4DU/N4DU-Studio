@echo off
rem N4DU Studio - lanzador para Windows (doble clic). Sin dependencias.
cd /d "%~dp0"
where python >nul 2>&1 && (python main.py) || (py main.py)
pause
