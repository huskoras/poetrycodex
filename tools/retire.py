#!/usr/bin/env python3
"""
Retire duplicate records: set "dupOf" on poems (and "mergedInto" on a whole poet file).

A retired poem stays in its poet file at its place, so no id moves, but build_index.py leaves
it out of every list and build_pages.py writes a redirect page at its address (AGENTS.md §3).

    python tools/retire.py rulings.json            # apply
    python tools/retire.py rulings.json --dry-run  # check and report, write nothing

rulings.json is a list of:
    {"from": "lazarus/103", "to": "ibn-gabirol/0"}            # a copy of another poem
    {"from": "pope/54", "to": "work:essay-on-man#0"}           # a copy of section 0 of a work
    {"from": "pope/54", "to": null}                            # undo: un-retire the poem
    {"poet": "macdonagh", "mergedInto": "macdonagh_t"}         # a whole poet merged into another
    {"poet": "macdonagh", "mergedInto": null}                  # undo the merge

Every rule is checked first, against the files as they are: the poem exists at that id, the
target exists, is not retired (nor being retired in this same list) and is not the poem itself;
a work target names a real section. Nothing is written if any rule fails.

Then each file is edited in place as text: only the one "dupOf" (or "mergedInto") line is
added, changed or removed, so the file keeps its indent, its line endings and every other byte.
Each file is read again just before it is written, and the write is refused if the file
changed while the edit was being made (another agent at work): run the tool again.
Afterwards: build_index.py, verify_split.py, build_pages.py, as after any content change.
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POETS = os.path.join(ROOT, "data", "poets")
WORKS = os.path.join(ROOT, "data", "works")
POEM_ID = re.compile(r"^([\w-]+)/(\d+)$")
WORK_ID = re.compile(r"^work:([\w-]+)#(\d+)$")
JSTR = r'"(?:[^"\\]|\\.)*"'


def read(path):
    with io.open(path, encoding="utf-8", newline="") as f:   # newline="": keep \r\n as it is
        return f.read()


def poem_spans(text):
    """(start, end) of every object in the file's "poems" array, in order."""
    m = re.search(r'"poems"\s*:\s*\[', text)
    if not m:
        return []
    dec, pos, spans = json.JSONDecoder(), m.end(), []
    while True:
        while pos < len(text) and text[pos] in " \t\r\n,":
            pos += 1
        if pos >= len(text) or text[pos] == "]":
            return spans
        _, end = dec.raw_decode(text, pos)
        spans.append((pos, end))
        pos = end


def set_key(obj_text, after_key, after_val, key, value):
    """obj_text with key set to value (a str, or None to remove it). A new key goes right after
    the "after_key": "after_val", pair, with the same whitespace (line ending and indent)."""
    pair = re.compile(r'("%s"\s*:\s*)%s' % (re.escape(key), JSTR))
    found = pair.findall(obj_text)
    if len(found) > 1:
        raise ValueError(f'"{key}" occurs {len(found)} times')
    if value is None:
        if not found:
            return obj_text
        out, k = re.subn(r'(\r?\n[ \t]*|[ \t]*)"%s"\s*:\s*%s\s*,' % (re.escape(key), JSTR), "", obj_text, count=1)
        if not k:      # the last key of the object: take the comma before it instead
            out, k = re.subn(r',(\s*)"%s"\s*:\s*%s' % (re.escape(key), JSTR), "", obj_text, count=1)
        if not k:
            raise ValueError(f'could not remove "{key}"')
        return out
    if found:
        return pair.sub(lambda m: m.group(1) + json.dumps(value, ensure_ascii=False), obj_text, count=1)
    anchor = re.compile(r'("%s"\s*:\s*%s\s*,)(\s*)' % (re.escape(after_key), re.escape(json.dumps(after_val, ensure_ascii=False))))
    if len(anchor.findall(obj_text)) != 1:
        raise ValueError(f'cannot find one "{after_key}": "{after_val}", to put "{key}" after')
    return anchor.sub(lambda m: m.group(1) + m.group(2) + json.dumps(key) + ": "
                      + json.dumps(value, ensure_ascii=False) + "," + m.group(2), obj_text, count=1)


