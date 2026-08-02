#!/usr/bin/env python3
"""
N4DU Studio — opening the page in its own window.

Chrome and Edge can open a page as a plain window with no tabs and no
address bar (--app). That is the closest thing to a desktop window without
shipping a browser, and it is what the "compact window" setting uses.

Split out of shell_integration.py: finding a browser and launching it has
nothing to do with the registry, and keeping them together meant every edit
to either one opened a file twice the size it needed to be.

Standard library only.
"""

import os
import sys
import subprocess

# A small starting size so the window does not flash open large. The page
# then measures its own contents and settles on the right height — small for
# one file, taller for a big batch (see js/ui/window-size.js).
_APP_FLAGS = ("--app={url}", "--window-size=452,400")

_WINDOWS_CANDIDATES = (
    r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
    r"%PROGRAMFILES%\Google\Chrome\Application\chrome.exe",
    r"%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe",
    r"%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe",
    r"%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe",
    r"%LOCALAPPDATA%\Programs\Opera\opera.exe",
    r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe",
)

_MACOS_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
)

_LINUX_CANDIDATES = (
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "microsoft-edge", "brave-browser",
)


def find_app_browser():
    """A browser that understands --app, or None."""
    if os.name == "nt":
        for raw in _WINDOWS_CANDIDATES:
            path = os.path.expandvars(raw)
            if "%" not in path and os.path.isfile(path):
                return path
        return None
    if sys.platform == "darwin":
        for path in _MACOS_CANDIDATES:
            if os.path.isfile(path):
                return path
        return None
    from shutil import which
    for name in _LINUX_CANDIDATES:
        found = which(name)
        if found:
            return found
    return None


def open_app_window(url, browser=None, profile=None):
    """Opens the page in its own compact window. Returns True on success;
    the caller falls back to a normal browser tab when it returns False.

    profile: a folder for the window to keep its own browser state in.
    This matters more than it looks. When Chrome is ALREADY RUNNING, a
    second launch does not start a process — it hands the address to the
    running one, which sizes the window however it likes and throws
    --window-size away. Measured: asking for 640x560 with Chrome open gave
    1500x1000, the size of the existing window. With a profile of its own
    this launch is the first for that profile, so the size is honoured and
    the window opens right rather than opening large and shrinking.
    """
    exe = browser or find_app_browser()
    if not exe:
        return False
    argv = [exe] + [flag.format(url=url) for flag in _APP_FLAGS]
    if profile:
        argv += ["--user-data-dir=" + profile,
                 "--no-first-run", "--no-default-browser-check",
                 "--disable-features=Translate"]
    try:
        # Detached: the app window must outlive nothing in particular, but it
        # must not die with a launcher that exits straight away.
        kwargs = {}
        if os.name == "nt":
            kwargs["creationflags"] = 0x00000008  # DETACHED_PROCESS
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, **kwargs)
        return True
    except OSError:
        return False
