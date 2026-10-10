#!/usr/bin/env python3
"""
Shrink poet portraits (poets/*.jpg) to a size the pages actually use.

Portraits show at most ~340 CSS pixels wide (a full-width poet card on a phone,
the 300px column on a poet page), so 640 pixels covers a 2x screen. Commons
downloads are often 1,000-2,000 pixels and several hundred KB; this brings
each down to 640 pixels wide at JPEG quality 80.

Safe to run again: a portrait that is already 640 pixels or narrower and under
100 KB is left alone, and a file is only replaced when the new one is at least
15% smaller, so an already-shrunk portrait is never re-compressed. Needs Pillow.

    python tools/shrink_portraits.py                 # every poets/*.jpg
    python tools/shrink_portraits.py poets/gower.jpg # just these
"""
import glob
import io
import os
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_W = 640
QUALITY = 80
LEAVE_UNDER = 100 * 1024
MIN_SAVING = 0.85   # keep the new file only if it is <= 85% of the old one


def shrink(path):
    before = os.path.getsize(path)
    with Image.open(path) as im:
        if im.width <= MAX_W and before <= LEAVE_UNDER:
            return None
        icc = im.info.get("icc_profile")
        im = ImageOps.exif_transpose(im)
        if im.mode != "RGB":
            im = im.convert("RGB")
        if im.width > MAX_W:
            im = im.resize((MAX_W, round(im.height * MAX_W / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=QUALITY, optimize=True, progressive=True,
                **({"icc_profile": icc} if icc else {}))
    if buf.tell() > before * MIN_SAVING:
        return None
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return before, buf.tell()


def main():
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(ROOT, "poets", "*.jpg")))
    saved = 0
    for p in paths:
        r = shrink(p)
        if r:
            saved += r[0] - r[1]
            print(f"{os.path.basename(p)}: {r[0] // 1024} KB -> {r[1] // 1024} KB")
    print(f"saved {saved // 1024} KB")


if __name__ == "__main__":
    main()
