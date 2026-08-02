#!/usr/bin/env python3
"""Telling the app when the folder it is showing has changed.

Pictures appear next to the one you opened while the program is running —
you save a screenshot there, you duplicate a photo, a scanner drops a file
in. Nothing in a browser can see that.

The obvious answer is to look every few seconds, and it is the wrong one:
it burns work forever to catch something that almost never happens, and it
is still late by up to however long the gap is. Every operating system this
program runs on can be asked to say something INSTEAD, and each one does it
by parking a thread in the kernel where it costs nothing at all until the
moment there is news.

    Windows   FindFirstChangeNotification, waited on together with an event
              we can signal, so the wait is infinite and still stoppable
    Linux     inotify, read through a poll() that also watches a pipe we
              can write to in order to stop it
    macOS/BSD kqueue with EVFILT_VNODE on the folder, plus the same pipe

None of them is polling: the thread sleeps until the kernel wakes it. What
they cost while nothing is happening is one blocked thread and no CPU.

Standard library only — ctypes on Windows and Linux, select.kqueue on macOS.
If a system turns out to have none of them, supported() says so and the
interface can offer to look on demand instead of pretending.

The app watches exactly one folder at a time: the one holding the picture
you opened. follow() moves the watch when that changes.
"""

import os
import sys
import threading

# ── What the rest of the program sees ───────────────────────────────
_lock = threading.Lock()
_state = {"folder": None, "changed": False}
_current = None          # the live watcher, whatever kind it is


def follow(folder):
    """Watch this folder, and stop watching whatever came before.

    Called with the folder the open picture lives in. Doing nothing when it
    is already the one being watched matters: this runs on every request for
    the folder listing, and tearing the watch down and building it back up
    each time would leave a gap exactly where a file could slip through.
    """
    global _current
    folder = os.path.abspath(folder) if folder else None
    with _lock:
        if folder == _state["folder"] and _current is not None:
            return True
        _state["folder"] = folder
        _state["changed"] = False
    if _current is not None:
        _current.stop()
        _current = None
    if not folder or not os.path.isdir(folder):
        return False
    _current = _start(folder, _noticed)
    return _current is not None


def taken():
    """Has it changed since the last time anybody asked? Asking clears it.

    The answer rides home on the heartbeat the page already sends every
    second, so nothing new is being polled — the kernel pushes, and a
    channel that has to exist anyway carries the news.
    """
    with _lock:
        was = _state["changed"]
        _state["changed"] = False
        return was


def supported():
    """Can this system be watched at all?"""
    return _kind() is not None


def stop():
    global _current
    if _current is not None:
        _current.stop()
        _current = None
    with _lock:
        _state["folder"] = None
        _state["changed"] = False


def _noticed():
    with _lock:
        _state["changed"] = True


def _kind():
    if os.name == "nt":
        return "windows"
    if sys.platform.startswith("linux"):
        return "inotify"
    import select
    return "kqueue" if hasattr(select, "kqueue") else None


def _start(folder, on_change):
    try:
        kind = _kind()
        if kind == "windows":
            return _Windows(folder, on_change)
        if kind == "inotify":
            return _Inotify(folder, on_change)
        if kind == "kqueue":
            return _Kqueue(folder, on_change)
    except Exception:
        # A watcher that will not start is not worth taking the program down
        # for. supported() has already told the interface what to expect.
        return None
    return None


class _Watcher:
    """The shape all three share: a thread that blocks, and a way to stop."""

    def __init__(self, folder, on_change):
        self.folder = folder
        self.on_change = on_change
        self.alive = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        raise NotImplementedError

    def stop(self):
        self.alive = False
        self._wake()

    def _wake(self):
        raise NotImplementedError


