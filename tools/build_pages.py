#!/usr/bin/env python3
"""
Build a real HTML page for every poem, poet and long work, plus sitemap.xml.

The archive itself is a single-page app whose addresses look like
/#/poem/blake/27. Search engines index addresses, not hash fragments, so the
app alone would only ever show Google the home page. These generated pages
give each poem, poet and work an address of its own, with the full text in the
HTML, and describe it to search engines with schema.org data (JSON-LD).

Output (all regenerated; do not edit by hand):
    poem/<poet-slug>/<n>/index.html   — /poem/blake/27/
    poet/<poet-slug>/index.html       — /poet/blake/ (also for poets with works only)
    work/<work-slug>/index.html       — /work/iliad-butler/   (contents)
    work/<work-slug>/<i>/index.html   — /work/iliad-butler/0/ (one book, canto, part)
    sitemap.xml + sitemap-<n>.xml
    404.html                          — shown for any address that does not exist

A reader who lands on one of these pages gets the poem in full, with a link
into the archive for the rest of the experience. Run after any content change:

    python tools/build_index.py && python tools/build_pages.py && python tools/verify_split.py
"""
import html
import io
import json
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://poetrycodex.com"
# Public Domain Mark: every text in the archive is out of copyright.
LICENSE = "https://creativecommons.org/publicdomain/mark/1.0/"
SHARE_IMAGE = SITE + "/icon-512.png"   # when a page has no portrait to show


def css_version():
    """The styles.css cache-buster index.html uses, so static pages never load a stale stylesheet."""
    shell_html = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    m = re.search(r"styles\.css\?v=(\d+)", shell_html)
    return m.group(1) if m else "1"


CSS_V = css_version()

FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com" />'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />'
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;'
    '0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=Cormorant+Garamond:'
    'ital,wght@0,400;0,500;1,400;1,500&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />'
)


def esc(s):
    return html.escape(s or "", quote=True)


def para_html(text):
    """Keep line and stanza breaks: stanzas become paragraphs, lines become <br>."""
    stanzas = [s for s in (text or "").split("\n\n") if s.strip()]
    return "\n".join(
        '<p class="stanza">' + "<br>\n".join(esc(line) for line in s.split("\n")) + "</p>"
        for s in stanzas
    )


def source_line(p):
    """'Translated by … · From <book>' under the author line, as the app shows it."""
    parts = []
    tr = (p.get("translator") or "").strip()
    co = (p.get("collection") or "").strip()
    if tr:
        parts.append(re.sub(r"^trans\.\s*", "Translated by ", tr, flags=re.I))
    if co:
        parts.append("From " + co)
    return f'<p class="detail-source">{esc(" · ".join(parts))}</p>' if parts else ""


def bio_html(para):
    """Bios carry <em> for titles (the app renders them as HTML); keep only that tag."""
    return esc(para).replace("&lt;em&gt;", "<em>").replace("&lt;/em&gt;", "</em>")


def plain(s):
    return re.sub(r"<[^>]+>", "", s or "")


def translated_by(tr):
    """'trans. Samuel Butler (1898)' -> 'translated by Samuel Butler (1898)'."""
    return re.sub(r"^trans\.\s*", "translated by ", (tr or "").strip(), flags=re.I)


def translator_names(tr):
    """'trans. Cosette Faust Newton & Stith Thompson (1918)' -> the two names.
    Anything after the name (a date, a book title, 'in Cook & Tinker…') is dropped."""
    name = re.sub(r"^trans\.\s*", "", (tr or "").strip(), flags=re.I)
    name = name.split("(")[0].split(",")[0].strip()
    return [n.strip() for n in re.split(r"\s+(?:&|and)\s+", name) if n.strip()]


def text_lang(category, translator):
    """Turkish and Ottoman poems in the original are Turkish; everything else is English."""
    return "tr" if category == "Turkish & Ottoman" and not (translator or "").strip() else "en"


