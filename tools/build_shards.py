"""Write the small files that let a poem or a book of a work open at once.

The app used to wait for data/index.json (32 MB, 8 MB compressed) before it drew any page
but the home page, and then fetched the whole poet file (up to 7.6 MB for Charles Wesley)
to show one poem. These shards hold just what one poem page or one work-section page needs:

  data/c/<poet>/<k>.json   poems k*50 .. k*50+49 of that poet, the poet's stub (name, dates,
                           category, portrait), the poet's poem count, and the titles just
                           before and after the shard (for Previous / Next)
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

SHARD = 50                       # poems per shard; app.js uses the same number (POEM_SHARD)
STUB = ("slug", "name", "dates", "era", "category", "portrait", "credit", "order")


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))


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
            dump(os.path.join(data, "c", poet["slug"], f"{k}.json"), {
                "poet": stub, "total": len(poems), "start": a,
                "before": poems[a - 1]["title"] if a > 0 else None,
                "after": poems[b]["title"] if b < len(poems) else None,
                "poems": poems[a:b]})
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
