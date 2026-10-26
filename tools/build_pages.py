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
    poet/index.html                   — /poet/: every poet, earliest first (the home footer links here)
    work/<work-slug>/index.html       — /work/iliad-butler/   (contents)
    work/<work-slug>/<i>/index.html   — /work/iliad-butler/0/ (one book, canto, part)
    guide/<group>/index.html          — /guide/iliad/: one study guide in full (data/guides/<group>.json)
    guide/index.html                  — /guide/: every study guide, by tradition (the footer links here)
    blog/index.html, blog/<slug>/     — the editors' articles (data/blog/<slug>.md)
    sitemap.xml + sitemap-<n>.xml
    llms.txt                          — the site described for AI assistants, from the guides, blog and works
    404.html                          — shown for any address that does not exist

A retired poem (one with "dupOf", see build_index.py) gets no page of its own: its address
gets a small redirect page (meta refresh + canonical + a plain link) to the text it is a copy
of, and it is left out of the sitemap, the poet's list, Previous / Next and "More by". A merged
poet ("mergedInto") gets the same at /poet/<slug>/, pointing at the poet it was merged into.

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
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from textlang import lang_code, needs_dir_auto  # noqa: E402  (a poem's language and writing direction)

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

# The web fonts are served from this site (/fonts/, @font-face at the top of styles.css, with
# font-display: swap, so the text shows at once and takes the web font when it arrives). As in
# index.html, only the reading text's face (Fraunces, latin) is asked for at once.
FONTS = '<link rel="preload" as="font" type="font/woff2" href="/fonts/fraunces-normal-latin.woff2" crossorigin />'


# The reader's "Aa" choices in the app (text size, light/dark: localStorage pc-text /
# pc-theme), applied before the page draws, exactly as the script in index.html does.
VIEW_PREFS = ('<script>'+'window.pcSetTheme=function(n){var d=document.documentElement;d.dataset.theme=n;try{localStorage.setItem("pc-theme",n)}catch(e){}document.querySelectorAll(".rt-panel [data-theme]").forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.theme===n))})};window.pcToggleTheme=function(){var d=document.documentElement,c=d.dataset.theme||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"),n=c==="dark"?"light":"dark";d.dataset.theme=n;try{localStorage.setItem("pc-theme",n)}catch(e){}document.querySelectorAll(".rt-panel [data-theme]").forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.theme===n))})};'+'try{var d=document.documentElement,t=localStorage.getItem("pc-theme"),'
              's=localStorage.getItem("pc-text");if(t==="light"||t==="dark")d.dataset.theme=t;'
              'if(s==="l"||s==="xl")d.dataset.text=s}catch(e){}</script>')


def esc(s):
    return html.escape("" if s is None else str(s), quote=True)  # a year stored as a number must not stop the build


def trimmed_lines(text):
    return [line.strip() for line in (text or "").split("\n") if line.strip()]


def is_prose(text, translator):
    """Prose translations, printed as prose in their source editions. Either one paragraph
    per line (Gordon's riddles, Kennedy's Cynewulf, Chodzko, Wharton's Sappho: most of the
    text in lines over 200 characters) or hard-wrapped at about 70 characters (Butler's
    Homer, Riley's Ovid, Southey's Cid, Evelyn-White's Hymns, Weston's Gawain: most lines
    start in lower case, which verse of this period almost never does; Gummere's Beowulf
    does too, but its lines are short). Same rule as isProse in app.js."""
    if not (translator or "").strip():
        return False
    lines = trimmed_lines(text)
    total = sum(len(line) for line in lines)
    if not total:
        return False
    if sum(len(line) for line in lines if len(line) > 200) / total >= 0.5:
        return True
    if len(lines) < 2:
        return False
    lengths = sorted(len(line) for line in lines)
    lower = sum(1 for line in lines if re.match(r"[a-z]", line)) / len(lines)
    return lower >= 0.5 and lengths[len(lines) // 2] >= 55


def prose_paras(text):
    """Hard-wrapped lines joined back into paragraphs, as proseHTML in app.js does: a line
    well short of the text's usual width (or a one-line paragraph over 200 characters)
    ends a paragraph."""
    lengths = sorted(len(line) for line in trimmed_lines(text))
    width = lengths[int(len(lengths) * 0.9)] if lengths else 0
    paras = []
    for stanza in re.split(r"\n\s*\n", text or ""):
        cur = []
        for line in trimmed_lines(stanza):
            cur.append(line)
            if len(line) > 200 or len(line) < width - 15:
                paras.append(" ".join(cur))
                cur = []
        if cur:
            paras.append(" ".join(cur))
    return paras


def para_html(text, prose=False):
    """Stanzas become paragraphs and each line its own block, as poemHTML in app.js does:
    styles.css gives a wrapped line a hanging indent, and leading spaces keep the poem's
    indentation. The <br> after each line is hidden by the stylesheet but keeps lines apart
    in reader modes and plain-text copies. Prose translations are plain paragraphs."""
    if prose:
        return "\n".join("<p>" + esc(p) + "</p>" for p in prose_paras(text))
    stanzas = [s for s in re.split(r"\n\s*\n", text or "") if s.strip()]
    return "\n".join(
        '<p class="stanza">' + "".join(
            '<span class="ln">' + esc(line.rstrip()) + "</span><br>"
            for line in s.split("\n") if line.strip()) + "</p>"
        for s in stanzas
    )


ARGUMENT = re.compile(r"(the\s+)?argument\b", re.I)


def verse_lines(text):
    """The lines of verse, counted as the app's "Line numbers" switch numbers them (poemHTML
    in app.js): headings with no lower-case letter ("BOOK I.", "12") and Arguments (a stanza
    opening "Argument", or the stanza after a heading that is only "THE ARGUMENT.") are left out."""
    n, skip_next = 0, False
    for st in re.split(r"\n\s*\n", text or ""):
        ls = [line for line in st.split("\n") if line.strip()]
        if not ls:
            continue
        first = ls[0].strip()
        argument = skip_next or bool(ARGUMENT.match(first))
        skip_next = bool(ARGUMENT.match(first)) and len(ls) == 1
        if not argument:
            n += sum(1 for line in ls if any(unicodedata.category(ch) == "Ll" for ch in line))
    return n


def part_size(text, translator):
    """How long a book or canto is, for a contents list: "about 540 lines" for verse (exact
    under 100), "38 paragraphs" for a prose translation, as partSize in app.js says it from
    the counts build_index.py stores (`lines`, `prose`, `paras`)."""
    if is_prose(text, translator):
        n = len(prose_paras(text))
        return f"{n} paragraph" + ("" if n == 1 else "s")
    n = verse_lines(text)
    if n < 100:
        return f"{n} line" + ("" if n == 1 else "s")
    return f"about {int(n / 10 + 0.5) * 10} lines"   # rounds .5 up, as Math.round does


def text_block(text, translator, lang_attr=""):
    """The poem's text, plus a short note under a prose translation."""
    prose = is_prose(text, translator)
    note = ('\n      <p class="prose-note">This translation is printed as prose in its source edition.</p>'
            if prose else "")
    return (f'<div class="poem-text{" is-prose" if prose else ""}"{lang_attr}>\n'
            f'{para_html(text, prose)}\n      </div>{note}')


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


_SOURCES = {}


def sources_of(slug):
    """data/sources/<slug>.json from tools/build_sources.py ({} when the poet has none)."""
    if slug not in _SOURCES:
        path = os.path.join(ROOT, "data", "sources", f"{slug}.json")
        try:
            _SOURCES[slug] = json.load(io.open(path, encoding="utf-8"))
        except (OSError, ValueError):
            _SOURCES[slug] = {}
    return _SOURCES[slug]


def book_source(src):
    """'Source: <the printed book>. Digital text: <where>.' as the app shows it.
    src['line'] is HTML made by build_sources.py (titles in <i>, the rest escaped)."""
    return ""   # the owner asked (17 Oct 2026) that the source books not be shown on the pages
    if not src:
        return ""
    txt = ""
    if src.get("text"):
        t = esc(src["text"])
        txt = f' Digital text: <a href="{esc(src["url"])}" rel="noopener">{t}</a>.' if src.get("url") else f" Digital text: {t}."
    unsure = "" if src.get("sure") else ' <span class="bs-note">(details from catalogue records, not yet checked against the title page)</span>'
    return f'<p class="book-source"><span class="bs-label">Source</span> {src["line"]}.{txt}{unsure}</p>'


def poem_source(slug, p):
    for x in sources_of(slug).get("poems") or []:
        if x.get("c") == (p.get("collection") or "") and x.get("t") == (p.get("translator") or ""):
            return x
    return None


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


# ---------- citation (plain text, as "Cite this poem" in app.js words it) ----------
# Surname first, as both styles want. Titles (Sir) are dropped; names with no surname to
# invert (Homer, Yunus Emre, "Anonymous (Old English)") stay as written. Keep in step with
# CITE_NAMES / citeName / citations in app.js.
CITE_NAMES = {
    "Alfred, Lord Tennyson": "Tennyson, Alfred, Lord",
    "Lord Byron": "Byron, George Gordon, Lord",
    "Dante Alighieri": "Dante Alighieri",
    "Jean de La Fontaine": "La Fontaine, Jean de",
    "William Drummond of Hawthornden": "Drummond, William, of Hawthornden",
    "Abu al-Ala al-Ma'arri": "al-Ma'arri, Abu al-Ala",
    "Yunus Emre": "Yunus Emre", "Namık Kemal": "Namık Kemal", "Şeyh Galip": "Şeyh Galip",
}


def cite_name(name):
    name = (name or "").strip()
    if name in CITE_NAMES:
        return CITE_NAMES[name]
    if re.search(r"[()]|^anonymous|\bpoets?$", name, re.I):
        return name
    person_part, _, rest = name.partition(",")          # "Henry Howard, Earl of Surrey"
    rest = rest.lstrip()
    parts = re.sub(r"^Sir\s+", "", person_part).split()
    if len(parts) < 2:
        return name
    return parts[-1] + ", " + " ".join(parts[:-1]) + (", " + rest if rest else "")


def cite_end(s):
    """One closing full stop: none after ? or !, and a stray trailing comma or colon in the
    data ("Ad Amicum Litigantem,") gives way to it."""
    s = re.sub(r"[\s,;:]+$", "", s or "")
    return s if re.search(r"[.?!]$", s) else s + "."


# The access date is the reader's, not the build's: a tiny script writes today's date into
# each entry. Without JavaScript the entries simply have none (both styles allow that).
CITE_DATE_JS = (
    '<script>(function(){var d=new Date(),M=["Jan.","Feb.","Mar.","Apr.","May","June","July",'
    '"Aug.","Sept.","Oct.","Nov.","Dec."],L=["January","February","March","April","May","June",'
    '"July","August","September","October","November","December"];'
    'document.querySelectorAll(".cite-acc").forEach(function(s){s.textContent=s.getAttribute("data-style")==="mla"'
    '?" Accessed "+d.getDate()+" "+M[d.getMonth()]+" "+d.getFullYear()+"."'
    ':" Accessed "+L[d.getMonth()]+" "+d.getDate()+", "+d.getFullYear()+".";});})();</script>'
)


def cite_block(author, path, title="", work="", translator=""):
    """MLA (9th ed.) and Chicago entries for a poem (`title`) or a part of a long work
    (`work`, plus the part's `title` when the work has several), on the permanent address."""
    url = SITE + path
    tr = re.sub(r"\s*\([^)]*\)\s*$", "", (translator or "").strip())
    tr = re.sub(r"\s*&\s*", " and ", re.sub(r"^trans\.\s*", "", tr, flags=re.I))
    by = f" Translated by {esc(tr)}." if tr else ""
    if not work:
        what = f"“{esc(cite_end(title))}”"
    elif title and title != work:
        what = f"<i>{esc(work)}</i>, {esc(cite_end(title))}"
    else:
        what = f"<i>{esc(cite_end(work))}</i>"
    lead = f"{esc(cite_end(cite_name(author)))} {what}{by}"
    mla = (f'{lead} <i>Poetry Codex</i>, {esc(url.replace("https://", ""))}.'
           '<span class="cite-acc" data-style="mla"></span>')
    chicago = f'{lead} Poetry Codex.<span class="cite-acc" data-style="chicago"></span> {esc(url)}.'
    label = "Cite this text" if work else "Cite this poem"
    entries = "".join(
        f'\n        <div class="cite-entry"><p class="cite-style">{style}</p><p class="cite-text">{text}</p></div>'
        for style, text in (("MLA", mla), ("Chicago", chicago)))
    return (f'<section class="cite-static" aria-label="{label}">\n'
            f'      <p class="section-label">{label}</p>\n'
            f'      <div class="cite-box">{entries}\n      </div>\n'
            f'      {CITE_DATE_JS}\n'
            f'      </section>')


def text_lang(category, translator, language=None):
    """The language a text is in: a translation is English; an original with a `language`
    (AGENTS.md rule 3d: on the poem or its poet; tools/textlang.py) is in that language;
    Turkish and Ottoman poems in the original are Turkish; everything else is English."""
    if (translator or "").strip():
        return "en"
    if language and lang_code(language):
        return lang_code(language)
    return "tr" if category == "Turkish & Ottoman" else "en"


def lang_attrs(lang, text="", language=None):
    """' lang="…"' for a text not in English, and, for a poem that has a `language` field
    (the new world originals, rule 3d), dir="auto" when that language or the text is right to
    left (the browser then sets each block from its first letter), as langAttr in app.js.
    Poems without the field keep exactly the markup they had (a changed page is a paid R2
    write: the owner's rule of 22 Oct 2026)."""
    rtl = bool(language) and needs_dir_auto(lang, text)
    return (f' lang="{lang}"' if lang != "en" else "") + (' dir="auto"' if rtl else "")


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


# The app's search box in the top bar, as a plain form: "/?q=…" opens the archive searched
# (app.js turns it into "#/poems?q=…"), so it works without any script on the page.
SEARCH_FORM = (
    '<form class="tb-search search-form" action="/" method="get" role="search" autocomplete="off">'
    '<input class="search-input" type="search" name="q" placeholder="Poem or poet…" aria-label="Search" />'
    '<button type="submit" aria-label="Search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" '
    'stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/>'
    '<line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button></form>'
)


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
  {VIEW_PREFS}
  <link rel="stylesheet" href="/styles.css?v={CSS_V}" />
</head>
<body>
  <a class="skip-link" href="#main">Skip to the text</a>
  <header class="site-head">
    <div class="topbar">
      <div class="topbar-inner has-search">
        <a class="tb-brand" href="/"><img src="/coin-68.webp" alt="" width="34" height="34" /><span>Poetry&nbsp;Codex</span></a>
        <nav class="tb-nav">
          <a href="/#/poems">Poems</a>
          <a href="/#/poets">Poets</a>
          <a href="/#/eras">Eras</a>
          <a class="tb-oracle" href="/#/oracle">The Oracle</a>
          <a href="/#/about">About</a>
        </nav>
        {SEARCH_FORM}
        <div class="tb-display" role="group" aria-label="Display"><span class="tb-display-l" aria-hidden="true">Display</span><span class="tb-display-opts"><button type="button" class="tb-disp tb-disp-light" onclick="pcSetTheme('light')" aria-label="Light display" title="Light"><svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.6" fill="currentColor"/><path d="M12 2.2v2.6M12 19.2v2.6M4.1 4.1l1.85 1.85M18.05 18.05l1.85 1.85M2.2 12h2.6M19.2 12h2.6M4.1 19.9l1.85-1.85M18.05 5.95l1.85-1.85" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></button><span class="tb-disp-sep" aria-hidden="true"></span><button type="button" class="tb-disp tb-disp-dark" onclick="pcSetTheme('dark')" aria-label="Dark display" title="Dark"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></button></span></div>
      </div>
    </div>
  </header>
  <main class="static-page" id="main">
{body}
  </main>
  <footer class="site-foot">
    <div class="foot-bar">
      <span>© 2026 Poetry Codex. All texts are in the public domain.</span>
      <span class="foot-privacy"><a href="/">Open the full archive</a> · <a href="/poet/">All poets, earliest first</a> · <a href="/guide/">Study guides</a> · <a href="/blog/">Blog</a> · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="mailto:admin@poetrycodex.com">admin@poetrycodex.com</a></span>
    </div>
  </footer>
</body>
</html>
"""


def dates_span(poet):
    """The poet's dates after the byline, as the app shows them (empty when unknown)."""
    d = (poet or {}).get("dates") if isinstance(poet, dict) else None
    return f' <span class="detail-dates">{esc(d)}</span>' if d else ""


MORE_BY = 5


def more_by(poet, poems, n, author):
    """Up to MORE_BY links to other poems by the same poet, spread through their list and the
    same on every build (the poems either side are already linked as Previous / Next)."""
    shown = [j for j in range(len(poems)) if live(poems, j)]
    others = [j for j in shown if abs(j - n) > 1] or [j for j in shown if j != n]
    if not others:
        return ""
    k = min(MORE_BY, len(others))
    step = len(others) / k
    start = (n * 7919) % len(others)
    picks = sorted({others[(start + int(i * step)) % len(others)] for i in range(k)})
    items = []
    for j in picks:
        q = poems[j]
        lang = text_lang(poet.get("category"), q.get("translator"), q.get("language") or poet.get("language"))
        la = lang_attrs(lang, q["title"], q.get("language") or poet.get("language"))
        items.append(f'<li><a href="/poem/{poet["slug"]}/{j}/"><span class="pl-title"{la}>{esc(q["title"])}</span></a></li>')
    return (f'<section class="poet-poems more-by"><h2>More by {esc(author)}</h2>'
            f'<ul class="poem-links">{"".join(items)}</ul></section>')


def poem_notes_html(slug, n):
    """The editors' study notes on a poem (data/glosses/poems/<slug>/<n>.json), as a plain list
    under the text, so that search engines and readers without scripts see them too."""
    f = os.path.join(ROOT, "data", "glosses", "poems", slug, f"{n}.json")
    if not os.path.exists(f):
        return ""
    try:
        notes = json.load(io.open(f, encoding="utf-8"))
    except Exception:
        return ""
    items = []
    for x in notes:
        src = "; ".join(esc(s.get("cite", "")) for s in (x.get("sources") or []) if s.get("cite"))
        items.append(f'<li><p class="sn-head"><strong>{esc(x.get("title", ""))}</strong>'
                     f'{" <span class=sn-ref>" + esc(x.get("ref", "")) + "</span>" if x.get("ref") else ""}</p>'
                     f'<p>{esc(x.get("body") or x.get("short", ""))}</p>'
                     f'{"<p class=sn-src>" + src + "</p>" if src else ""}</li>')
    return ('<section class="static-notes"><p class="section-label">Study notes by the editors</p><ol class="sn-list">'
            + "".join(items) + "</ol></section>")


DUP_TARGET = re.compile(r"^(?:([\w-]+)/(\d+)|work:([\w-]+)#(\d+))$")


def dup_path(value):
    """The site path of a dupOf target: /poem/<slug>/<n>/ or /work/<slug>/<i>/ (None if malformed)."""
    m = DUP_TARGET.match(value or "")
    if not m:
        return None
    return f"/poem/{m.group(1)}/{m.group(2)}/" if m.group(1) else f"/work/{m.group(3)}/{m.group(4)}/"


def live(poems, j):
    """Poem j of the list is shown on the site (not retired with dupOf)."""
    return 0 <= j < len(poems) and not poems[j].get("dupOf")


def redirect_page(path, title, what="text"):
    """The page left at a retired address: sends the reader (and search engines) to path."""
    url = SITE + path
    name = esc(title) if title else esc(url)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{name} · Poetry Codex</title>
  <link rel="canonical" href="{esc(url)}" />
  <meta http-equiv="refresh" content="0; url={esc(path)}" />
  <script>location.replace({json.dumps(path)});</script>
</head>
<body>
  <p>This {what} is now at <a href="{esc(path)}">{name}</a>.</p>
</body>
</html>
"""


def poem_page(poet, poems, n, p):
    title = p["title"]
    author = p["author"]
    slug = poet["slug"]
    subj = p.get("primarySubject") or ""
    lang = text_lang(poet.get("category"), p.get("translator"), p.get("language") or poet.get("language"))
    lang_attr = lang_attrs(lang, title + " " + (p["text"] or "")[:1000], p.get("language") or poet.get("language"))
    themes = "".join(
        f'<span class="theme-tag">{esc(s)}</span>' for s in (p.get("subjects") or [])
    )
    note = (p.get("note") or "").strip()
    desc_src = note or (p["text"] or "").replace("\n", " ")
    description = (f"{title} by {author}. " + desc_src)[:300]

    # Previous / Next skip retired poems (dupOf): they are redirects, not poems of this poet.
    pv = next((j for j in range(n - 1, -1, -1) if live(poems, j)), None)
    nx = next((j for j in range(n + 1, len(poems)) if live(poems, j)), None)
    prev_link = (f'<a class="pn prev" href="/poem/{slug}/{pv}/">← {esc(poems[pv]["title"])}</a>'
                 if pv is not None else '<span></span>')
    next_link = (f'<a class="pn next" href="/poem/{slug}/{nx}/">{esc(poems[nx]["title"])} →</a>'
                 if nx is not None else '<span></span>')

    body = f"""    <article class="detail">
      <p class="detail-subject">{esc(subj)}</p>
      <h1 class="detail-title"{lang_attr}>{esc(title)}</h1>
      <p class="detail-author">by <a href="/poet/{slug}/">{esc(author)}</a>{dates_span(poet)}</p>
      {source_line(p)}
      {('<div class="themes">' + themes + '</div>') if themes else ''}
      <hr class="rule">
      {text_block(p["text"], p.get("translator"), lang_attr)}
      {book_source(poem_source(slug, p))}
      {('<div class="rule-ornament">✦ ✦ ✦</div><p class="section-label">Codex Note</p><p class="note-block">' + esc(note) + '</p>') if note else ''}
      {poem_notes_html(slug, n)}
      {cite_block(author, f"/poem/{slug}/{n}/", title=title, translator=p.get("translator"))}
      <p class="read-in-archive"><a href="/#/poem/{slug}/{n}">Read this poem with the Codex →</a></p>
      <nav class="pn-row">{prev_link}{next_link}</nav>
      {more_by(poet, poems, n, author)}
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


# The Pylos Combat Agate on Homer's page (the owner's request, 17 Oct 2026); the same text
# as AGATE_HTML in app.js. The photograph is the excavators'; the owner chose it (17 Oct 2026).
AGATE_HTML = """
      <figure class="artefact">
        <div class="artefact-case">
          <a class="artefact-img" href="/agate2-1200.webp"><img src="/agate2-640.webp" srcset="/agate2-640.webp 640w, /agate2-1200.webp 1200w" sizes="(max-width: 760px) 92vw, 720px" width="640" height="402" loading="lazy" alt="The Pylos Combat Agate: on an almond-shaped stone of banded agate, a warrior lunges over a great body-shield to drive his sword at the neck of a second, crested warrior, while a third lies dead beneath them" /></a>
          <div class="artefact-actual"><img src="/agate2-240.webp" width="240" height="151" alt="" /><span>Actual size</span></div>
        </div>
        <figcaption>
          <div class="artefact-head">
            <p class="artefact-kicker">Before Homer</p>
            <h2 class="artefact-title">The Pylos Combat Agate</h2>
            <p class="artefact-meta">Minoan Crete, about 1450 BCE<br>Banded agate, 3.4 cm long</p>
          </div>
          <div class="artefact-text">
            <p>A warrior who has already struck down one enemy lunges over a great body-shield and drives his sword at the throat of a second, gripping the crest of the man’s helmet. The whole fight is cut into a sealstone smaller than a thumb, so finely that the muscles of the fighters and the patterns of their kilts can be read only under a lens.</p>
            <p>It was buried with a man of rank, the so-called Griffin Warrior, beside the Palace of Nestor at Pylos, and found in 2015 by the University of Cincinnati excavation led by Sharon Stocker and Jack Davis. Encrusted with limestone, it was first taken for a bead; cleaning revealed the scene in 2017, and it is now counted the finest engraving known from the Aegean Bronze Age.</p>
            <p>The <em>Iliad</em> would not be written down for another seven centuries, yet its world is already here: champions in single combat, crested helmets, the tall shields Homer still remembers in Ajax’s shield “like a tower”, and Pylos itself, the city of old Nestor.</p>
            <p class="artefact-credit">Photograph: Palace of Nestor Excavations, Department of Classics, University of Cincinnati.</p>
          </div>
        </figcaption>
      </figure>
"""


def poet_page(poet, poem_list, works):
    name = poet["name"]
    slug = poet["slug"]
    bio = poet.get("bio") or []
    bio = [bio] if isinstance(bio, str) else bio      # one paragraph given as a plain string
    bio = [b for b in bio if b and b.strip()]
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
    shown = [(i, p) for i, p in enumerate(poem_list) if not p.get("dupOf")]
    if shown:
        rows = "\n".join(
            f'<li><a href="/poem/{slug}/{i}/">{esc(p["title"])}</a></li>'
            for i, p in shown)
        poems_block = f"""
      <p class="section-label">Poems ({len(shown):,})</p>
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
      </div>{AGATE_HTML if slug == "homer" else ""}{works_block}{poems_block}
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


# "Also in this archive": the other translations of a work, as on the app's part pages
# (otherTranslations / matchingPart / otherTrHTML in app.js, same rules): works count as
# translations of each other only when they share a workGroup and have different
# translators; a book is matched by its title ("Book VI"), else by position when both have
# as many parts. Index entries (titles only) are enough.
def tr_label(t):
    """'trans. Samuel Butler (1898)' -> 'Samuel Butler’s translation (1898)'."""
    name = re.sub(r"^trans\.\s*", "", t or "", flags=re.I)
    year = re.search(r"\(([^)]*)\)\s*$", name)
    short = re.sub(r"\s*\([^)]*\)\s*$", "", name)
    return f"{short}’s translation" + (f" ({year.group(1)})" if year else "")


def other_translations(w, all_works):
    if not w.get("workGroup") or not w.get("translator"):
        return []
    short = lambda t: re.sub(r"\s*\([^)]*\)\s*$", "", re.sub(r"^trans\.\s*", "", t or "", flags=re.I))
    mine = short(w["translator"])
    return [o for o in all_works if o["slug"] != w["slug"] and o.get("workGroup") == w["workGroup"]
            and o.get("translator") and short(o["translator"]) != mine]


def part_key(t):
    t = unicodedata.normalize("NFD", (t or "").lower())
    return re.sub(r"[^a-z0-9]+", "", "".join(c for c in t if not unicodedata.combining(c)))


def matching_part(w, o, i):
    ws, os_ = w.get("sections") or [], o.get("sections") or []
    k = part_key(ws[i]["title"]) if i < len(ws) else ""
    for j, sec in enumerate(os_):
        if k and part_key(sec["title"]) == k:
            return j
    return i if len(os_) == len(ws) and i < len(os_) else -1


def also_block(w, others, i=None):
    """The gold-edged box under the translator line; i is the book on a part page."""
    if not others:
        return ""
    rows = []
    for o in others:
        j = -1 if i is None else matching_part(w, o, i)
        if j >= 0:
            rows.append(f'<p class="also-row"><a href="/work/{o["slug"]}/{j}/">{esc(tr_label(o["translator"]))}'
                        f' · {esc(o["sections"][j]["title"])}</a>'
                        f' <a class="compare-btn" href="/#/work/{w["slug"]}/{i}/with/{o["slug"]}">Compare side by side</a></p>')
        else:
            rows.append(f'<p class="also-row"><a href="/work/{o["slug"]}/">{esc(tr_label(o["translator"]))} →</a></p>')
    return ('<div class="also-tr">\n        <p class="section-label">Also in this archive</p>\n        '
            + "\n        ".join(rows) + "\n      </div>")


def work_page(w, poet, grouped, others=()):
    """A long work's contents: what it is, who wrote and translated it, and every part."""
    slug = w["slug"]
    sections = w.get("sections") or []
    rows = "\n".join(
        f'<li><a href="/work/{slug}/{i}/"><span class="pl-title">{esc(s["title"])}</span>'
        f'<span class="pl-sub">{part_size(s.get("text"), w.get("translator"))}</span></a></li>'
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
      {also_block(w, others)}
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


def section_page(w, poet, grouped, i, others=()):
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
      <p class="detail-author">by <a href="/poet/{w["authorSlug"]}/">{esc(w["author"])}</a>{dates_span(poet)}</p>
      {source_line(w)}
      {also_block(w, others, i)}
      <hr class="rule">
      {text_block(s.get("text"), w.get("translator"))}
      {book_source((sources_of(w["authorSlug"]).get("works") or {}).get(slug))}
      {cite_block(w["author"], f"/work/{slug}/{i}/", title="" if whole else s["title"], work=w["title"], translator=w.get("translator"))}
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


# ---------- study guides: /guide/<group>/ ----------
# The app draws each guide from data/guides/<group>.json behind a hash route that search
# engines cannot read; this writes the whole guide as one plain page, so the editors'
# summaries, analyses, debates and bibliography can be found and cited.
def guide_cite(text, bib):
    import re as _re

    def one(m):
        b = bib.get(m.group(1))
        if not b:
            return ""
        who = _re.split(r"[,.]", b)[0].strip()
        yrs = _re.findall(r"\b(1[5-9]\d\d|20\d\d)\b", b)
        return f"({esc(who)}{' ' + yrs[-1] if yrs else ''})"
    out, last = [], 0
    for m in _re.finditer(r"\[\[([\w-]+)\]\]", text or ""):
        out.append(esc(text[last:m.start()]))
        out.append(one(m))
        last = m.end()
    out.append(esc((text or "")[last:]))
    return "".join(out)


def guide_page(g, group):
    bib = {b["id"]: b["text"] for b in g.get("bibliography") or []}
    P = lambda paras: "".join(f"<p>{guide_cite(t, bib)}</p>" for t in (paras or []))
    unit = g.get("unit") or "Book"
    qe = g.get("quoteEdition")

    def quote(q, extra=""):
        return (f'<figure class="gd-quote"><blockquote>{esc(q.get("quote", ""))}</blockquote>'
                f'<figcaption>{esc(q.get("who", "") + " · " if q.get("who") else "")}{esc(q.get("ref", ""))}</figcaption>'
                f'{"<p>" + guide_cite(extra, bib) + "</p>" if extra else ""}</figure>')
    glance = "".join(f'<div><dt>{esc(r["label"])}</dt><dd>{guide_cite(r["value"], bib)}</dd></div>'
                     for r in g.get("glance") or [])
    books = []
    for b in g.get("books") or []:
        read = ""
        if qe:
            sec = b.get("section") if b.get("section") is not None else b["n"] - 1
            read = f'<p class="gd-read"><a href="/work/{esc(qe)}/{sec}/">Read the text</a></p>'
        lines = f'<p class="gd-lines">{esc(b["lines"])}</p>' if b.get("lines") else ""
        books.append(f'<section id="part-{b["n"]}"><h3 class="gd-h">{esc(unit)} {b["n"]}: {esc(b["title"])}</h3>{lines}'
                     f'<h4 class="gd-h3">Summary</h4>{P(b.get("summary"))}'
                     f'<h4 class="gd-h3">Analysis</h4>{P(b.get("analysis"))}'
                     + "".join(quote(k, k.get("note", "")) for k in b.get("key") or []) + read + "</section>")
    sides = []
    for c in g.get("characters") or []:
        if c.get("side") not in sides:
            sides.append(c.get("side"))
    chars = "".join(f'<h3 class="gd-h3">{esc(sd)}</h3><dl class="gd-chars">'
                    + "".join(f'<div><dt>{esc(c["name"])}</dt><dd>{guide_cite(c["text"], bib)}</dd></div>'
                              for c in g["characters"] if c.get("side") == sd) + "</dl>" for sd in sides)
    themes = "".join(f'<h3 class="gd-h3">{esc(t["title"])}</h3>{P(t["text"])}' for t in g.get("themes") or [])
    motifs = "".join(f'<h3 class="gd-h3">{esc(t["title"])}</h3>{P([t["text"]])}' for t in g.get("motifs") or [])
    symbols = "".join(f'<h3 class="gd-h3">{esc(t["title"])}</h3>{P([t["text"]])}' for t in g.get("symbols") or [])
    debates = "".join(f'<h3 class="gd-h3">{esc(t["title"])}</h3>{P(t["text"])}' for t in g.get("debates") or [])
    quotes = "".join(quote(q, q.get("explanation", "")) for q in g.get("quotes") or [])
    qs = "".join(f'<li><p>{esc(q["q"])}</p><p class="gd-hint">{guide_cite(q.get("hint", ""), bib)}</p></li>'
                 for q in g.get("questions") or [])
    bibl = "".join(f"<li>{esc(b['text'])}</li>" for b in g.get("bibliography") or [])
    toc = " · ".join(f'<a href="#{a}">{t}</a>' for a, t in (("overview", "Overview"), ("parts", f"{unit} by {unit.lower()}"),
                     ("characters", "Characters"), ("themes", "Themes"), ("debates", "Critical debates"),
                     ("quotes", "Key passages"), ("questions", "Questions"), ("reading", "Further reading")))
    body = f"""    <article class="detail gd-page">
      <p class="detail-subject">Study guide</p>
      <h1 class="detail-title">{esc(g["title"])}</h1>
      <p class="detail-author">by {esc(g.get("author", ""))}</p>
      <p class="read-in-archive"><a href="/#/guide/{esc(group)}">Open the interactive study guide →</a></p>
      <nav class="gd-tabs" aria-label="Contents">{toc}</nav>
      <section id="overview"><h2 class="gd-h">Overview</h2><dl class="gd-glance">{glance}</dl>
      <h3 class="gd-h3">Context</h3>{P(g.get("context"))}<h3 class="gd-h3">Plot overview</h3>{P(g.get("plot"))}</section>
      <section id="parts"><h2 class="gd-h">{esc(unit)} by {esc(unit.lower())}</h2>{"".join(books)}</section>
      <section id="characters"><h2 class="gd-h">Characters</h2>{chars}</section>
      <section id="themes"><h2 class="gd-h">Themes</h2>{themes}<h2 class="gd-h">Motifs</h2>{motifs}<h2 class="gd-h">Symbols</h2>{symbols}</section>
      <section id="debates"><h2 class="gd-h">Critical debates</h2>{debates}</section>
      <section id="quotes"><h2 class="gd-h">Key passages</h2>{quotes}</section>
      <section id="questions"><h2 class="gd-h">Questions for study</h2><ol class="gd-qs">{qs}</ol></section>
      <section id="reading"><h2 class="gd-h">Further reading</h2><ul class="gd-bib">{bibl}</ul></section>
      <p class="gd-foot">Written by the Poetry Codex editors. Updated {esc(g.get("updated", ""))}.</p>
    </article>"""
    canonical = f"{SITE}/guide/{group}/"
    title = f"{g['title']}: Study Guide"
    first = (g.get("plot") or g.get("context") or [""])[0]
    import re as _re
    description = (f"Study guide to {g['title']} by {g.get('author', '')}: summary and analysis of every "
                   f"{unit.lower()}, characters, themes, critical debates, key passages and further reading. "
                   + _re.sub(r"\[\[[\w-]+\]\]", "", first))[:300]
    ld = ld_json({"@type": "LearningResource", "name": title, "url": canonical, "inLanguage": "en",
                  "learningResourceType": "Study guide", "isAccessibleForFree": True,
                  "about": {"@type": "CreativeWork", "name": g["title"], "author": {"@type": "Person", "name": g.get("author", "")}},
                  "publisher": {"@type": "Organization", "name": "Poetry Codex", "url": SITE + "/"}},
                 breadcrumbs(("Study guides", None), (g["title"], None)))
    return shell(title, description, canonical, body, ld=ld)


# ---------- the blog: /blog/ and /blog/<slug>/ ----------
# Articles by the editors, kept as Markdown in data/blog/<slug>.md with a small front-matter
# block (title, description, date, author, slug). Only the Markdown the editors use is read:
# headings (##, ###), paragraphs, block quotes (>), lists (- or 1.), **bold**, *italic* and
# [links](url).
def md_inline(t):
    import re as _re
    t = esc(t)
    t = _re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', t)
    t = _re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    t = _re.sub(r"(?<![*\w])\*([^*\n]+)\*(?!\w)", r"<em>\1</em>", t)
    return t


def md_html(src):
    out, para, lst, quote = [], [], None, []

    def flush():
        nonlocal para, lst, quote
        if para:
            out.append("<p>" + md_inline(" ".join(para)) + "</p>")
            para = []
        if lst:
            tag, items = lst
            out.append(f"<{tag}>" + "".join(f"<li>{md_inline(i)}</li>" for i in items) + f"</{tag}>")
            lst = None
        if quote:
            out.append('<blockquote class="blog-quote">' + "<br>".join(md_inline(q) for q in quote) + "</blockquote>")
            quote = []
    import re as _re
    for line in src.splitlines():
        st = line.strip()
        if not st:
            flush()
            continue
        m = _re.match(r"(#{2,4})\s+(.*)", st)
        if m:
            flush()
            lvl = len(m.group(1))
            out.append(f"<h{lvl}>{md_inline(m.group(2))}</h{lvl}>")
            continue
        if st.startswith(">"):
            if para or lst:
                flush()
            quote.append(st.lstrip("> ").rstrip())
            continue
        m = _re.match(r"(?:[-*]|\d+\.)\s+(.*)", st)
        if m:
            if para or quote:
                flush()
            tag = "ol" if st[0].isdigit() else "ul"
            if not lst:
                lst = (tag, [])
            lst[1].append(m.group(1))
            continue
        if lst or quote:
            flush()
        para.append(st)
    flush()
    return "\n".join(out)


def blog_posts():
    import re as _re
    bdir = os.path.join(ROOT, "data", "blog")
    posts = []
    for f in sorted(os.listdir(bdir)) if os.path.isdir(bdir) else []:
        if not f.endswith(".md"):
            continue
        raw = io.open(os.path.join(bdir, f), encoding="utf-8").read().replace("\r\n", "\n")
        meta, body = {}, raw
        m = _re.match(r"---\n(.*?)\n---\n", raw, _re.S)
        if m:
            for line in m.group(1).splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip().strip('"')
            body = raw[m.end():]
        meta.setdefault("slug", f[:-3])
        meta["body"] = body
        posts.append(meta)
    posts.sort(key=lambda x: x.get("date", ""), reverse=True)
    return posts


def blog_page(post):
    canonical = f"{SITE}/blog/{post['slug']}/"
    body = f"""    <article class="detail blog-post">
      <p class="detail-subject"><a href="/blog/">Notes from the Codex</a></p>
      <h1 class="detail-title">{esc(post.get("title", ""))}</h1>
      <p class="detail-author">{esc(post.get("author", "The Poetry Codex editors"))} · {esc(post.get("date", ""))}</p>
      <div class="blog-body">
{md_html(post["body"])}
      </div>
      <p class="read-in-archive"><a href="/blog/">More notes from the Codex →</a></p>
    </article>"""
    ld = ld_json({"@type": "BlogPosting", "headline": post.get("title", ""), "description": post.get("description", ""),
                  "datePublished": post.get("date", ""), "url": canonical, "inLanguage": "en",
                  "author": {"@type": "Organization", "name": "Poetry Codex"},
                  "publisher": {"@type": "Organization", "name": "Poetry Codex", "url": SITE + "/"}},
                 breadcrumbs(("Notes from the Codex", f"{SITE}/blog/"), (post.get("title", ""), None)))
    return shell(post.get("title", ""), post.get("description", ""), canonical, body, ld=ld)


def blog_index(posts):
    rows = "\n".join(
        f'<li><a href="/blog/{esc(p["slug"])}/"><span class="pl-title">{esc(p.get("title", ""))}</span>'
        f'<span class="pl-sub">{esc(p.get("date", ""))} · {esc(p.get("description", ""))}</span></a></li>' for p in posts)
    body = f"""    <article class="detail">
      <p class="detail-subject">The Poetry Codex blog</p>
      <h1 class="detail-title">Notes from the Codex</h1>
      <p class="detail-author">Articles by the editors on reading the world's poetry</p>
      <ul class="poem-links">
{rows}
      </ul>
    </article>"""
    return shell("Notes from the Codex", "Articles by the Poetry Codex editors on reading the world's poetry: translations, epics, poets and how to study them.",
                 f"{SITE}/blog/", body, og_type="website")


def not_found_page():
    """404.html: GitHub Pages serves it for any address that does not exist."""
    body = r"""<article class="detail not-found">
      <style>
        .nf-quill { display: block; width: min(220px, 60vw); height: auto; margin: 0 auto .4rem; overflow: visible; }
        .nf-quill .nf-ink { stroke: var(--accent); }
        .nf-quill .nf-dot { fill: var(--accent); }
        .nf-quill .nf-feather { fill: var(--surface-alt); stroke: var(--gold); }
        .nf-quill .nf-vane { stroke: var(--gold); }
        .nf-quill .nf-nib { fill: var(--ink-soft); }
        .nf-quill .nf-shadow { fill: var(--line); }
        .nf-code { font-family: var(--sans); letter-spacing: .32em; color: var(--gold-ink); font-size: .8rem; margin: 0 0 .5rem; }
        .nf-verse { font-family: var(--serif); font-style: italic; font-size: 1.12rem; line-height: 1.6; color: var(--ink-soft); margin: 1.1rem auto 1.3rem; }
        .nf-verse cite { display: block; font-style: normal; font-family: var(--sans); font-size: .78rem; letter-spacing: .04em; color: var(--faint); margin-top: .35rem; }
        .nf-verse a { color: inherit; }
        .nf-instead { margin: 1.6rem 0 0; font-family: var(--serif); font-style: italic; }
        .nf-instead a { color: var(--accent); }
      </style>
      <svg class="nf-quill" viewBox="0 0 220 210" role="img" aria-label="A quill pen writing a question mark">
        <ellipse class="nf-shadow" cx="110" cy="196" rx="46" ry="5"/>
        <g id="nf-scene">
          <path id="nf-q" class="nf-ink" d="M78 74 C76 40 142 34 144 70 C146 98 110 102 110 128 L110 146" fill="none" stroke-width="9" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1">
            <animate attributeName="stroke-dashoffset" values="1;0;0" keyTimes="0;.46;1" dur="5s" repeatCount="indefinite"/>
          </path>
          <circle class="nf-dot" cx="110" cy="172" r="0">
            <animate attributeName="r" values="0;0;7.5;6;6" keyTimes="0;.56;.6;.63;1" dur="5s" repeatCount="indefinite"/>
          </circle>
          <g>
            <animateMotion dur="5s" repeatCount="indefinite" keyPoints="0;.86;1;1;.94" keyTimes="0;.46;.56;.62;1" calcMode="linear" path="M78 74 C76 40 142 34 144 70 C146 98 110 102 110 128 L110 146 L110 172"/>
            <g transform="rotate(32)">
              <animateTransform attributeName="transform" type="rotate" values="32;26;34;30;32" keyTimes="0;.25;.46;.6;1" dur="5s" repeatCount="indefinite"/>
              <path class="nf-nib" d="M0 0 L-3.2 -14 L3.2 -14 Z"/>
              <path class="nf-feather" d="M0 -12 C-14 -40 -20 -80 -6 -118 C4 -96 18 -62 10 -30 C8 -22 4 -16 0 -12 Z" stroke-width="1.6"/>
              <path class="nf-vane" d="M0 -14 C-2 -50 -4 -85 -6 -116 M-2 -40 L-11 -50 M-3 -58 L-13 -70 M-4 -76 L-13 -90 M-1 -46 L8 -58 M-2 -66 L10 -80 M-4 -86 L6 -98" fill="none" stroke-width="1.2" stroke-linecap="round"/>
            </g>
          </g>
          <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.88;.97;1" dur="5s" repeatCount="indefinite"/>
        </g>
      </svg>
      <p class="nf-code">404</p>
      <h1 class="detail-title">This page is nobody</h1>
      <blockquote class="nf-verse" id="nf-verse">I’m nobody! Who are you?<br />Are you nobody, too?<cite>— <a href="/poem/dickinson/115/">Emily Dickinson</a></cite></blockquote>
      <script>
        // One of five lines about being lost, a different one on each visit (Dickinson without script).
        (function () {
          var V = [
            ["Midway upon the journey of our life<br />I found myself within a forest dark,<br />For the straightforward pathway had been lost.", "/work/divine-comedy-longfellow/0/", "Dante, translated by Longfellow"],
            ["Failing to fetch me at first keep encouraged,<br />Missing me one place search another,<br />I stop somewhere waiting for you.", "/poem/whitman/25/", "Walt Whitman"],
            ["Does the road wind up-hill all the way?<br />Yes, to the very end.", "/poem/rossetti_c/259/", "Christina Rossetti"],
            ["The World was all before them, where to choose<br />Thir place of rest, and Providence thir guide.", "/work/paradise-lost/11/", "John Milton"]
          ];
          var k = Math.floor(Math.random() * (V.length + 1));
          if (k < V.length) document.getElementById("nf-verse").innerHTML = V[k][0] + '<cite>— <a href="' + V[k][1] + '">' + V[k][2] + "</a></cite>";
        })();
      </script>
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
      <p class="nf-instead"><a href="/#/surprise">Or read a poem instead</a></p>
    </article>
    <script>
      (function () {
        // /poets, /about … typed as paths are meant as the archive's pages of that name.
        var path = location.pathname.replace(/\/+$/, "").toLowerCase();
        if (/^\/(poems|poets|eras|oracle|about)$/.test(path)) { location.replace("/#" + path); return; }
        // the quill's little animation: shown finished, and still, to readers who ask for less motion
        var quill = document.querySelector(".nf-quill");
        if (quill && quill.pauseAnimations && matchMedia("(prefers-reduced-motion: reduce)").matches) { quill.pauseAnimations(); quill.setCurrentTime(3.5); }
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


WORK_FIELDS = ("slug", "title", "subtitle", "authorSlug", "author", "year", "type", "translator",
               "workGroup", "blurb")


def works_manifest(works):
    """work/works.json: every work as data/index.json lists it, without the notes and the stanza
    counts (about 150 KB compressed). app.js draws a work's contents page, a book's "Also in this
    archive" and the side-by-side view from it, so those pages never fetch the 32 MB index."""
    rows = []
    for w in works:
        row = {k: w[k] for k in WORK_FIELDS if w.get(k) not in (None, "")}
        row["sections"] = [{k: v for k, v in s.items() if k != "stanzas"} for s in w.get("sections") or []]
        rows.append(row)
    return "[\n" + ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows) + "\n]\n"


def main():
    idx = json.load(io.open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))

    # Rebuild from scratch so a removed poem's page does not linger.
    for d in ("poem", "poet", "work", "guide", "blog"):
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
    urls = [f"{SITE}/", f"{SITE}/poet/"]
    poem_count = poet_count = work_count = section_count = 0
    titles = {}   # live poem id -> title (for the redirect pages of retired poems)

    for poet_stub in idx["poets"]:
        slug = poet_stub["slug"]
        pf = os.path.join(ROOT, "data", "poets", slug + ".json")
        poems = []
        if os.path.exists(pf):
            poems = json.load(io.open(pf, encoding="utf-8")).get("poems") or []
        works = works_by_poet.get(slug, [])
        for n, p in enumerate(poems):
            if not p.get("dupOf"):
                titles[f"{slug}/{n}"] = p["title"]
        if not any(not p.get("dupOf") for p in poems) and not works:
            continue

        poet = {
            "slug": slug, "name": poet_stub["name"], "dates": poet_stub.get("dates"),
            "category": poet_stub.get("category"), "bio": poet_stub.get("bio") or [],
            "portrait": poet_stub.get("portrait"),
        }
        POET_ROWS.append({"slug": slug, "name": poet["name"], "dates": poet.get("dates")})
        write(os.path.join(ROOT, "poet", slug, "index.html"), poet_page(poet, poems, works))
        urls.append(f"{SITE}/poet/{slug}/")
        poet_count += 1

        for n, p in enumerate(poems):
            if p.get("dupOf"):
                continue          # a redirect page is written below, and no sitemap entry
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
            others = other_translations(stub, idx.get("works") or [])
            write(os.path.join(ROOT, "work", w["slug"], "index.html"), work_page(w, poet, grouped, others))
            urls.append(f"{SITE}/work/{w['slug']}/")
            work_count += 1
            for i in range(len(w.get("sections") or [])):
                write(os.path.join(ROOT, "work", w["slug"], str(i), "index.html"),
                      section_page(w, poet, grouped, i, others))
                urls.append(f"{SITE}/work/{w['slug']}/{i}/")
                section_count += 1
    write(os.path.join(ROOT, "work", "works.json"), works_manifest(idx.get("works") or []))

    # Retired poems and merged poets: a redirect page at the old address, not in the sitemap.
    works_by_slug = {w["slug"]: w for w in idx.get("works") or []}
    redirect_count = 0
    for pid, target in (idx.get("retired") or {}).items():
        path = dup_path(target)
        if not path:
            continue                       # verify_split.py reports a malformed dupOf
        if target.startswith("work:"):
            wslug, i = target[5:].split("#")
            w, i = works_by_slug.get(wslug) or {}, int(i)
            secs = w.get("sections") or []
            title = (w.get("title", "") + (" · " + secs[i]["title"] if i < len(secs) else "")) if w else ""
        else:
            title = titles.get(target, "")
        slug, n = pid.rsplit("/", 1)
        write(os.path.join(ROOT, "poem", slug, n, "index.html"), redirect_page(path, title, "poem"))
        redirect_count += 1
    poets_by_slug = {p["slug"]: p for p in idx["poets"]}
    for slug, into in (idx.get("merged") or {}).items():
        write(os.path.join(ROOT, "poet", slug, "index.html"),
              redirect_page(f"/poet/{into}/", (poets_by_slug.get(into) or {}).get("name", ""), "poet"))
        redirect_count += 1

    guide_count = 0
    guides = []   # (group, guide) for the /guide/ hub and llms.txt
    gdir = os.path.join(ROOT, "data", "guides")
    for f in sorted(os.listdir(gdir)) if os.path.isdir(gdir) else []:
        if f.endswith(".json"):
            group = f[:-5]
            g = json.load(io.open(os.path.join(gdir, f), encoding="utf-8"))
            write(os.path.join(ROOT, "guide", group, "index.html"), guide_page(g, group))
            urls.append(f"{SITE}/guide/{group}/")
            guides.append((group, g))
            guide_count += 1
    guide_sets = guide_groups(guides, idx)
    write(os.path.join(ROOT, "guide", "index.html"), guide_hub_page(guide_sets))
    urls.insert(2, f"{SITE}/guide/")
    print(f"study guides: {guide_count} pages + the /guide/ hub")
    posts = blog_posts()
    if posts:
        write(os.path.join(ROOT, "blog", "index.html"), blog_index(posts))
        urls.append(f"{SITE}/blog/")
        for post in posts:
            write(os.path.join(ROOT, "blog", post["slug"], "index.html"), blog_page(post))
            urls.append(f"{SITE}/blog/{post['slug']}/")
    print(f"blog: {len(posts)} posts")

    # Child sitemaps of 25,000 URLs (the limit is 50,000) behind one index, so Google reads
    # the whole site in a handful of fetches (at 1,000 a file it had read 9 of ~137 in two weeks).
    CHUNK = 25000
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
    write_poet_hub(POET_ROWS)
    write(os.path.join(ROOT, "404.html"), not_found_page())
    write_llms_txt(idx, guide_sets, posts)
    update_home_meta(idx)
    print("sitemap index: " + str(len(chunks)) + " child sitemaps")

    print(f"poet pages: {poet_count}")
    print(f"poem pages: {poem_count}")
    print(f"work pages: {work_count} (+ {section_count} sections)")
    print(f"sitemap urls: {len(urls)}")
    print(f"redirect pages (retired poems, merged poets): {redirect_count}")


