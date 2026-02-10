#!/usr/bin/env python3

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path


def _png_chunk(typ: bytes, data: bytes) -> bytes:
    ln = struct.pack(">I", len(data))
    crc = zlib.crc32(typ)
    crc = zlib.crc32(data, crc)
    return ln + typ + data + struct.pack(">I", crc & 0xFFFFFFFF)


def write_png_rgba(path: Path, w: int, h: int, pixels: bytes) -> None:
    if len(pixels) != w * h * 4:
        raise ValueError("pixels length mismatch")

    raw = bytearray()
    row_bytes = w * 4
    for y in range(h):
        raw.append(0)  # PNG filter type 0
        i0 = y * row_bytes
        raw.extend(pixels[i0 : i0 + row_bytes])

    comp = zlib.compress(bytes(raw), level=6)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    data = sig + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", comp) + _png_chunk(b"IEND", b"")
    path.write_bytes(data)


def clamp_u8(v: float) -> int:
    if v < 0:
        return 0
    if v > 255:
        return 255
    return int(v)


def blend(px: bytearray, i: int, r: int, g: int, b: int, a: int) -> None:
    # Alpha blend source color (r,g,b,a) over destination pixel at index i.
    ia = 255 - a
    px[i] = (r * a + px[i] * ia) // 255
    px[i + 1] = (g * a + px[i + 1] * ia) // 255
    px[i + 2] = (b * a + px[i + 2] * ia) // 255
    px[i + 3] = 255


def generate_icon_png(path: Path, size: int = 1024) -> None:
    w = size
    h = size
    px = bytearray(w * h * 4)

    cx = w / 2.0
    cy = h / 2.0
    max_r = (w * w + h * h) ** 0.5 / 2.0

    # Background radial gradient.
    for y in range(h):
        for x in range(w):
            dx = x - cx
            dy = y - cy
            t = ((dx * dx + dy * dy) ** 0.5) / max_r
            if t > 1:
                t = 1.0
            # Interpolate from deep blue -> slate.
            r = clamp_u8(18 + 18 * t)
            g = clamp_u8(36 + 38 * t)
            b = clamp_u8(84 + 44 * t)
            i = (y * w + x) * 4
            px[i] = r
            px[i + 1] = g
            px[i + 2] = b
            px[i + 3] = 255

    # Road bands (stylized intersection).
    road = (226, 232, 240)
    lane = (59, 130, 246)
    shoulder = (148, 163, 184)
    h_band = int(size * 0.19)
    v_band = int(size * 0.17)

    for y in range(h):
        dy = abs(y - cy)
        for x in range(w):
            dx = abs(x - cx)
            i = (y * w + x) * 4

            # Horizontal road.
            if dy <= h_band:
                # Soft edge alpha.
                edge = max(0.0, 1.0 - (dy / (h_band + 1)))
                a = clamp_u8(185 + 55 * edge)
                blend(px, i, road[0], road[1], road[2], a)

            # Vertical road.
            if dx <= v_band:
                edge = max(0.0, 1.0 - (dx / (v_band + 1)))
                a = clamp_u8(190 + 55 * edge)
                blend(px, i, road[0], road[1], road[2], a)

            # Shoulders.
            if h_band < dy <= h_band + int(size * 0.018):
                blend(px, i, shoulder[0], shoulder[1], shoulder[2], 120)
            if v_band < dx <= v_band + int(size * 0.018):
                blend(px, i, shoulder[0], shoulder[1], shoulder[2], 120)

    # Lane separators (dashed).
    dash = int(size * 0.045)
    gap = int(size * 0.03)
    stripe_w = max(2, int(size * 0.006))

    # Horizontal centerline.
    y0 = int(cy)
    for x0 in range(int(size * 0.06), int(size * 0.94), dash + gap):
        for y in range(y0 - stripe_w, y0 + stripe_w + 1):
            if y < 0 or y >= h:
                continue
            for x in range(x0, min(w, x0 + dash)):
                i = (y * w + x) * 4
                blend(px, i, lane[0], lane[1], lane[2], 210)

    # Vertical centerline.
    x0 = int(cx)
    for y0 in range(int(size * 0.06), int(size * 0.94), dash + gap):
        for x in range(x0 - stripe_w, x0 + stripe_w + 1):
            if x < 0 or x >= w:
                continue
            for y in range(y0, min(h, y0 + dash)):
                i = (y * w + x) * 4
                blend(px, i, lane[0], lane[1], lane[2], 210)

    path.parent.mkdir(parents=True, exist_ok=True)
    write_png_rgba(path, w, h, bytes(px))


def main() -> int:
    out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path("desktop/assets/app-icon-source.png").resolve()
    generate_icon_png(out, size=1024)
    print(f"Generated icon source: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
