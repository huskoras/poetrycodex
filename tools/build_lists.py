#!/usr/bin/env python3
"""Build the small files every list page and the search read, so no reader ever downloads the
whole archive index (data/index.json: 40 MB at 116,000 poems, and it grows with every poem).

Run after build_index.py (it reads data/index.json and data/translators.json):

    python -I tools/build_lists.py              # writes data/l/ and data/s/
    python -I tools/build_lists.py --root DIR   # the same for a site tree elsewhere (sync_r2.py)
    python -I tools/build_lists.py --check-js   # also check app.js splits words as this does (Node)

Like the shards (build_shards.py) these are derived files: never edit them, never commit them
(.gitignore). tools/sync_r2.py builds them into the copy it uploads.

data/l/  lists of poems, each cut into pages of a few hundred (about 35 KB compressed)
  <list>/_.json   {"n": poems, "p": [[page file, poems on it], ...]}; a list of up to INLINE
                  poems has them in "items" instead, and no pages
  <list>/<h>.json one page: the poems' index entries (id, title, primarySubject, excerpt cut to
                  EXCERPT_MAX, and subjects / collection / translator / hasNote / form /
                  language when the index has them). A page is named after its content (h, a
                  hash), so it never changes once written; only _.json does.
     lists:  all                       every poem by title
             s-<subject>               by subject (subjectKey in app.js: "death-dying")
             f-<form>                  by form ("f-Sonnet")
             sf-<subject>-<form>       both
             c-<category>              by tradition (catListKey in app.js: "c-turkish-ottoman");
                                       its _.json also has "start", the era page's "Poems to
                                       begin with" (eraListsHTML in app.js, the same rule)
     Pages end where an entry's id hashes to a multiple of AVG (at least MIN, at most MAX
     entries), so a poem added to a list changes one page, not every page after it, and a
     publish uploads only the pages that changed.
  p/<poet>.json   a poet's page: {"bio", "credit", "poems": [slim entries in id order, with
                  "first", the first line, for reading lists]}
  t/<slug>.json   a translator's poems (slim entries), t/_counts.json {slug: number of poems}
  counts.json     {"forms": [{name, count}], "sf": {"<subject>|<form>": count}}

data/s/  the search index
  manifest.json   {"n": docs, "bits": how many top bits of a doc's number pick its block,
                   "depth": longest key, "keys": [every word file], "caps": {...}}
  d/<k>.json      the docs of block k: [[number in base 36, id, title, poet], ...]
  t/k<key>.json   {word: [title (Codex Note), title (short), title (other), names, opening
                  lines]}: the docs under that word in each field, as gaps between doc numbers
                  in base 36 joined by "." ("" none; 0 when the word is in so many docs in that
                  field that it is not indexed there; a word whose titles are not indexed is
                  left out of a search, like "the")
     A doc's number is fixed, from its id (doc_keys), so adding a poem rewrites only its block
     and the files of its words: R2 bills every file written. The title is split in three
     fields so that a search can put poems with a Codex Note, then short titles, first.
     Words are filed by their first two letters; a file grown past TARGET bytes is cut by the
     third letter, and so on (up to MAX_DEPTH). Chinese, Japanese and the other scripts without
     spaces go by one of 256 buckets of their first character (tools/textlang.py).
"""
import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from array import array

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from textlang import search_tokens, query_tokens, term_key, normalize  # noqa: E402

EXCERPT_MAX = 340        # app.js clips a card at 300 characters (clipExcerpt), so 340 shows the same
INLINE = 300             # a list this short is one file
MIN, AVG, MAX = 120, 330, 900
DOC_BLOCK = 256
TARGET = 192 * 1024      # a word file this big is cut by one more letter
MAX_DEPTH = 6
ERA_START = 10           # "Poems to begin with": the first poem of the 10 poets with most poems


