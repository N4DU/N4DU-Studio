#!/usr/bin/env python3
"""The numbers and names the rest of the program agrees on.

Nothing here does anything. It exists so that the launcher, the HTTP layer
and the page-state tracker can share one definition of a limit instead of
three that drift apart.
"""

import os

ROOT = os.path.dirname(os.path.abspath(__file__))
REAL_ROOT = os.path.realpath(ROOT)

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

# What the interface is made of. Everything else in this folder — the code,
# the git history, whatever a user has parked here — is not the browser's
# business, and staying inside ROOT was never the same as being servable.
SERVABLE_EXT = {"html", "js", "css", "svg", "png", "ico", "webmanifest", "woff2"}
