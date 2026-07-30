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

RING = (0xE8, 0xFF, 0x47)   # brand green
CORE = (0x14, 0x14, 0x14)   # the dark centre of the logo


def raster(size):
    """The logo as RGBA rows: a green disc with a dark core, antialiased by
    sampling the distance to each circle edge."""
    c = (size - 1) / 2
    r_out = size * 0.47
    r_in = size * 0.20
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            d = ((x - c) ** 2 + (y - c) ** 2) ** 0.5
            # Coverage of the outer disc, faded over one pixel at the rim.
            a_out = min(1.0, max(0.0, r_out - d + 0.5))
            # Coverage of the dark core, same treatment.
            a_in = min(1.0, max(0.0, r_in - d + 0.5))
            r = RING[0] * (1 - a_in) + CORE[0] * a_in
            g = RING[1] * (1 - a_in) + CORE[1] * a_in
            b = RING[2] * (1 - a_in) + CORE[2] * a_in
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
