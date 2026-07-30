#!/usr/bin/env python3
"""
N4DU Studio — disk bridge (optional).

The app processes images entirely in the browser and works on its own: open
index.html directly or host it anywhere. This program adds the one thing a
browser cannot do — open files through the operating system dialog and
REPLACE files on disk, even when the format changes.

No dependencies: the Python 3.8+ standard library only.
Binds to 127.0.0.1 exclusively (your machine; never exposed to the network).

    python3 main.py        # or double-click start.bat / start.command

Stops with Ctrl+C, or on its own: when the page closes it waits a few
seconds in case it was a reload, then shuts down if nobody returns.
"""

import os
import sys
import json
import time
import secrets
import mimetypes
import subprocess
import threading
import webbrowser
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORTS = range(4517, 4537)          # first free port in this range
GRACE_SECONDS = 3                  # wait after the page closes (was it a reload?)
# No heartbeat for this long → the page is considered gone. Deliberately
# generous: browsers throttle timers in background tabs (down to about one
# per minute), so a short threshold would shut the server down while it is
# still in use. Normal shutdown does not rely on this — /api/bye is instant.
STALL_SECONDS = 150
MAX_SESSIONS = 64                  # remembered files (oldest is evicted)
ALLOWED_EXT = {"png", "jpg", "webp", "avif", "bmp", "ico"}

# Per-run secret. Authenticates /api/bye, which cannot require headers
# because sendBeacon does not send them: without this, any website open in
# another tab could shut the server down.
SECRET = secrets.token_urlsafe(24)

# Open files: ephemeral token -> real path. The browser only ever sees
# tokens; no endpoint accepts an arbitrary path.
_files = OrderedDict()
_lock = threading.Lock()

# Page state (drives the auto-shutdown)
_page = {"connected": False, "last_ping": 0.0, "closing_since": None}
_shutdown = {"event": threading.Event(), "reason": ""}


# ── Console ─────────────────────────────────────────────────────────
def _supports_color():
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
    try:
        "─✓⚠⟳⬈".encode(sys.stdout.encoding or "ascii")
        return True
    except (UnicodeEncodeError, LookupError, TypeError):
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
    """Prints without ever failing on the console encoding."""
    try:
        print(text)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "ascii"
        print(text.encode(enc, "replace").decode(enc, "replace"))


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
_PICKER_SCRIPT = """
import sys, tkinter as tk
from tkinter import filedialog
title = sys.argv[1] if len(sys.argv) > 1 else "N4DU Studio"
root = tk.Tk(); root.withdraw()
root.attributes("-topmost", True)
path = filedialog.askopenfilename(title=title, filetypes=[
    ("Images", "*.png *.jpg *.jpeg *.jfif *.webp *.avif *.gif *.bmp *.ico *.svg *.tif *.tiff"),
    ("All files", "*.*")])
print(path or "", end="")
"""

_PICK_TITLES = {
    "open":   "N4DU Studio - Open image",
    "target": "N4DU Studio - Choose the file to replace",
}


def native_pick(intent="open"):
    """Returns the chosen path, '' if cancelled, or raises without tkinter."""
    test = os.environ.get("N4DU_TEST_PICK")  # hook for automated tests
    if test is not None:
        return test
    title = _PICK_TITLES.get(intent, _PICK_TITLES["open"])
    proc = subprocess.run([sys.executable, "-c", _PICKER_SCRIPT, title],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "Could not open the system dialog (tkinter is missing). "
            "Use the browser picker; replacing files will be unavailable.")
    return proc.stdout.strip()


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
def page_alive():
    _page["last_ping"] = time.time()
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
            return self._json({"ok": True})
        if path == "/api/read":
            return self._read()
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
        self.send_error(404)

    # ── Endpoints ──
    def _pick(self):
        intent = parse_qs(urlparse(self.path).query).get("intent", ["open"])[0]
        try:
            path = native_pick(intent)
        except RuntimeError as exc:
            return self._json({"error": str(exc)}, 501)
        if not path:
            self.send_response(204)  # cancelled
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not os.path.isfile(path):
            return self._json({"error": "That file does not exist."}, 400)
        token = remember_file(path)
        verb = "Target" if intent == "target" else "Opened"
        event(SYM["open"], f"{verb}: {path}", "0")
        return self._json({"token": token, "path": path,
                           "name": os.path.basename(path)})

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


def main():
    mimetypes.add_type("text/javascript", ".js")
    server, port = start_server()
    url = f"http://{HOST}:{port}/"

    banner(url)
    threading.Thread(target=watchdog, daemon=True).start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

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
