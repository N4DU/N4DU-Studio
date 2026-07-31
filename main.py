#!/usr/bin/env python3
"""
N4DU Studio — disk bridge (optional).

The app processes images entirely in the browser and works on its own: open
index.html directly or host it anywhere. This program adds the one thing a
browser cannot do — open files through the operating system dialog and
REPLACE files on disk, even when the format changes.

No dependencies: the Python 3.8+ standard library only.
Binds to 127.0.0.1 exclusively (your machine; never exposed to the network).

    python3 main.py                 # or double-click start.bat / start.command
    python3 main.py --open PIC.PNG  # open that file (used by the right-click entry)

Stops with Ctrl+C, or on its own: when the page closes it waits a few
seconds in case it was a reload, then shuts down if nobody returns.
"""

import os
import sys
import json
import time
import atexit
import secrets
import shutil
import mimetypes
import subprocess
import threading
import webbrowser
import urllib.error
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, urlencode

ROOT = os.path.dirname(os.path.abspath(__file__))

# Our own folder, ahead of the import: normally Python puts a script's
# directory first anyway, but not when main.py is loaded from somewhere else
# (a wrapper, an embedded interpreter, a test harness). Without this the
# sibling module would go missing depending on how the app was started.
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import shell_integration  # noqa: E402  (needs the path fixed up first)

HOST = "127.0.0.1"
PORTS = range(4517, 4537)          # first free port in this range
GRACE_SECONDS = 3                  # wait after the page closes (was it a reload?)
# No heartbeat for this long → the page is considered gone. Deliberately
# generous: browsers throttle timers in background tabs (down to about one
# per minute), so a short threshold would shut the server down while it is
# still in use. Normal shutdown does not rely on this — /api/bye is instant.
STALL_SECONDS = 150
# Remembered files (oldest is evicted). Generous on purpose: a batch can be
# hundreds of files, and every one needs its token to stay valid until it is
# replaced — an evicted token means "Replace originals" silently skips it.
MAX_SESSIONS = 600
MAX_SIBLINGS = 400                 # matches the converter's list limit
ALLOWED_EXT = {"png", "jpg", "webp", "avif", "bmp", "ico"}

# Per-run secret. Authenticates /api/bye, which cannot require headers
# because sendBeacon does not send them: without this, any website open in
# another tab could shut the server down.
SECRET = secrets.token_urlsafe(24)

# Open files: ephemeral token -> real path. The browser only ever sees
# tokens; no endpoint accepts an arbitrary path.
_files = OrderedDict()
_lock = threading.Lock()

# Page state (drives the auto-shutdown).
# expected_until: a window has just been launched but has not reported in
# yet. Without it, twenty images right-clicked at once would each decide
# "no page is running" and open twenty windows.
_page = {"connected": False, "last_ping": 0.0, "closing_since": None,
         "expected_until": 0.0}

# Files handed over while a window was already open. The page collects them
# on its next heartbeat, so they join the list it is already showing.
_pending = []
_shutdown = {"event": threading.Event(), "reason": ""}

# Images the right-click entry is allowed to hand over. Wider than
# ALLOWED_EXT (which is about what we can WRITE); anything the browser can
# decode is fine to OPEN.
OPENABLE_EXT = {"png", "jpg", "jpeg", "jfif", "webp", "avif", "gif",
                "bmp", "ico", "tif", "tiff", "svg"}


# ── Where settings and the running-instance marker live ─────────────
def state_dir(create=False):
    """A per-user folder outside the app, so the settings survive moving,
    updating or re-downloading the program.

    Only created when something is actually about to be written into it:
    merely asking where it would be must not conjure it into existence, or
    "leave no trace" could never finish.
    """
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        path = os.path.join(base, "N4DU Studio")
    elif sys.platform == "darwin":
        path = os.path.expanduser("~/Library/Application Support/N4DU Studio")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
        path = os.path.join(base, "n4du-studio")
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def _state_file(name, create=False):
    return os.path.join(state_dir(create), name)


DEFAULT_SETTINGS = {
    # Open in a small window of its own instead of a browser tab.
    "appWindow": True,
}


