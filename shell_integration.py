#!/usr/bin/env python3
"""
N4DU Studio — system integration.

Adds (or removes) the entry that appears when you right-click an image file
in the file manager: "Edit with N4DU Studio", with the logo next to it.
Choosing it launches this app with the real path of that file, which is what
lets Replace overwrite it in place.

Everything here is written to the CURRENT USER only — no administrator
rights, nothing touched outside your own account, and disabling removes
exactly what enabling created.

Standard library only. Windows uses the registry; macOS and Linux report
themselves as unsupported for now (see MACOS_NOTE / LINUX_NOTE) rather than
pretending to work.
"""

import os
import sys
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(ROOT, "main.py")
ICON = os.path.join(ROOT, "assets", "n4du.ico")

VERB_KEY = "N4DUStudio"                 # registry key name (never shown)
VERB_LABEL = "Edit with N4DU Studio"    # what the menu shows

# Only image types. Registering "all files" would put us in every menu on the
# machine, which is exactly the kind of thing people uninstall software over.
EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".avif",
    ".gif", ".bmp", ".ico", ".tif", ".tiff", ".svg",
)

# Where Windows keeps per-user, per-extension context menu verbs.
_KEY_FMT = r"Software\Classes\SystemFileAssociations\{ext}\shell\{verb}"

MACOS_NOTE = ("On macOS the equivalent is a Quick Action in Automator; "
              "N4DU Studio does not install one yet.")
LINUX_NOTE = ("On Linux the entry depends on the desktop (Nautilus, Dolphin, "
              "Thunar each differ); N4DU Studio does not install one yet.")


# ── Platform ────────────────────────────────────────────────────────
def _winreg():
    """The winreg module, or None when this is not Windows. Kept behind a
    function so the tests can substitute a fake registry."""
    if os.name != "nt":
        return None
    import winreg
    return winreg


def platform_name():
    if os.name == "nt":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def _unsupported_reason():
    return {"macos": MACOS_NOTE, "linux": LINUX_NOTE}.get(platform_name(), "")


# ── The command the menu entry runs ─────────────────────────────────
def shell_python():
    """The interpreter the menu entry should call.

    On Windows that is pythonw.exe: python.exe would flash a console window
    every time somebody right-clicks an image. The app shuts itself down when
    the page closes, so nothing is left running invisibly.
    """
    exe = sys.executable or "python"
    if os.name == "nt" and os.path.basename(exe).lower() == "python.exe":
        quiet = os.path.join(os.path.dirname(exe), "pythonw.exe")
        if os.path.isfile(quiet):
            return quiet
    return exe


def command_line(python=None, entry=None):
    """The exact string stored in the registry. %1 is the file that was
    right-clicked; Windows substitutes its full path."""
    return '"{py}" "{entry}" --open "%1"'.format(
        py=python or shell_python(), entry=entry or ENTRY)


# ── Reading the current state ───────────────────────────────────────
def _read_command(reg, ext):
    """The command currently registered for this extension, or None."""
    key_path = _KEY_FMT.format(ext=ext, verb=VERB_KEY) + r"\command"
    try:
        with reg.OpenKey(reg.HKEY_CURRENT_USER, key_path) as key:
            return reg.QueryValueEx(key, "")[0]
    except OSError:
        return None


def status():
    """What the integration looks like right now.

    enabled  — every image extension points at this copy of the app
    partial  — some extensions are registered (half-finished, or the list grew)
    stale    — registered, but pointing at a different folder or interpreter
               (the app was moved, or Python was reinstalled)
    """
    reg = _winreg()
    base = {
        "platform": platform_name(),
        "supported": reg is not None,
        "enabled": False,
        "partial": False,
        "stale": False,
        "extensions": list(EXTENSIONS),
        "installed": [],
        "label": VERB_LABEL,
    }
    if reg is None:
        base["reason"] = _unsupported_reason()
        return base

    expected = command_line()
    installed, stale = [], []
    for ext in EXTENSIONS:
        current = _read_command(reg, ext)
        if current is None:
            continue
        installed.append(ext)
        if current.strip().lower() != expected.strip().lower():
            stale.append(ext)

    base["installed"] = installed
    base["enabled"] = len(installed) == len(EXTENSIONS) and not stale
    base["partial"] = 0 < len(installed) < len(EXTENSIONS)
    base["stale"] = bool(stale)
    base["command"] = expected
    return base