def share_image(poet):
    return f"{SITE}/{poet['portrait']}" if poet.get("portrait") else SHARE_IMAGE


def person(name, slug):
    return {"@type": "Person", "name": name, "url": f"{SITE}/poet/{slug}/"}


def creative_work(name, url, author, translator, lang, **extra):
    """schema.org description of one text: what it is, who wrote it, that it is free and public domain."""
    d = {"@type": "CreativeWork", "genre": "Poetry", "name": name, "author": author,
         "inLanguage": lang, "isAccessibleForFree": True, "license": LICENSE, "url": url}
    names = translator_names(translator)
    if names:
        d["translator"] = [{"@type": "Person", "name": n} for n in names]
    d.update(extra)
    return d


def breadcrumbs(*trail):
    """Home › … › this page. Each step is (name, url); the last step has no url."""
    items = [("Poetry Codex", SITE + "/")] + list(trail)
    return {"@type": "BreadcrumbList", "itemListElement": [
        dict({"@type": "ListItem", "position": i, "name": name}, **({"item": url} if url else {}))
        for i, (name, url) in enumerate(items, 1)]}


def ld_json(*nodes):
    data = json.dumps({"@context": "https://schema.org", "@graph": list(nodes)},
                      ensure_ascii=False, separators=(",", ":"))
    return '<script type="application/ld+json">' + data.replace("</", "<\\/") + "</script>"


def shell(title, description, canonical, body, og_type="article", image=SHARE_IMAGE, ld=""):
    if canonical:
        meta = f"""<link rel="canonical" href="{esc(canonical)}" />
  <meta property="og:type" content="{og_type}" />
  <meta property="og:site_name" content="Poetry Codex" />
  <meta property="og:title" content="{esc(title)}" />
  <meta property="og:description" content="{esc(description)}" />
  <meta property="og:url" content="{esc(canonical)}" />
  <meta property="og:image" content="{esc(image)}" />
  <meta name="twitter:card" content="summary" />
  {ld}"""
    else:  # the 404 page: nothing there for a search engine to keep
        meta = '<meta name="robots" content="noindex" />'
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{esc(title)} · Poetry Codex</title>
  <meta name="description" content="{esc(description)}" />
  {meta}
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
  {FONTS}
  <link rel="stylesheet" href="/styles.css?v={CSS_V}" />
</head>
<body>
  <header class="site-head">
    <div class="topbar">
      <div class="topbar-inner">
        <a class="tb-brand" href="/"><img src="/coin-68.webp" alt="" width="34" height="34" /><span>Poetry&nbsp;Codex</span></a>
        <nav class="tb-nav">
          <a href="/#/poems">Poems</a>
          <a href="/#/poets">Poets</a>
          <a href="/#/eras">Eras</a>
          <a class="tb-oracle" href="/#/oracle">The Oracle</a>
          <a href="/#/about">About</a>
        </nav>
      </div>
    </div>
  </header>
  <main class="static-page">
{body}
  </main>
  <footer class="site-foot">
    <div class="foot-bar">
      <span>© 2026 Poetry Codex. All texts are in the public domain.</span>
      <span class="foot-privacy"><a href="/">Open the full archive</a> · <a href="mailto:admin@poetrycodex.com">admin@poetrycodex.com</a></span>
    </div>
  </footer>
