#!/usr/bin/env python3
"""
Verifies data/poets/*.json + data/works/*.json + data/index.json against the
original poems.json (must still be present in the working tree when you run
this -- run it BEFORE deleting poems.json).

Checks:
  - poem count across all poet files == original count (11012)
  - poet count == original (107)
  - work count == original (39)
  - every poem's text is byte-identical to the original
  - every work section's text is byte-identical to the original
  - index.json poem/poet/work counts line up
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    orig = load(os.path.join(ROOT, "poems.json"))
    errors = []

    # ---- poets ----
    poet_files = sorted(f for f in os.listdir(os.path.join(ROOT, "data", "poets")) if f.endswith(".json"))
    if len(poet_files) != len(orig["poets"]):
        errors.append(f"poet file count {len(poet_files)} != original {len(orig['poets'])}")

    # ---- rebuild original poem lookup: authorSlug -> [poem,...] in original order ----
    orig_by_slug = {}
    for p in orig["poems"]:
        orig_by_slug.setdefault(p["authorSlug"], []).append(p)

    total_poems = 0
    text_mismatches = 0
    for fn in poet_files:
        slug = fn[:-5]
        pdata = load(os.path.join(ROOT, "data", "poets", fn))
        poems = pdata.get("poems", [])
        total_poems += len(poems)
        orig_poems = orig_by_slug.get(slug, [])
        if len(poems) != len(orig_poems):
            errors.append(f"{slug}: poem count {len(poems)} != original {len(orig_poems)}")
            continue
        for n, (new_p, old_p) in enumerate(zip(poems, orig_poems)):
            if new_p["text"] != old_p["text"]:
                text_mismatches += 1
                errors.append(f"{slug}/{n}: text mismatch")
            if new_p["id"] != f"{slug}/{n}":
                errors.append(f"{slug}/{n}: id mismatch, got {new_p['id']}")

    if total_poems != orig["count"]:
        errors.append(f"total poems across poet files {total_poems} != original count {orig['count']}")
    if total_poems != len(orig["poems"]):
        errors.append(f"total poems across poet files {total_poems} != len(original poems) {len(orig['poems'])}")

    # ---- works ----
    work_files = sorted(f for f in os.listdir(os.path.join(ROOT, "data", "works")) if f.endswith(".json"))
    orig_works = {w["slug"]: w for w in orig.get("works", [])}
    if len(work_files) != len(orig_works):
        errors.append(f"work file count {len(work_files)} != original {len(orig_works)}")
    section_mismatches = 0
    for fn in work_files:
        slug = fn[:-5]
        wdata = load(os.path.join(ROOT, "data", "works", fn))
        ow = orig_works.get(slug)
        if ow is None:
            errors.append(f"work {slug}: not in original")
            continue
        if len(wdata["sections"]) != len(ow["sections"]):
            errors.append(f"work {slug}: section count mismatch")
            continue
        for i, (ns, os_) in enumerate(zip(wdata["sections"], ow["sections"])):
            if ns["text"] != os_["text"]:
                section_mismatches += 1
                errors.append(f"work {slug} section {i}: text mismatch")
            if ns["title"] != os_["title"]:
                errors.append(f"work {slug} section {i}: title mismatch")

    # ---- legacy index ----
    legacy = load(os.path.join(ROOT, "data", "legacy_index.json"))
    if len(legacy) != len(orig["poems"]):
        errors.append(f"legacy_index length {len(legacy)} != original poems {len(orig['poems'])}")
    else:
        # spot check: legacy[i] should resolve to a poem whose text matches orig poems[i]
        poet_cache = {}
        sample_idx = list(range(0, len(legacy), max(1, len(legacy) // 200)))
        for i in sample_idx:
            slug, n = legacy[i].rsplit("/", 1)
            n = int(n)
            if slug not in poet_cache:
                poet_cache[slug] = load(os.path.join(ROOT, "data", "poets", f"{slug}.json"))["poems"]
            resolved = poet_cache[slug][n]
            if resolved["text"] != orig["poems"][i]["text"]:
                errors.append(f"legacy_index[{i}] -> {legacy[i]} text mismatch")

    # ---- index.json ----
    idx = load(os.path.join(ROOT, "data", "index.json"))
    if idx["count"] != orig["count"]:
        errors.append(f"index.json count {idx['count']} != original {orig['count']}")
    if len(idx["poets"]) != len(orig["poets"]):
        errors.append(f"index.json poets {len(idx['poets'])} != original {len(orig['poets'])}")
    if idx["workCount"] != len(orig.get("works", [])):
        errors.append(f"index.json workCount {idx['workCount']} != original {len(orig.get('works', []))}")
    if len(idx["poems"]) != len(orig["poems"]):
        errors.append(f"index.json poems length {len(idx['poems'])} != original {len(orig['poems'])}")

    print(f"poet files: {len(poet_files)}")
    print(f"total poems (poet files): {total_poems}")
    print(f"work files: {len(work_files)}")
    print(f"text mismatches: {text_mismatches}")
    print(f"section mismatches: {section_mismatches}")
    print(f"index.json size: {os.path.getsize(os.path.join(ROOT, 'data', 'index.json')) / 1024:.1f} KB")

    if errors:
        print(f"\n{len(errors)} ERROR(S):")
        for e in errors[:50]:
            print(" -", e)
        sys.exit(1)
    else:
        print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()