def load_settings():
    try:
        with open(_state_file("settings.json"), "r", encoding="utf-8") as fh:
            saved = json.load(fh)
    except (OSError, ValueError):
        saved = {}
    settings = dict(DEFAULT_SETTINGS)
    for key, default in DEFAULT_SETTINGS.items():
        if isinstance(saved.get(key), type(default)):
            settings[key] = saved[key]
    return settings


def save_settings(settings):
    # Nothing worth storing → store nothing. A settings file that only says
    # "everything is default" is litter in the user's profile.
    if all(settings.get(k) == v for k, v in DEFAULT_SETTINGS.items()):
        _forget("settings.json")
        return
    try:
        with open(_state_file("settings.json", create=True), "w", encoding="utf-8") as fh:
            json.dump(settings, fh, indent=2)
    except OSError:
        pass  # settings are a convenience; failing to store them is not fatal


def _forget(name):
    try:
        os.remove(_state_file(name))
    except OSError:
        pass


def tidy_state():
    """Leaves nothing behind once there is nothing to remember.

    Turning the right-click entry off should undo everything the program put
    on the machine — not leave a folder with a file in it saying "off". The
    folder itself goes too, as soon as the last live file (this run's
    session marker) is gone.
    """
    save_settings(load_settings())      # drops settings.json when all default
    try:
        leftovers = set(os.listdir(state_dir())) - {"session.json", "start.lock", "browser"}
    except OSError:
        return False
    if leftovers:
        return False
    _state["purge_on_exit"] = True      # the marker is still in use right now
    return True


def purge_state():
    """Removes the folder entirely. Safe to call when nothing is running."""
    for name in ("settings.json", "session.json", "start.lock"):
        _forget(name)
    # The window's own browser profile is ours too, so it goes as well.
    try:
        shutil.rmtree(os.path.join(state_dir(), "browser"), ignore_errors=True)
    except OSError:
        pass
    try:
        os.rmdir(state_dir())
        return True
    except OSError:
        return False      # something else is in there; leave it alone


_state = {"purge_on_exit": False}


