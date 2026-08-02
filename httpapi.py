#!/usr/bin/env python3
"""Everything the browser can ask for, and nothing about starting up.

One class, one route table. The page talks to this and to nothing else; the
launcher in main.pyw brings it up and then gets out of the way.

The rules it enforces are all here on purpose, where they can be read
together rather than found one at a time:

  * loopback only, and the Host header must say so — a page on another
    domain that resolves here is treated as the stranger it is
  * every API call carries X-N4DU, which forces a preflight this server
    never authorises
  * static files come from an allow-list of eight extensions, not from
    "anywhere under the program folder", which would include its own source
    and its git history
  * the two dangerous routes — open a path, replace a file — need the run
    secret, compared in constant time
"""

import json
import mimetypes
import os
import secrets
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, urlencode

import console
import shell_integration
import appstate
import diskio
import pagestate
from config import (
    HOST, PORTS, GRACE_SECONDS, MAX_SIBLINGS, MAX_UPLOAD,
    ROOT, REAL_ROOT, SERVABLE_EXT,
)
from appstate import (
    SECRET, state_dir, load_settings, save_settings, tidy_state, purge_state,
    remember_file, lookup_file, retarget_file, forget_everything,
)
from diskio import (
    OPENABLE_EXT, PICK_TIMEOUT,
    native_pick, target_path, replace_file, openable, _natural_key, _safe_stem,
)
from pagestate import (
    _page, _pending, _pending_lock, _picking,
    page_is_there, expect_page, take_pending, page_alive, request_shutdown,
)

trace = console.trace
event = console.event
SYM = console.SYM


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


