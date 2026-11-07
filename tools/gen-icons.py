#!/usr/bin/env python3
"""生成扩展图标（青色圆角方块 + 白色十字），仅用标准库。"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")


def in_rrect(px, py, s, r):
    x = min(px, s - px)
    y = min(py, s - py)
    if x >= r or y >= r:
        return x > 0 and y > 0
    return (x - r) ** 2 + (y - r) ** 2 <= r * r


def make_pixel_fn(s):
    r = s * 0.22
    bar = s * 0.19          # 十字臂宽
    half = s * 0.28         # 半臂长
    c = s / 2.0

    def fn(px, py):
        if not in_rrect(px + 0.5, py + 0.5, s, r):
            return (0, 0, 0, 0)
        if abs(px + 0.5 - c) <= bar / 2 and abs(py + 0.5 - c) <= half:
            return (255, 255, 255, 255)
        if abs(py + 0.5 - c) <= bar / 2 and abs(px + 0.5 - c) <= half:
            return (255, 255, 255, 255)
        return (15, 118, 110, 255)

    return fn


def write_png(path, s, fn):
    rows = bytearray()
    for y in range(s):
        rows.append(0)  # filter: none
        for x in range(s):
            rows.extend(fn(x, y))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", s, s, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 48, 128):
        write_png(os.path.join(OUT, "icon%d.png" % s), s, make_pixel_fn(s))
        print("wrote icon%d.png" % s)


if __name__ == "__main__":
    main()
