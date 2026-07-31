#!/usr/bin/env python3
"""Builds assets/n4du.ico — the logo Windows shows next to the right-click
entry. Kept in the repository so the icon can be rebuilt from source instead
of being an opaque binary nobody can regenerate.

Standard library only (zlib writes the PNGs, struct writes the ICO), so it
runs anywhere the app itself runs.

    python3 tools/make_icon.py
"""

import os
import zlib
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "n4du.ico")

SIZES = (16, 24, 32, 48, 64, 128, 256)

EDGE = (0xE8, 0xFF, 0x47)   # brand green: the outline
BODY = (0x14, 0x14, 0x14)   # near-black: the letter itself

# The letter N as a three-segment stroke, in a 0..1 box. Drawn rather than
# set in a font so the .ico and the SVG in the interface agree exactly and
# nothing depends on what fonts a machine happens to have.
STROKE = ((0.255, 0.815), (0.255, 0.185), (0.745, 0.815), (0.745, 0.185))
OUTER = 0.33    # full width of the glyph including its border
INNER = 0.175   # width of the black letter inside it


def _dist_to_stroke(px, py):
    """Shortest distance from a point to the N's centre line."""
    best = float("inf")
    for (x0, y0), (x1, y1) in zip(STROKE, STROKE[1:]):
        dx, dy = x1 - x0, y1 - y0
        span = dx * dx + dy * dy
        # Where the perpendicular lands, clamped to the segment's ends.
        t = 0.0 if span == 0 else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / span))
        ex, ey = px - (x0 + t * dx), py - (y0 + t * dy)
        best = min(best, (ex * ex + ey * ey) ** 0.5)
    return best


def raster(size):
    """The logo as RGBA rows: a black N with a green border, antialiased by
    fading each edge over a single pixel."""
    step = 1.0 / size          # one pixel, in glyph units
    rows = []
    for y in range(size):
        row = bytearray()
        py = (y + 0.5) * step
        for x in range(size):
            d = _dist_to_stroke((x + 0.5) * step, py)
            # Coverage of the whole glyph, and of the black core inside it.
            a_out = min(1.0, max(0.0, (OUTER / 2 - d) / step + 0.5))
            a_in = min(1.0, max(0.0, (INNER / 2 - d) / step + 0.5))
            r = EDGE[0] * (1 - a_in) + BODY[0] * a_in
            g = EDGE[1] * (1 - a_in) + BODY[1] * a_in
            b = EDGE[2] * (1 - a_in) + BODY[2] * a_in
            row += bytes((int(r + .5), int(g + .5), int(b + .5), int(a_out * 255 + .5)))
        rows.append(bytes(row))
    return rows


def png(size):
    """Minimal RGBA PNG (filter 0 on every row)."""
    raw = b"".join(b"\x00" + row for row in raster(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def build():
    images = [(s, png(s)) for s in SIZES]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        # 256 is stored as 0 in the directory (one byte per dimension).
        entries += struct.pack("<BBBBHHII",
                               size % 256, size % 256, 0, 0, 1, 32,
                               len(data), offset)
        blobs += data
        offset += len(data)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as fh:
        fh.write(header + entries + blobs)
    print(f"wrote {OUT} ({len(header + entries + blobs)} bytes, "
          f"{len(images)} sizes)")


if __name__ == "__main__":
    build()
