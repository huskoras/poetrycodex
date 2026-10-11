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
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# The page text's own rule for prose translations and their paragraphs, so the contents
# list counts what the reader will see (app.js has the same rule as isProse/proseHTML).
from build_pages import is_prose, prose_paras, verse_lines  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POETS_DIR = os.path.join(ROOT, "data", "poets")
WORKS_DIR = os.path.join(ROOT, "data", "works")
INDEX_PATH = os.path.join(ROOT, "data", "index.json")
LEGACY_INDEX_PATH = os.path.join(ROOT, "data", "legacy_index.json")

EXCERPT_LINES = 3

# Forms (B3): the "Form" row on #/poems. A poem gets one only when its title names the form
# ("Sonnet 18", "Ode to Psyche", "Tam Samson's Elegy", "Burns: an Ode", "Elegy Written in a
# Country Churchyard"), when its book is a sonnet sequence ("Sonnets from the Portuguese"),
# or, for sonnets, when it has the sonnet's shape: 14 lines of ordinary length set as 8 + 6
# or 4 + 4 + 3 + 3. A form word elsewhere in a title ("What of Rafael's sonnets, Dante's
# picture?", "The Origin of Song-Writing", "Tahmis-i Gazel-i ...") does not count. A bare
# 14-line rule was tried and left out: it also catches couplet poems and fables.
FORMS = [("Sonnet", "sonnets?"), ("Ode", "odes?"), ("Ballad", "ballads?|ballade"),
         ("Elegy", "elegy|elegie|elegiac"), ("Hymn", "hymns?"), ("Song", "songs?"),
         ("Riddle", "riddles?"), ("Epigram", "epigrams?"), ("Epitaph", "epitaphs?"),
         ("Ghazal", "gazel|ghazel|ghazal|gazal")]
FORM_AFTER = r"(?:to|on|for|upon|in|at|of|written|composed|addressed|from|by|with|against)"
SONNET_SHAPES = ((8, 6), (4, 4, 3, 3))


def poem_form(title, text, collection):
    t = title.lower().strip().rstrip(".,;:!?")
    for name, word in FORMS:
        w = r"(?:%s)(?![\w-])" % word
        if (re.match(r"^(?:(?:an?|the|\d+|[ivxlc]+)[.)]?\s+)?" + w, t)    # "Ode to…", "A Song for…"
                or re.search(r"(?<![\w-])" + w + "$", t)                  # "…: an Ode", "Bede's Death Song"
                or re.search(r"(?<![\w-])" + w + r"\s+" + FORM_AFTER + r"\b", t)  # "Birthday Ode for…"
                or re.search(r"(?<![\w-])" + w + r"\s+[ivxlc\d]+\b", t)):  # "Amoretti: Sonnet XXV"
            return name
    if re.match(r"sonnets\b", (collection or "").lower()):
        return "Sonnet"
    stanzas = [[l for l in b.split("\n") if l.strip()] for b in text.split("\n\n")]
    stanzas = [b for b in stanzas if b]
    lines = [l for b in stanzas for l in b]
    if (len(lines) == 14 and all(20 <= len(l.strip()) <= 80 for l in lines)
            and tuple(len(b) for b in stanzas) in SONNET_SHAPES):
        return "Sonnet"
    return None


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
            # Slim entries (C2): the poet's slug is the first half of the id and the author is
            # the poet's name (verify_split.py checks both), so neither is repeated 14,000 times;
            # subjects are written only when there is more than the primary one, collection and
            # translator only when there is one. app.js and build_search_index.py fill them back in.
            entry = {
                "id": pm["id"],
                "title": pm["title"],
                "primarySubject": pm["primarySubject"],
                "excerpt": make_excerpt(pm["text"]),
            }
            if pm["subjects"] != [pm["primarySubject"]]:
                entry["subjects"] = pm["subjects"]
            if pm.get("collection"):
                entry["collection"] = pm["collection"]
            if pm.get("translator"):
                entry["translator"] = pm["translator"]
            # The home page's poem of the day is drawn from the poems with a Codex Note.
            if (pm.get("note") or "").strip():
                entry["hasNote"] = True
            form = poem_form(pm["title"], pm["text"], pm.get("collection"))
            if form:
                entry["form"] = form
            index_poems.append(entry)
            subject_tally[pm["primarySubject"]] = subject_tally.get(pm["primarySubject"], 0) + 1

    index_works = []
    for w in works_raw:
        sections = []
        for s in w["sections"]:
            # lines: verse lines as the "Line numbers" switch counts them (the app says "about
            # 540 lines"); a prose translation is counted in the paragraphs it is printed as.
            sec = {"title": s["title"], "stanzas": s["text"].count("\n\n") + 1,
                   "lines": verse_lines(s["text"])}
            if is_prose(s["text"], w.get("translator")):
                sec["prose"] = True
                sec["paras"] = len(prose_paras(s["text"]))
            sections.append(sec)
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

    # legacyIndex: the frozen map from the OLD #/poem/<i> numeric array index (pre-split
    # poems.json) to the new stable id lives in data/legacy_index.json (written once by
    # tools/split_data.py, never changed). It is no longer copied in here (C2): app.js
    # fetches that file only when an old numeric link is opened.
    index = {
        "count": len(index_poems),
        "workCount": len(index_works),
        "poets": index_poets,
        "subjects": subjects,
        "works": index_works,
        "poems": index_poems,
    }

    # Compact JSON, one poet / work / poem per line: indent=1 spent about a third of the
    # file on spaces, and a line per record keeps git diffs readable.
    def dumps(o):
        return json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    out = ["{"]
    keys = list(index)
    for k, key in enumerate(keys):
        tail = "," if k < len(keys) - 1 else ""
        v = index[key]
        if isinstance(v, list) and v:
            out.append(dumps(key) + ":[")
            out.append(",\n".join(dumps(x) for x in v))
            out.append("]" + tail)
        else:
            out.append(dumps(key) + ":" + dumps(v) + tail)
    out.append("}")
    with open(INDEX_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")

    size = os.path.getsize(INDEX_PATH)
    print(f"Wrote {INDEX_PATH} ({size / 1024:.1f} KB)")
    print(f"  poets={len(index_poets)} poems={len(index_poems)} works={len(index_works)}")


if __name__ == "__main__":
    build()
