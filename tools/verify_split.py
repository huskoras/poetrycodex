#!/usr/bin/env python3
"""
Integrity check for the split data layer.

Self-contained: verifies data/poets/*.json + data/works/*.json + data/index.json
are internally consistent. Does NOT need the old poems.json (that file was
removed after the September 2026 split; the original byte-identity check against
it lives in git history at/before commit b38eab4).

Run after any content change, together with tools/build_index.py:

    python tools/build_index.py && python tools/verify_split.py

Checks:
  - every poet file's poems match that poet's index entry (count + poemCount)
  - poem ids are exactly "<slug>/<n>", sequential from 0, globally unique
  - index poem stubs match the poet files 1:1 (id, title, author, subject)
  - subjects[] tallies match the actual primarySubject distribution
  - per-poet workCount matches the work files that name that poet
  - work files match their index metadata (slug, section count, section titles)
  - legacy_index entries all resolve to a real poem
  - required fields present, no empty poem/section texts
  - every non-null portrait path exists on disk
  - every poet's category is one of the categories declared in app.js
"""
import json
import os
import re
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

POEM_FIELDS = ("id", "title", "authorSlug", "author", "primarySubject", "subjects", "text")
POET_FIELDS = ("slug", "name", "dates", "category", "bio", "poemCount", "workCount")


