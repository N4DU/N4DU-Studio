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
import mimetypes
import threading
import webbrowser
import urllib.error
import urllib.request
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
import appstate          # noqa: E402  settings, session marker, file tokens
import diskio            # noqa: E402  the file dialog and replacing on disk

# Re-exported so the rest of this file — and anything importing main — can
# keep saying replace_file() rather than diskio.replace_file(). The split is
# about where the code LIVES, not about renaming everything that uses it.
from appstate import (  # noqa: E402
    SECRET, MAX_SESSIONS, LOCK_STALE,
    state_dir, load_settings, save_settings, tidy_state, purge_state,
    write_session, clear_session, read_session,
    acquire_start_lock, release_start_lock,
    remember_file, lookup_file, retarget_file, forget_everything,
)
from diskio import (  # noqa: E402
    ALLOWED_EXT, OPENABLE_EXT, PICK_TIMEOUT,
    native_pick, target_path, replace_file, openable, _natural_key, _safe_stem,
)

HOST = "127.0.0.1"
PORTS = range(4517, 4537)          # first free port in this range
GRACE_SECONDS = 3                  # wait after the page closes (was it a reload?)
# No heartbeat for this long → the page is considered gone. Deliberately
# generous: browsers throttle timers in background tabs (down to about one
# per minute), so a short threshold would shut the server down while it is
# still in use. Normal shutdown does not rely on this — /api/bye is instant.
STALL_SECONDS = 150
MAX_SIBLINGS = 400                 # matches the converter's list limit
MAX_UPLOAD = 512 * 1024 * 1024     # a replacement bigger than this is a mistake

# Page state (drives the auto-shutdown).
# expected_until: a window has just been launched but has not reported in
# yet. Without it, twenty images right-clicked at once would each decide
# "no page is running" and open twenty windows.
_page = {"connected": False, "last_ping": 0.0, "closing_since": None,
         "expected_until": 0.0}

# Files handed over while a window was already open. The page collects them
# on its next heartbeat, so they join the list it is already showing.
_pending = []
_pending_lock = threading.Lock()
_picking = threading.Semaphore(1)  # only one native dialog at a time
_shutdown = {"event": threading.Event(), "reason": ""}

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
    with _pending_lock:
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
        # The address must be our own. Under DNS rebinding a page on another
        # domain resolves to 127.0.0.1 and the browser then treats it as
        # same-origin — sending no Origin header at all, so the check below
        # would pass.
        host = self.headers.get("Host", "").strip()
        port = self.server.server_address[1]
        if host not in (f"{HOST}:{port}", f"localhost:{port}"):
            self._json({"error": "Wrong host"}, 403)
            return False
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
        # Refusals end the connection. Every guard answers before reading the
        # request body, and the unread bytes were then parsed as the NEXT
        # request on the same keep-alive connection — so a page on any other
        # site could send a rejected request whose body was a second,
        # fully-formed one carrying whatever headers it liked. That walked
        # straight past the header check this whole design rests on.
        if status >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        """Exactly the declared number of bytes, or an error.

        rfile.read(n) returns SHORT at end of stream — it does not promise n
        bytes. Nothing noticed, so a browser killed mid-upload (tab closed,
        machine asleep) delivered a truncated image that was then written
        over the user's only copy, whose original was deleted afterwards.
        Reported as a success. The declared length is also capped: an absurd
        Content-Length would otherwise be buffered in full.
        """
        declared = int(self.headers.get("Content-Length", 0) or 0)
        if declared < 0 or declared > MAX_UPLOAD:
            raise ValueError("That file is too large to write.")
        buf = bytearray()
        while len(buf) < declared:
            chunk = self.rfile.read(min(1 << 20, declared - len(buf)))
            if not chunk:
                raise ValueError(
                    "The upload ended early, so nothing was written. Try again.")
            buf += chunk
        return bytes(buf)

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
        # One dialog at a time: without this, repeated calls stack up native
        # windows and an interpreter process behind each of them.
        if not _picking.acquire(blocking=False):
            return self._json({"error": "A file dialog is already open."}, 409)
        try:
            paths = native_pick(intent)
        except RuntimeError as exc:
            return self._json({"error": str(exc)}, 501)
        finally:
            _picking.release()
        paths = [p for p in paths if os.path.isfile(p)]
        if not paths:
            self._started = True
            self.send_response(204)  # cancelled, or nothing usable
            self.end_headers()       # 204 must not carry a Content-Length
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
            forget_everything()
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

        # Every file goes into the queue, always. Deciding between "queue it"
        # and "let the caller open a window for it" lost exactly one file
        # whenever the two raced — the whole point of the queue is that it
        # cannot matter who gets there first. pageLive only tells the caller
        # whether a window still has to be opened.
        with _pending_lock:
            _pending.extend(entries)
            # A window that never arrives must not let this grow for ever.
            if len(_pending) > MAX_SIBLINGS:
                del _pending[:-MAX_SIBLINGS]
        live = page_is_there()
        if not live:
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
        except ValueError as exc:
            return self._json({"error": str(exc)}, 400)
        except FileExistsError as exc:
            # The target is a different existing file: nothing is
            # overwritten without explicit confirmation.
            return self._json({"error": f"{exc} already exists.", "conflict": str(exc)}, 409)

        retarget_file(token, target)   # later replacements follow the new file
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
        # A request for the interface ITSELF during the countdown means the
        # page is reloading: cancel the shutdown and let the heartbeat
        # watchdog take over. Any URL used to count, so an <img> tag on any
        # website could keep a server with file-replacing powers alive for
        # ever — and an unrelated favicon fetch did it by accident.
        if _page["closing_since"] is not None and path in ("/", "", "/index.html"):
            _page["closing_since"] = None
            _page["last_ping"] = time.time()
        if path in ("/", ""):
            path = "/index.html"
        wanted = unquote(path)
        if "\0" in wanted:
            self.send_error(404)
            return
        safe = os.path.normpath(os.path.join(ROOT, wanted.lstrip("/\\")))
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
    # app=1 tells the page it is in a window of its own. That window already
    # carries "N4DU Studio" in its own title bar, so the interface drops its
    # wordmark rather than saying the name twice — and the height that frees
    # up goes to the part of the window that actually does something.
    if load_settings()["appWindow"] and shell_integration.open_app_window(
            url + ("&" if "?" in url else "?") + "app=1",
            profile=browser_profile()):
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
            # Everything the launch was given goes into the same queue the
            # hand-offs use, and the page collects the lot on its first
            # heartbeat. One route in, so there is no race to lose a file to.
            for path in args["open"]:
                full = os.path.abspath(path)
                _pending.append({"token": remember_file(full), "path": full,
                                 "name": os.path.basename(full)})
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