def poet_hub_page(poets):
    """/poet/: every poet as a plain link, earliest first (the order of data/index.json), so
    crawlers reach every poet page from one page that the home page and every static page's
    footer link to. The editor's ruling (21 Oct 2026): no count of poets anywhere on it."""
    links = " · ".join(
        f'<a href="/poet/{esc(p["slug"])}/">{esc(p["name"])}</a>'
        + (f' <span class="ph-dates">{esc(p["dates"])}</span>' if p.get("dates") else "")
        for p in poets)
    canonical = f"{SITE}/poet/"
    title = "All poets, earliest first"
    description = ("Every poet in the Poetry Codex, from the oldest songs and epics to the early "
                   "twentieth century, in order of time. Each name opens the poet's page of poems and works.")
    body = f"""    <article class="detail poet-hub">
      <p class="detail-subject">The poets of the Codex</p>
      <h1 class="detail-title">{title}</h1>
      <p class="page-sub">{esc(description)}</p>
      <nav class="ph-list" aria-label="Poets">
        {links}
      </nav>
    </article>"""
    ld = ld_json({"@type": "CollectionPage", "name": title, "description": description, "url": canonical,
                  "inLanguage": "en", "isPartOf": {"@type": "WebSite", "name": "Poetry Codex", "url": SITE + "/"}},
                 breadcrumbs((title, None)))
    return shell(title, description, canonical, body, og_type="website", ld=ld)