# ── HTTP server ─────────────────────────────────────────────────────
class UploadError(ValueError):
    """A request body that never arrived, or one too big to accept.

    A subclass of ValueError so the existing handlers still catch it, but
    carrying the right status: an upload cut off halfway is the client's
    problem (400), an absurd Content-Length is 413, and neither is the 500
    they were both reported as. It also has to be told apart from a genuinely
    malformed body, which used to swallow it and say "Malformed request."
    """

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # One thread per connection, and without this they never end. Forty
    # connections that send half a request line and then nothing took the
    # process from 3 threads to 43, all still parked minutes later. Any
    # program on this machine could have kept going until nothing was left.
    timeout = 30

    # The page is thirty-odd separate files, all fetched down one reused
    # connection. Each response goes out as two writes — headers, then body —
    # and with Nagle's algorithm on, the second write waits for the first to
    # be acknowledged. The browser has nothing to acknowledge it with, so the
    # kernel's delayed ACK timer answers instead: 40ms, per file, every time.
    # Measured on this machine: 45-57ms per file on a kept-alive connection
    # against 0.7ms on a fresh one. That is the whole difference.
    disable_nagle_algorithm = True

    def log_message(self, *_):
        pass  # keep the console clean: only our own events

    # Every API request must carry the X-N4DU header. That forces a CORS
    # preflight this server never authorises, so no external site can call it.
    def _same_machine(self):
        """Was this asked for by its own address?

        Under DNS rebinding a page on another domain resolves to 127.0.0.1
        and the browser then treats it as same-origin — sending no Origin
        header at all, so an Origin check alone would pass. The Host header
        still carries the name that was actually typed.
        """
        host = self.headers.get("Host", "").strip()
        port = self.server.server_address[1]
        return host in (f"{HOST}:{port}", f"localhost:{port}")

    def _guard(self):
        if not self._same_machine():
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
        self._status = status
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
            raise UploadError("That file is too large to write.", 413)
        buf = bytearray()
        while len(buf) < declared:
            chunk = self.rfile.read(min(1 << 20, declared - len(buf)))
            self._read_bytes = getattr(self, "_read_bytes", 0) + len(chunk)
            if not chunk:
                raise UploadError(
                    "The upload ended early, so nothing was written. Try again.")
            buf += chunk
        return bytes(buf)

    # Runs a handler without ever taking the server down. Once the response
    # has started there is no way to send an error on top, so the connection
    # is closed instead of leaving the client waiting for promised bytes.
    def _safely(self, fn):
        self._started = False
        self._status = 200
        self._read_bytes = 0
        started_at = time.perf_counter()
        try:
            fn()
        except Exception as exc:
            self._status = 500
            if getattr(self, "_started", False):
                self.close_connection = True
            else:
                try:
                    self._json({"error": str(exc)}, 500)
                except Exception:
                    self.close_connection = True
        finally:
            # Drain whatever is left of the request body. On a keep-alive
            # connection the leftover bytes are read as the START of the next
            # request — one connection, one request sent, two answers back.
            # The refusal paths close the connection instead; these are the
            # ones that answered and carried on.
            if not self.close_connection:
                try:
                    left = int(self.headers.get("Content-Length") or 0) \
                        - getattr(self, "_read_bytes", 0)
                    # Draining is a courtesy to the next request on the same
                    # connection, not an obligation. A client that announces
                    # 100 KB and sends none of it held the thread until it
                    # felt like closing — thirteen seconds a request, twenty
                    # at once. Past a megabyte the connection is simply not
                    # worth reusing.
                    if left > 1 << 20:
                        raise OSError("too much left to drain")
                    while left > 0:
                        chunk = self.rfile.read(min(left, 65536))
                        if not chunk:
                            break
                        left -= len(chunk)
                except (ValueError, OSError):
                    self.close_connection = True
            # Every request, with what it cost. The heartbeat is left out on
            # purpose: it arrives every few seconds and would bury everything
            # that actually happened.
            path = urlparse(self.path).path
            if console.verbose() and path != "/api/ping":
                ms = (time.perf_counter() - started_at) * 1000
                colour = "0" if self._status < 400 else "91"
                trace("http", "{} {}  {}  {:.0f}ms".format(
                    self.command, path, self._status, ms), colour)

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
            if not secrets.compare_digest(token.encode("utf-8", "ignore"), SECRET.encode()):
                return self._json({"error": "Not authorised"}, 403)
            _page["closing_since"] = time.time()
            event(SYM["warn"], f"Page closed — waiting {GRACE_SECONDS}s in case it reloads…", "93")
            return self._json({"ok": True})
        if not self._guard():
            return
        if path == "/api/hello":
            page_alive()
            event(SYM["ok"], "Page connected", "92")
            trace("page", "{} — {}".format(
                self.headers.get("User-Agent", "?")[:70],
                self.client_address[0]), "2")
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
            self._status = 204
            self.send_response(204)  # cancelled, or nothing usable
            self.end_headers()       # 204 must not carry a Content-Length
            return

        files = [{"token": remember_file(p), "path": p,
                  "name": os.path.basename(p)} for p in paths]
        for f in files:
            trace("token", "{}  {}".format(f["token"][:8], f["path"]), "2")
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
        except UploadError as exc:
            # Not a malformed body: a body that never finished arriving, or
            # one too big to accept. Reporting both as "Malformed request."
            # hid the only fact worth knowing.
            return self._json({"error": str(exc)}, exc.status)
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
        if not secrets.compare_digest(key.encode("utf-8", "ignore"), SECRET.encode()):
            return self._json({"error": "Not authorised"}, 403)
        try:
            body = json.loads(self._body().decode("utf-8") or "{}")
        except UploadError as exc:
            # Not a malformed body: a body that never finished arriving, or
            # one too big to accept. Reporting both as "Malformed request."
            # hid the only fact worth knowing.
            return self._json({"error": str(exc)}, exc.status)
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
        if not entries and paths:
            # They handed something over and none of it was usable.
            return self._json({"error": refused[0] if refused else "Nothing to open."}, 400)
        if not entries:
            # Nothing handed over at all: this is a plain launch asking "is
            # anybody already running?". Answering it is what stops a second
            # server appearing every time the app is opened twice.
            live = page_is_there()
            if not live:
                expect_page()
            return self._json({"pageLive": live, "url": "/"})

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
        for handed in entries:
            trace("token", "{}  {}".format(handed["token"][:8], handed["path"]), "2")
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
        self._status = 200
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
        try:
            data = self._body()
        except UploadError as exc:
            return self._json({"error": str(exc)}, exc.status)
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
        except OSError as exc:
            # Read-only file, no permission, disk full, a name the filesystem
            # will not take, the target turning out to be a folder. All of
            # them used to escape as a 500 carrying a raw errno and the full
            # path — a wall of nothing, where the answer is one sentence.
            return self._json({"error": "Could not write {}: {}.".format(
                os.path.basename(target_path(original, ext, new_stem or None))
                if new_stem else os.path.basename(original),
                exc.strerror or "the system refused it")}, 400)

        retarget_file(token, target)   # later replacements follow the new file
        kb = len(data) / 1024
        size = f"{kb/1024:.2f} MB" if kb >= 1024 else f"{kb:.0f} KB"
        old = os.path.basename(original)
        new = os.path.basename(target)
        detail = new if old == new else f'{old} {SYM["arrow"]} {new}'
        event(SYM["swap"], f"Replaced: {detail} ({size})", "96")
        trace("disk", "wrote {} bytes to {}".format(len(data), target), "96")
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
        # Same Host rule the API uses. Without it the interface answers to
        # any name that resolves here, which is what makes DNS rebinding
        # worth trying.
        if not self._same_machine():
            self.send_error(404)
            return
        # An allow-list, not merely a containment check. Staying inside ROOT
        # was never the whole question: ROOT also holds main.pyw, the other
        # modules, and .git — remote URLs and, with a packed tree, the entire
        # history. The interface needs eight kinds of file and nothing else.
        parts = [p for p in wanted.split("/") if p not in ("", ".")]
        if any(p.startswith(".") for p in parts):
            self.send_error(404)          # .git, .env, anything hidden
            return
        if os.path.splitext(wanted)[1].lower().lstrip(".") not in SERVABLE_EXT:
            self.send_error(404)
            return
        # realpath, so a symlink parked inside ROOT cannot lead out of it.
        safe = os.path.realpath(os.path.join(ROOT, wanted.lstrip("/\\")))
        # Compare including the separator: without it a sibling folder that
        # merely starts the same (Avatar_Studio_other) would pass the check.
        if not (safe == REAL_ROOT or safe.startswith(REAL_ROOT + os.sep)) \
                or not os.path.isfile(safe):
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
        self._status = 200
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        # Not framable, by anyone. Embedded in an <iframe> the interface is
        # same-origin JavaScript with the run secret and full file-replacing
        # powers, and its buttons can be clickjacked into opening a native
        # dialog and overwriting a file in place.
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
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