def dumps(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"))


def slug_rule(s):
    """The list key of a category or a subject (catListKey / subjectKey in app.js)."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def sort_key(title):
    """sortKey() in app.js (without "A", "An", "The" and leading marks), plus a fold for
    accents (Intl.Collator("en") ignores them first). Unlike app.js it keeps a title in Greek,
    Cyrillic, Arabic or Chinese whole (only marks that are not letters or digits go), so those
    file after the Latin titles by their own letters instead of all first."""
    s = title.lower()
    s = re.sub(r"^[\"'“‘]*(a|an|the)\s+", "", s)
    k = 0
    while k < len(s) and unicodedata.category(s[k])[0] not in "LN":
        k += 1
    s = s[k:].strip()
    f = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return (f.casefold(), s)


def clip(ex):
    ex = ex or ""
    return ex if len(ex) <= EXCERPT_MAX else ex[:EXCERPT_MAX]


def h32(s):
    return int(hashlib.sha1(s.encode("utf-8")).hexdigest()[:8], 16)


class Writer:
    def __init__(self, root):
        self.root = root
        self.files = 0
        self.bytes = 0

    def put(self, rel, text):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = text.encode("utf-8")
        with open(path, "wb") as f:
            f.write(data)
        self.files += 1
        self.bytes += len(data)
        return len(data)


def write_list(w, name, entries, extra=None, stats=None):
    """One list: _.json plus pages cut where an id's hash says (see the docstring)."""
    meta = {"n": len(entries)}
    if extra:
        meta.update(extra)
    if len(entries) <= INLINE:
        meta["items"] = entries
    else:
        pages, cur = [], []
        for e in entries:
            cur.append(e)
            if len(cur) >= MAX or (len(cur) >= MIN and h32(e["id"]) % AVG == 0):
                pages.append(cur)
                cur = []
        if cur:
            pages.append(cur)
        meta["p"] = []
        for pg in pages:
            text = dumps(pg)
            hname = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
            size = w.put(f"l/{name}/{hname}.json", text)
            meta["p"].append([hname, len(pg)])
            if stats is not None:
                stats["pages"] += 1
                stats["max_page"] = max(stats["max_page"], size)
    size = w.put(f"l/{name}/_.json", dumps(meta))
    if stats is not None:
        stats["max_meta"] = max(stats["max_meta"], size)
    return meta


def b36(n):
    if n == 0:
        return "0"
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append("0123456789abcdefghijklmnopqrstuvwxyz"[r])
    return "".join(reversed(out))


def encode(docs):
    prev, out = 0, []
    for d in docs:
        out.append(b36(d - prev))
        prev = d
    return ".".join(out)


def author_terms(name, translator):
    tr = re.sub(r"^trans\.\s*", "", translator or "", flags=re.I)
    tr = re.sub(r"\([^)]*\)", " ", tr)
    return search_tokens(name + " " + tr)


def doc_keys(ids):
    """A fixed 32-bit number for each poem, from its id (so a publish moves no other poem's
    number and rewrites only the files its words are in). The rare clash takes the next free
    number, in id order."""
    used, keys = set(), {}
    for i in sorted(ids):
        k = int(hashlib.sha1(i.encode("utf-8")).hexdigest()[:8], 16)
        while k in used:
            k = (k + 1) & 0xFFFFFFFF
        used.add(k)
        keys[i] = k
    return keys


def build_search(w, poems, poet_name, verbose):
    n = len(poems)
    keys = doc_keys([p["id"] for p in poems])
    bits = max(0, math.ceil(math.log2(max(1, n) / DOC_BLOCK)))   # 2**bits blocks of ~DOC_BLOCK docs
    caps = {"t": max(50000, int(n * 0.2)), "a": max(50000, int(n * 0.2)), "x": max(30000, int(n * 0.08))}
    post = {}                 # term -> array of key * 8 + field (FIELDS)
    blocks = {}
    for p in poems:
        k = keys[p["id"]]
        slug = p["id"].rsplit("/", 1)[0]
        name = poet_name.get(slug, "")
        blocks.setdefault(k >> (32 - bits) if bits else 0, []).append([b36(k), p["id"], p["title"], name])
        # the title's words go in one of three fields by how good a first result the poem is:
        # 0 it has a Codex Note, 1 a short title (up to three words), 2 the rest
        tf = 0 if p.get("hasNote") else 1 if len(query_tokens(p["title"])) <= 3 else 2
        fields = ((tf, search_tokens(p["title"])),
                  (3, author_terms(name, p.get("translator"))),
                  (4, search_tokens((p.get("excerpt") or "") + " " + (p.get("collection") or ""))))
        for f, toks in fields:
            for t in toks:
                a = post.get(t)
                if a is None:
                    a = post[t] = array("Q")
                a.append(k * 8 + f)
    enc = {}
    capped = 0
    for t, a in post.items():
        fl = ([], [], [], [], [])
        for v in sorted(a):
            fl[v & 7].append(v >> 3)
        row = [encode(x) for x in fl]
        if len(fl[0]) + len(fl[1]) + len(fl[2]) > caps["t"]:
            row[0] = row[1] = row[2] = 0
            capped += 1
        if len(fl[3]) > caps["a"]:
            row[3] = 0
            capped += 1
        if len(fl[4]) > caps["x"]:
            row[4] = 0
            capped += 1
        enc[t] = row
    post = None
    # group words into files, cutting a big file by one more letter
    groups = {}
    for t in enc:
        groups.setdefault(term_key(t, 2), []).append(t)
    final = {}
    stack = [(k, ts, 2) for k, ts in groups.items()]
    while stack:
        k, ts, depth = stack.pop()
        size = sum(len(t) * 2 + 16 + sum(len(x) if isinstance(x, str) else 1 for x in enc[t]) for t in ts)
        if size <= TARGET or depth >= MAX_DEPTH or k.startswith("x"):
            final[k] = ts
            continue
        stay, sub = [], {}
        for t in ts:
            if len(t) <= depth:
                stay.append(t)
            else:
                sub.setdefault(term_key(t, depth + 1), []).append(t)
        if stay:
            final[k] = stay
        stack.extend((k2, ts2, depth + 1) for k2, ts2 in sub.items())
    biggest = 0
    for k in sorted(final):
        biggest = max(biggest, w.put(f"s/t/k{k}.json", dumps({t: enc[t] for t in sorted(final[k])})))
    for b, rows in blocks.items():
        rows.sort(key=lambda r: int(r[0], 36))
        w.put(f"s/d/{b}.json", dumps(rows))
    manifest = {"n": n, "bits": bits, "depth": MAX_DEPTH, "keys": sorted(final), "caps": caps}
    w.put("s/manifest.json", dumps(manifest))
    if verbose:
        print(f"search: {n} docs in {len(blocks)} blocks, {len(enc)} words in {len(final)} files "
              f"(largest {biggest // 1024} KB), {capped} word fields over the caps")


def slim(p):
    e = {"id": p["id"], "title": p["title"], "primarySubject": p["primarySubject"]}
    for k in ("translator", "form", "language"):
        if p.get(k):
            e[k] = p[k]
    return e


def first_line(ex):
    for line in (ex or "").split("\n"):
        s = line.strip().rstrip("…").strip()
        if s:
            return s[:100]
    return ""


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if "--root" in sys.argv:
        root = sys.argv[sys.argv.index("--root") + 1]
    data = os.path.join(root, "data")
    with io.open(os.path.join(data, "index.json"), encoding="utf-8") as f:
        idx = json.load(f)
    poets = {p["slug"]: p for p in idx["poets"]}
    poet_name = {s: p["name"] for s, p in poets.items()}
    poems = idx["poems"]

    # write everything into a new folder, then swap it in, so a failed run leaves the old files
    tmp = tempfile.mkdtemp(prefix="lists-", dir=data)
    w = Writer(tmp)
    stats = {"pages": 0, "max_page": 0, "max_meta": 0}

    entries = []
    for p in poems:
        e = {k: p[k] for k in ("id", "title", "primarySubject") if k in p}
        e["excerpt"] = clip(p.get("excerpt"))
        for k in ("subjects", "collection", "translator", "hasNote", "form", "language"):
            if p.get(k):
                e[k] = p[k]
        entries.append(e)
    by_title = sorted(range(len(entries)), key=lambda i: (sort_key(entries[i]["title"]), entries[i]["id"]))
    titled = [entries[i] for i in by_title]

    write_list(w, "all", titled, stats=stats)
    subj, form, sf, cat = {}, {}, {}, {}
    for e in titled:
        sk = slug_rule(e["primarySubject"])
        subj.setdefault(sk, []).append(e)
        if e.get("form"):
            form.setdefault(e["form"], []).append(e)
            sf.setdefault(sk + "-" + e["form"], []).append(e)
        c = (poets.get(e["id"].rsplit("/", 1)[0]) or {}).get("category")
        if c:
            cat.setdefault(c, []).append(e)
    for k, es in subj.items():
        write_list(w, "s-" + k, es, stats=stats)
    for k, es in form.items():
        write_list(w, "f-" + k, es, stats=stats)
    for k, es in sf.items():
        write_list(w, "sf-" + k, es, stats=stats)

    # "Poems to begin with" on an era page: eraListsHTML in app.js. Each poet's first poem with
    # a Codex Note, else the first poem (index order); for the ERA_START poets with most poems
    # and works (ties: the earlier poet), then in date order.
    firsts = {}
    for e in entries:
        s = e["id"].rsplit("/", 1)[0]
        f = firsts.get(s)
        if f is None or (e.get("hasNote") and not f.get("hasNote")):
            firsts[s] = e
    size = lambda p: (p.get("poemCount") or 0) + (p.get("workCount") or 0)
    for c, es in cat.items():
        inc = [p for p in idx["poets"] if p.get("category") == c and size(p) > 0]
        start = []
        if len(inc) >= 2:
            by_size = sorted(inc, key=lambda p: (-size(p), p.get("order") or 0))
            start = [firsts[p["slug"]] for p in by_size if p["slug"] in firsts][:ERA_START]
            start.sort(key=lambda e: (poets[e["id"].rsplit("/", 1)[0]].get("order") or 0))
        write_list(w, "c-" + slug_rule(c), es, {"start": start}, stats=stats)

    # poets: bio, credit and every poem (slim) in id order
    by_poet = {}
    for p in poems:
        by_poet.setdefault(p["id"].rsplit("/", 1)[0], []).append(p)
    for s, p in poets.items():
        rows = []
        for q in by_poet.get(s, []):
            e = slim(q)
            fl = first_line(q.get("excerpt"))
            if fl:
                e["first"] = fl
            rows.append(e)
        w.put(f"l/p/{s}.json", dumps({"bio": p.get("bio") or [], "credit": p.get("credit"), "poems": rows}))

    # translators (data/translators.json: each person's `match` strings)
    tr_counts = {}
    try:
        with io.open(os.path.join(data, "translators.json"), encoding="utf-8") as f:
            trs = json.load(f)
    except (OSError, ValueError):
        trs = []
    owner = {}
    for t in trs:
        for m in t.get("match") or []:
            owner.setdefault(m, []).append(t["slug"])
    tr_rows = {}
    for p in poems:
        for s in owner.get(p.get("translator") or "", []):
            tr_rows.setdefault(s, []).append(slim(p))
    for s, rows in tr_rows.items():
        w.put(f"l/t/{s}.json", dumps(rows))
        tr_counts[s] = len(rows)
    w.put("l/t/_counts.json", dumps(tr_counts))

    forms = sorted(({"name": k, "count": len(v)} for k, v in form.items()), key=lambda x: -x["count"])
    w.put("l/counts.json", dumps({"forms": forms, "sf": {k: len(v) for k, v in sf.items()}}))
    n_lists = 1 + len(subj) + len(form) + len(sf) + len(cat)
    print(f"lists: {n_lists} lists in {stats['pages']} pages (largest {stats['max_page'] // 1024} KB, "
          f"largest list file {stats['max_meta'] // 1024} KB), {len(poets)} poet files, {len(tr_rows)} translator files")

    build_search(w, poems, poet_name, True)

    # checks before the swap: every list adds up
    assert sum(len(v) for v in subj.values()) == len(poems), "subject lists do not add up"
    assert len(titled) == idx["count"], "the list of all poems is not the index's count"

    for sub in ("l", "s"):
        new, cur, old = os.path.join(tmp, sub), os.path.join(data, sub), os.path.join(data, sub + ".old")
        shutil.rmtree(old, ignore_errors=True)
        if os.path.exists(cur):
            os.replace(cur, old)
        os.replace(new, cur)
        shutil.rmtree(old, ignore_errors=True)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"lists and search: {w.files} files, {w.bytes / 1e6:.1f} MB")

    if "--check-js" in sys.argv:
        check_js(root, poems)


