"""Everything N4DU Studio prints, and nothing it decides.

The bridge has two audiences. Most of the time nobody is watching at all —
launched from main.pyw or the right-click entry there is no console, and
sys.stdout is None, so a single unguarded print() would raise AttributeError
and take the app down before it opened a window. The rest of the time
somebody opened start.bat precisely to watch, and deserves the whole picture
rather than a headline.

Both are the same problem: presentation. Which is why it lives here and not
in the middle of a server.

Nothing in this module reaches out for the facts it prints — report() is
handed them. That keeps the dependency pointing one way (main.pyw imports
console, never the reverse) and means the technical view can be checked
without starting a server.

Imported by main.pyw; no dependency in the other direction.
"""

import os
import sys
import time
import threading

# The technical view is off unless someone asked for it AND there is
# somewhere to print. Kept private with accessors: a module-level flag read
# from another module is the kind of thing that silently stops working when
# one of them rebinds it.
_verbose = False


def set_verbose(on):
    global _verbose
    _verbose = bool(on) and has_console()


def verbose():
    return _verbose


def has_console():
    return getattr(sys, "stdout", None) is not None


def _supports_color():
    if not has_console():
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
    if not has_console():
        return False
    try:
        "─✓⚠⟳⬈".encode(getattr(sys.stdout, "encoding", None) or "ascii")
        return True
    except (UnicodeEncodeError, LookupError, TypeError, AttributeError):
        return False


COLOR = _supports_color()
UNICODE = _supports_unicode()

# Event symbols, with ASCII fallbacks when the console cannot do better.
SYM = {
    "ok": "✓" if UNICODE else "*",
    "warn": "⚠" if UNICODE else "!",
    "swap": "⟳" if UNICODE else "~",
    "open": "⬈" if UNICODE else ">",
    "line": "─" if UNICODE else "-",
    "arrow": "→" if UNICODE else "->",
}


def _c(code, text):
    return f"\033[{code}m{text}\033[0m" if COLOR else text


def accent(text):
    """For the one line a reader is looking for."""
    return _c("96", text)


_print_lock = threading.Lock()


def write(text):
    """Prints without ever failing — on the console encoding, or on there
    being no console at all."""
    if not has_console():
        return
    try:
        print(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        try:
            print(text.encode(enc, "replace").decode(enc, "replace"))
        except OSError:
            pass
    except (OSError, ValueError, AttributeError):
        # ValueError is what print() raises on a CLOSED stdout — a redirect
        # whose reader went away. This function promises never to fail, and
        # trace() is called from a finally block where a raised exception
        # would replace whatever the request was doing.
        pass


def event(symbol, text, color="0"):
    """One thing that happened, in either view."""
    stamp = _c("2", time.strftime("%H:%M:%S"))
    with _print_lock:
        write(f"  {stamp}  {_c(color, symbol + ' ' + text)}")


def trace(category, text, color="0"):
    """One line of the running log. Silent outside the technical view."""
    if not _verbose:
        return
    stamp = _c("2", time.strftime("%H:%M:%S"))
    with _print_lock:
        write("  {}  {}  {}".format(stamp, _c("2", category.ljust(8)), _c(color, text)))


def banner(url):
    """The short greeting: where the interface is, and how to stop."""
    line = SYM["line"] * 46
    dot = "·" if UNICODE else "-"
    with _print_lock:
        write("")
        write(_c("2", "  " + line))
        write("  " + _c("1;93", "N4DU Studio") + _c("2", f"  {dot}  disk bridge"))
        write(_c("2", "  " + line))
        write(f"  Interface  {_c('96', url)}")
        write(f"  Quit       Ctrl+C  {_c('2', '(or close the page)')}")
        write(_c("2", "  " + line))


def report(sections, footer=""):
    """The whole picture, printed once at startup.

    sections: [(HEADING, [(label, value, note), ...]), ...] — already
    gathered by the caller, because deciding what is true is the server's
    job and laying it out is this module's.
    """
    line = SYM["line"] * 62
    dot = "·" if UNICODE else "-"
    with _print_lock:
        write("")
        write(_c("2", "  " + line))
        write("  " + _c("1;93", "N4DU Studio") + _c("2", f"  {dot}  disk bridge")
              + _c("2", f"  {dot}  technical view"))
        write(_c("2", "  " + line))
        for heading, rows in sections:
            write("")
            write(_c("1", "  " + heading))
            for label, value, *rest in rows:
                note = rest[0] if rest else ""
                write("  {}  {}{}".format(
                    _c("2", label.ljust(13)), value,
                    _c("2", "  " + note) if note else ""))
        write("")
        write(_c("2", "  " + line))
        if footer:
            write("  " + _c("2", footer))
            write(_c("2", "  " + line))
        write("")
