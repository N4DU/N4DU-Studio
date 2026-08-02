#!/usr/bin/env python3
"""
N4DU Studio — disk bridge (optional).

The app processes images entirely in the browser and works on its own: open
index.html directly or host it anywhere. This program adds the one thing a
browser cannot do — open files through the operating system dialog and
REPLACE files on disk, even when the format changes.

No dependencies: the Python 3.8+ standard library only.
Binds to 127.0.0.1 exclusively (your machine; never exposed to the network).

TWO WAYS IN, AND THE EXTENSION IS WHY
─────────────────────────────────────
    double-click main.pyw       the app, and nothing else
    double-click start.bat      the app, plus the technical log

Windows decides whether a program gets a console before that program runs a
single instruction: the loader reads the subsystem field out of the
executable's header and acts on it. python.exe is marked WINDOWS_CUI and is
always given a console; pythonw.exe is marked WINDOWS_GUI and never is.
Which of the two runs a script is decided by its extension — .py belongs to
python.exe, .pyw to pythonw.exe.

That is the whole reason this file is called main.pyw. There is no window to
hide, because none was ever created. It is also why the right-click entry
has never shown a console: it names pythonw.exe outright.

start.bat is the other side of the same coin. cmd.exe is a console program
too, so Windows makes its window before the first line of the batch file is
read — which is exactly what is wanted there.

    python3 main.pyw                 # run it directly
    python3 main.pyw --console       # the technical log, and stay up
    python3 main.pyw --open PIC.PNG  # open that file (the right-click entry)
    python3 main.pyw --check         # what is installed on this machine

Stops with Ctrl+C, or on its own: when the page closes it waits a few
seconds in case it was a reload, then shuts down if nobody returns. In
--console mode it stays up instead — someone watching the log is not done
just because they closed a window.
"""

import os
import sys
import json
import time
import atexit
import mimetypes
import threading
import webbrowser
import urllib.error
import urllib.request

# Our own folder, ahead of everything: normally Python puts a script's
# directory first anyway, but not when main.pyw is loaded from somewhere else
# (a wrapper, an embedded interpreter, a test harness). Without this the
# sibling modules would go missing depending on how the app was started —
# which is why this cannot wait for config.py to say where ROOT is. It has to
# be worked out here, before the first sibling import.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from config import HOST, PORTS, ROOT, MAX_SIBLINGS, MAX_UPLOAD, STALL_SECONDS  # noqa: E402

import shell_integration  # noqa: E402  (needs the path fixed up first)
import appstate          # noqa: E402  settings, session marker, file tokens
import diskio            # noqa: E402  the file dialog and replacing on disk
import console           # noqa: E402  everything printed, and nothing decided
import pagestate         # noqa: E402  is anybody looking at the interface?
import httpapi           # noqa: E402  everything the browser can ask for

# Re-exported so anything importing main — the test suites in particular —
# can keep saying replace_file() rather than diskio.replace_file(). The split
# is about where the code LIVES, not about renaming everything that uses it.
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
from httpapi import Handler, start_server, settings_status  # noqa: E402
from pagestate import (  # noqa: E402
    _page, _pending, _pending_lock, _shutdown,
    page_is_there, expect_page, take_pending, page_alive, request_shutdown,
    watchdog,
)


# ── Console ─────────────────────────────────────────────────────────
# Presentation lives in console.py. Deciding what is true is this file's
# job; laying it out is not, and the two were tangled together.
_write = console.write
event = console.event
trace = console.trace
banner = console.banner
SYM = console.SYM