def check_js(root, poems):
    """The app must split a search into the words this script filed things under. Runs the
    tokeniser from app.js (between the "<search-tokens>" markers) in Node over every title
    and opening lines, and compares."""
    src = io.open(os.path.join(root, "app.js"), encoding="utf-8").read()
    m = re.search(r"// <search-tokens>(.*?)// </search-tokens>", src, re.S)
    if not m:
        sys.exit("check-js: no <search-tokens> block in app.js")
    texts = [p["title"] for p in poems] + [p.get("excerpt") or "" for p in poems]
    texts += ["Ode on a Grecian Urn", "Haşim İŞIK", "Cædmon þæt", "床前明月光，疑是地上霜。", "ひさかたの光のどけき",
              "كتاب الأغاني", "دیوان حافظ", "שִׁירֵי מֶלֶךְ", "Ёлка и ёж", "ΟΔΥΣΣΕΥΣ ἄνδρα μοι", "Ζεύς", "मेघदूत", "한국 시",
              "ﷲ ﻻ", "Ｆｕｌｌｗｉｄｔｈ", "co-operate o'er", "ไทย", "ـــمـد", "קורא־ספר", "می‌روم"]
    with tempfile.TemporaryDirectory() as d:
        inp = os.path.join(d, "in.json")
        with io.open(inp, "w", encoding="utf-8") as f:
            json.dump(texts, f, ensure_ascii=False)
        js = os.path.join(d, "t.js")
        with io.open(js, "w", encoding="utf-8") as f:
            f.write(m.group(1) + "\nconst fs=require('fs');const t=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));"
                    "process.stdout.write(JSON.stringify(t.map((s)=>[[...indexTokens(s)].sort(),queryTokens(s),"
                    "queryTokens(s).map((x)=>termKey(x,2))])));")
        out = subprocess.run(["node", js, inp], capture_output=True)
        if out.returncode:
            sys.exit("check-js: node failed: " + out.stderr.decode("utf-8", "replace")[:400])
        got = json.loads(out.stdout.decode("utf-8"))
    bad = 0
    for s, (ix, q, keys) in zip(texts, got):
        want = (sorted(search_tokens(s)), query_tokens(s), [term_key(x, 2) for x in query_tokens(s)])
        if (ix, q, keys) != (want[0], want[1], want[2]):
            bad += 1
            if bad <= 5:
                print("check-js: differs on", repr(s[:60]), "\n  py", want[1][:12], "\n  js", q[:12])
    print(f"check-js: {len(texts)} texts, {bad} differ")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
