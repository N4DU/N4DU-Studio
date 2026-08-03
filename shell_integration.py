#!/usr/bin/env python3
"""
N4DU Studio — the right-click entry.

Adds (or removes) the entry that appears when you right-click an image file
in the file manager: "Edit with N4DU Studio", with the logo next to it.
Choosing it launches this app with the real path of that file, which is what
lets Replace overwrite it in place.

Everything here is written to the CURRENT USER only — no administrator
rights, nothing touched outside your own account, and disabling removes
exactly what enabling created.

Standard library only. Windows uses the registry; macOS and Linux report
themselves as unsupported for now (see shellbase) rather than pretending to
work. Two neighbours carry the rest: sendto.py builds the Send To shortcut,
appwindow.py opens the page in its own window.
"""

import os
import sys

from shellbase import (
    ENTRY, ICON, LINUX_NOTE, MACOS_NOTE, ROOT,
    command_line, platform_name, shell_python, unsupported_reason,
    winreg_module as _winreg,
)
from sendto import (
    install_sendto, remove_sendto, sendto_dir, sendto_installed,
    sendto_path, sendto_supported,
)
from appwindow import find_app_browser, open_app_window

__all__ = [
    "EXTENSIONS", "VERB_KEY", "VERB_LABEL", "ROOT", "ENTRY", "ICON",
    "MACOS_NOTE", "LINUX_NOTE", "platform_name", "shell_python",
    "command_line", "status", "enable", "disable", "repair_if_stale",
    "dump", "describe", "notify_shell",
    "sendto_dir", "sendto_path", "sendto_supported", "sendto_installed",
    "install_sendto", "remove_sendto",
    "find_app_browser", "open_app_window",
]

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

# And where it keeps the two ways of right-clicking a FOLDER, which are not
# the same thing and both have to be registered separately:
#
#   Directory              the folder's own icon, right-clicked from outside
#   Directory\Background    empty space INSIDE the folder, with nothing selected
#
# They also need different arguments. The first gets %1, the folder that was
# clicked. The second gets %V, "the folder this window is showing" — %1 there
# is nothing at all, which is why a Background entry written like the other
# one opens the program on no files and looks broken.
_DIR_KEYS = (
    (r"Software\Classes\Directory\shell\{verb}", "%1"),
    (r"Software\Classes\Directory\Background\shell\{verb}", "%V"),
)

_unsupported_reason = unsupported_reason


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
        base["reason"] = unsupported_reason()
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
        raise RuntimeError(unsupported_reason() or "Not supported on this system.")
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
    # Folders, both ways of right-clicking one. Written after the extensions
    # so a refusal here leaves the file entry working rather than half of it.
    for template, arg in _DIR_KEYS:
        key_path = template.format(verb=VERB_KEY)
        try:
            with reg.CreateKey(reg.HKEY_CURRENT_USER, key_path) as key:
                reg.SetValueEx(key, "MUIVerb", 0, reg.REG_SZ, VERB_LABEL)
                if icon:
                    reg.SetValueEx(key, "Icon", 0, reg.REG_SZ, icon)
            with reg.CreateKey(reg.HKEY_CURRENT_USER, key_path + r"\command") as key:
                reg.SetValueEx(key, "", 0, reg.REG_SZ,
                               command_line(entry=ENTRY).replace('"%1"', f'"{arg}"'))
        except OSError:
            pass    # a folder entry is a bonus; the file entries are the point

    # Send To goes in alongside: it is the only route that hands over a whole
    # selection, so the two belong to the same switch.
    install_sendto()
    notify_shell()
    return status()


def disable():
    """Removes exactly the keys enable() creates, and nothing else."""
    reg = _winreg()
    if reg is None:
        raise RuntimeError(unsupported_reason() or "Not supported on this system.")
    for ext in EXTENSIONS:
        _remove_ext(reg, ext)
    for template, _ in _DIR_KEYS:
        key_path = template.format(verb=VERB_KEY)
        for full in (key_path + r"\command", key_path):
            try:
                reg.DeleteKey(reg.HKEY_CURRENT_USER, full)
            except OSError:
                pass
    remove_sendto()
    notify_shell()
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


# ── Repair ──────────────────────────────────────────────────────────
# One Send To attempt per run — see repair_if_stale().
_sendto_tried = False


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
    # The Send To shortcut can be impossible to create rather than merely
    # missing: PowerShell blocked by policy, the COM object disabled, a
    # roaming profile that discards it. sendto_supported() only says the
    # FOLDER is there, so on such a machine this repaired on every single
    # launch — twelve extensions rewritten into the registry and a PowerShell
    # spawn with a thirty-second timeout, before the right-clicked image
    # could open. One attempt per run is enough; a real repair still happens
    # the moment the registry itself goes stale.
    global _sendto_tried
    missing_sendto = (sendto_supported() and not st.get("sendTo")
                      and not _sendto_tried)
    if not st["stale"] and not missing_sendto:
        return None
    if missing_sendto:
        _sendto_tried = True
    try:
        return enable()
    except RuntimeError:
        return None


# ── Saying what is there (for support, and for tests) ───────────────
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


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
