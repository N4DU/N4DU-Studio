#!/usr/bin/env python3
"""
N4DU Studio — the Send To entry.

The right-click entry runs once per file — except it does not: Windows
invokes it only for the item under the cursor, and MultiSelectModel does not
change that for a verb under SystemFileAssociations (verified on a real
machine: the value is stored, the behaviour is unchanged).

Send To is the mechanism that does work. Windows passes the WHOLE selection
to one invocation, which is exactly what "select twenty images and open
them" needs. It is also older than the context menu itself, so it behaves
the same on every version.

Standard library only.
"""

import os
import subprocess

from shellbase import ENTRY, ICON, ROOT, shell_python

SENDTO_NAME = "N4DU Studio.lnk"

# Building a .lnk by hand means writing a binary shell-link structure.
# WScript.Shell has done it correctly since 1998 and ships with Windows, so
# PowerShell drives it instead — still no dependencies to install.
_SHORTCUT_PS = """
$ErrorActionPreference = 'Stop'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:N4DU_LNK)
$s.TargetPath = $env:N4DU_TARGET
$s.Arguments = $env:N4DU_ARGS
$s.WorkingDirectory = $env:N4DU_CWD
$s.IconLocation = $env:N4DU_ICON
$s.Description = 'Convert or edit these images with N4DU Studio'
$s.Save()
"""


def sendto_dir():
    base = os.environ.get("APPDATA")
    if not base:
        return None
    return os.path.join(base, "Microsoft", "Windows", "SendTo")


def sendto_path():
    folder = sendto_dir()
    return os.path.join(folder, SENDTO_NAME) if folder else None


def sendto_supported():
    """Can a Send To entry exist here at all? Only then is a missing one
    worth repairing — otherwise every launch on a machine without the
    folder would rewrite the registry for nothing."""
    folder = sendto_dir()
    return os.name == "nt" and bool(folder) and os.path.isdir(folder)


def sendto_installed():
    path = sendto_path()
    return bool(path) and os.path.isfile(path)


def install_sendto():
    """Puts N4DU Studio in the Send To menu. Returns True when it is there."""
    if os.name != "nt":
        return False
    path = sendto_path()
    if not path or not os.path.isdir(os.path.dirname(path)):
        return False
    env = dict(os.environ)
    env.update({
        "N4DU_LNK": path,
        "N4DU_TARGET": shell_python(),
        # Windows appends the selected files after these arguments, and
        # --open takes every path that follows it.
        "N4DU_ARGS": '"{}" --open'.format(ENTRY),
        "N4DU_CWD": ROOT,
        "N4DU_ICON": ICON if os.path.isfile(ICON) else shell_python(),
    })
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-Command", _SHORTCUT_PS],
            env=env, capture_output=True, text=True, timeout=30,
            creationflags=0x08000000)      # no console window flashes
        return proc.returncode == 0 and os.path.isfile(path)
    except (OSError, subprocess.SubprocessError):
        return False


def remove_sendto():
    path = sendto_path()
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass
