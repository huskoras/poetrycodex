#!/usr/bin/env python3
"""
Make the WebP copies of the poet portraits that the pages show: beside each
poets/<slug>.jpg, poets/<slug>-320.webp and poets/<slug>-640.webp.

The JPEG stays: it is the share image (og:image) of the static poet pages, the
fallback when a WebP is missing, and the master these are made from. The app
(portraitImgHTML in app.js) shows the 320 on a poet card and lets the browser take
the 640 on a 2x screen or on the poet page.

A copy is never made wider than its JPEG (most portraits are 600 pixels wide, so
their "-640" is 600 wide). Quality 75. Safe to run again: a WebP newer than its JPEG
is left alone, so after a portrait is added or replaced only that one is made.
Run it after tools/shrink_portraits.py. Needs Pillow.

    python tools/make_webp.py                 # every poets/*.jpg
    python tools/make_webp.py poets/gower.jpg # just these
    python tools/make_webp.py --force         # remake them all
"""
import glob
import os
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIDTHS = (320, 640)
QUALITY = 75


def make(jpg, force=False):
    """Write the WebP copies of one JPEG; returns the sizes written (bytes), [] if up to date."""
    base = jpg[:-4]
    outs = [(w, f"{base}-{w}.webp") for w in WIDTHS]
    src_time = os.path.getmtime(jpg)
    if not force and all(os.path.exists(o) and os.path.getmtime(o) >= src_time for _, o in outs):
        return []
    written = []
    with Image.open(jpg) as im:
        icc = im.info.get("icc_profile")
        im = ImageOps.exif_transpose(im)
        if im.mode != "RGB":
            im = im.convert("RGB")
        for w, out in outs:
            copy = im if im.width <= w else im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
            copy.save(out, "WEBP", quality=QUALITY, method=6, **({"icc_profile": icc} if icc else {}))
            written.append(os.path.getsize(out))
    return written


def main():
    args = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv[1:]
    paths = args or sorted(glob.glob(os.path.join(ROOT, "poets", "*.jpg")))
    made = total = 0
    for p in paths:
        sizes = make(p, force)
        if sizes:
            made += 1
            total += sum(sizes)
    print(f"{made} portrait(s) converted, {total // 1024} KB of WebP written")


if __name__ == "__main__":
    main()