# ── Running-instance marker ─────────────────────────────────────────
# Lets a second launch (someone right-clicking another image) hand the file
# to the copy that is already running instead of starting a second server.
def write_session(port):
    data = {"port": port, "secret": SECRET, "pid": os.getpid()}
    try:
        with open(_state_file("session.json", create=True), "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        # Readable by this user only where the platform supports it.
        if os.name != "nt":
            os.chmod(_state_file("session.json"), 0o600)
    except OSError:
        pass


def clear_session():
    """Removes the marker, but only if it is still ours: a newer instance
    may already have taken over."""
    try:
        with open(_state_file("session.json"), "r", encoding="utf-8") as fh:
            if json.load(fh).get("pid") != os.getpid():
                return
        os.remove(_state_file("session.json"))
    except (OSError, ValueError):
        pass
    # Asked to leave nothing behind: with the marker gone, the folder can go.
    if _state["purge_on_exit"]:
        purge_state()


LOCK_STALE = 25          # seconds before a start lock is assumed abandoned


def acquire_start_lock():
    """Wins the right to start the server, or returns False.

    Right-clicking twenty images launches twenty processes at once. Without
    this they would all find no session marker and all start a server —
    twenty ports, twenty windows. Exactly one gets the lock; the rest wait
    for its marker and hand their file over.
    """
    lock = _state_file("start.lock", create=True)
    try:
        # O_EXCL is the atomic part: the filesystem picks the winner.
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        try:
            # A crash could leave the lock behind for ever; ignore an old one.
            if time.time() - os.path.getmtime(lock) > LOCK_STALE:
                os.remove(lock)
                return acquire_start_lock()
        except OSError:
            pass
        return False
    except OSError:
        return True      # cannot lock (odd filesystem): carrying on beats hanging


def release_start_lock():
    try:
        os.remove(_state_file("start.lock"))
    except OSError:
        pass


def read_session():
    try:
        with open(_state_file("session.json"), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data.get("port"), int) and isinstance(data.get("secret"), str):
            return data
    except (OSError, ValueError):
        pass
    return None


# ── Console ─────────────────────────────────────────────────────────
# There may be no console at all. The right-click entry launches the program
# with pythonw.exe, where sys.stdout is None: printing anything would raise
# AttributeError and take the app down before it ever opened a window.
def _has_console():
    return getattr(sys, "stdout", None) is not None


def _supports_color():
    if not _has_console():
        return False
    if os.name == "nt":
        os.system("")  # enables ANSI sequences on the Windows console
    try:
        return sys.stdout.isatty()
    except Exception:
        return False


def _supports_unicode():
    """Can the console display the nicer symbols? On Windows with a legacy
    code page (cp1252) printing them raises UnicodeEncodeError and takes the
    program down, so ASCII stand-ins are used instead."""
    if not _has_console():
        return False
    try:
        "─✓⚠⟳⬈".encode(getattr(sys.stdout, "encoding", None) or "ascii")
        return True
    except (UnicodeEncodeError, LookupError, TypeError, AttributeError):
        return False


_COLOR = _supports_color()
_UNICODE = _supports_unicode()

# Event symbols, with ASCII fallbacks when the console cannot do better.
SYM = {
    "ok": "✓" if _UNICODE else "*",
    "warn": "⚠" if _UNICODE else "!",
    "swap": "⟳" if _UNICODE else "~",
    "open": "⬈" if _UNICODE else ">",
    "line": "─" if _UNICODE else "-",
    "arrow": "→" if _UNICODE else "->",
}


def _c(code, text):
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


_print_lock = threading.Lock()


def _write(text):
    """Prints without ever failing — on the console encoding, or on there
    being no console (launched from the right-click entry)."""
    if not _has_console():
        return
    try:
        print(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        try:
            print(text.encode(enc, "replace").decode(enc, "replace"))
        except OSError:
            pass
    except (OSError, AttributeError):
        pass


def event(symbol, text, color="0"):
    stamp = _c("2", time.strftime("%H:%M:%S"))
    with _print_lock:
        _write(f"  {stamp}  {_c(color, symbol + ' ' + text)}")


def banner(url):
    line = SYM["line"] * 46
    dot = "·" if _UNICODE else "-"
    with _print_lock:
        _write("")
        _write(_c("2", "  " + line))
        _write("  " + _c("1;93", "N4DU Studio") + _c("2", f"  {dot}  disk bridge"))
        _write(_c("2", "  " + line))
        _write(f"  Interface  {_c('96', url)}")
        _write(f"  Quit       Ctrl+C  {_c('2', '(or close the page)')}")
        _write(_c("2", "  " + line))


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
    proc = subprocess.run([sys.executable, "-c", _PICKER_SCRIPT, title, mode],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "Could not open the system dialog (tkinter is missing). "
            "Use the browser picker; replacing files will be unavailable.")
    return [p for p in proc.stdout.split("\n") if p.strip()]


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
    name = os.path.splitext(name)[0]              # drop any extension
    for ch in '\\/:*?"<>|':
        name = name.replace(ch, "")
    name = "".join(c for c in name if ord(c) >= 32)   # no control characters
    # Windows does not allow trailing dots or spaces in a name.
    name = name.strip().strip(".").strip()
    if name.lower() in _WINDOWS_RESERVED:
        name += "_"
    return name


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
    same_file = os.path.abspath(target) == os.path.abspath(original)

    if not same_file and os.path.exists(target) and not overwrite:
        raise FileExistsError(os.path.basename(target))

    folder = os.path.dirname(original)
    stem = os.path.splitext(os.path.basename(target))[0]
    tmp = os.path.join(folder, f".{stem}.{secrets.token_hex(4)}.tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())   # bytes hit the disk before publishing
    try:
        os.replace(tmp, target)  # atomic: never leaves a half-written file
    except Exception:
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
        if ch.isdigit():
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


# ── Settings shown in the interface ─────────────────────────────────
def settings_status():
    """Everything the settings screen needs, in one call."""
    integration = shell_integration.status()
    settings = load_settings()
    browser = shell_integration.find_app_browser()
    return {
        "platform": integration["platform"],
        "contextMenu": integration,
        "appWindow": {
            "enabled": settings["appWindow"],
            "available": browser is not None,
            "browser": os.path.basename(browser) if browser else None,
        },
        "folder": ROOT,
        "settingsFolder": state_dir(),
    }


# ── File sessions ───────────────────────────────────────────────────
def remember_file(path):
    """Stores the path and returns a token, evicting the oldest entry when
    needed (otherwise the table would grow forever in a long session)."""
    token = secrets.token_urlsafe(16)
    with _lock:
        _files[token] = path
        _files.move_to_end(token)
        while len(_files) > MAX_SESSIONS:
            _files.popitem(last=False)
    return token


def lookup_file(token):
    with _lock:
        path = _files.get(token)
        if path is not None:
            _files.move_to_end(token)   # in use: keep it around
        return path


# ── Page heartbeat / auto-shutdown ──────────────────────────────────
def page_is_there():
    """Is a window showing the interface right now — or about to?

    Decides whether an incoming file joins the open list or gets a window of
    its own.
    """
    now = time.time()
    if now < _page["expected_until"]:
        return True
    return (_page["connected"]
            and _page["closing_since"] is None
            and now - _page["last_ping"] < 5)


def expect_page(seconds=20):
    _page["expected_until"] = time.time() + seconds


def take_pending():
    """Hands the queued files to the page, exactly once."""
    with _lock:
        queued = list(_pending)
        _pending.clear()
    return queued


def page_alive():
    _page["last_ping"] = time.time()
    _page["expected_until"] = 0.0     # it is really here now
    if _page["closing_since"] is not None:
        _page["closing_since"] = None
        event(SYM["ok"], "Page reconnected", "92")
    if not _page["connected"]:
        _page["connected"] = True


def request_shutdown(reason):
    if not _shutdown["event"].is_set():
        _shutdown["reason"] = reason
        _shutdown["event"].set()


def watchdog():
    while not _shutdown["event"].is_set():
        time.sleep(0.25)
        now = time.time()
        closing = _page["closing_since"]
        if closing is None:
            # Vanished without notice? (browser killed outright). Only counts
            # once a page has connected; before that there is nothing to watch.
            if _page["connected"] and now - _page["last_ping"] > STALL_SECONDS:
                _page["closing_since"] = now
                event(SYM["warn"], f"Connection lost — waiting {GRACE_SECONDS}s…", "93")
        elif now - closing >= GRACE_SECONDS and _page["last_ping"] <= closing:
            request_shutdown("Page closed.")


# ── HTTP server ─────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass  # keep the console clean: only our own events

    # Every API request must carry the X-N4DU header. That forces a CORS
    # preflight this server never authorises, so no external site can call it.
    def _guard(self):
        origin = self.headers.get("Origin", "")
        own = f"http://{HOST}:{self.server.server_address[1]}"
        if origin and origin != own:
            self._json({"error": "Origin not allowed"}, 403)
            return False
        if self.headers.get("X-N4DU") != "1":
            self._json({"error": "Missing header"}, 403)
            return False
        return True

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self._started = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))

    # Runs a handler without ever taking the server down. Once the response
    # has started there is no way to send an error on top, so the connection
    # is closed instead of leaving the client waiting for promised bytes.
    def _safely(self, fn):
        self._started = False
        try:
            fn()
        except Exception as exc:
            if getattr(self, "_started", False):
                self.close_connection = True
            else:
                try:
                    self._json({"error": str(exc)}, 500)
                except Exception:
                    self.close_connection = True

    # ── GET ──
    def do_GET(self):
        self._safely(self._route_get)

    def _route_get(self):
        path = urlparse(self.path).path
        if path == "/api/ping":
            if not self._guard():
                return
            page_alive()
            # Files waiting to be handed over are released only when asked
            # for. The bridge probes with a plain ping before the page is
            # ready to receive anything; draining the queue there threw the
            # files away silently.
            take = parse_qs(urlparse(self.path).query).get("take", [""])[0] == "1"
            return self._json({"ok": True, "pending": take_pending() if take else []})
        if path == "/api/read":
            return self._read()
        if path == "/api/file":
            if not self._guard():
                return
            return self._file_meta()
        if path == "/api/siblings":
            if not self._guard():
                return
            return self._siblings()
        if path == "/api/settings":
            if not self._guard():
                return
            return self._json(settings_status())
        return self._static(path)

    # ── POST ──
    def do_POST(self):
        self._safely(self._route_post)

    def _route_post(self):
        path = urlparse(self.path).path
        # sendBeacon cannot send custom headers, so /api/bye authenticates
        # with this run's secret in the URL. Only the page served by this
        # process knows it.
        if path == "/api/bye":
            token = parse_qs(urlparse(self.path).query).get("k", [""])[0]
            if not secrets.compare_digest(token, SECRET):
                return self._json({"error": "Not authorised"}, 403)
            _page["closing_since"] = time.time()
            event(SYM["warn"], f"Page closed — waiting {GRACE_SECONDS}s in case it reloads…", "93")
            return self._json({"ok": True})
        if not self._guard():
            return
        if path == "/api/hello":
            page_alive()
            event(SYM["ok"], "Page connected", "92")
            return self._json({"ok": True, "key": SECRET})
        if path == "/api/pick":
            return self._pick()
        if path == "/api/replace":
            return self._replace()
        if path == "/api/settings":
            return self._settings()
        if path == "/api/adopt":
            return self._adopt()
        self.send_error(404)

    # ── Endpoints ──
    def _pick(self):
        intent = parse_qs(urlparse(self.path).query).get("intent", ["open"])[0]
        try:
            paths = native_pick(intent)
        except RuntimeError as exc:
            return self._json({"error": str(exc)}, 501)
        paths = [p for p in paths if os.path.isfile(p)]
        if not paths:
            self.send_response(204)  # cancelled, or nothing usable
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        files = [{"token": remember_file(p), "path": p,
                  "name": os.path.basename(p)} for p in paths]
        verb = "Target" if intent == "target" else "Opened"
        if len(files) == 1:
            event(SYM["open"], f"{verb}: {paths[0]}", "0")
        else:
            event(SYM["open"], f"{verb} {len(files)} files", "0")
        # The single-file shape is kept alongside the list so the editor and
        # the converter can both read the same answer.
        return self._json({"files": files, **files[0]})

    def _file_meta(self):
        """Name and path behind a token, so a page opened from the
        right-click entry can show what it is editing."""
        token = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        path = lookup_file(token)
        if not path or not os.path.isfile(path):
            return self._json({"error": "File not available."}, 404)
        return self._json({"path": path, "name": os.path.basename(path)})

    def _siblings(self):
        """The other images sitting next to a file that is already open.

        Windows decides for itself how many files a right-click hands over,
        and that decision is not ours to make. This is the way out: one file
        arrived, so offer the rest of its folder. The folder is never named
        by the browser — it comes from a token the user already opened, so
        this cannot be used to go fishing through the disk.
        """
        query = parse_qs(urlparse(self.path).query)
        token = query.get("token", [""])[0]
        anchor = lookup_file(token)
        if not anchor or not os.path.isfile(anchor):
            return self._json({"error": "File not available."}, 404)

        folder = os.path.dirname(os.path.abspath(anchor))
        # Paths already in the list, so they are not offered twice.
        known = {os.path.abspath(p) for p in query.get("have", []) if p}
        try:
            names = sorted(os.listdir(folder), key=_natural_key)
        except OSError as exc:
            return self._json({"error": "Could not read the folder: " + (exc.strerror or "")}, 500)

        found = []
        for name in names:
            full = os.path.join(folder, name)
            if full in known or not os.path.isfile(full):
                continue
            if os.path.splitext(name)[1].lower().lstrip(".") not in OPENABLE_EXT:
                continue
            found.append(full)
            if len(found) >= MAX_SIBLINGS:
                break

        files = [{"token": remember_file(p), "path": p, "name": os.path.basename(p)}
                 for p in found]
        return self._json({"folder": folder, "files": files})

    # ── Settings ──
    def _settings(self):
        try:
            body = json.loads(self._body().decode("utf-8") or "{}")
        except ValueError:
            return self._json({"error": "Malformed request."}, 400)
        if not isinstance(body, dict):
            return self._json({"error": "Malformed request."}, 400)

        if isinstance(body.get("appWindow"), bool):
            settings = load_settings()
            settings["appWindow"] = body["appWindow"]
            save_settings(settings)

        if isinstance(body.get("contextMenu"), bool):
            try:
                if body["contextMenu"]:
                    shell_integration.enable()
                    event(SYM["ok"], "Right-click entry added for image files", "92")
                else:
                    shell_integration.disable()
                    tidy_state()
                    event(SYM["ok"], "Right-click entry removed", "92")
            except RuntimeError as exc:
                return self._json({"error": str(exc), **settings_status()}, 400)

        # "Leave no trace": undo the system entry and delete everything the
        # program stored, so uninstalling is just deleting the folder.
        if body.get("forget") is True:
            try:
                if shell_integration.status()["supported"]:
                    shell_integration.disable()
            except RuntimeError:
                pass
            _forget("settings.json")
            _state["purge_on_exit"] = True
            event(SYM["ok"], "Removed every trace from this machine", "92")

        return self._json(settings_status())

    def _adopt(self):
        """Another launch of the program (someone right-clicked an image
        while this one was running) hands its file over.

        Authenticated with this run's secret, which lives in a file only this
        user can read. Without it any page in the browser could ask the
        server to open arbitrary paths from disk.
        """
        key = self.headers.get("X-N4DU-Key", "")
        if not secrets.compare_digest(key, SECRET):
            return self._json({"error": "Not authorised"}, 403)
        try:
            body = json.loads(self._body().decode("utf-8") or "{}")
        except ValueError:
            return self._json({"error": "Malformed request."}, 400)
        # One path or many: Send To hands over a whole selection at once.
        paths = body.get("paths")
        if not isinstance(paths, list):
            paths = [body.get("path") or ""]

        entries, refused = [], []
        for path in paths[:MAX_SIBLINGS]:
            ok, reason = openable(path)
            if not ok:
                refused.append(reason)
                continue
            full = os.path.abspath(path)
            entries.append({"token": remember_file(full), "path": full,
                            "name": os.path.basename(full)})
        if not entries:
            return self._json({"error": refused[0] if refused else "Nothing to open."}, 400)

        # A window is already up: park the files for its next heartbeat
        # rather than opening a second one. This is what turns "right-click
        # twenty images" into one list instead of twenty windows.
        live = page_is_there()
        if live:
            with _lock:
                _pending.extend(entries)
        else:
            expect_page()

        where = "Added to the open window: " if live else "Opened: "
        event(SYM["open"], where + (entries[0]["path"] if len(entries) == 1
                                    else f"{len(entries)} files"), "0")
        first = entries[0]
        return self._json({**first, "files": entries, "pageLive": live,
                           "url": "/?" + urlencode({"open": first["token"]})})

    def _read(self):
        if not self._guard():
            return
        token = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        path = lookup_file(token)
        if not path or not os.path.isfile(path):
            return self._json({"error": "File not available."}, 404)
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            # Read fully BEFORE sending headers: on failure a clean error
            # can still be returned without breaking the connection.
            return self._json({"error": f"Could not read the file: {exc.strerror}"}, 500)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self._started = True
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _replace(self):
        token = self.headers.get("X-N4DU-Token", "")
        ext = self.headers.get("X-N4DU-Ext", "").lower().lstrip(".")
        new_stem = unquote(self.headers.get("X-N4DU-Name", ""))
        overwrite = self.headers.get("X-N4DU-Overwrite") == "1"
        original = lookup_file(token)
        if not original:
            return self._json({"error": "No file selected to replace."}, 400)
        if not os.path.isfile(original):
            return self._json(
                {"error": f"{os.path.basename(original)} is no longer in its folder."}, 410)
        data = self._body()
        if not data:
            return self._json({"error": "No data received."}, 400)

        try:
            target, warning = replace_file(original, data, ext, new_stem or None, overwrite)
        except FileExistsError as exc:
            # The target is a different existing file: nothing is
            # overwritten without explicit confirmation.
            return self._json({"error": f"{exc} already exists.", "conflict": str(exc)}, 409)

        with _lock:
            _files[token] = target  # later replacements follow the new file
        kb = len(data) / 1024
        size = f"{kb/1024:.2f} MB" if kb >= 1024 else f"{kb:.0f} KB"
        old = os.path.basename(original)
        new = os.path.basename(target)
        detail = new if old == new else f'{old} {SYM["arrow"]} {new}'
        event(SYM["swap"], f"Replaced: {detail} ({size})", "96")
        if warning:
            event(SYM["warn"], warning, "93")
        return self._json({"path": target, "name": new, "warning": warning})

    # ── Static files ──
    def _static(self, path):
        # A request for interface files during the countdown means a page is
        # reloading: cancel the shutdown and let the heartbeat watchdog take
        # over (if no heartbeat ever arrives, it shuts down later anyway).
        if _page["closing_since"] is not None:
            _page["closing_since"] = None
            _page["last_ping"] = time.time()
        if path in ("/", ""):
            path = "/index.html"
        safe = os.path.normpath(os.path.join(ROOT, unquote(path).lstrip("/\\")))
        # Compare including the separator: without it a sibling folder that
        # merely starts the same (Avatar_Studio_other) would pass the check.
        if not (safe == ROOT or safe.startswith(ROOT + os.sep)) or not os.path.isfile(safe):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        try:
            with open(safe, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_error(404)
            return
        self._started = True
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def start_server():
    """Starts the server on the first free port. It really binds (rather
    than probing) so nothing else can win the race for the port."""
    last = None
    for port in PORTS:
        try:
            return ThreadingHTTPServer((HOST, port), Handler), port
        except OSError as exc:
            last = exc
    raise SystemExit(
        f"\n  No free port between {PORTS.start} and {PORTS.stop - 1}.\n"
        f"  Is N4DU Studio already running? Close it and try again.\n"
        f"  ({last})\n")


# ── Launch helpers ──────────────────────────────────────────────────
def parse_args(argv):
    """--open PATH... (one or many), --no-browser, --settings.

    --open takes every path that follows it, not just one: Send To and a
    drop onto the launcher both hand over a whole selection in a single
    command line.
    """
    args = {"open": [], "browser": True, "settings": None}
    rest = list(argv)
    while rest:
        arg = rest.pop(0)
        if arg == "--open":
            while rest and not rest[0].startswith("--"):
                args["open"].append(rest.pop(0))
        elif arg.startswith("--open="):
            args["open"].append(arg[len("--open="):])
        elif arg == "--no-browser":
            args["browser"] = False
        elif arg in ("--enable-context-menu", "--disable-context-menu",
                     "--forget", "--check"):
            args["settings"] = arg
        elif not arg.startswith("-"):
            # Bare paths, so dropping files onto the launcher works too.
            args["open"].append(arg)
    return args


def hand_off(paths):
    """Gives the files to an instance that is already running.

    Returns (url, page_live), or None when there is nobody to hand them to
    (no marker, a stale one, or the other process refused). page_live tells
    the caller whether a window is already showing the interface, in which
    case it must NOT open another one.
    """
    session = read_session()
    if not session:
        return None
    url = f"http://{HOST}:{session['port']}/api/adopt"
    body = json.dumps({"paths": [os.path.abspath(p) for p in paths]}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "X-N4DU": "1",
        "X-N4DU-Key": session["secret"],
    })
    try:
        with urllib.request.urlopen(req, timeout=3) as res:
            answer = json.loads(res.read().decode())
    except (urllib.error.URLError, OSError, ValueError):
        return None      # not running any more: start our own below
    if not answer.get("url"):
        return None
    return (f"http://{HOST}:{session['port']}" + answer["url"],
            bool(answer.get("pageLive")))


def wait_for_hand_off(paths, seconds=15):
    """Retries the hand-off while another launch is starting the server.

    The loser of the start lock lands here: it polls until the winner has
    written its marker, then gives its file to it.
    """
    deadline = time.time() + seconds
    while time.time() < deadline:
        answer = hand_off(paths)
        if answer:
            return answer
        time.sleep(0.25)
    return None


def browser_profile():
    """Where the app window keeps its own browser state.

    Small (about 4 MB) and deleted along with everything else by "leave no
    trace". It buys the window opening at the right size instead of
    inheriting whatever the already-running browser felt like.
    """
    return os.path.join(state_dir(create=True), "browser")


def open_interface(url):
    """Compact window when the setting allows it and a browser supports it,
    otherwise an ordinary tab."""
    if load_settings()["appWindow"] and shell_integration.open_app_window(
            url, profile=browser_profile()):
        return
    webbrowser.open(url)


def fatal(message):
    """Reports a problem and stops.

    Launched from the right-click entry there is no console to print to, so
    on Windows the message goes to a dialog instead of vanishing.
    """
    _write("\n  " + message + "\n")
    if os.name == "nt" and not _has_console():
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, "N4DU Studio", 0x10)
        except Exception:
            pass
    raise SystemExit(1)