def write_poet_hub(poets):
    write(os.path.join(ROOT, "poet", "index.html"), poet_hub_page(poets))
    print("poet hub page: " + str(len(poets)) + " poet links")


# ---------- /guide/ hub and llms.txt ----------
def category_order():
    """CATEGORY_ORDER from app.js, so the guide hub follows the home page's order of traditions."""
    src = io.open(os.path.join(ROOT, "app.js"), encoding="utf-8").read()
    m = re.search(r"const CATEGORY_ORDER = \[(.*?)\];", src, re.S)
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []


def strip_article(title):
    return re.sub(r"^(The|A|An) ", "", title or "").lower()


def guide_groups(guides, idx):
    """The guides grouped by the tradition (poet category) of the work's author, in the home
    page's order; a guide whose work cannot be found goes under "Other works" at the end."""
    cat_of = {p["slug"]: p.get("category") for p in idx["poets"]}
    works = idx.get("works") or []
    sets = {}
    for group, g in guides:
        keys = {group, g.get("work"), g.get("quoteEdition")}
        w = next((w for w in works if w.get("workGroup") in keys or w["slug"] in keys), None)
        cat = (cat_of.get(w["authorSlug"]) if w else None) or "Other works"
        sets.setdefault(cat, []).append((group, g))
    order = category_order()
    cats = sorted(sets, key=lambda c: (order.index(c) if c in order else len(order), c))
    return [(c, sorted(sets[c], key=lambda gg: strip_article(gg[1].get("title")))) for c in cats]


