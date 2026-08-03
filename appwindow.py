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

# The size the window should already be when it appears.
#
# 452 wide and 440 of PAGE is what the converter asks for with nothing in it
# and with one picture alike (MIN_H in js/ui/window-size.js). This flag is
# the whole window though, frame included, so it carries an allowance for
# the title bar an --app window still draws: about 34 pixels on Windows,
# rather more on Linux. It is an estimate and it is meant to be — whatever
# is left over, the page corrects the moment it loads, in one step and
# without animating it.
#
# 400 was the old value, chosen "so the window does not flash open large".
# It flashed open SHORT instead, and then grew in front of you, which is the
# same fault the other way round.
_APP_FLAGS = ("--app={url}", "--window-size={w},{h}")
# Used until the page has told us what the window really came out as — see
# load_window_size() in appstate.py. 440 of page plus about 34 for the title
# bar an --app window still draws on Windows.
DEFAULT_SIZE = (452, 474)

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


def open_app_window(url, browser=None, profile=None, size=None):
    """Opens the page in its own compact window. Returns True on success;
    the caller falls back to a normal browser tab when it returns False.

    size: (width, height) of the whole window, frame included. The page
    remembers what it settled on last time and it is passed back in here, so
    the window opens at the right size rather than opening at a guess and
    correcting itself in front of you.

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
    w, h = size or DEFAULT_SIZE
    argv = [exe] + [flag.format(url=url, w=w, h=h) for flag in _APP_FLAGS]
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