def main():
    args = parse_args(sys.argv[1:])

    # Support commands: let people fix the right-click entry from a terminal
    # without opening the interface.
    if args["settings"]:
        try:
            if args["settings"] == "--check":
                _write("")
                _write(shell_integration.dump())
                _write("")
                _write("  " + shell_integration.describe(shell_integration.status()))
                return
            if args["settings"] == "--forget":
                if shell_integration.status()["supported"]:
                    shell_integration.disable()
                gone = purge_state()
                _write("  Removed the right-click entry and every stored setting.")
                _write("  " + ("Nothing of N4DU Studio is left on this machine."
                               if gone else
                               "Note: " + state_dir() + " was not empty and was kept."))
                return
            st = (shell_integration.enable() if args["settings"].startswith("--enable")
                  else shell_integration.disable())
            if args["settings"].startswith("--disable"):
                tidy_state()
            _write("  " + shell_integration.describe(st))
            return
        except RuntimeError as exc:
            fatal(str(exc))

    # An entry left over from an older version is rewritten now, quietly.
    # Waiting for someone to toggle a setting is how a fix never arrives.
    repaired = shell_integration.repair_if_stale()

    # A file was handed to us (right-click entry, or dropped on the launcher).
    holds_lock = False
    if args["open"]:
        # Keep only what we can actually open; complain only if none survive.
        usable = [p for p in args["open"] if openable(p)[0]]
        if not usable:
            fatal(openable(args["open"][0])[1])
        args["open"] = usable
        existing = hand_off(args["open"])
        if not existing:
            # Nobody is running yet — but twenty of these may have started at
            # the same instant, so exactly one of us starts the server and
            # the others queue up behind it.
            holds_lock = acquire_start_lock()
            if not holds_lock:
                existing = wait_for_hand_off(args["open"])
        if existing:
            # Another copy holds the file now. Only open a window if there
            # is not one already: twenty right-clicked images must land in
            # one list, not twenty windows.
            url, page_live = existing
            _write("  " + url)
            if args["browser"] and not page_live:
                open_interface(url)
            if holds_lock:
                release_start_lock()
            return

    mimetypes.add_type("text/javascript", ".js")
    try:
        server, port = start_server()
        url = f"http://{HOST}:{port}/"
        if args["open"]:
            # The page receives tokens, never paths: the URL is visible to
            # the browser (and its history), and tokens die with the process.
            # The first rides in the address; the rest wait for the page's
            # first heartbeat, so a whole selection lands in one list.
            tokens = [remember_file(os.path.abspath(p)) for p in args["open"]]
            url += "?" + urlencode({"open": tokens[0]})
            for token, path in zip(tokens[1:], args["open"][1:]):
                _pending.append({"token": token, "path": os.path.abspath(path),
                                 "name": os.path.basename(path)})
        write_session(port)
    finally:
        # Held until the marker exists, so the launches waiting behind us
        # find something to hand their file to.
        if holds_lock:
            release_start_lock()
    atexit.register(clear_session)

    banner(url)
    if repaired:
        event(SYM["ok"], "Right-click entry brought up to date", "92")
    if args["open"]:
        event(SYM["open"], "Opened: " + (os.path.abspath(args["open"][0])
                                         if len(args["open"]) == 1
                                         else f"{len(args['open'])} files"), "0")
    threading.Thread(target=watchdog, daemon=True).start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if args["browser"]:
        # From here on, a file arriving joins this window instead of opening
        # one of its own.
        expect_page()
        threading.Timer(0.5, lambda: open_interface(url)).start()

    try:
        # Polled instead of a plain wait(): on Windows a blocking wait with no
        # timeout swallows Ctrl+C until it returns, so the key appeared to do
        # nothing. Waking briefly lets the interrupt through.
        while not _shutdown["event"].wait(0.2):
            pass
        event(SYM["ok"], _shutdown["reason"] + " Server stopped. Goodbye.", "92")
    except KeyboardInterrupt:
        with _print_lock:
            _write("")
        event(SYM["ok"], "Stopped with Ctrl+C. Goodbye.", "92")
    server.shutdown()


if __name__ == "__main__":
    main()
