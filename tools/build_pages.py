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
    sitemap.xml

A reader who lands on one of these pages gets the poem in full, with a link
into the archive for the rest of the experience. Run after any content change:

    python tools/build_index.py && python tools/build_pages.py && python tools/verify_split.py
"""
import html
import io
import json
import os
import shutil
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://poetrycodex.com"
TODAY = date.today().isoformat()

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


def shell(title, description, canonical, body, og_type="article"):
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{esc(title)} · Poetry Codex</title>
  <meta name="description" content="{esc(description)}" />
  <link rel="canonical" href="{esc(canonical)}" />
  <meta property="og:type" content="{og_type}" />
  <meta property="og:site_name" content="Poetry Codex" />
  <meta property="og:title" content="{esc(title)}" />
  <meta property="og:description" content="{esc(description)}" />
  <meta property="og:url" content="{esc(canonical)}" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
  {FONTS}
  <link rel="stylesheet" href="/styles.css?v=29" />
</head>
<body>
  <header class="site-head">
    <div class="topbar">
      <div class="topbar-inner">
        <a class="tb-brand" href="/"><img src="/coin.png" alt="" width="34" height="34" /><span>Poetry&nbsp;Codex</span></a>
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


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def main():
    idx = json.load(io.open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))

    # Rebuild from scratch so a removed poem's page does not linger.
    for d in ("poem", "poet"):
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)

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
        write(os.path.join(ROOT, "poet", slug, "index.html"),
              poet_page(poet, len(poems), poems))
        urls.append(f"{SITE}/poet/{slug}/")
        poet_count += 1

        for n, p in enumerate(poems):
            write(os.path.join(ROOT, "poem", slug, str(n), "index.html"),
                  poem_page(poet, poems, n, p, poet["name"]))
            urls.append(f"{SITE}/poem/{slug}/{n}/")
            poem_count += 1

    sm = ['<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        sm.append(f"  <url><loc>{esc(u)}</loc><lastmod>{TODAY}</lastmod></url>")
    sm.append("</urlset>")
    write(os.path.join(ROOT, "sitemap.xml"), "\n".join(sm) + "\n")

    print(f"poet pages: {poet_count}")
    print(f"poem pages: {poem_count}")
    print(f"sitemap urls: {len(urls)}")


if __name__ == "__main__":
    main()
