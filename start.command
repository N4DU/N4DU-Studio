#!/usr/bin/env bash
# N4DU Studio - lanzador para macOS / Linux (doble clic en Mac).
cd "$(dirname "$0")" || exit 1

PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo "No se encontró Python. Instalalo desde https://python.org"
  read -r -p "Enter para salir..."
  exit 1
fi

# Instala Pillow si falta.
"$PY" -c "import PIL" >/dev/null 2>&1 || {
  echo "Instalando Pillow por única vez..."
  "$PY" -m pip install --user Pillow
}

"$PY" server.py
