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
ENTRY = os.path.join(ROOT, "main.pyw")
ICON = os.path.join(ROOT, "assets", "n4du.ico")

VERB_KEY = "N4DUStudio"        # registry key name (never shown)
VERB_LABEL = "N4DU Studio"     # what the menu shows — the name, nothing else

# Without this, Windows runs the command only for the item actually under the
# cursor: select twelve images, right-click one, and eleven are silently
# dropped. "Document" means "invoke me once per selected file", which is what
# makes opening a whole selection work at all.
MULTI_SELECT_MODEL = "Document"

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


# ── Reading the current state ───────────────────────────────────────
def _read_value(reg, key_path, name):
    try:
        with reg.OpenKey(reg.HKEY_CURRENT_USER, key_path) as key:
            return reg.QueryValueEx(key, name)[0]
    except OSError:
        return None


def _read_command(reg, ext):
    """The command currently registered for this extension, or None."""
    return _read_value(reg, _KEY_FMT.format(ext=ext, verb=VERB_KEY) + r"\command", "")


def _read_multi(reg, ext):
    return _read_value(reg, _KEY_FMT.format(ext=ext, verb=VERB_KEY), "MultiSelectModel")


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
        # Stale covers two things: a command pointing at another folder, and
        # an entry registered before multi-selection was handled. Both are
        # repaired by switching the setting off and on again.
        if (current.strip().lower() != expected.strip().lower()
                or _read_multi(reg, ext) != MULTI_SELECT_MODEL):
            stale.append(ext)

    base["installed"] = installed
    base["sendTo"] = sendto_installed()
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
        raise RuntimeError("main.pyw is not where it was expected: " + ENTRY)

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
                reg.SetValueEx(key, "MultiSelectModel", 0, reg.REG_SZ, MULTI_SELECT_MODEL)
                if icon:
                    reg.SetValueEx(key, "Icon", 0, reg.REG_SZ, icon)
            with reg.CreateKey(reg.HKEY_CURRENT_USER, key_path + r"\command") as key:
                reg.SetValueEx(key, "", 0, reg.REG_SZ, command)
    except OSError as exc:
        # Never leave half of the extensions registered: undo and report.
        for ext in touched:
            _remove_ext(reg, ext)
        raise RuntimeError("Windows refused the change: {}".format(exc))
    # Send To goes in alongside: it is the only route that hands over a whole
    # selection, so the two belong to the same switch.
    install_sendto()
    notify_shell()
    return status()


def disable():
    """Removes exactly the keys enable() creates, and nothing else."""
    reg = _winreg()
    if reg is None:
        raise RuntimeError(_unsupported_reason() or "Not supported on this system.")
    for ext in EXTENSIONS:
        _remove_ext(reg, ext)
    remove_sendto()
    notify_shell()
    return status()


# ── Send To ─────────────────────────────────────────────────────────
# The right-click entry runs once per file — except it does not: Windows
# invokes it only for the item under the cursor, and MultiSelectModel does
# not change that for a verb under SystemFileAssociations (verified on a
# real machine: the value is stored, the behaviour is unchanged).
#
# Send To is the mechanism that does work. Windows passes the WHOLE
# selection to one invocation, which is exactly what "select twenty images
# and open them" needs. It is also older than the context menu itself, so
# it behaves the same on every version.
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


def notify_shell():
    """Tells Explorer the file associations changed.

    Without this Windows keeps serving the menu it already had in memory, so
    a corrected entry looks like it did not take — the old behaviour survives
    until Explorer is restarted or the machine is rebooted.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        SHCNE_ASSOCCHANGED = 0x08000000
        SHCNF_IDLIST = 0x0000
        ctypes.windll.shell32.SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None)
        return True
    except Exception:
        return False


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


def repair_if_stale():
    """Brings an out-of-date registration up to date, without being asked.

    Relying on somebody remembering to toggle a setting is how a fix fails to
    reach the machine that needs it. If the entry is there but wrong — an
    older version's values, or a folder that moved — this quietly rewrites
    it at launch. It never turns the feature ON: only repairs what the user
    already chose.
    """
    try:
        st = status()
    except Exception:
        return None
    if not st["supported"] or not st["installed"]:
        return None
    missing_sendto = sendto_supported() and not st.get("sendTo")
    if not st["stale"] and not missing_sendto:
        return None
    try:
        return enable()
    except RuntimeError:
        return None


def dump():
    """Everything actually stored, verbatim. For working out why the menu is
    behaving the way it is on a machine we cannot see."""
    reg = _winreg()
    lines = ["platform: " + platform_name()]
    if reg is None:
        lines.append("registry: not available on this system")
        return "\n".join(lines)
    lines.append("expected command: " + command_line())
    # Whether the menu entry opens a console is decided entirely by this one
    # file name: pythonw.exe is silent, python.exe puts a black window on
    # screen. Worth stating outright rather than making it be deduced from
    # the command string.
    chosen = shell_python()
    lines.append("interpreter: {}  ({})".format(
        chosen,
        "silent" if os.path.basename(chosen).lower().startswith("pythonw")
        else "WILL SHOW A CONSOLE — pythonw.exe was not found"))
    lines.append("send to entry: {}  ({})".format(
        "yes" if sendto_installed() else "NO", sendto_path()))
    lines.append("")
    for ext in EXTENSIONS:
        key = _KEY_FMT.format(ext=ext, verb=VERB_KEY)
        cmd = _read_command(reg, ext)
        if cmd is None:
            lines.append("{:<7} not registered".format(ext))
            continue
        lines.append("{:<7} MultiSelectModel={!r}  MUIVerb={!r}".format(
            ext, _read_multi(reg, ext), _read_value(reg, key, "MUIVerb")))
        lines.append("        command={!r}".format(cmd))
    return "\n".join(lines)


def describe(st):
    if not st["supported"]:
        return "Right-click entry: not available on {}. {}".format(
            st["platform"], st.get("reason", ""))
    if st["enabled"]:
        return ("Right-click entry: ON for {} image types\n"
                "  Send To entry: {}\n  {}").format(
            len(st["installed"]),
            "yes" if st.get("sendTo") else "MISSING",
            st.get("command", ""))
    if st["stale"]:
        return ("Right-click entry: registered, but pointing somewhere else "
                "(the app was moved). Switch it off and on again to repair.")
    if st["partial"]:
        return "Right-click entry: partly registered ({} of {} types)".format(
            len(st["installed"]), len(st["extensions"]))
    return "Right-click entry: OFF"


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
