#!/usr/bin/env python3
"""
Build data/search.json — the lookup table the Oracle searches.

data/index.json is 4.5 MB because it carries notes, bios, credits and section
lists. The Oracle only ever needs to answer "what is in this archive that
matches X", so it gets a stripped file an order of magnitude smaller, which the
Worker can fetch and hold in memory.

Shape (deliberately short keys — this file is fetched, not read by humans):

    {"poems": [{"i": "<id>", "t": title, "a": author, "s": subject, "e": era}, ...],
     "works": [{"w": slug, "t": title, "a": author, "y": year, "n": sections}, ...]}

Run after tools/build_index.py on any content change:

    python tools/build_index.py && python tools/build_search_index.py && python tools/verify_split.py
"""
import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")


def main():
    with io.open(os.path.join(DATA, "index.json"), encoding="utf-8") as f:
        idx = json.load(f)

    era = {p["slug"]: p.get("category") or "" for p in idx["poets"]}

    poems = [
        {
            "i": p["id"],
            "t": p["title"],
            "a": p["author"],
            "s": p.get("primarySubject") or "",
            "e": era.get(p["authorSlug"], ""),
        }
        for p in idx["poems"]
    ]

    works = [
        {
            "w": w["slug"],
            "t": w["title"],
            "a": w["author"],
            "y": w.get("year") or "",
            "n": len(w.get("sections") or []),
        }
        for w in idx.get("works", [])
    ]

    out = os.path.join(DATA, "search.json")
    with io.open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"poems": poems, "works": works}, f, ensure_ascii=False,
                  separators=(",", ":"))

    kb = os.path.getsize(out) / 1024
    print("poems:   %d" % len(poems))
    print("works:   %d" % len(works))
    print("written: data/search.json (%.0f KB, index.json is %.0f KB)"
          % (kb, os.path.getsize(os.path.join(DATA, "index.json")) / 1024))


if __name__ == "__main__":
    main()