def report(url, port):
    """The technical view's opening picture.

    Gathered here, printed there. Everything a person who deliberately
    opened a console would otherwise have to go looking for.
    """
    settings = load_settings()
    integration = shell_integration.status()
    browser = shell_integration.find_app_browser()
    exe = sys.executable or "?"
    leaf = exe.replace("\\", "/").rsplit("/", 1)[-1]
    installed = integration.get("installed") or []
    folder = state_dir()

    console.report([
        ("SERVING", [
            ("interface", console.accent(url)),
            ("bound to", f"{HOST}:{port}",
             "loopback only — never reachable from the network"),
            ("process", str(os.getpid())),
        ]),
        ("RUNNING ON", [
            ("python", "{}.{}.{}".format(*sys.version_info[:3]),
             leaf + (" — no console build" if leaf.lower().startswith("pythonw") else "")),
            ("platform", "{} {}".format(os.name, sys.platform)),
            ("program", ROOT),
            ("settings", folder, "" if os.path.isdir(folder) else "(not created yet)"),
        ]),
        ("SET UP", [
            ("right-click",
             "on for {} of {} types".format(len(installed),
                                            len(integration.get("extensions") or []))
             if installed else "off",
             "" if integration.get("supported") else "not available on this system"),
            ("send to", "yes" if shell_integration.sendto_installed() else "no"),
            ("own window", "on" if settings["appWindow"] else "off",
             os.path.basename(browser) if browser else "no suitable browser found"),
        ]),
        ("LIMITS", [
            ("files", str(MAX_SIBLINGS), "per batch"),
            ("upload", "{} MB".format(MAX_UPLOAD // (1024 * 1024)), "per replacement"),
            ("tokens", str(MAX_SESSIONS), "open files remembered at once"),
            ("idle", "{}s".format(STALL_SECONDS),
             "no heartbeat for this long = page gone"),
        ]),
    ], footer="Ctrl+C to stop. The window closing does not stop it — "
              "this console is the point.")


# ── Launch helpers ──────────────────────────────────────────────────
def parse_args(argv):
    """--open PATH... (one or many), --no-browser, --console, --settings.

    --open takes every path that follows it, not just one: Send To and a
    drop onto the launcher both hand over a whole selection in a single
    command line.
    """
    args = {"open": [], "browser": True, "settings": None, "console": False}
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
        elif arg == "--console":
            # Keeps the console on screen even when it is ours alone, for
            # anyone who wants to watch what the bridge is doing.
            args["console"] = True
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


def wait_for_hand_off(paths, seconds=LOCK_STALE + 5):
    """Retries the hand-off while another launch is starting the server.

    The loser of the start lock lands here: it polls until the winner has
    written its marker, then gives its file to it.

    The patience has to outlast the stale window. At fifteen seconds against
    a twenty-five second window there was a gap where a loser could neither
    hand over nor take the lock, so it started a server of its own — and
    with twenty files right-clicked at once, twenty of them did. Measured:
    six launches, six servers, five of them orphans nobody could reach.
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


def open_when_ready(url, seconds=8):
    """Opens the interface once the server can actually answer for it.

    The browser used to be launched on a half-second timer — a guess, and on
    a slow machine the wrong one. What the person then saw was not a slow
    launch but a broken one: a browser sitting on "page not found" while the
    launcher cheerfully printed the address it had failed to reach.

    So ask. One real request against our own port, retried until it answers,
    and only then hand the address to a browser. If it never answers, say so
    rather than opening a window onto nothing.
    """
    deadline = time.time() + seconds
    probe = urllib.request.Request(url, headers={"X-N4DU": "1"})
    while time.time() < deadline:
        if _shutdown["event"].is_set():
            return
        try:
            with urllib.request.urlopen(probe, timeout=1) as res:
                if res.status == 200:
                    trace("boot", "answering after {:.0f} ms".format(
                        (seconds - (deadline - time.time())) * 1000), "2")
                    open_interface(url)
                    return
        except Exception:
            time.sleep(0.05)
    event(SYM["warn"], "The server did not answer in time; not opening a window.", "33")


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
    if os.name == "nt" and not console.has_console():
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, "N4DU Studio", 0x10)
        except Exception:
            pass
    raise SystemExit(1)


def main():
    args = parse_args(sys.argv[1:])
    # Asking for the technical view only makes sense where there is somewhere
    # to print it. Under pythonw.exe sys.stdout is None and every line would
    # go nowhere, so the flag is quietly ignored rather than half-honoured.
    console.set_verbose(args["console"])

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

    if args["open"]:
        # Keep only what we can actually open; complain only if none survive.
        usable = [p for p in args["open"] if openable(p)[0]]
        if not usable:
            fatal(openable(args["open"][0])[1])
        args["open"] = usable

    # Is somebody already running? Asked EVERY time, not only when files were
    # passed: launching the app twice by hand used to produce two servers on
    # two ports, with the second marker overwriting the first and every later
    # right-click going to the newer one while the older sat there orphaned.
    holds_lock = False
    existing = hand_off(args["open"])
    if not existing:
        # Nobody yet — but twenty launches may have started at the same
        # instant, so exactly one of us starts the server and the others
        # queue up behind it.
        holds_lock = acquire_start_lock()
        if not holds_lock:
            existing = wait_for_hand_off(args["open"])
            if not existing:
                # The winner never appeared: it crashed, or was killed
                # before it could write its marker. Take the lock rather
                # than adding a second server to the pile.
                holds_lock = acquire_start_lock()
                if not holds_lock:
                    # Still not ours: the winner is alive and refreshing the
                    # lock, only slower than we waited. Falling through from
                    # here bound a second port and overwrote the winner's
                    # marker, which is the exact accident this lock exists to
                    # prevent. Give it one more full wait, then give up
                    # rather than start a rival.
                    existing = wait_for_hand_off(args["open"])
                    if not existing:
                        fatal("Another copy is starting. Try again in a moment.")
    if existing:
        # Another copy is running. Only open a window if there is not one
        # already: twenty right-clicked images must land in one list, not
        # twenty windows.
        url, page_live = existing
        _write("  " + url)
        # Somebody who opened the console launcher wants to WATCH the bridge.
        # Handing the launch to a copy already running is right — but then
        # this window printed one URL, "The bridge has stopped." and closed,
        # which is the opposite of the truth: the bridge is running fine, in
        # the other process, and its log is not ours to show.
        if args["console"]:
            console.event(SYM["warn"],
                          "Already running in another process. Its log belongs "
                          "to that window, not this one.", "33")
            console.event(SYM["arrow"],
                          "To watch the log here, close the running copy "
                          "first, then start this launcher again.")
        if args["browser"] and not page_live:
            open_interface(url)
        if holds_lock:
            release_start_lock()
        return

    mimetypes.add_type("text/javascript", ".js")
    try:
        # Starting can be slow on a cold machine with twenty interpreters
        # contending. Without this the winner's own lock goes stale
        # underneath it and everyone waiting gives up.
        if holds_lock:
            appstate.touch_start_lock()
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

    # Answering comes first, before anything that can be slow.
    #
    # The socket is bound by start_server(), but nothing was READING it until
    # here, and everything above used to include the registry work below —
    # which on Windows can reach PowerShell and its thirty-second timeout.
    # A launcher that has printed a URL nobody can load yet is how "page not
    # found" happens, and it happens on exactly the machines where the
    # platform work is slowest.
    threading.Thread(target=server.serve_forever, daemon=True).start()

    # An entry left over from an older version is rewritten now, quietly, and
    # off the critical path: waiting for someone to toggle a setting is how a
    # fix never arrives, but so is holding up the launch to do it.
    def repair_quietly():
        try:
            if shell_integration.repair_if_stale():
                event(SYM["ok"], "Right-click entry brought up to date", "92")
        except Exception:
            pass          # a broken registry must never stop the program
    threading.Thread(target=repair_quietly, daemon=True).start()

    # The technical view, or the plain one. Both say where the interface is;
    # the difference is everything underneath.
    if console.verbose():
        report(url, port)
    else:
        banner(url)
    if args["open"]:
        event(SYM["open"], "Opened: " + (os.path.abspath(args["open"][0])
                                         if len(args["open"]) == 1
                                         else f"{len(args['open'])} files"), "0")
        for waiting in _pending:
            trace("token", "{}  {}".format(waiting["token"][:8], waiting["path"]), "2")
    threading.Thread(target=watchdog, args=(time.time(),), daemon=True).start()
    if args["browser"]:
        # From here on, a file arriving joins this window instead of opening
        # one of its own.
        expect_page()
        # A daemon: Ctrl+C in the first half-second used to stop the server,
        # return from main(), and then have the interpreter sit waiting for
        # this timer — which duly opened a browser window pointing at a
        # server that had just gone.
        opener = threading.Thread(target=open_when_ready, args=(url,), daemon=True)
        opener.start()

    try:
        # Polled instead of a plain wait(): on Windows a blocking wait with no
        # timeout swallows Ctrl+C until it returns, so the key appeared to do
        # nothing. Waking briefly lets the interrupt through.
        while not _shutdown["event"].wait(0.2):
            pass
        event(SYM["ok"], _shutdown["reason"] + " Server stopped. Goodbye.", "92")
    except KeyboardInterrupt:
        # A newline first: Ctrl+C leaves "^C" where the cursor was.
        _write("")
        event(SYM["ok"], "Stopped with Ctrl+C. Goodbye.", "92")
    server.shutdown()
    server.server_close()   # release the port now, not at interpreter exit


if __name__ == "__main__":
    main()
