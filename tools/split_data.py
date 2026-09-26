#!/usr/bin/env python3
"""
ONE-OFF migration script.

Splits the monolithic poems.json (~30 MB, all content in one file) into:
  - data/poets/<slug>.json   one file per poet: metadata + ALL that poet's poems
                             (full text, notes, everything)
  - data/works/<slug>.json   one file per work: full text incl. sections[].text
  - data/index.json          small startup index (built by build_index.py)

Run once from the repo root:
    python tools/split_data.py

After this script is trusted and the site is verified working from data/*,
poems.json is deleted from the working tree (it stays in git history).

Going forward, poems.json is NOT the source of truth any more -- data/poets/*.json
and data/works/*.json are. See tools/build_index.py and AGENTS.md.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "poems.json")
POETS_DIR = os.path.join(ROOT, "data", "poets")
WORKS_DIR = os.path.join(ROOT, "data", "works")

ORDER_STEP = 10  # spacing between poets' order values so new poets can be
                  # slotted in later without renumbering everyone else
                  # (e.g. insert order=15 between order=10 and order=20)


def main():
    os.makedirs(POETS_DIR, exist_ok=True)
    os.makedirs(WORKS_DIR, exist_ok=True)

    with open(SRC, encoding="utf-8") as f:
        data = json.load(f)

    poets = data["poets"]          # already in chronological order
    poems = data["poems"]          # flat list, original array order
    works = data.get("works", [])

    # ---- group poems by authorSlug, preserving original relative order ----
    # NOTE: the original poems[] array is NOT grouped by poet (a poet's poems
    # can appear in several non-contiguous runs), so we cannot derive the old
    # numeric #/poem/<i> -> new id mapping from poet order. We compute it
    # explicitly below (legacy_ids) while walking the original array.
    poems_by_slug = {}
    for p in poems:
        poems_by_slug.setdefault(p["authorSlug"], []).append(p)

    # ---- legacy numeric index -> new stable id, in the OLD array's order ----
    counters = {}
    legacy_ids = []
    for p in poems:
        slug = p["authorSlug"]
        n = counters.get(slug, 0)
        legacy_ids.append(f"{slug}/{n}")
        counters[slug] = n + 1
    legacy_path = os.path.join(ROOT, "data", "legacy_index.json")
    with open(legacy_path, "w", encoding="utf-8") as f:
        json.dump(legacy_ids, f, ensure_ascii=False, indent=1)
    print(f"Wrote {legacy_path} ({len(legacy_ids)} entries)")

    # ---- write data/poets/<slug>.json ----
    # Each file is the single source of truth for that poet: identity fields
    # + an explicit `order` sort key (chronological, spaced by ORDER_STEP so
    # future poets can be inserted without renumbering) + full poems[].
    for idx, poet in enumerate(poets):
        slug = poet["slug"]
        poet_poems = poems_by_slug.get(slug, [])
        out = {
            "slug": slug,
            "name": poet["name"],
            "dates": poet["dates"],
            "era": poet["era"],
            "category": poet["category"],
            "portrait": poet.get("portrait"),
            "credit": poet.get("credit"),
            "bio": poet.get("bio", []),
            "order": idx * ORDER_STEP,
            "poems": [
                {
                    "id": f"{slug}/{n}",
                    "title": pm["title"],
                    "authorSlug": pm["authorSlug"],
                    "author": pm["author"],
                    "primarySubject": pm["primarySubject"],
                    "subjects": pm["subjects"],
                    "collection": pm.get("collection"),
                    "note": pm.get("note", ""),
                    **({"translator": pm["translator"]} if "translator" in pm else {}),
                    "text": pm["text"],
                }
                for n, pm in enumerate(poet_poems)
            ],
        }
        with open(os.path.join(POETS_DIR, f"{slug}.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)

    # ---- write data/works/<slug>.json (unchanged, full text) ----
    for w in works:
        with open(os.path.join(WORKS_DIR, f"{w['slug']}.json"), "w", encoding="utf-8") as f:
            json.dump(w, f, ensure_ascii=False, indent=1)

    print(f"Wrote {len(poets)} poet files to {POETS_DIR}")
    print(f"Wrote {len(works)} work files to {WORKS_DIR}")

    # ---- build the index from what we just wrote (dogfoods build_index.py) ----
    import build_index  # tools/build_index.py, same directory
    build_index.build()


if __name__ == "__main__":
    main()
