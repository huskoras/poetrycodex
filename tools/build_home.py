#!/usr/bin/env python3
"""
Build data/home.json — the little file the home page is drawn from.

data/index.json has grown to about 25 MB (6.7 MB compressed): on a phone the home
page waited 10 to 40 seconds for it. The home page needs almost nothing from it —
the number of poems, each era's poem and work counts, how many epics there are, and
the poem of the day — so app.js fetches this file first, draws the home page from it
at once, and lets index.json arrive in the background. When the index is in, the app
compares and redraws only if something differs (a home.json older than the index).

Shape:

    {"count": 75160, "workCount": 180, "epics": 37,
     "eras": {"Romantic": {"poems": 12041, "works": 3}, ...},
     "potdStart": 20740,          # the UTC day number (days since 1970-01-01) of potd[0]
     "potdFields": ["id", "title", "author", "translator", "excerpt", "lang"],
     "potd": [["keats/0", "Ode on a Grecian Urn", "John Keats", "", "Thou still…", ""], ...]}

The poem of the day is computed exactly as poemOfTheDay() in app.js does it, so the
day's poem does not change when the index arrives: the pool is the poems with a Codex
Note (`hasNote`) whose opening lines all fit a card (90 characters, counted as
JavaScript counts them), in index order, or every poem that fits if none has a note;
day d shows pool[(d * 7919) % len(pool)]. `lang` is "tr" for a Turkish & Ottoman poem
with no translator (langAttr in app.js), else "". No total of poets is written: the
site never prints one.

Reads only the committed data/index.json. Run it after tools/build_index.py on every
content change, and commit data/home.json with the regenerated index:

    python tools/build_index.py && python tools/build_home.py
"""
import io
import json
import os
import re
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DAYS = 400                      # how far ahead the poem of the day is written out
STRIDE = 7919                   # the prime in poemOfTheDay() (app.js)
EPIC = re.compile(r"\b(epic|heroic poem)\b", re.I | re.A)   # isEpicWork() in app.js


def js_len(s):
    """String length as JavaScript counts it (UTF-16 code units)."""
    return len(s.encode("utf-16-le")) // 2


def fits(p):
    ex = p.get("excerpt") or ""
    return bool(ex) and all(js_len(line) <= 90 for line in ex.split("\n"))


def main():
    with io.open(os.path.join(DATA, "index.json"), encoding="utf-8") as f:
        idx = json.load(f)

    poets = {p["slug"]: p for p in idx["poets"]}
    eras = {}
    for p in idx["poets"]:
        if not p.get("category"):
            continue
        s = eras.setdefault(p["category"], {"poems": 0, "works": 0})
        s["poems"] += p.get("poemCount") or 0
        s["works"] += p.get("workCount") or 0

    pool = [p for p in idx["poems"] if p.get("hasNote") and fits(p)]
    if not pool:
        pool = [p for p in idx["poems"] if fits(p)]

    start = int(time.time() // 86400)
    potd = []
    if pool:
        for day in range(start, start + DAYS):
            p = pool[(day * STRIDE) % len(pool)]
            slug = p.get("authorSlug") or p["id"][: p["id"].rindex("/")]
            poet = poets.get(slug) or {}
            translator = p.get("translator") or ""
            tr = poet.get("category") == "Turkish & Ottoman" and not translator.strip()
            potd.append([p["id"], p["title"], p.get("author") or poet.get("name") or "",
                         translator, p["excerpt"], "tr" if tr else ""])

    home = {
        "count": idx["count"],
        "workCount": idx.get("workCount") or len(idx.get("works") or []),
        "epics": sum(1 for w in idx.get("works") or [] if EPIC.search(w.get("type") or "")),
        "eras": eras,
        "potdStart": start,
        "potdFields": ["id", "title", "author", "translator", "excerpt", "lang"],
        "potd": potd,
    }

    # One poem of the day per line, so the file can still be read and diffed.
    dump = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    head = {k: v for k, v in home.items() if k != "potd"}
    text = dump(head)[:-1] + ',"potd":[\n' + ",\n".join(dump(r) for r in potd) + "\n]}\n"
    json.loads(text)   # never write a file the browser cannot read

    out = os.path.join(DATA, "home.json")
    tmp = out + ".tmp"
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, out)
    print(f"home.json: {len(text.encode('utf-8')) // 1024} KB, poem of the day for {len(potd)} days "
          f"from a pool of {len(pool)}")


if __name__ == "__main__":
    main()