</body>
</html>
"""


def poem_page(poet, poems, n, p):
    title = p["title"]
    author = p["author"]
    slug = poet["slug"]
    subj = p.get("primarySubject") or ""
    lang = text_lang(poet.get("category"), p.get("translator"))
    lang_attr = f' lang="{lang}"' if lang != "en" else ""
    themes = "".join(
        f'<span class="theme-tag">{esc(s)}</span>' for s in (p.get("subjects") or [])
    )
    note = (p.get("note") or "").strip()
    desc_src = note or (p["text"] or "").replace("\n", " ")
    description = (f"{title} by {author}. " + desc_src)[:300]

    prev_link = (f'<a class="pn prev" href="/poem/{slug}/{n-1}/">← {esc(poems[n-1]["title"])}</a>'
                 if n > 0 else '<span></span>')
    next_link = (f'<a class="pn next" href="/poem/{slug}/{n+1}/">{esc(poems[n+1]["title"])} →</a>'
                 if n < len(poems) - 1 else '<span></span>')

    body = f"""    <article class="detail">
      <p class="detail-subject">{esc(subj)}</p>
      <h1 class="detail-title"{lang_attr}>{esc(title)}</h1>
      <p class="detail-author">by <a href="/poet/{slug}/">{esc(author)}</a></p>
      {source_line(p)}
      {('<div class="themes">' + themes + '</div>') if themes else ''}
      <hr class="rule">
      <div class="poem-text"{lang_attr}>
{para_html(p["text"])}
      </div>
      {('<div class="rule-ornament">✦ ✦ ✦</div><p class="section-label">Codex Note</p><p class="note-block">' + esc(note) + '</p>') if note else ''}
      <p class="read-in-archive"><a href="/#/poem/{slug}/{n}">Read this poem with the Codex →</a></p>
      <nav class="pn-row">{prev_link}{next_link}</nav>
    </article>"""
    canonical = f"{SITE}/poem/{slug}/{n}/"
    extra = {"about": p["subjects"]} if p.get("subjects") else {}
    if (p.get("collection") or "").strip():
        extra["isPartOf"] = {"@type": "CreativeWork", "name": p["collection"].strip()}
    ld = ld_json(
        creative_work(title, canonical, person(author, slug), p.get("translator"), lang, **extra),
        breadcrumbs((poet["name"], f"{SITE}/poet/{slug}/"), (title, None)))
    return shell(f"{title} — {author}", description, canonical, body,
                 image=share_image(poet), ld=ld)


def work_meta(w):
    """The short line a poet page shows after a work's title: who translated it, or what it is."""
    if (w.get("translator") or "").strip():
        return translated_by(w["translator"])
    return ", ".join(x for x in (w.get("type"), w.get("year")) if x)


def poet_page(poet, poem_list, works):
    name = poet["name"]
    slug = poet["slug"]
    bio = [b for b in (poet.get("bio") or []) if b and b.strip()]
    bio_block = "\n".join(f"<p>{bio_html(b)}</p>" for b in bio)
    works_block = ""
    if works:
        rows = "\n".join(
            f'<li><a href="/work/{w["slug"]}/">{esc(w["title"])}</a> — {esc(work_meta(w))}</li>'
            for w in works)
        works_block = f"""
      <p class="section-label">Major Works ({len(works)})</p>
      <ol class="poet-poems">
{rows}
      </ol>"""
    poems_block = ""
    if poem_list:
        rows = "\n".join(
            f'<li><a href="/poem/{slug}/{i}/">{esc(p["title"])}</a></li>'
            for i, p in enumerate(poem_list))
        poems_block = f"""
      <p class="section-label">Poems ({len(poem_list)})</p>
      <ol class="poet-poems">
{rows}
      </ol>"""
    body = f"""    <article class="detail">
      <p class="detail-subject">{esc(poet.get("category") or "")}</p>
      <h1 class="detail-title">{esc(name)}</h1>
      <p class="detail-author">{esc(poet.get("dates") or "")}</p>
      <hr class="rule">
      <div class="bio">
{bio_block}
      </div>{works_block}{poems_block}
      <p class="read-in-archive"><a href="/#/poet/{slug}">See {esc(name)} in the full archive →</a></p>
    </article>"""
    if bio:
        desc = plain(bio[0])
    else:
        what = ", ".join(w["title"] for w in works) if works else "poems"
        desc = f"{name}: {what} in the Poetry Codex archive."
    canonical = f"{SITE}/poet/{slug}/"
    who = dict(person(name, slug))
    if poet.get("portrait"):
        who["image"] = share_image(poet)
    ld = ld_json({"@type": "ProfilePage", "url": canonical, "mainEntity": who},
                 breadcrumbs((name, None)))
    return shell(name, desc[:300], canonical, body, og_type="profile",
                 image=share_image(poet), ld=ld)


