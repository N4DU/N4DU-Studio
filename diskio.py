"""Everything N4DU Studio does to files on disk.

This is the whole reason the bridge exists. A browser can decode and encode
images perfectly well on its own; what it cannot do is open the operating
system's file dialog, or write a converted picture back over the original.
Both of those live here.

The rules this module exists to enforce:

  * a name that came from the browser is never trusted — it is stripped of
    paths, control characters, reserved device names and anything that would
    let it escape its folder;
  * a replacement is written to a temp file, fsync'd, then moved into place
    with os.replace, so an interrupted write can never leave a half-finished
    image where a real one used to be;
  * an existing, unrelated file at the target is never overwritten silently —
    FileExistsError goes back to the interface so it can ask.

Imported by main.py; no dependency in the other direction.
"""

import os
import sys
import secrets
import subprocess

PICK_TIMEOUT = 600                 # a dialog left open this long is abandoned

# What we can WRITE.
ALLOWED_EXT = {"png", "jpg", "webp", "avif", "bmp", "ico"}

# What we can OPEN. Wider than ALLOWED_EXT on purpose: anything the browser
# can decode is fine to open, even if we would never save in that format.
OPENABLE_EXT = {"png", "jpg", "jpeg", "jfif", "webp", "avif", "gif",
                "bmp", "ico", "tif", "tiff", "svg"}


# ── Native dialog (in a subprocess: tkinter needs its own main thread) ──
# Paths come back one per line: a file name can contain almost anything
# except a newline, so this is the one separator that cannot be ambiguous.
_PICKER_SCRIPT = """
import sys, tkinter as tk
from tkinter import filedialog
title = sys.argv[1] if len(sys.argv) > 1 else "N4DU Studio"
many = len(sys.argv) > 2 and sys.argv[2] == "many"
root = tk.Tk(); root.withdraw()
root.attributes("-topmost", True)
kinds = [
    ("Images", "*.png *.jpg *.jpeg *.jfif *.webp *.avif *.gif *.bmp *.ico *.svg *.tif *.tiff"),
    ("All files", "*.*")]
if many:
    paths = list(root.tk.splitlist(filedialog.askopenfilenames(title=title, filetypes=kinds)))
else:
    one = filedialog.askopenfilename(title=title, filetypes=kinds)
    paths = [one] if one else []
sys.stdout.write("\\n".join(p for p in paths if p))
"""

_PICK_TITLES = {
    "open":      "N4DU Studio - Open image",
    "open-many": "N4DU Studio - Choose images to convert",
    "target":    "N4DU Studio - Choose the file to replace",
}


def native_pick(intent="open"):
    """Returns the chosen paths as a list ([] if cancelled), or raises when
    tkinter is unavailable."""
    test = os.environ.get("N4DU_TEST_PICK")  # hook for automated tests
    if test is not None:
        return [p for p in test.split("\n") if p]
    title = _PICK_TITLES.get(intent, _PICK_TITLES["open"])
    mode = "many" if intent == "open-many" else "one"
    # utf-8 on both ends: the child writes the chosen path to the pipe, and
    # on a Western-locale Windows console a Cyrillic or CJK filename raised
    # UnicodeEncodeError there — reported back to the user, wrongly, as
    # "tkinter is missing".
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    try:
        proc = subprocess.run([sys.executable, "-c", _PICKER_SCRIPT, title, mode],
                              capture_output=True, encoding="utf-8", env=env,
                              timeout=PICK_TIMEOUT)
    except subprocess.TimeoutExpired:
        # A dialog nobody ever answers must not pin a handler thread and an
        # interpreter for the rest of the session.
        return []
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        raise RuntimeError(
            "Could not open the system dialog"
            + (f" ({detail[-1][:120]})" if detail else "")
            + ". Use the browser picker; replacing files will be unavailable.")
    return [p for p in (proc.stdout or "").split("\n") if p.strip()]


# ── Replacing files on disk ─────────────────────────────────────────
# Names Windows reserves for devices: such a file cannot be created (or
# behaves strangely), so an underscore is appended.
_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}


