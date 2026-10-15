"""List the words of newly added text that occur nowhere else in the archive: most OCR slips
("chaunglessc", "accursM", "skifF") show up here, among genuine rarities (names, old
spellings, a translator's coinages), which the reader of the list tells apart by the source.

    python -I tools/odd_words.py --poets keats,tennyson     # poems added since HEAD
    python -I tools/odd_words.py --works inferno-wright     # a whole new (or changed) work
    python -I tools/odd_words.py --poets x --all            # every poem of the file, not only new ones

"New" poems are those beyond the poem count of the committed (HEAD) copy of the file, so run
it before committing. The word list it compares against is every poem and work in the
committed archive (read once, then kept in a cache file under the system temp folder and
rebuilt when HEAD changes). Also listed: words with a capital inside, digits inside words,
double full stops, stray characters. Read-only: it never writes a data file.
"""
import argparse
import collections
import glob
import io
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORD = re.compile(r"[A-Za-zÀ-ÿĀ-žƀ-ɏ]+(?:['’][A-Za-z]+)*")
ODD_SHAPE = re.compile(r"[a-z][A-Z]|\w\d|\d[a-z]")
DEBRIS = re.compile(r"\S*(?<!\.)\.\.(?!\.)\S*|[|{}\^~<>_*\\■«»™]|\s[b-hj-np-z]\s")


def head():
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def committed(path):
    r = subprocess.run(["git", "show", "HEAD:" + path], cwd=ROOT, capture_output=True)
    return json.loads(r.stdout.decode("utf-8")) if r.returncode == 0 else None


def texts_of(f):
    if "poems" in f:
        for q in f.get("poems") or []:
            yield q.get("text", "")
    for s in f.get("sections") or []:
        yield s.get("text", "")


def head_files():
    """Every committed poet and work file, read straight from HEAD with one git process."""
    names = [p for p in subprocess.run(["git", "ls-tree", "-r", "--name-only", "HEAD", "data/poets", "data/works"],
                                       cwd=ROOT, capture_output=True, text=True).stdout.split() if p.endswith(".json")]
    proc = subprocess.Popen(["git", "cat-file", "--batch"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    def feed():   # in its own thread: git's answers must be read while the names go in
        proc.stdin.write("".join(f"HEAD:{p}\n" for p in names).encode("utf-8"))
        proc.stdin.close()
    import threading
    threading.Thread(target=feed, daemon=True).start()
    for p in names:
        hdr = proc.stdout.readline().split()
        if len(hdr) < 3 or hdr[1] != b"blob":
            continue
        data = proc.stdout.read(int(hdr[2]))
        proc.stdout.read(1)
        try:
            yield p, json.loads(data.decode("utf-8"))
        except ValueError:
            continue
    proc.wait()


def count(f):
    c = collections.Counter()
    for t in texts_of(f):
        c.update(w.lower() for w in WORD.findall(t))
    return c


def lexicon():
    """Word counts of the committed archive, cached per HEAD."""
    cache = os.path.join(tempfile.gettempdir(), "poetrycodex-lexicon.json")
    h = head()
    try:
        c = json.load(io.open(cache, encoding="utf-8"))
        if c.get("head") == h:
            return collections.Counter(c["words"])
    except (OSError, ValueError):
        pass
    words = collections.Counter()
    for _, f in head_files():
        words.update(count(f))
    try:   # written aside and renamed, so a checker running at the same moment never reads half a file
        tmp = f"{cache}.{os.getpid()}"
        json.dump({"head": h, "words": words}, io.open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
        os.replace(tmp, cache)
    except OSError:
        pass
    return words


def new_units(kind, slug, everything):
    path = f"data/{kind}/{slug}.json"
    f = json.load(io.open(os.path.join(ROOT, path), encoding="utf-8"))
    key = "poems" if kind == "poets" else "sections"
    units = f.get(key) or []
    old = committed(path)
    start = 0 if everything or not old else len(old.get(key) or [])
    for i, u in enumerate(units[start:], start):
        yield (u.get("id") or f"{slug} §{i}"), u.get("title", ""), u.get("text", "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--poets", default="")
    ap.add_argument("--works", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--max", type=int, default=400, help="lines to print per file")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    lex = lexicon()
    for kind, slugs in (("poets", a.poets), ("works", a.works)):
        for slug in [s for s in slugs.split(",") if s]:
            own = collections.Counter()
            rows = []
            units = list(new_units(kind, slug, a.all))
            base = lex
            if a.all:
                old = committed(f"data/{kind}/{slug}.json")
                base = lex - count(old) if old else lex
            for uid, title, text in units:
                own.update(w.lower() for w in WORD.findall(text))
            for uid, title, text in units:
                for line in text.split("\n"):
                    odd = [w for w in WORD.findall(line) if base[w.lower()] == 0 and own[w.lower()] == 1]
                    shape = [w for w in re.findall(r"\S+", line) if ODD_SHAPE.search(w) and not re.match(r"^(Mc|Mac|O'|D')", w)]
                    junk = [m.group(0).strip() for m in DEBRIS.finditer(line)]
                    if odd or shape or junk:
                        rows.append((uid, title, sorted(set(odd + shape + junk)), line.strip()))
            words = sum(own.values())
            print(f"== {kind[:-1]} {slug}: {len(units)} {'poems' if kind == 'poets' else 'sections'} checked, "
                  f"{words} words, {len(rows)} lines to look at ({1000 * len(rows) / max(words, 1):.1f} per 1000 words)")
            for uid, title, flagged, line in rows[: a.max]:
                print(f"  {uid} | {title[:40]} | {', '.join(flagged)} | {line[:110]}")
            if len(rows) > a.max:
                print(f"  ... {len(rows) - a.max} more (use --max)")


if __name__ == "__main__":
    main()