# ── Windows ─────────────────────────────────────────────────────────
class _Windows(_Watcher):
    """FindFirstChangeNotification, which answers the exact question asked:
    "has anything in this folder changed?" — not "what changed", which is
    ReadDirectoryChangesW and a great deal more machinery for an answer
    nobody here needs.

    Waited on alongside an event of our own, so the wait can be infinite and
    still end the moment the program wants it to. A wait with a timeout would
    have meant waking up over and over to ask "can I stop yet?", which is the
    polling this file exists to avoid.
    """

    def __init__(self, folder, on_change):
        import ctypes
        from ctypes import wintypes
        self.k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Signatures spelled out rather than left to ctypes to guess. This is
        # the one of the three that cannot be tried on the machine it was
        # written on, so nothing about it is left implicit.
        self.k32.FindFirstChangeNotificationW.argtypes = [
            wintypes.LPCWSTR, wintypes.BOOL, wintypes.DWORD]
        self.k32.FindFirstChangeNotificationW.restype = wintypes.HANDLE
        self.k32.FindNextChangeNotification.argtypes = [wintypes.HANDLE]
        self.k32.FindNextChangeNotification.restype = wintypes.BOOL
        self.k32.FindCloseChangeNotification.argtypes = [wintypes.HANDLE]
        self.k32.CreateEventW.argtypes = [
            wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
        self.k32.CreateEventW.restype = wintypes.HANDLE
        self.k32.SetEvent.argtypes = [wintypes.HANDLE]
        self.k32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.k32.WaitForMultipleObjects.argtypes = [
            wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE),
            wintypes.BOOL, wintypes.DWORD]
        self.k32.WaitForMultipleObjects.restype = wintypes.DWORD

        FILE_NAME, DIR_NAME, SIZE, LAST_WRITE = 0x01, 0x02, 0x08, 0x10
        self.handle = self.k32.FindFirstChangeNotificationW(
            folder, False, FILE_NAME | DIR_NAME | SIZE | LAST_WRITE)
        # A HANDLE restype gives None for NULL and a plain int otherwise, so
        # both spellings of "it did not work" have to be caught: NULL, and
        # INVALID_HANDLE_VALUE, which is all-ones at whatever the word size is.
        if not self.handle or self.handle in (-1, 0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF):
            raise OSError("could not watch the folder")
        # Manual-reset, unsignalled: this is the "stop now" tap on the shoulder.
        self.quit = self.k32.CreateEventW(None, True, False, None)
        if not self.quit:
            self.k32.FindCloseChangeNotification(self.handle)
            raise OSError("could not create the stop event")
        super().__init__(folder, on_change)

    def _run(self):
        import ctypes
        from ctypes import wintypes
        pair = (wintypes.HANDLE * 2)(self.handle, self.quit)
        WAIT_CHANGED, INFINITE = 0, 0xFFFFFFFF
        try:
            while self.alive:
                which = self.k32.WaitForMultipleObjects(2, pair, False, INFINITE)
                if not self.alive or which != WAIT_CHANGED:
                    break
                self.on_change()
                # Re-arm. Without this the handle stays signalled and the
                # next wait returns instantly, for ever.
                if not self.k32.FindNextChangeNotification(self.handle):
                    break
        finally:
            try:
                self.k32.FindCloseChangeNotification(self.handle)
                self.k32.CloseHandle(self.quit)
            except Exception:
                pass

    def _wake(self):
        try:
            self.k32.SetEvent(self.quit)
        except Exception:
            pass


# ── Linux ───────────────────────────────────────────────────────────
class _Inotify(_Watcher):
    """inotify, read through poll(). The pipe is in the poll set purely so
    stop() has something to write to: without it the thread would sit in
    poll() until the folder happened to change, which could be never."""

    # created | deleted | moved out | moved in | finished being written
    MASK = 0x100 | 0x200 | 0x40 | 0x80 | 0x8

    def __init__(self, folder, on_change):
        import ctypes
        import ctypes.util
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6",
                           use_errno=True)
        self.libc = libc
        self.fd = libc.inotify_init1(0o4000)          # IN_NONBLOCK
        if self.fd < 0:
            raise OSError("inotify is not available")
        if libc.inotify_add_watch(self.fd, folder.encode("utf-8"), self.MASK) < 0:
            os.close(self.fd)
            raise OSError("could not watch the folder")
        self.rpipe, self.wpipe = os.pipe()
        super().__init__(folder, on_change)

    def _run(self):
        import select
        poller = select.poll()
        poller.register(self.fd, select.POLLIN)
        poller.register(self.rpipe, select.POLLIN)
        try:
            while self.alive:
                ready = poller.poll()
                if not self.alive:
                    break
                hit = False
                for fd, _ in ready:
                    try:
                        os.read(fd, 65536)
                    except OSError:
                        pass
                    if fd == self.fd:
                        hit = True
                if hit:
                    self.on_change()
        finally:
            for fd in (self.fd, self.rpipe, self.wpipe):
                try:
                    os.close(fd)
                except OSError:
                    pass

    def _wake(self):
        try:
            os.write(self.wpipe, b"x")
        except OSError:
            pass


# ── macOS and the BSDs ──────────────────────────────────────────────
class _Kqueue(_Watcher):
    """kqueue watching the folder itself. A directory reports NOTE_WRITE
    when an entry is added or removed, which is the whole question."""

    def __init__(self, folder, on_change):
        import select
        self.select = select
        self.dirfd = os.open(folder, os.O_RDONLY)
        self.rpipe, self.wpipe = os.pipe()
        self.kq = select.kqueue()
        NOTE = (select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND
                | select.KQ_NOTE_DELETE | select.KQ_NOTE_RENAME)
        self.events = [
            select.kevent(self.dirfd, filter=select.KQ_FILTER_VNODE,
                          flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=NOTE),
            select.kevent(self.rpipe, filter=select.KQ_FILTER_READ,
                          flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR),
        ]
        super().__init__(folder, on_change)

    def _run(self):
        try:
            while self.alive:
                hits = self.kq.control(self.events, 1, None)   # None = wait for ever
                if not self.alive:
                    break
                for ev in hits:
                    if ev.ident == self.dirfd:
                        self.on_change()
                    else:
                        try:
                            os.read(self.rpipe, 4096)
                        except OSError:
                            pass
        finally:
            for closer in (self.kq.close,):
                try:
                    closer()
                except Exception:
                    pass
            for fd in (self.dirfd, self.rpipe, self.wpipe):
                try:
                    os.close(fd)
                except OSError:
                    pass

    def _wake(self):
        try:
            os.write(self.wpipe, b"x")
        except OSError:
            pass
