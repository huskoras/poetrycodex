#!/usr/bin/env python3
"""
Regenerates data/index.json by scanning data/poets/*.json and data/works/*.json.

data/poets/*.json and data/works/*.json are the SOURCE OF TRUTH for content.
data/index.json is a derived, lightweight build artifact -- never hand-edit it.

Workflow for adding content:
    1. Write/edit data/poets/<slug>.json (a new poet: include slug, name, dates,
       era, category, portrait, credit, bio, order, and poems[]; an existing
       poet: just append to its poems[], each with a fresh sequential "id"
       "<slug>/<n>") or data/works/<slug>.json (a full work with sections[].text).
    2. Run:  python tools/build_index.py
    3. Verify (python tools/verify_split.py, or just preview locally).
    4. Commit and push.

Poet ordering: each poet file carries an explicit "order" integer (chronological
by birth/floruit, spaced by 10: 0, 10, 20, ...). To insert a new poet between two
existing ones, give it an order value in between (e.g. 15) -- no renumbering
needed. Index output is sorted by this field.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POETS_DIR = os.path.join(ROOT, "data", "poets")
WORKS_DIR = os.path.join(ROOT, "data", "works")
INDEX_PATH = os.path.join(ROOT, "data", "index.json")
LEGACY_INDEX_PATH = os.path.join(ROOT, "data", "legacy_index.json")

EXCERPT_LINES = 3


def make_excerpt(text):
    lines = text.split("\n")
    excerpt_lines = lines[:EXCERPT_LINES]
    excerpt = "\n".join(excerpt_lines)
    if len(lines) > EXCERPT_LINES:
        excerpt += " …"
    return excerpt


def build():
    poet_files = sorted(f for f in os.listdir(POETS_DIR) if f.endswith(".json"))
    work_files = sorted(f for f in os.listdir(WORKS_DIR) if f.endswith(".json"))

    poets_raw = []
    for fn in poet_files:
        with open(os.path.join(POETS_DIR, fn), encoding="utf-8") as f:
            poets_raw.append(json.load(f))
    poets_raw.sort(key=lambda p: p.get("order", 0))

    works_raw = []
    for fn in work_files:
        with open(os.path.join(WORKS_DIR, fn), encoding="utf-8") as f:
            works_raw.append(json.load(f))
    works_raw.sort(key=lambda w: w["slug"])

    work_count_by_slug = {}
    for w in works_raw:
        work_count_by_slug[w["authorSlug"]] = work_count_by_slug.get(w["authorSlug"], 0) + 1

    index_poets = []
    index_poems = []
    subject_tally = {}

    for poet in poets_raw:
        slug = poet["slug"]
        poet_poems = poet.get("poems", [])
        index_poets.append({
            "slug": slug,
            "name": poet["name"],
            "dates": poet["dates"],
            "era": poet["era"],
            "category": poet["category"],
            "portrait": poet.get("portrait"),
            "credit": poet.get("credit"),
            "bio": poet.get("bio", []),
            "order": poet.get("order", 0),
            "poemCount": len(poet_poems),
            "workCount": work_count_by_slug.get(slug, 0),
        })
        for pm in poet_poems:
            entry = {
                "id": pm["id"],
                "title": pm["title"],
                "authorSlug": pm["authorSlug"],
                "author": pm["author"],
                "primarySubject": pm["primarySubject"],
                "subjects": pm["subjects"],
                "collection": pm.get("collection"),
                "excerpt": make_excerpt(pm["text"]),
            }
            if "translator" in pm:
                entry["translator"] = pm["translator"]
            index_poems.append(entry)
            subject_tally[pm["primarySubject"]] = subject_tally.get(pm["primarySubject"], 0) + 1

    index_works = []
    for w in works_raw:
        sections = [
            {"title": s["title"], "stanzas": s["text"].count("\n\n") + 1}
            for s in w["sections"]
        ]
        index_works.append({
            "slug": w["slug"],
            "title": w["title"],
            "subtitle": w.get("subtitle"),
            "authorSlug": w["authorSlug"],
            "author": w["author"],
            "year": w.get("year"),
            "type": w.get("type"),
            "translator": w.get("translator"),
            "workGroup": w.get("workGroup"),
            "note": w.get("note", ""),
            "blurb": w.get("blurb"),
            "sections": sections,
        })

    subjects = [{"name": k, "count": v} for k, v in subject_tally.items()]
    subjects.sort(key=lambda s: -s["count"])

    # legacyIndex: a one-time, frozen mapping from the OLD #/poem/<i> numeric
    # array index (from the pre-split poems.json) to the new stable id, written
    # once by tools/split_data.py. It never changes after that -- new poems
    # added going forward only ever get new stable ids, never a legacy number
    # -- so we just carry the file through unmodified on every rebuild.
    legacy_index = []
    if os.path.exists(LEGACY_INDEX_PATH):
        with open(LEGACY_INDEX_PATH, encoding="utf-8") as f:
            legacy_index = json.load(f)

    index = {
        "count": len(index_poems),
        "workCount": len(index_works),
        "poets": index_poets,
        "subjects": subjects,
        "works": index_works,
        "poems": index_poems,
        "legacyIndex": legacy_index,
    }

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    size = os.path.getsize(INDEX_PATH)
    print(f"Wrote {INDEX_PATH} ({size / 1024:.1f} KB)")
    print(f"  poets={len(index_poets)} poems={len(index_poems)} works={len(index_works)}")


if __name__ == "__main__":
    build()
