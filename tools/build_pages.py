#!/usr/bin/env python3
"""
Build a real HTML page for every poem and every poet, plus sitemap.xml.

The archive itself is a single-page app whose addresses look like
/#/poem/blake/27. Search engines index addresses, not hash fragments, so the
app alone would only ever show Google the home page. These generated pages
give each poem and poet an address of its own, with the full text in the HTML.

Output (all regenerated; do not edit by hand):
    poem/<poet-slug>/<n>/index.html   — /poem/blake/27/
    poet/<poet-slug>/index.html       — /poet/blake/
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
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://poetrycodex.com"
TODAY = date.today().isoformat()


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


def shell(title, description, canonical, body, og_type="article"):
    if canonical:
        meta = f"""<link rel="canonical" href="{esc(canonical)}" />
  <meta property="og:type" content="{og_type}" />
  <meta property="og:site_name" content="Poetry Codex" />
  <meta property="og:title" content="{esc(title)}" />
  <meta property="og:description" content="{esc(description)}" />
  <meta property="og:url" content="{esc(canonical)}" />"""
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


def poem_page(poet, poems, n, p, poet_name):
    title = p["title"]
    author = p["author"]
    subj = p.get("primarySubject") or ""
    themes = "".join(
        f'<span class="theme-tag">{esc(s)}</span>' for s in (p.get("subjects") or [])
    )
    note = (p.get("note") or "").strip()
    desc_src = note or (p["text"] or "").replace("\n", " ")
    description = (f"{title} by {author}. " + desc_src)[:300]

    prev_link = (f'<a class="pn prev" href="/poem/{poet["slug"]}/{n-1}/">← {esc(poems[n-1]["title"])}</a>'
                 if n > 0 else '<span></span>')
    next_link = (f'<a class="pn next" href="/poem/{poet["slug"]}/{n+1}/">{esc(poems[n+1]["title"])} →</a>'
                 if n < len(poems) - 1 else '<span></span>')

    body = f"""    <article class="detail">
      <p class="detail-subject">{esc(subj)}</p>
      <h1 class="detail-title">{esc(title)}</h1>
      <p class="detail-author">by <a href="/poet/{poet["slug"]}/">{esc(author)}</a></p>
      {source_line(p)}
      {('<div class="themes">' + themes + '</div>') if themes else ''}
      <hr class="rule">
      <div class="poem-text">
{para_html(p["text"])}
      </div>
      {('<div class="rule-ornament">✦ ✦ ✦</div><p class="section-label">Codex Note</p><p class="note-block">' + esc(note) + '</p>') if note else ''}
      <p class="read-in-archive"><a href="/#/poem/{poet["slug"]}/{n}">Read this poem with the Codex →</a></p>
      <nav class="pn-row">{prev_link}{next_link}</nav>
    </article>"""
    canonical = f"{SITE}/poem/{poet['slug']}/{n}/"
    return shell(f"{title} — {author}", description, canonical, body)


def poet_page(poet, poems_count, poem_list):
    name = poet["name"]
    bio = poet.get("bio") or []
    bio_html = "\n".join(f"<p>{esc(b)}</p>" for b in bio if b and b.strip())
    rows = "\n".join(
        f'<li><a href="/poem/{poet["slug"]}/{i}/">{esc(p["title"])}</a></li>'
        for i, p in enumerate(poem_list)
    )
    body = f"""    <article class="detail">
      <p class="detail-subject">{esc(poet.get("category") or "")}</p>
      <h1 class="detail-title">{esc(name)}</h1>
      <p class="detail-author">{esc(poet.get("dates") or "")}</p>
      <hr class="rule">
      <div class="bio">
{bio_html}
      </div>
      <p class="section-label">Poems ({poems_count})</p>
      <ol class="poet-poems">
{rows}
      </ol>
      <p class="read-in-archive"><a href="/#/poet/{poet["slug"]}">See {esc(name)} in the full archive →</a></p>
    </article>"""
    desc = (bio[0] if bio else f"{name}: poems in the Poetry Codex archive.")[:300]
    canonical = f"{SITE}/poet/{poet['slug']}/"
    return shell(name, desc, canonical, body, og_type="profile")


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
    for d in ("poem", "poet"):
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)

    POET_ROWS = []
    # Only the home page and the generated pages are listed: hash routes are not crawlable.
    urls = [f"{SITE}/"]
    poem_count = poet_count = 0

    for poet_stub in idx["poets"]:
        slug = poet_stub["slug"]
        pf = os.path.join(ROOT, "data", "poets", slug + ".json")
        if not os.path.exists(pf):
            continue
        full = json.load(io.open(pf, encoding="utf-8"))
        poems = full.get("poems") or []
        if not poems:
            continue  # works-only poets get no poem pages of their own

        poet = {
            "slug": slug, "name": poet_stub["name"], "dates": poet_stub.get("dates"),
            "category": poet_stub.get("category"), "bio": poet_stub.get("bio") or [],
        }
        POET_ROWS.append({"slug": slug, "name": poet["name"]})
        write(os.path.join(ROOT, "poet", slug, "index.html"),
              poet_page(poet, len(poems), poems))
        urls.append(f"{SITE}/poet/{slug}/")
        poet_count += 1

        for n, p in enumerate(poems):
            write(os.path.join(ROOT, "poem", slug, str(n), "index.html"),
                  poem_page(poet, poems, n, p, poet["name"]))
            urls.append(f"{SITE}/poem/{slug}/{n}/")
            poem_count += 1

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
            body.append("  <url><loc>" + esc(u) + "</loc><lastmod>" + TODAY + "</lastmod></url>")
        body.append("</urlset>")
        write(os.path.join(ROOT, "sitemap-" + str(n) + ".xml"), NL.join(body) + NL)
    index = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for n in range(1, len(chunks) + 1):
        index.append("  <sitemap><loc>" + SITE + "/sitemap-" + str(n) + ".xml</loc><lastmod>" + TODAY + "</lastmod></sitemap>")
    index.append("</sitemapindex>")
    write(os.path.join(ROOT, "sitemap.xml"), NL.join(index) + NL)
    fill_home_poet_links(POET_ROWS)
    write(os.path.join(ROOT, "404.html"), not_found_page())
    print("sitemap index: " + str(len(chunks)) + " child sitemaps")

    print(f"poet pages: {poet_count}")
    print(f"poem pages: {poem_count}")
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
