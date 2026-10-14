"""Build the per-poet source files the poem and work pages cite.

Input:  data/bibliography.json - one record per printed source (book, edition, anthology,
        translation), each with a `match` saying which poems it covers:
        {"poets": [slug, ...], "collection": "...", "translator": "..."}  (poems whose
        `collection` and `translator` fields are exactly those values), or {"work": slug}.
Output: data/sources/<poet-slug>.json = {"poems": [{"c", "t", ...citation}], "works": {slug: citation}}
        read by app.js (one small fetch beside the poet file) and by build_pages.py.

Each citation carries ready-made strings, so the app and the static pages agree:
  line     - the source as a reader sees it, Chicago-style ("Edward, Earl of Derby, trans.,
             The Iliad of Homer (London: John Murray, 1864)"), with the title in <i>.
  mla, chi - the container part of the MLA and Chicago citations of a poem from that book.
  text     - where the digital text came from ("Project Gutenberg 6150") and its url.
  sure     - false when the details were not checked against a title page.
Records whose confidence is "unknown", or with no title, are left out (nothing is better
than a guess). Run after build_index.py; safe to run any number of times.
"""
import io
import json
import os
import re
from html import escape as _esc


def escape(s):
    return _esc(s, quote=False)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIB = os.path.join(ROOT, "data", "bibliography.json")
OUT = os.path.join(ROOT, "data", "sources")


def clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().rstrip(".,;:")


def digital(d):
    d = d or {}
    name, ident, url = clean(d.get("name")), clean(d.get("id")), clean(d.get("url"))
    if name.lower().startswith("project gutenberg"):
        m = re.search(r"\d+", ident) or re.search(r"/ebooks/(\d+)", url)
        ident = m.group(1) if m and m.groups() else (m.group(0) if m else ident)
    label = (name + (" " + ident if ident and ident not in name else "")).strip()
    return label, url


def names(s):
    s = clean(s)
    s = re.sub(r"\s*\((?:ed|eds|editor|editors)\.?\)\s*$", "", s, flags=re.I)
    s = re.sub(r"\s*\([^)]*\)", "", s)                     # bibliographers' asides
    return s.strip(" ,;")


def short_title(t):
    """Title-page titles can run to fifty words; keep the main title when it is long."""
    if len(t) <= 100:
        return t
    for sep in (": ", "; ", ". "):
        if sep in t[:100] and t.index(sep) >= 15:
            return t[: t.index(sep)]
    cut = t[:90].rsplit(" ", 1)[0].rstrip(",;:")
    return cut + "…"


def citation(r):
    title = short_title(clean(r.get("title")))
    if not title or r.get("confidence") == "unknown":
        return None
    kind = r.get("type") or "edition"
    raw_who = clean(r.get("author_or_editor"))
    editor = ""
    m = re.match(r"^(.*?);\s*(?:ed\.|edited by)\s*(.+)$", raw_who, re.I)
    if m:
        raw_who, editor = m.group(1), names(m.group(2))
    who = names(raw_who)
    if re.match(r"anonymous", who, re.I):
        who = ""
    tr = names(r.get("translator"))
    vol, ed, series = clean(r.get("volume")), clean(r.get("edition")), clean(r.get("series"))
    place, pub, year = clean(r.get("place")), clean(r.get("publisher")), clean(r.get("year"))
    edited = kind == "anthology" or bool(re.search(r"\((?:ed|eds|editor)\.?\)", str(r.get("author_or_editor") or ""), re.I))
    ititle = f"<i>{escape(title)}</i>"
    # Lead: who made the book.
    if kind == "translation" and tr and (not who or who == tr):
        lead = f"{escape(tr)}, trans."
        by_tr = ""
    else:
        lead = escape(who) + (", ed." if edited and who else "") if who else ""
        by_tr = f", trans. {escape(tr)}" if tr and tr != who else ""
    bits = [ititle + (f", {escape(vol)}" if vol else "") + (f", ed. {escape(editor)}" if editor else "") + by_tr]
    if ed and not re.search(r"gutenberg|impression|reprint", ed, re.I):
        bits.append(escape(ed))
    pubs = ": ".join(x for x in (escape(place), escape(pub)) if x)
    pubs = ", ".join(x for x in (pubs, escape(year)) if x)
    line = ", ".join(x for x in ([lead] if lead else []) + bits)
    if series:
        line += f" ({escape(series)})"
    if pubs:
        line += f" ({pubs})"
    # MLA container: Title, translated by X, edited by Y, Publisher, Year.
    mla = [ititle]
    if tr:
        mla.append(f"translated by {escape(tr)}")
    if (edited and who and who != tr) or editor:
        mla.append(f"edited by {escape(editor or who)}")
    if vol:
        mla.append(escape(vol))
    mla += [x for x in (escape(pub), escape(year)) if x]
    # Chicago (bibliography) container: In Title. Translated by X. Edited by Y. Place: Publisher, Year.
    chi = f"In {ititle}."
    if tr:
        chi += f" Translated by {escape(tr)}."
    if (edited and who and who != tr) or editor:
        chi += f" Edited by {escape(editor or who)}."
    if pubs:
        chi += f" {pubs}."
    label, url = digital(r.get("digital"))
    return {"line": line, "mla": ", ".join(mla), "chi": chi,
            "text": label, "url": url, "sure": r.get("confidence") == "verified"}


def main():
    recs = json.load(io.open(BIB, encoding="utf-8"))
    works_author = {}
    wdir = os.path.join(ROOT, "data", "works")
    for f in os.listdir(wdir):
        if f.endswith(".json"):
            w = json.load(io.open(os.path.join(wdir, f), encoding="utf-8"))
            works_author[w["slug"]] = w.get("authorSlug")
    per = {}
    n_poem = n_work = skipped = 0
    for r in recs:
        c = citation(r)
        if not c:
            skipped += 1
            continue
        m = r.get("match") or {}
        if m.get("work"):
            a = works_author.get(m["work"])
            if not a:
                skipped += 1
                continue
            per.setdefault(a, {"poems": [], "works": {}})["works"][m["work"]] = c
            n_work += 1
            continue
        for slug in m.get("poets") or []:
            e = dict(c, c=m.get("collection") or "", t=m.get("translator") or "")
            per.setdefault(slug, {"poems": [], "works": {}})["poems"].append(e)
            n_poem += 1
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".json") and f[:-5] not in per:
            os.remove(os.path.join(OUT, f))
    for slug, d in per.items():
        with io.open(os.path.join(OUT, slug + ".json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(d, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"sources: {len(per)} poet files, {n_poem} poem-group citations, {n_work} work citations, {skipped} records skipped")


if __name__ == "__main__":
    main()
