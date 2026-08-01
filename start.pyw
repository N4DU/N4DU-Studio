#!/usr/bin/env pythonw
"""
N4DU Studio — launcher for Windows. Double-click this one.

Why this file exists, and why it is not just main.py with another name:

Windows decides whether a program gets a console BEFORE that program runs a
single instruction. The loader reads one field out of the executable's
header — the subsystem — and acts on it:

    python.exe    IMAGE_SUBSYSTEM_WINDOWS_CUI   a console is created for it
    pythonw.exe   IMAGE_SUBSYSTEM_WINDOWS_GUI   no console, ever

Nothing the script does afterwards can undo that, because by then the window
already exists. Microsoft's own console specification says so outright: "if
the runtime chooses to hide the window, there will still be a brief period
during which that window is visible. It is inescapable."

So the console is not something to hide — it is something never to be given.
The only way to do that is for the program Windows launches to be the GUI
build, and the extension is what decides which one that is: .py belongs to
python.exe, .pyw belongs to pythonw.exe. That is the whole trick. It is also
exactly why the right-click entry has never shown a console: it names
pythonw.exe directly.

The same reasoning is why start.bat still flashes. cmd.exe is a console
program too, so Windows makes a window for it before the first line of the
batch file is read. A batch file cannot avoid its own console — this can.

Everything else lives in main.py; this only hands over to it. Files dropped
onto this launcher are passed straight through.
"""

import os
import sys
import runpy

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, "main.py")

if HERE not in sys.path:
    sys.path.insert(0, HERE)

if not os.path.isfile(MAIN):
    # No console to complain into, so say it in a way that can be seen.
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            None,
            "main.py is not next to this launcher.\n\n"
            "Keep start.pyw in the same folder as the rest of N4DU Studio.",
            "N4DU Studio", 0x30)
    except Exception:
        pass
    raise SystemExit(1)

# argv[0] is the script being run, the way main.py expects to find it. Anything
# after it — files dropped onto the launcher — is left untouched.
sys.argv = [MAIN] + sys.argv[1:]
runpy.run_path(MAIN, run_name="__main__")