def _safe_stem(name):
    """File name with no path and no invalid characters (defence in depth:
    the front end already sanitises, but the server does not trust it)."""
    name = os.path.basename(name or "")           # drop any path
    # Only drop an extension we actually recognise: splitext() turned
    # "render v1.2" into "render v1", and the original was then deleted
    # under its old name — a silent rename nobody asked for.
    stem, ext = os.path.splitext(name)
    if ext.lower().lstrip(".") in OPENABLE_EXT | ALLOWED_EXT:
        name = stem
    for ch in '\\/:*?"<>|':
        name = name.replace(ch, "")
    name = "".join(c for c in name if ord(c) >= 32)   # no control characters
    # Windows does not allow trailing dots or spaces in a name.
    name = name.strip().strip(".").strip()
    if name.lower() in _WINDOWS_RESERVED:
        name += "_"
    return name[:180]      # every filesystem has a limit; 255 bytes is common


def target_path(original, ext, new_stem=None):
    """The path a replacement would produce, without writing anything."""
    if ext not in ALLOWED_EXT:
        raise ValueError(f"Extension not allowed: {ext}")
    folder = os.path.dirname(original)
    stem = _safe_stem(new_stem) if new_stem else os.path.splitext(os.path.basename(original))[0]
    if not stem:
        raise ValueError("Empty file name.")
    target = os.path.join(folder, f"{stem}.{ext}")
    if os.path.dirname(os.path.abspath(target)) != os.path.abspath(folder):
        raise ValueError("Invalid file name.")
    return target


def replace_file(original, data, ext, new_stem=None, overwrite=False):
    """Writes the bytes into the original's folder under the new extension
    (and name, when given), atomically, then deletes the previous file if the
    resulting path changed.

    If the target is a DIFFERENT file that already exists, nothing is
    overwritten: FileExistsError is raised so the interface can ask for
    confirmation. Without this, a repeated name would destroy two files —
    the unrelated one and the original.

    Returns (final_path, warning_or_None).
    """
    target = target_path(original, ext, new_stem)
    # Not a string comparison. On Windows and macOS the filesystem is
    # case-insensitive, so IMG.PNG and IMG.png are ONE file while comparing
    # unequal — the code then wrote the new bytes and deleted "the original",
    # which was the same file. samefile() asks the filesystem instead.
    same_file = os.path.exists(target) and os.path.samefile(target, original)

    if not same_file and os.path.exists(target) and not overwrite:
        raise FileExistsError(os.path.basename(target))

    folder = os.path.dirname(original)
    stem = os.path.splitext(os.path.basename(target))[0]
    tmp = os.path.join(folder, f".{stem}.{secrets.token_hex(4)}.tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())   # bytes hit the disk before publishing
        os.replace(tmp, target)     # atomic: never leaves a half-written file
    except Exception:
        # A full disk or a vanished network drive used to leave the hidden
        # temp file behind, one per attempt, invisible and never cleaned up.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    # The new file is already on disk: from here nothing can fail in a way
    # that loses work, so a failed delete is only reported as a warning.
    warning = None
    if not same_file:
        try:
            os.remove(original)
        except FileNotFoundError:
            pass
        except OSError as exc:
            warning = f"Could not delete {os.path.basename(original)} ({exc.strerror})."
    return target, warning


def _natural_key(name):
    """Sorts page 2 before page 10, the way a person reading a folder of
    scans expects."""
    parts = []
    digits = ""
    for ch in name.lower():
        # ASCII only: '²'.isdigit() is True but int('²') raises, and one such
        # character in one filename broke sorting for the entire folder.
        if ch.isascii() and ch.isdigit():
            digits += ch
        else:
            if digits:
                parts.append((1, int(digits), ""))
                digits = ""
            parts.append((0, 0, ch))
    if digits:
        parts.append((1, int(digits), ""))
    return parts


def openable(path):
    """Is this something we should open? Returns (ok, reason).

    Checked here rather than trusted from the caller: the right-click entry
    is wired to image types, but the command line can be typed by hand.
    """
    if not path or not isinstance(path, str):
        return False, "No file given."
    if not os.path.isfile(path):
        return False, "That file does not exist: " + path
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext not in OPENABLE_EXT:
        return False, "Not an image N4DU Studio can open: ." + ext
    return True, ""