def guide_hub_page(guide_sets):
    """/guide/: every study guide as a plain link, by tradition. No count of poets anywhere on it
    (the editor's ruling of 21 Oct 2026, as for /poet/)."""
    sections = []
    for cat, items in guide_sets:
        rows = "\n".join(
            f'          <li><a href="/guide/{esc(group)}/"><span class="pl-title">{esc(g.get("title", ""))}</span>'
            + (f'<span class="pl-sub">{esc(g["author"])}</span>' if g.get("author") else "") + "</a></li>"
            for group, g in items)
        sections.append(f"""      <section class="poet-poems">
        <h2>{esc(cat)}</h2>
        <ul class="poem-links">
{rows}
        </ul>
      </section>""")
    canonical = f"{SITE}/guide/"
    title = "Study guides"
    description = ("The Poetry Codex study guides to the great poems, epics and plays: summary and analysis of "
                   "every book, characters, themes, critical debates, key passages, questions and a scholarly "
                   "bibliography, written by the editors.")
    body = f"""    <article class="detail guide-hub">
      <p class="detail-subject">Reading the great works</p>
      <h1 class="detail-title">{title}</h1>
      <p class="page-sub">{esc(description)}</p>
{chr(10).join(sections)}
    </article>"""
    ld = ld_json({"@type": "CollectionPage", "name": title, "description": description, "url": canonical,
                  "inLanguage": "en", "isPartOf": {"@type": "WebSite", "name": "Poetry Codex", "url": SITE + "/"}},
                 breadcrumbs((title, None)))
    return shell(title, description, canonical, body, og_type="website", ld=ld)