def work_title(w, grouped):
    """Page-title form of a work; translations of the same original say whose they are."""
    names = translator_names(w.get("translator"))
    return f"{w['title']} — {w['author']}" + (", trans. " + " & ".join(names) if grouped and names else "")


def work_page(w, poet, grouped):
    """A long work's contents: what it is, who wrote and translated it, and every part."""
    slug = w["slug"]
    sections = w.get("sections") or []
    rows = "\n".join(
        f'<li><a href="/work/{slug}/{i}/"><span class="pl-title">{esc(s["title"])}</span></a></li>'
        for i, s in enumerate(sections))
    kind = " · ".join(esc(x) for x in (w.get("type"), w.get("year")) if x)
    parts = f"{len(sections)} part" + ("" if len(sections) == 1 else "s")
    subtitle = f'<p class="work-subtitle">{esc(w["subtitle"])}</p>' if w.get("subtitle") else ""
    blurb = f'<p class="note-block">{esc(w["blurb"])}</p>' if w.get("blurb") else ""
    body = f"""    <article class="detail work-toc">
      <p class="detail-subject">{kind}</p>
      <h1 class="detail-title">{esc(w["title"])}</h1>
      {subtitle}
      <p class="detail-author">by <a href="/poet/{w["authorSlug"]}/">{esc(w["author"])}</a></p>
      {source_line(w)}
      {blurb}
      <hr class="rule">
      <p class="section-label">Contents · {parts}</p>
      <ul class="poem-links">
{rows}
      </ul>
      <p class="read-in-archive"><a href="/#/work/{slug}">Read this work with the Codex →</a></p>
    </article>"""
    tr = translated_by(w.get("translator"))
    description = (f"Full text of {w['title']} by {w['author']}" + (f", {tr}" if tr else "")
                   + f", in {parts}. " + (w.get("blurb") or ""))[:300]
    canonical = f"{SITE}/work/{slug}/"
    ld = ld_json(
        creative_work(w["title"], canonical, person(w["author"], w["authorSlug"]),
                      w.get("translator"), "en"),
        breadcrumbs((w["author"], f"{SITE}/poet/{w['authorSlug']}/"), (w["title"], None)))
    return shell(work_title(w, grouped), description, canonical, body,
                 image=share_image(poet), ld=ld)


