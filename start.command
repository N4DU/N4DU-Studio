#!/usr/bin/env bash
# N4DU Studio - the technical way in, for macOS and Linux.
#
# The counterpart to start.bat: it runs the bridge with the full log in the
# terminal and leaves it running when the window is closed, so you can watch
# what is happening behind the interface.
#
# For the app on its own, run main.pyw.
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

"$PY" main.pyw --console "$@"

echo ""
echo "  The bridge has stopped."
read -r -p "Press Enter to close..."