# Work types counted as prose in the "Ancient sources in prose" list of llms.txt.
ANCIENT_PROSE_TYPES = {"History", "Biography", "Philosophical dialogue", "Oration", "Letters", "Treatise",
                       "Philosophy", "Philosophical treatise", "Chronicle", "Philosophical essays", "Essays",
                       "Dialogue", "Encyclopaedia", "Literary criticism", "Travel writing", "Mythography",
                       "Character sketches", "Law code", "Wisdom literature", "Autobiography",
                       "Philosophical memoir", "Satirical prose"}
ANCIENT_CATS = ("Ancient Greek & Roman", "Ancient Near East")


def llms_txt(idx, guide_sets, posts):
    """llms.txt (https://llmstxt.org): the site described for AI assistants. Generated, so it
    lists every guide and article and never falls behind the archive. It says no more about who
    makes the site than the About page does, names no one, and gives no count of poets."""
    works = idx.get("works") or []
    cat_of = {p["slug"]: p.get("category") for p in idx["poets"]}
    count = idx.get("count") or 0
    held = f"over {count // 1000 * 1000:,} poems" if count >= 1000 else "thousands of poems"
    L = ["# Poetry Codex", "",
         f"> Poetry Codex (https://poetrycodex.com) is a free, advertisement-free reading archive of the world's "
         f"poetry in the public domain. It holds {held} and the great epics in their classic translations, from "
         f"Gilgamesh, Homer and the Mahabharata to the early twentieth century, with the ancient sources of "
         f"Greece and Rome in prose and verse, and study guides and line-by-line study notes written by its "
         f"editors. Every text is reproduced in full and is in the public domain; translations were published "
         f"before 1931 and name their translator. The editors' guides and notes are original.",
         "", "## What is here", "",
         f"- Poems: {SITE}/poem/<poet>/<n>/ (one page per poem, with its source, translator and date)",
         f"- Poets: {SITE}/poet/<poet>/ (biography and list of works); every poet, earliest first: {SITE}/poet/",
         f"- Long works and epics, with every book or canto on its own page: {SITE}/work/<work>/",
         f"- Study guides (summary and analysis of every book, characters, themes, critical debates, key passages, "
         f"questions and a scholarly bibliography): {SITE}/guide/",
         f"- Articles by the editors: {SITE}/blog/",
         f"- Sitemap of all pages: {SITE}/sitemap.xml",
         "", "## Study guides", "", f"All guides on one page: {SITE}/guide/"]
    for cat, items in guide_sets:
        L += ["", f"### {cat}", ""]
        for group, g in items:
            by = f" ({g['author']})" if g.get("author") else ""
            L.append(f"- {g.get('title', '')}{by}: {SITE}/guide/{group}/")
    if posts:
        L += ["", "## Articles", "", f"- Notes from the Codex (the editors' blog): {SITE}/blog/"]
        for p in posts:
            L.append(f"- {p.get('title', '')}: {SITE}/blog/{p['slug']}/")

    # The major works: one line per epic of twelve books or more (one translation stands for its
    # group), and one line per ancient author of prose (their poet page lists all their works).
    groups = {}
    for w in works:
        groups.setdefault(w.get("workGroup") or w["slug"], []).append(w)
    epics, prose = [], {}
    for g, ws in groups.items():
        w = next((x for x in ws if x["slug"] == g), ws[0])
        t = (w.get("type") or "").lower()
        if "epic" in t and "mock" not in t and max(len(x.get("sections") or []) for x in ws) >= 12:
            epics.append(w)
        elif cat_of.get(w["authorSlug"]) in ANCIENT_CATS and w.get("type") in ANCIENT_PROSE_TYPES:
            prose.setdefault(w["authorSlug"], [w["author"], []])[1].append(w["title"])
    if epics or prose:
        L += ["", "## Major works"]
    if epics:
        L += ["", "### Epics (twelve books or more)", ""]
        for w in sorted(epics, key=lambda w: strip_article(w["title"])):
            L.append(f"- {w['title']} ({w['author']}): {SITE}/work/{w['slug']}/")
    if prose:
        L += ["", "### Ancient sources in prose (history, philosophy, oratory, biography, letters)", ""]
        for slug, (author, titles) in sorted(prose.items(), key=lambda kv: kv[1][0].lower()):
            shown = "; ".join(titles[:4]) + ("; and others" if len(titles) > 4 else "")
            L.append(f"- {author}: {shown}: {SITE}/poet/{slug}/")
    L += ["", "## Citing", "",
          "Each poem page gives its source edition and translator. To cite the editors' study guides: "
          "\"Poetry Codex editors, '<Title>: Study Guide', Poetry Codex, <URL>, accessed <date>.\""]
    return "\n".join(L) + "\n"