def edit_file(text, slug, poem_rules, merge_rule):
    """The file's text with the rules applied; checks that nothing but those fields changed."""
    before = json.loads(text)
    spans = poem_spans(text)
    if len(spans) != len(before.get("poems") or []):
        raise ValueError("could not find every poem object in the file")
    out, last = [], 0
    for n, target in sorted(poem_rules.items()):
        a, b = spans[n]
        out.append(text[last:a])
        out.append(set_key(text[a:b], "id", f"{slug}/{n}", "dupOf", target))
        last = b
    out.append(text[last:])
    new = "".join(out)
    if merge_rule is not ...:
        head_end = re.search(r'"poems"\s*:', new).start()   # the poet's own keys come first
        new = set_key(new[:head_end], "slug", slug, "mergedInto", merge_rule) + new[head_end:]
    after = json.loads(new)
    # the parsed file must differ only in the fields this tool sets
    want = json.loads(text)
    for n, target in poem_rules.items():
        if target is None:
            want["poems"][n].pop("dupOf", None)
        else:
            want["poems"][n]["dupOf"] = target
    if merge_rule is not ...:
        if merge_rule is None:
            want.pop("mergedInto", None)
        else:
            want["mergedInto"] = merge_rule
    if after != want:
        raise ValueError("the edit changed more than the retired fields (nothing written)")
    return new


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    dry = "--dry-run" in argv
    if len(args) != 1:
        print(__doc__)
        return 2
    rules = json.load(io.open(args[0], encoding="utf-8"))
    if not isinstance(rules, list):
        print("rulings file must be a JSON list")
        return 2

    cache = {}

    def poet(slug):
        if slug not in cache:
            p = os.path.join(POETS, slug + ".json")
            cache[slug] = json.loads(read(p)) if os.path.exists(p) else None
        return cache[slug]

    errors = []
    by_file = {}       # slug -> {"poems": {n: target}, "merge": value or ...}
    froms = set()
    for r in rules:
        if isinstance(r, dict) and "from" in r:
            froms.add(r["from"])
    for k, r in enumerate(rules):
        where = f"rule {k + 1} {json.dumps(r, ensure_ascii=False)}"
        if not isinstance(r, dict):
            errors.append(f"{where}: not an object")
            continue
        if "poet" in r:
            slug, into = r.get("poet"), r.get("mergedInto", ...)
            if into is ...:
                errors.append(f"{where}: a poet rule needs \"mergedInto\"")
                continue
            if poet(slug) is None:
                errors.append(f"{where}: no poet file {slug!r}")
                continue
            if into is not None and (into == slug or poet(into) is None or poet(into).get("mergedInto")):
                errors.append(f"{where}: mergedInto {into!r} is not another live poet")
                continue
            by_file.setdefault(slug, {"poems": {}, "merge": ...})["merge"] = into
            continue
        src, to = r.get("from"), r.get("to", ...)
        m = POEM_ID.match(src or "")
        if not m or to is ...:
            errors.append(f"{where}: needs \"from\": \"<poet>/<n>\" and \"to\"")
            continue
        slug, n = m.group(1), int(m.group(2))
        pf = poet(slug)
        poems = (pf or {}).get("poems") or []
        if n >= len(poems) or poems[n].get("id") != src:
            errors.append(f"{where}: no poem {src} at its place in data/poets/{slug}.json")
            continue
        if to is not None:
            mp, mw = POEM_ID.match(str(to)), WORK_ID.match(str(to))
            if mp:
                tp = poet(mp.group(1))
                tpoems = (tp or {}).get("poems") or []
                ti = int(mp.group(2))
                if to == src:
                    errors.append(f"{where}: a poem cannot be a copy of itself")
                elif ti >= len(tpoems) or tpoems[ti].get("id") != to:
                    errors.append(f"{where}: target {to} is not a poem")
                elif tpoems[ti].get("dupOf") or to in froms:
                    errors.append(f"{where}: target {to} is itself retired (point at the text that stays)")
                elif tp.get("mergedInto"):
                    errors.append(f"{where}: target {to} is in a merged poet's file")
            elif mw:
                wp = os.path.join(WORKS, mw.group(1) + ".json")
                if not os.path.exists(wp):
                    errors.append(f"{where}: no work {mw.group(1)!r}")
                else:
                    secs = len(json.loads(read(wp)).get("sections") or [])
                    if int(mw.group(2)) >= secs:
                        errors.append(f"{where}: {mw.group(1)} has {secs} sections")
            else:
                errors.append(f"{where}: \"to\" must be \"<poet>/<n>\", \"work:<slug>#<i>\" or null")
                continue
        rec = by_file.setdefault(slug, {"poems": {}, "merge": ...})
        if n in rec["poems"]:
            errors.append(f"{where}: {src} has two rules")
        rec["poems"][n] = to

    if errors:
        print(f"{len(errors)} problem(s), nothing written:")
        for e in errors:
            print(" -", e)
        return 1

    changed = 0
    for slug, rec in sorted(by_file.items()):
        path = os.path.join(POETS, slug + ".json")
        text = read(path)                    # read again: the file may have moved on since the check
        try:
            new = edit_file(text, slug, rec["poems"], rec["merge"])
        except ValueError as e:
            print(f"{slug}: {e}")
            return 1
        if new == text:
            print(f"{slug}: already as ruled")
            continue
        n_rules = len(rec["poems"]) + (rec["merge"] is not ...)
        if dry:
            print(f"{slug}: would set {n_rules} field(s)")
            continue
        if read(path) != text:               # changed under us while editing
            print(f"{slug}: the file changed while it was being edited; nothing written to it. Run again.")
            return 1
        with io.open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new)
        changed += 1
        print(f"{slug}: set {n_rules} field(s)")
    print(("dry run: " if dry else "") + f"{len(rules)} rule(s), {changed} file(s) written")
    if not dry and changed:
        print("Next: python tools/build_index.py && python tools/verify_split.py && python tools/build_pages.py")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