# ── Turning it on and off ───────────────────────────────────────────
def enable():
    """Registers the entry for every image extension.

    Re-running is safe and is also the repair path: the values are
    overwritten, so a stale command (app moved to another folder) is
    corrected by switching the setting off and on again.
    """
    reg = _winreg()
    if reg is None:
        raise RuntimeError(_unsupported_reason() or "Not supported on this system.")
    if not os.path.isfile(ENTRY):
        raise RuntimeError("main.py is not where it was expected: " + ENTRY)

    command = command_line()
    icon = ICON if os.path.isfile(ICON) else None
    # Tracks the extension being written, not only the finished ones: a
    # refusal between the verb key and its command subkey would otherwise
    # leave a menu entry that does nothing when clicked.
    touched = []
    try:
        for ext in EXTENSIONS:
            touched.append(ext)
            key_path = _KEY_FMT.format(ext=ext, verb=VERB_KEY)
            with reg.CreateKey(reg.HKEY_CURRENT_USER, key_path) as key:
                # MUIVerb is the label; Icon is the logo shown beside it.
                reg.SetValueEx(key, "MUIVerb", 0, reg.REG_SZ, VERB_LABEL)
                if icon:
                    reg.SetValueEx(key, "Icon", 0, reg.REG_SZ, icon)
            with reg.CreateKey(reg.HKEY_CURRENT_USER, key_path + r"\command") as key:
                reg.SetValueEx(key, "", 0, reg.REG_SZ, command)
    except OSError as exc:
        # Never leave half of the extensions registered: undo and report.
        for ext in touched:
            _remove_ext(reg, ext)
        raise RuntimeError("Windows refused the change: {}".format(exc))
    return status()


def disable():
    """Removes exactly the keys enable() creates, and nothing else."""
    reg = _winreg()
    if reg is None:
        raise RuntimeError(_unsupported_reason() or "Not supported on this system.")
    for ext in EXTENSIONS:
        _remove_ext(reg, ext)
    return status()


def _remove_ext(reg, ext):
    key_path = _KEY_FMT.format(ext=ext, verb=VERB_KEY)
    # The command subkey has to go first: Windows will not delete a key that
    # still has children.
    for path in (key_path + r"\command", key_path):
        try:
            reg.DeleteKey(reg.HKEY_CURRENT_USER, path)
        except OSError:
            pass  # already gone, which is the desired end state anyway


# ── The compact window ──────────────────────────────────────────────
# Chrome and Edge can open a page as its own small window with no tabs or
# address bar (--app). That is the closest thing to a desktop window without
# shipping a browser, and it is what the "compact window" setting uses.
# Sized for the converter, which is a narrow column. Big enough for the
# editor to be usable if you switch, and you can always maximise.
_APP_FLAGS = ("--app={url}", "--window-size=840,900")

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


def open_app_window(url, browser=None):
    """Opens the page in its own compact window. Returns True on success;
    the caller falls back to a normal browser tab when it returns False."""
    exe = browser or find_app_browser()
    if not exe:
        return False
    argv = [exe] + [flag.format(url=url) for flag in _APP_FLAGS]
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


# ── Command line (useful for support, and for tests) ────────────────
def _cli(argv):
    action = argv[0] if argv else "status"
    if action == "enable":
        print(describe(enable()))
    elif action == "disable":
        print(describe(disable()))
    elif action == "status":
        print(describe(status()))
    else:
        print("usage: python shell_integration.py [status|enable|disable]")
        return 2
    return 0


def describe(st):
    if not st["supported"]:
        return "Right-click entry: not available on {}. {}".format(
            st["platform"], st.get("reason", ""))
    if st["enabled"]:
        return "Right-click entry: ON for {} image types\n  {}".format(
            len(st["installed"]), st.get("command", ""))
    if st["stale"]:
        return ("Right-click entry: registered, but pointing somewhere else "
                "(the app was moved). Switch it off and on again to repair.")
    if st["partial"]:
        return "Right-click entry: partly registered ({} of {} types)".format(
            len(st["installed"]), len(st["extensions"]))
    return "Right-click entry: OFF"


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
