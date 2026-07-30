#!/usr/bin/env bash
# N4DU Studio - launcher for macOS / Linux (double-click on macOS).
# No dependencies: the Python standard library is enough.
cd "$(dirname "$0")" || exit 1

PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo ""
  echo "  Python was not found on this machine."
  echo "  Install it from https://www.python.org/downloads/"
  echo ""
  read -r -p "Press Enter to close..."
  exit 1
fi

"$PY" main.py
