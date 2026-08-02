#!/usr/bin/env python3
"""
N4DU Studio — the facts the system integration is built on.

Where the app lives, which interpreter should run it, and what platform this
is. Both halves of the integration need these — the registry entry and the
Send To shortcut — so they live here rather than in either one, which is
what keeps sendto.py and shell_integration.py from importing each other.

Standard library only.
"""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(ROOT, "main.pyw")
ICON = os.path.join(ROOT, "assets", "n4du.ico")

MACOS_NOTE = ("On macOS the equivalent is a Quick Action in Automator; "
              "N4DU Studio does not install one yet.")
LINUX_NOTE = ("On Linux the entry depends on the desktop (Nautilus, Dolphin, "
              "Thunar each differ); N4DU Studio does not install one yet.")


def platform_name():
    if os.name == "nt":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def unsupported_reason():
    return {"macos": MACOS_NOTE, "linux": LINUX_NOTE}.get(platform_name(), "")


def winreg_module():
    """The winreg module, or None when this is not Windows. Kept behind a
    function so the tests can substitute a fake registry."""
    if os.name != "nt":
        return None
    import winreg
    return winreg


def shell_python():
    """The interpreter the menu entry should call.

    On Windows that is pythonw.exe: python.exe would flash a console window
    every time somebody right-clicks an image. The app shuts itself down when
    the page closes, so nothing is left running invisibly.
    """
    exe = sys.executable or "python"
    if os.name != "nt":
        return exe
    name = os.path.basename(exe).lower()
    if name.startswith("pythonw"):
        return exe                      # already the quiet one

    # Look in more than one place. Next to the interpreter is the usual
    # answer, but it is not the only one: inside a virtual environment the
    # console build sits in Scripts\ while the windowed build may only exist
    # in the base installation, and the "python3.exe" naming has its own
    # "pythonw3.exe" partner. Falling back to python.exe is what put a black
    # console on screen every time an image was right-clicked.
    stem = os.path.splitext(name)[0]                 # python, python3, ...
    windowed = "pythonw" + stem[len("python"):] if stem.startswith("python") else "pythonw"
    folders = [os.path.dirname(exe)]
    for attr in ("_base_executable", "base_prefix", "prefix", "exec_prefix"):
        value = getattr(sys, attr, None)
        if not value:
            continue
        folders.append(os.path.dirname(value) if attr == "_base_executable" else value)
    for folder in folders:
        for candidate in (windowed + ".exe", "pythonw.exe"):
            path = os.path.join(folder, candidate)
            if os.path.isfile(path):
                return path
    return exe


def command_line(python=None, entry=None):
    """The exact string stored in the registry. %1 is the file that was
    right-clicked; Windows substitutes its full path."""
    return '"{py}" "{entry}" --open "%1"'.format(
        py=python or shell_python(), entry=entry or ENTRY)
