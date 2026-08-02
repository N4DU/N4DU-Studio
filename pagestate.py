#!/usr/bin/env python3
"""Is anybody looking at the interface, and should the server still be here?

The bridge exists to serve one page. When that page goes, the server has no
reason to stay — but "gone" is a guess, and a wrong guess in either direction
is bad: shut down too eagerly and a reload kills the program; wait too long
and a closed window leaves a process behind.

So this keeps the evidence in one place: the heartbeat, the grace period
after a page announces its exit, and the watchdog for a page that dies
without announcing anything.
"""

import threading
import time

import console
from config import GRACE_SECONDS, STALL_SECONDS

event = console.event
trace = console.trace
SYM = console.SYM

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

def page_is_there():
    """Is a window showing the interface right now — or about to?

    Decides whether an incoming file joins the open list or gets a window of
    its own.
    """
    now = time.time()
    if now < _page["expected_until"]:
        return True
    # Five seconds was far too strict. Browsers throttle timers in background
    # tabs to roughly one a minute — the whole reason STALL_SECONDS exists —
    # so any window that was not the foreground tab looked dead. Right-click
    # an image while the app sits behind another tab and it opened a SECOND,
    # empty window, while the file went into the queue the first one then
    # collected. The page announces its own exit, and the watchdog handles
    # one that dies without saying so; the same patience applies here.
    return (_page["connected"]
            and _page["closing_since"] is None
            and now - _page["last_ping"] < STALL_SECONDS)


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


def watchdog(started_at=None):
    started_at = started_at or time.time()
    while not _shutdown["event"].is_set():
        time.sleep(0.25)
        now = time.time()
        # A window that never arrived at all. Without this the stall check
        # below never armed — it only watches pages that HAVE connected — so
        # a launch whose browser failed to open ran for ever, holding a port,
        # with no console and no window to notice it by.
        if (not _page["connected"] and not console.verbose()
                and now - started_at > STALL_SECONDS
                and now > _page["expected_until"]):
            request_shutdown("No window ever appeared.")
            return
        closing = _page["closing_since"]
        if closing is None:
            # Vanished without notice? (browser killed outright). Only counts
            # once a page has connected; before that there is nothing to watch.
            if _page["connected"] and now - _page["last_ping"] > STALL_SECONDS:
                _page["closing_since"] = now
                event(SYM["warn"], f"Connection lost — waiting {GRACE_SECONDS}s…", "93")
        elif now - closing >= GRACE_SECONDS and _page["last_ping"] <= closing:
            if console.verbose():
                # Someone is watching the log. Closing a window is not a
                # reason to take that away from them — the console was opened
                # on purpose and only Ctrl+C should end it.
                _page["closing_since"] = None
                _page["connected"] = False
                trace("page", "window gone — still serving (Ctrl+C to stop)", "93")
            else:
                request_shutdown("Page closed.")


