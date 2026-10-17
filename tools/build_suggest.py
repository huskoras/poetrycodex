"""Build the search box's small indexes (the type-ahead and the results page), so a search
never has to load the 35 MB archive index.

data/suggest/core.json   every work (translations of one original grouped, as on the Epics
                         page) and every poet: [kind, label, sub, href, weight, extra]
data/suggest/p/<k>.json  poem titles, filed under the first three letters of each word of three
                         letters or more in the title (common words left out), so a search
                         reads one small file: [[title, author, id], ...]

Run after build_index.py (it reads data/index.json). Usage: python -I tools/build_suggest.py
"""
import io, json, os, re, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "suggest")


def fold(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


STOP = set("the and for from with that this into upon unto your thou thee thy his her our their its was are not but all who what when where which".split())


def keys_of(title):
    ws = [w for w in fold(title).split() if len(w) >= 3 and w not in STOP] or [w for w in fold(title).split()][:1]
    return {w[:3] for w in ws if len(w) >= 3} or {"___"}


def main():
    idx = json.load(io.open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    poets = {p["slug"]: p for p in idx["poets"]}
    works = idx.get("works") or []
    core = []
    # Works: one entry per group of translations (workGroup), else per work.
    groups = {}
    for w in works:
        groups.setdefault(w.get("workGroup") or w["slug"], []).append(w)
    for g, ws in groups.items():
        title = min((re.sub(r"\s*\([^)]*\)\s*$", "", w["title"]) for w in ws), key=len)
        lead = ws[0]
        n = len(ws)
        href = f"#/versions/{g}" if n > 1 else f"#/work/{lead['slug']}"
        sub = lead.get("author", "")
        tr = sum(1 for w in ws if w.get("translator"))
        extra = f"{tr} translations" if tr > 1 else (f"{n} versions" if n > 1 else lead.get("type", ""))
        core.append(["w", title, sub, href, 3 + min(n, 20) / 4, extra])
    for slug, p in poets.items():
        size = (p.get("poemCount") or 0) + (p.get("workCount") or 0)
        if not size:
            continue
        core.append(["p", p["name"], p.get("dates", ""), f"#/poet/{slug}", min(size, 2000) ** 0.5 / 10, p.get("category", "")])
    os.makedirs(os.path.join(OUT, "p"), exist_ok=True)
    io.open(os.path.join(OUT, "core.json"), "w", encoding="utf-8").write(json.dumps(core, ensure_ascii=False, separators=(",", ":")))
    shards = {}
    for p in idx["poems"]:
        for k in keys_of(p["title"]):
            shards.setdefault(k, []).append([p["title"], poets.get(p["id"].rsplit("/", 1)[0], {}).get("name", ""), p["id"]])
    old = set(os.listdir(os.path.join(OUT, "p")))
    for k, rows in shards.items():
        io.open(os.path.join(OUT, "p", k + ".json"), "w", encoding="utf-8").write(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
        old.discard(k + ".json")
    for f in old:
        os.remove(os.path.join(OUT, "p", f))
    size = os.path.getsize(os.path.join(OUT, "core.json"))
    print(f"suggest: {len(core)} works and poets ({size // 1024} KB), {len(idx['poems'])} poem titles in {len(shards)} files")


if __name__ == "__main__":
    main()