def write_llms_txt(idx, guide_sets, posts):
    text = llms_txt(idx, guide_sets, posts)
    write(os.path.join(ROOT, "llms.txt"), text)
    print("llms.txt: " + str(text.count("\n")) + " lines")

def update_home_meta(idx):
    """Keep the poem count in index.html's description and link-preview tags current
    (rounded down to the thousand below a multiple of 5,000; never a count of poets)."""
    n = idx.get("count") or len(idx.get("poems", []))
    shown = f"{(n // 5000) * 5000:,}"
    desc = (f"A free reading archive of poetry in the public domain: more than {shown} poems, from Homer "
            "and Anglo-Saxon verse to the early twentieth century, with the great epics, ancient histories "
            "and plays, study guides and line notes.")
    og = (f"More than {shown} poems, from Homer and Anglo-Saxon verse to the early twentieth century. "
          "Every text in the public domain, with study guides, line notes and the great epics in many translations.")
    path = os.path.join(ROOT, "index.html")
    with open(path, encoding="utf-8", newline="") as f:
        old = f.read()
    new = re.sub(r'(<meta name="description" content=")[^"]*(")', lambda m: m.group(1) + html.escape(desc, quote=True) + m.group(2), old, count=1)
    for prop in ("og:description", "twitter:description"):
        new = re.sub(r'(<meta (?:property|name)="' + prop + r'" content=")[^"]*(")', lambda m: m.group(1) + html.escape(og, quote=True) + m.group(2), new, count=1)
    if new != old:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new)
    print("index.html meta: more than " + shown + " poems")

if __name__ == "__main__":
    main()
