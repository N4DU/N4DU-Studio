"""Where N4DU Studio keeps its handful of persistent bits.

Three things, all small, all in one per-user folder outside the app:

  settings.json  what the user chose in the settings screen
  session.json   the running-instance marker, so a second launch can hand
                 its file to the copy already running instead of starting
                 a second server
  start.lock     the atomic race-winner when twenty launches fire at once

The whole folder is disposable. "Leave no trace" is a supported end state,
not an afterthought: nothing here is created until something is actually
about to be written, and purge_state() takes the folder away again.

Imported by main.pyw; no dependency in the other direction.
"""

import os
import sys
import json
import time
import shutil
import secrets
import threading
from collections import OrderedDict

# Per-run secret. Authenticates /api/bye, which cannot require headers
# because sendBeacon does not send them: without this, any website open in
# another tab could shut the server down.
SECRET = secrets.token_urlsafe(24)

# Remembered files (oldest is evicted). Generous on purpose: a batch can be
# hundreds of files, and every one needs its token to stay valid until it is
# replaced — an evicted token means "Replace originals" silently skips it.
MAX_SESSIONS = 600

LOCK_STALE = 25          # seconds before a start lock is assumed abandoned

# Open files: ephemeral token -> real path. The browser only ever sees
# tokens; no endpoint accepts an arbitrary path.
_files = OrderedDict()
_lock = threading.Lock()

_state = {"purge_on_exit": False}


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


# ── Running-instance marker ─────────────────────────────────────────
# Lets a second launch (someone right-clicking another image) hand the file
# to the copy that is already running instead of starting a second server.
def write_session(port):
    data = {"port": port, "secret": SECRET, "pid": os.getpid()}
    try:
        path = _state_file("session.json", create=True)
        # Created 0600 rather than created-then-chmodded. This file holds the
        # secret that authorises opening arbitrary paths, and the old order
        # left it world-readable for the width of the write — a real window
        # on a shared machine. On Windows the mode is ignored, which is fine:
        # LOCALAPPDATA is already per-user.
        fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
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
        return _steal_stale_lock(lock)
    except OSError:
        return True      # cannot lock (odd filesystem): carrying on beats hanging


def _steal_stale_lock(lock):
    """Takes over a lock left behind by a launch that never finished.

    Removing it and trying again is not enough: two launches can both read
    the same old timestamp, and then the second one's remove() deletes the
    lock the first has just legitimately created — leaving both convinced
    they won, which is two servers on two ports.

    A rename is the atomic part. Exactly one process can move a given file
    to a given name; whoever loses that race finds nothing to move and
    accepts that somebody else is starting.
    """
    try:
        if time.time() - os.path.getmtime(lock) <= LOCK_STALE:
            return False                       # someone is genuinely starting
    except OSError:
        return False                           # it went away by itself
    mine = "{}.{}".format(lock, secrets.token_hex(4))
    try:
        os.replace(lock, mine)                 # only one process can win this
    except OSError:
        return False
    try:
        os.remove(mine)
    except OSError:
        pass
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except OSError:
        return False


def release_start_lock():
    """Only ever releases OUR lock.

    A launch slow enough for its lock to go stale would otherwise delete the
    lock a different process is legitimately holding, and the storm starts
    all over again.
    """
    lock = _state_file("start.lock")
    try:
        with open(lock, "r", encoding="utf-8") as fh:
            if fh.read().strip() != str(os.getpid()):
                return
    except OSError:
        return
    try:
        os.remove(lock)
    except OSError:
        pass


def touch_start_lock():
    """Keeps the lock fresh while the server is still coming up.

    Starting can take a while on a cold machine — twenty interpreters at
    once, antivirus reading every file. Without this the winner's own lock
    goes stale underneath it and the losers give up waiting.
    """
    try:
        os.utime(_state_file("start.lock"), None)
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


# ── File sessions ───────────────────────────────────────────────────
def remember_file(path):
    """Stores the path and returns a token, evicting the oldest entry when
    needed (otherwise the table would grow forever in a long session).

    The same path always gets the same token back. Listing a folder twice
    used to mint a second set of tokens for the same files, and the table
    then evicted the FIRST set — the very files the user had selected — so
    "Replace originals" silently skipped them.
    """
    full = os.path.abspath(path)
    with _lock:
        for token, known in _files.items():
            if known == full:
                _files.move_to_end(token)
                return token
        token = secrets.token_urlsafe(16)
        _files[token] = full
        while len(_files) > MAX_SESSIONS:
            _files.popitem(last=False)
    return token


def lookup_file(token):
    with _lock:
        path = _files.get(token)
        if path is not None:
            _files.move_to_end(token)   # in use: keep it around
        return path


def retarget_file(token, path):
    """Points a token that is already in use at a new path.

    A replacement can change the file's name (png -> webp, or a rename), and
    a second replacement of the same picture has to land on the new file, not
    the one that no longer exists.
    """
    with _lock:
        if token not in _files:
            return                      # evicted, or never ours: not a way back in
        _files[token] = os.path.abspath(path)
        _files.move_to_end(token)       # just used: not the next to be evicted
        while len(_files) > MAX_SESSIONS:
            _files.popitem(last=False)


def forget_everything():
    """The user asked the program to leave no trace: drop the settings now,
    and take the folder away as soon as this run's marker is released."""
    _forget("settings.json")
    _state["purge_on_exit"] = True
