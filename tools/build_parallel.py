"""Build data/parallel.json: which original-language text faces which translation.

Input:  data/parallel-oe.json (pairs and line maps made by the Old English specialist agent:
        poems[] {oe_id, translations[] {id, mode, exceptions}}, works[] {oe_work,
        translation_work, sections[] {section, oe_lines, oe_section?, chunks?, exceptions?,
        ocr_junk_paras?, kennedy_captions?, para_anchors?}, line_for_line}).
Output: data/parallel.json, read by app.js for the facing-page (Loeb-style) view:
  {"poems": {<poem id>: [{"with": <other id>, "orig": <original's id>, "lang": "ang",
                          "mode": "lines"|"blocks", "map": [[oa, ob, ta, tb(, per)], ...] | null}]},
   "works": {<work slug>: [{"with": <other slug>, "orig": <original's slug>, "lang": "ang",
                            "lfl": bool, "merged"?: [n...], "sections": [{"tr": i, "oe": [a, b], "oes"?: j,
                            "map"?: [...], "skip"?: [k...], "caps"?: [k...],
                            "chunks": [{"oe": [a, b], "paras": [p, q], "from"?: "..."}] | null}]}]}}
Units: every number on the translation side is a 1-based index of the non-empty lines of its
text (a verse line, or a paragraph of a prose translation printed one paragraph per line); on
the original's side of a poem the same, and on the original's side of a work the line numbers
of the original's sections ("Lines 126-259"), or, with "oes", of that one section from 1 (the
Meters of Boethius are numbered meter by meter). map null = line for line. tb < ta ([0, -1])
= no counterpart (a heading, a prose rubric). per = 2: each original line takes two lines of
the translation (Thorpe sets every half-line as a line). "from" = the sentence a chunk starts
with when it begins inside a paragraph; "skip" = running heads, page numbers, marginal line
markers and footnotes of the printed book (left out of the facing view); "caps" = the
translator's own section captions; "merged" = lines of the original's text that stand for two
numbers (n and n + 1, a slip in the text), so the lines after them keep their right numbers.
Both directions are written, so the original's page and the translation's page both know.
"""
import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "parallel-oe.json")
OUT = os.path.join(ROOT, "data", "parallel.json")
LANG = "ang"   # every pair in parallel-oe.json has an Old English original
# Lines an original's text runs together: {work slug: [n, ...]}, the line numbered n there also
# standing for n + 1, so the numbering after it stays right. Empty now: the one case,
# beowulf-oe ASPR 140-141, was restored in the text itself on 14 Oct 2026.
MERGED = {}


def seg_map(exc):
    if not exc or exc == ["1:1"]:
        return None
    out = []
    for e in exc:
        if not isinstance(e, dict) or not e.get("oe"):
            continue
        tr = e.get("tr") or [0, -1]          # an OE line with no counterpart (a heading)
        seg = [e["oe"][0], e["oe"][1], tr[0], tr[1]]
        if e.get("per_line"):
            seg.append(e["per_line"])
        out.append(seg)
    return out or None


def chunk(c):
    out = {"oe": c.get("oe_lines"), "paras": c.get("tr_paras") or c.get("tr_lines")}
    st = c.get("tr_start")
    if isinstance(st, dict) and st.get("mid_paragraph") and st.get("starts_with"):
        out["from"] = st["starts_with"]
    return out


def section(s):
    rec = {"tr": s["section"], "oe": s.get("oe_lines")}
    if s.get("oe_section") is not None and not s.get("chunks"):
        rec["oes"] = s["oe_section"]
    m = seg_map(s.get("exceptions"))
    if m:
        rec["map"] = m
    junk = s.get("ocr_junk_paras") or {}
    skip = sorted({k for v in junk.values() if isinstance(v, list) for k in v})
    if skip:
        rec["skip"] = skip
    if s.get("kennedy_captions"):
        rec["caps"] = sorted(s["kennedy_captions"])
    anchors = [a for a in (s.get("para_anchors") or []) if a.get("oe_lines")]
    if anchors:   # an OE line range for every paragraph: finer than the chunks
        rec["chunks"] = [{"oe": a["oe_lines"], "paras": [a["para"], a["para"]]} for a in anchors]
    else:
        rec["chunks"] = [chunk(c) for c in (s.get("chunks") or [])] or None
    return rec


def retired_ids():
    """Poem ids retired with dupOf (data/index.json "retired", written by build_index.py)."""
    try:
        return json.load(io.open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8")).get("retired") or {}
    except (OSError, ValueError):
        return {}


def main():
    d = json.load(io.open(SRC, encoding="utf-8"))
    poems, works = {}, {}
    retired = retired_ids()   # a retired poem has no page of its own to face anything on
    for p in d.get("poems", []):
        oe = p["oe_id"]
        for t in p.get("translations", []):
            if t.get("confidence") not in ("high", "medium"):
                continue
            if oe in retired or t["id"] in retired:
                print(f"parallel: skipped {oe} <> {t['id']}: retired (point the pair at {retired.get(oe) or retired.get(t['id'])})")
                continue
            rec = {"orig": oe, "lang": LANG, "mode": t.get("mode") or "blocks",
                   "map": seg_map(t.get("exceptions"))}
            poems.setdefault(oe, []).append(dict(rec, **{"with": t["id"]}))
            poems.setdefault(t["id"], []).append(dict(rec, **{"with": oe}))
    for w in d.get("works", []):
        oe, tr = w["oe_work"], w["translation_work"]
        rec = {"orig": oe, "lang": LANG, "lfl": bool(w.get("line_for_line")),
               "sections": [section(s) for s in w.get("sections", [])]}
        if MERGED.get(oe):
            rec["merged"] = MERGED[oe]
        works.setdefault(oe, []).append(dict(rec, **{"with": tr}))
        works.setdefault(tr, []).append(dict(rec, **{"with": oe}))
    with io.open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump({"poems": poems, "works": works}, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"parallel: {len(poems)} poem entries, {len(works)} work entries")


if __name__ == "__main__":
    main()