def section_page(w, poet, grouped, i):
    """One book, canto or part of a long work, in full."""
    slug = w["slug"]
    sections = w["sections"]
    s = sections[i]
    whole = len(sections) == 1
    prev_link = (f'<a class="pn prev" href="/work/{slug}/{i-1}/">← {esc(sections[i-1]["title"])}</a>'
                 if i > 0 else '<span></span>')
    next_link = (f'<a class="pn next" href="/work/{slug}/{i+1}/">{esc(sections[i+1]["title"])} →</a>'
                 if i < len(sections) - 1 else '<span></span>')
    kind = " · ".join(esc(x) for x in (w["title"], w.get("year")) if x)
    body = f"""    <article class="detail">
      <a class="back" href="/work/{slug}/">← {esc(w["title"])} · Contents</a>
      <p class="detail-subject">{kind}</p>
      <h1 class="detail-title">{esc(s["title"])}</h1>
      <p class="detail-author">by <a href="/poet/{w["authorSlug"]}/">{esc(w["author"])}</a></p>
      {source_line(w)}
      <hr class="rule">
      <div class="poem-text">
{para_html(s.get("text"))}
      </div>
      <p class="read-in-archive"><a href="/#/work/{slug}/{i}">Read this with the Codex →</a></p>
      <nav class="pn-row">{prev_link}{next_link}</nav>
    </article>"""
    tr = translated_by(w.get("translator"))
    lead = w["title"] if whole else f"{w['title']}, {s['title']}"
    description = (f"{lead}, by {w['author']}" + (f", {tr}" if tr else "") + ". "
                   + (s.get("text") or "").replace("\n", " "))[:300]
    # "Paradise Lost, Book I — John Milton"; a one-part work is "Andreas: full text — …"
    page_title = (f"{w['title']}: full text" if whole else lead) + work_title(w, grouped)[len(w["title"]):]
    canonical = f"{SITE}/work/{slug}/{i}/"
    work_url = f"{SITE}/work/{slug}/"
    ld = ld_json(
        creative_work(s["title"], canonical, person(w["author"], w["authorSlug"]),
                      w.get("translator"), "en", position=i + 1,
                      isPartOf={"@type": "CreativeWork", "name": w["title"], "url": work_url}),
        breadcrumbs((w["author"], f"{SITE}/poet/{w['authorSlug']}/"), (w["title"], work_url),
                    (s["title"], None)))
    return shell(page_title, description, canonical, body, image=share_image(poet), ld=ld)