def load(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return json.load(f)


def app_categories():
    """Pull CATEGORY_ORDER out of app.js so data and UI can't drift apart."""
    src = open(os.path.join(ROOT, "app.js"), encoding="utf-8").read()
    m = re.search(r"const CATEGORY_ORDER\s*=\s*\[(.*?)\]", src, re.S)
    if not m:
        return None
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def main():
    errors = []
    idx = load(DATA, "index.json")
    idx_poets = {p["slug"]: p for p in idx["poets"]}

    # ---- poets & poems ----
    poet_files = sorted(f for f in os.listdir(os.path.join(DATA, "poets")) if f.endswith(".json"))
    if len(poet_files) != len(idx["poets"]):
        errors.append(f"poet files {len(poet_files)} != index poets {len(idx['poets'])}")

    all_ids, total_poems = set(), 0
    subject_counts = Counter()
    poems_by_id = {}

    for fn in poet_files:
        slug = fn[:-5]
        poems = load(DATA, "poets", fn).get("poems", [])
        total_poems += len(poems)
        ip = idx_poets.get(slug)
        if ip is None:
            errors.append(f"{slug}: poet file has no index entry")
            continue
        for f in POET_FIELDS:
            if f not in ip:
                errors.append(f"{slug}: index entry missing field '{f}'")
        if ip.get("poemCount") != len(poems):
            errors.append(f"{slug}: poemCount {ip.get('poemCount')} != {len(poems)} poems in file")
        if ip.get("portrait") and not os.path.exists(os.path.join(ROOT, ip["portrait"])):
            errors.append(f"{slug}: portrait file missing: {ip['portrait']}")

        for n, p in enumerate(poems):
            for f in POEM_FIELDS:
                if f not in p:
                    errors.append(f"{slug}/{n}: missing field '{f}'")
            if p.get("id") != f"{slug}/{n}":
                errors.append(f"{slug}/{n}: id is {p.get('id')!r}, expected {slug}/{n}")
            if p.get("authorSlug") != slug:
                errors.append(f"{slug}/{n}: authorSlug {p.get('authorSlug')!r} != file slug")
            if not (p.get("text") or "").strip():
                errors.append(f"{slug}/{n}: empty text")
            if not (p.get("title") or "").strip():
                errors.append(f"{slug}/{n}: empty title")
            if p.get("id") in all_ids:
                errors.append(f"duplicate poem id {p.get('id')}")
            all_ids.add(p.get("id"))
            poems_by_id[p.get("id")] = p
            if p.get("primarySubject"):
                subject_counts[p["primarySubject"]] += 1

    if idx.get("count") != total_poems:
        errors.append(f"index count {idx.get('count')} != {total_poems} poems in poet files")
    if len(idx.get("poems", [])) != total_poems:
        errors.append(f"index has {len(idx.get('poems', []))} poem stubs != {total_poems} poems")

    # index stubs must mirror the poet files
    for stub in idx.get("poems", []):
        src = poems_by_id.get(stub.get("id"))
        if src is None:
            errors.append(f"index stub {stub.get('id')} has no poem in any poet file")
            continue
        for f in ("title", "author", "authorSlug", "primarySubject"):
            if stub.get(f) != src.get(f):
                errors.append(f"{stub['id']}: index {f}={stub.get(f)!r} != source {src.get(f)!r}")

    # ---- subjects ----
    idx_subjects = {s["name"]: s["count"] for s in idx.get("subjects", [])}
    for name, count in subject_counts.items():
        if idx_subjects.get(name) != count:
            errors.append(f"subject '{name}': index {idx_subjects.get(name)} != actual {count}")
    for name in idx_subjects:
        if name not in subject_counts:
            errors.append(f"subject '{name}' in index but no poems use it")

    # ---- works ----
    work_files = sorted(f for f in os.listdir(os.path.join(DATA, "works")) if f.endswith(".json"))
    idx_works = {w["slug"]: w for w in idx.get("works", [])}
    if len(work_files) != len(idx_works):
        errors.append(f"work files {len(work_files)} != index works {len(idx_works)}")
    if idx.get("workCount") != len(work_files):
        errors.append(f"index workCount {idx.get('workCount')} != {len(work_files)} work files")

    work_counts = Counter()
    total_sections = 0
    for fn in work_files:
        slug = fn[:-5]
        w = load(DATA, "works", fn)
        iw = idx_works.get(slug)
        if iw is None:
            errors.append(f"work {slug}: no index entry")
            continue
        if w.get("slug") != slug:
            errors.append(f"work {slug}: slug field is {w.get('slug')!r}")
        if w.get("authorSlug") not in idx_poets:
            errors.append(f"work {slug}: authorSlug {w.get('authorSlug')!r} is not a known poet")
        else:
            work_counts[w["authorSlug"]] += 1
        secs, isecs = w.get("sections", []), iw.get("sections", [])
        total_sections += len(secs)
        if not secs:
            errors.append(f"work {slug}: no sections")
        if len(secs) != len(isecs):
            errors.append(f"work {slug}: {len(secs)} sections != index {len(isecs)}")
        else:
            for i, (s, i_s) in enumerate(zip(secs, isecs)):
                if s.get("title") != i_s.get("title"):
                    errors.append(f"work {slug} §{i}: title differs from index")
                if not (s.get("text") or "").strip():
                    errors.append(f"work {slug} §{i}: empty text")

    for slug, ip in idx_poets.items():
        if ip.get("workCount", 0) != work_counts.get(slug, 0):
            errors.append(f"{slug}: workCount {ip.get('workCount')} != {work_counts.get(slug, 0)} work files")

    # ---- legacy index ----
    legacy_path = os.path.join(DATA, "legacy_index.json")
    if os.path.exists(legacy_path):
        legacy = load(DATA, "legacy_index.json")
        missing = [i for i, pid in enumerate(legacy) if pid not in all_ids]
        if missing:
            errors.append(f"legacy_index: {len(missing)} entries do not resolve (first: {missing[:5]})")
    else:
        errors.append("data/legacy_index.json is missing (old #/poem/<n> links would break)")

    # ---- categories must exist in app.js ----
    cats = app_categories()
    if cats is None:
        errors.append("could not parse CATEGORY_ORDER from app.js")
    else:
        for slug, ip in idx_poets.items():
            c = ip.get("category")
            if c and c not in cats:
                errors.append(f"{slug}: category {c!r} is not in app.js CATEGORY_ORDER (poet hidden on home page)")

    # ---- report ----
    print(f"poets:          {len(poet_files)}")
    print(f"poems:          {total_poems}")
    print(f"works:          {len(work_files)} ({total_sections} sections)")
    print(f"subjects:       {len(subject_counts)}")
    print(f"index.json:     {os.path.getsize(os.path.join(DATA, 'index.json')) / 1024:.1f} KB")

    if errors:
        print(f"\n{len(errors)} ERROR(S):")
        for e in errors[:50]:
            print(" -", e)
        if len(errors) > 50:
            print(f" ... and {len(errors) - 50} more")
        sys.exit(1)
    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()
