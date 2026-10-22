"""Write the small files that let a poem or a book of a work open at once.

The app used to wait for data/index.json (32 MB, 8 MB compressed) before it drew any page
but the home page, and then fetched the whole poet file (up to 7.6 MB for Charles Wesley)
to show one poem. These shards hold just what one poem page or one work-section page needs:

  data/c/<poet>/<k>.json   poems k*50 .. k*50+49 of that poet, the poet's stub (name, dates,
                           category, portrait), the poet's poem count, and the titles just
                           before and after the shard (for Previous / Next); a retired
                           poem (dupOf) is skipped there, and "beforeAt" / "afterAt" then
                           give the place of the poem named
  data/ws/<work>/<i>.json  section i of that work (with its text), the work's metadata, its
                           number of sections and the titles before and after (Previous / Next)

They are derived files: never edit them, never commit them (they are in .gitignore).
tools/sync_r2.py builds them into the copy it uploads to Cloudflare; run this script by hand
only for local testing (python tools/build_shards.py), which writes them under data/.

    python tools/build_shards.py [--root DIR]   # DIR: a site tree (default: the repository)
"""
import io
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_index import poem_form  # noqa: E402  (the "Sonnet" in a poem page's label)

SHARD = 50                       # poems per shard; app.js uses the same number (POEM_SHARD)
STUB = ("slug", "name", "dates", "era", "category", "portrait", "credit", "order", "language")


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))


def with_form(p):
    """The poem with its form ("Sonnet", as build_index.py gives it), so a poem page drawn from
    its shard has the form in its label without the archive index."""
    f = poem_form(p.get("title") or "", p.get("text") or "", p.get("collection")) if not p.get("dupOf") else None
    return dict(p, form=f) if f else p


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if "--root" in sys.argv:
        root = sys.argv[sys.argv.index("--root") + 1]
    data = os.path.join(root, "data")
    for sub in ("c", "ws"):
        shutil.rmtree(os.path.join(data, sub), ignore_errors=True)
    n_poem = n_sec = 0
    for f in sorted(os.listdir(os.path.join(data, "poets"))):
        if not f.endswith(".json"):
            continue
        with io.open(os.path.join(data, "poets", f), encoding="utf-8") as fh:
            poet = json.load(fh)
        poems = poet.get("poems") or []
        stub = {k: poet.get(k) for k in STUB if k in poet}
        for k in range(0, (len(poems) + SHARD - 1) // SHARD):
            a, b = k * SHARD, min(len(poems), (k + 1) * SHARD)
            # Previous / Next across the shard's edges: the nearest poem that is not retired.
            pv = next((j for j in range(a - 1, -1, -1) if not poems[j].get("dupOf")), None)
            nx = next((j for j in range(b, len(poems)) if not poems[j].get("dupOf")), None)
            rec = {"poet": stub, "total": len(poems), "start": a,
                   "before": poems[pv]["title"] if pv is not None else None,
                   "after": poems[nx]["title"] if nx is not None else None,
                   "poems": [with_form(p) for p in poems[a:b]]}
            if pv is not None and pv != a - 1:
                rec["beforeAt"] = pv
            if nx is not None and nx != b:
                rec["afterAt"] = nx
            dump(os.path.join(data, "c", poet["slug"], f"{k}.json"), rec)
            n_poem += 1
    for f in sorted(os.listdir(os.path.join(data, "works"))):
        if not f.endswith(".json"):
            continue
        with io.open(os.path.join(data, "works", f), encoding="utf-8") as fh:
            w = json.load(fh)
        secs = w.get("sections") or []
        meta = {k: v for k, v in w.items() if k != "sections"}
        for i, s in enumerate(secs):
            dump(os.path.join(data, "ws", w["slug"], f"{i}.json"), {
                "work": meta, "count": len(secs), "i": i, "section": s,
                "prev": secs[i - 1].get("title") if i > 0 else None,
                "next": secs[i + 1].get("title") if i + 1 < len(secs) else None})
            n_sec += 1
    print(f"shards: {n_poem} poem shards, {n_sec} work-section shards")


if __name__ == "__main__":
    main()