def not_found_page():
    """404.html: GitHub Pages serves it for any address that does not exist."""
    body = r"""    <article class="detail not-found">
      <p class="detail-subject">Page not found</p>
      <h1 class="detail-title">This page is not in the Codex</h1>
      <p class="page-sub">The address may be mistyped, or the page may have moved. Search the archive, or start from one of these.</p>
      <form class="archive-search" id="nf-search" action="/" method="get" autocomplete="off">
        <input type="search" name="q" placeholder="Search by poem or poet…" aria-label="Search the archive" />
        <button type="submit" aria-label="Search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
      </form>
      <nav class="hero-nav" aria-label="Archive">
        <a href="/#/poems">Poems</a>
        <a href="/#/poets">Poets</a>
        <a href="/#/eras">Eras</a>
        <a href="/#/oracle">The Oracle</a>
        <a href="/#/about">About</a>
      </nav>
    </article>
    <script>
      (function () {
        // /poets, /about … typed as paths are meant as the archive's pages of that name.
        var path = location.pathname.replace(/\/+$/, "").toLowerCase();
        if (/^\/(poems|poets|eras|oracle|about)$/.test(path)) { location.replace("/#" + path); return; }
        document.getElementById("nf-search").addEventListener("submit", function (e) {
          e.preventDefault();
          var q = this.q.value.trim();
          location.href = "/#/poems" + (q ? "?q=" + encodeURIComponent(q) : "");
        });
      })();
    </script>"""
    return shell("Page not found", "This page is not in the Poetry Codex archive.", None, body)


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def main():
    idx = json.load(io.open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))

    # Rebuild from scratch so a removed poem's page does not linger.
    for d in ("poem", "poet", "work"):
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)

    works_by_poet = {}
    for w in idx.get("works") or []:
        works_by_poet.setdefault(w["authorSlug"], []).append(w)
    group_size = {}
    for w in idx.get("works") or []:
        if w.get("workGroup"):
            group_size[w["workGroup"]] = group_size.get(w["workGroup"], 0) + 1

    POET_ROWS = []
    # Only the home page and the generated pages are listed: hash routes are not crawlable.
    # No <lastmod>: every build would stamp all of them "today", and a date that always
    # changes is one search engines learn to ignore.
    urls = [f"{SITE}/"]
    poem_count = poet_count = work_count = section_count = 0

    for poet_stub in idx["poets"]:
        slug = poet_stub["slug"]
        pf = os.path.join(ROOT, "data", "poets", slug + ".json")
        poems = []
        if os.path.exists(pf):
            poems = json.load(io.open(pf, encoding="utf-8")).get("poems") or []
        works = works_by_poet.get(slug, [])
        if not poems and not works:
            continue

        poet = {
            "slug": slug, "name": poet_stub["name"], "dates": poet_stub.get("dates"),
            "category": poet_stub.get("category"), "bio": poet_stub.get("bio") or [],
            "portrait": poet_stub.get("portrait"),
        }
        POET_ROWS.append({"slug": slug, "name": poet["name"]})
        write(os.path.join(ROOT, "poet", slug, "index.html"), poet_page(poet, poems, works))
        urls.append(f"{SITE}/poet/{slug}/")
        poet_count += 1

        for n, p in enumerate(poems):
            write(os.path.join(ROOT, "poem", slug, str(n), "index.html"),
                  poem_page(poet, poems, n, p))
            urls.append(f"{SITE}/poem/{slug}/{n}/")
            poem_count += 1

        for stub in works:
            wf = os.path.join(ROOT, "data", "works", stub["slug"] + ".json")
            if not os.path.exists(wf):
                continue
            w = json.load(io.open(wf, encoding="utf-8"))
            grouped = group_size.get(w.get("workGroup"), 0) > 1
            write(os.path.join(ROOT, "work", w["slug"], "index.html"), work_page(w, poet, grouped))
            urls.append(f"{SITE}/work/{w['slug']}/")
            work_count += 1
            for i in range(len(w.get("sections") or [])):
                write(os.path.join(ROOT, "work", w["slug"], str(i), "index.html"),
                      section_page(w, poet, grouped, i))
                urls.append(f"{SITE}/work/{w['slug']}/{i}/")
                section_count += 1

    # Split into small child sitemaps behind one index. Google fetches each child
    # separately, so no single file is large, and a failure in one does not hide the rest.
    CHUNK = 1000
    chunks = [urls[i:i + CHUNK] for i in range(0, len(urls), CHUNK)]
    for old in [f for f in os.listdir(ROOT) if f.startswith("sitemap-") and f.endswith(".xml")]:
        os.remove(os.path.join(ROOT, old))
    NL = chr(10)
    for n, chunk in enumerate(chunks, 1):
        body = ['<?xml version="1.0" encoding="UTF-8"?>',
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
        for u in chunk:
            body.append("  <url><loc>" + esc(u) + "</loc></url>")
        body.append("</urlset>")
        write(os.path.join(ROOT, "sitemap-" + str(n) + ".xml"), NL.join(body) + NL)
    index = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for n in range(1, len(chunks) + 1):
        index.append("  <sitemap><loc>" + SITE + "/sitemap-" + str(n) + ".xml</loc></sitemap>")
    index.append("</sitemapindex>")
    write(os.path.join(ROOT, "sitemap.xml"), NL.join(index) + NL)
    fill_home_poet_links(POET_ROWS)
    write(os.path.join(ROOT, "404.html"), not_found_page())
    print("sitemap index: " + str(len(chunks)) + " child sitemaps")

    print(f"poet pages: {poet_count}")
    print(f"poem pages: {poem_count}")
    print(f"work pages: {work_count} (+ {section_count} sections)")
    print(f"sitemap urls: {len(urls)}")


def fill_home_poet_links(poets):
    """Rewrite the poet-link block in index.html so crawlers can reach every poet."""
    path = os.path.join(ROOT, "index.html")
    text = io.open(path, encoding="utf-8").read()
    start_m = "<!-- POET-LINKS:START -->"
    end_m = "<!-- POET-LINKS:END -->"
    a = text.index(start_m) + len(start_m)
    b = text.index(end_m)
    links = " · ".join(
        '<a href="/poet/' + p["slug"] + '/">' + esc(p["name"]) + "</a>" for p in poets
    )
    text = text[:a] + links + text[b:]
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    print("home page: " + str(len(poets)) + " poet links")


if __name__ == "__main__":
    main()
