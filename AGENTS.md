# Poetry Codex — Agent Briefing

This file is the onboarding document for any AI coding agent working on this repo
(OpenAI Codex reads `AGENTS.md` automatically; Claude Code reads `CLAUDE.md`, which
points here). Read it fully before making changes.

**Live site:** https://huskoras.github.io/poetrycodex/
**Repo:** https://github.com/huskoras/poetrycodex
**Owner:** a non-technical user. Explain things in plain language, avoid jargon, and
do the technical work yourself rather than handing them instructions to run.

---

## 1. What this project is

A curated archive of **public-domain poetry** — currently **11,012 poems, 107 poets,
39 multi-section works**, spanning Cædmon (~7th c.) and Homer (~8th c. BC) through
early-20th-century American poets.

Each poem page shows the full text; each poet has a page with portrait, dates, bio and
their poem/work list. Long texts (epics, poem cycles) are "works" split into readable
sections (cantos/books/fitts).

---

## 2. Tech stack — deliberately simple

- **Plain static site.** No framework, no build step, no bundler, no package.json, no CI.
- `index.html` — page shell (sticky top bar, hero, footer)
- `styles.css` — all styling (design tokens in `:root`)
- `app.js` — the whole app: hash routing + all render functions + on-demand data fetching
- `data/index.json` — **startup index**, fetched once on page load (~4.5 MB): poet
  metadata + counts, poem *index entries* (title/author/subjects/3-line excerpt, no
  full text), work metadata + section titles (no section text), subject tallies, and
  `legacyIndex` (see below). This is a generated build artifact — never hand-edit it.
- `data/poets/<slug>.json` — **source of truth** for one poet: identity fields +
  every one of that poet's poems, **full text included**. Fetched lazily the first
  time a poem by that poet is opened, then cached in memory for the session.
- `data/works/<slug>.json` — **source of truth** for one long work: full metadata +
  `sections[]` with **full section text**. Fetched lazily the first time a section of
  that work is opened, then cached in memory.
- `data/legacy_index.json` — a frozen, one-time array mapping the old pre-split
  `poems.json` array position (`0..11011`) to the new stable poem id. Written once by
  `tools/split_data.py`; carried through unmodified by every `build_index.py` rebuild.
  New poems never get a legacy number — only ids that existed before the 2026 split do.
- `tools/split_data.py` — one-off migration script that produced the files above from
  the old monolithic `poems.json` (kept for reference; do not re-run — `poems.json` no
  longer exists in the working tree, only in git history at or before commit `b38eab4`).
- `tools/build_index.py` — regenerates `data/index.json` from `data/poets/*.json` +
  `data/works/*.json`. Run this after any content edit.
- `tools/verify_split.py` — data-integrity check (see "Verifying data integrity" below).
- `poets/*.jpg` — portrait/illustration images (unrelated to `data/poets/`; note the
  singular/plural difference — this is the images folder, `data/poets/` is poem data).
- `dev_server.py` — local no-cache dev server (`python dev_server.py` → http://localhost:8777)
- `BAŞLAT.bat` — double-click launcher for the owner (starts server + opens browser)

**Why split:** the original `poems.json` held all ~30 MB of content in one file the
browser had to fetch in full before showing anything, and GitHub warns above 50 MB /
hard-rejects above 100 MB. As of September 2026 content is split as above: the browser
fetches only the ~4.5 MB index up front, then fetches one poet or work file (usually a
few dozen KB to a few hundred KB) only when that specific poem or work section is opened.

**Deploy:** GitHub Pages serves `main` directly. **Pushing to `main` IS deploying** —
the live site updates ~1 minute after a push. There is no build or deploy step.

**Cache-busting:** `index.html` loads `styles.css?v=N` and `app.js?v=N`. If you change
either file, bump `N` in `index.html` or returning visitors get a stale cached copy.

---

## 3. Data schema (`data/poets/<slug>.json`, `data/works/<slug>.json`, `data/index.json`)

**`data/poets/<slug>.json`** (source of truth for a poet + all their short/medium poems):
```json
{ "slug": "keats", "name": "John Keats", "dates": "1795–1821",
  "era": "Romantic", "category": "Romantic",
  "portrait": "poets/keats.jpg",   // or null
  "credit": "Portrait of John Keats by William Hilton (c. 1822) · Public domain (Wikimedia Commons)",
  "bio": ["paragraph 1", "paragraph 2"],
  "order": 730,                   // chronological sort key, spaced by 10 — see below
  "poems": [
    { "id": "keats/0", "title": "Ode on a Grecian Urn", "authorSlug": "keats", "author": "John Keats",
      "primarySubject": "Arts & Sciences", "subjects": ["Arts & Sciences"],
      "collection": null,          // or e.g. "Hesperides (1648)"
      "note": "",                  // optional short critical "Codex Note"; "" hides the section
      "translator": "trans. ...",  // ONLY for translated works; omit for English originals
      "text": "line\nline\n\nnext stanza" }
  ] }
```

**Stable poem ids:** each poem's `id` is `"<authorSlug>/<n>"`, where `n` is that poem's
plain index within its own poet's `poems[]` array (0, 1, 2, …). It is stable across edits
to *other* poets — appending a poem to a different poet's file never changes anyone
else's id. Appending a poem to the *same* poet's file is safe (new poem gets the next
`n`); inserting one in the middle of an existing poet's array would shift later ids, so
prefer appending. `#/poem/<authorSlug>/<n>` is the URL.

**`data/works/<slug>.json`** (source of truth for one long work, full text):
```json
{ "slug": "iliad-butler", "title": "The Iliad", "subtitle": "...",
  "authorSlug": "homer", "author": "Homer", "year": "1898",
  "type": "Epic poem",                       // see "Epics" below
  "translator": "trans. Samuel Butler (1898)",
  "workGroup": "iliad",                      // shared by all translations of one original
  "note": "", "blurb": "one-sentence description",
  "sections": [ { "title": "Book I", "text": "..." } ] }
```

**`data/index.json`** (generated by `tools/build_index.py` — never hand-edit):
`{ count, poets[] (metadata+counts only), subjects[], poems[] (index entries: id,
title, author, authorSlug, primarySubject, subjects, collection, excerpt, translator —
no full text), works[] (metadata + section titles/stanza counts — no section text),
workCount, legacyIndex[] }`.

### Rules when you change data
- **Workflow:** write or extend `data/poets/<slug>.json` (existing poet: append to its
  `poems[]`, each with the next sequential `id`; new poet: include all fields above plus
  an `order` value in the right chronological gap) or `data/works/<slug>.json` (a full
  work with `sections[].text`). Then run `python tools/build_index.py` to regenerate
  `data/index.json`. Then `python tools/verify_split.py` to confirm nothing broke.
  Then preview locally, commit, push.
- `count`, the `subjects[]` tallies, and each poet's `poemCount`/`workCount` in
  `data/index.json` are all derived by `build_index.py` — never hand-compute or hand-edit
  them, just re-run the script.
- Poets are ordered by their `order` field (chronological by birth), spaced by 10 so a
  new poet can be inserted between two existing ones (e.g. `order: 15` between `10` and
  `20`) without renumbering anyone else.
- Keep each poet/work file's `indent=1` pretty-printing (`json.dump(..., ensure_ascii=False,
  indent=1)`) so diffs stay readable. Do not collapse it to one line.
- `primarySubject` must be one of: Living, Love, Nature, Religion, Death & Dying,
  History & Politics, The Mind, Time & Brevity, Arts & Sciences, Social Commentaries,
  Relationships, Mythology & Folklore.

### Multiple translations of one original
The site supports several translations of the same text. Each is its **own work entry**
with a unique `slug` (`iliad-butler`, `iliad-pope`) but a **shared `workGroup`**
(`"iliad"`), plus a `translator` string. The owner intends to add more Homer
translations over time — preserve this pattern.

### Categories (home page "Browse by Era")
Every poet has a `category`, one of the eight in `CATEGORY_ORDER` in `app.js`:
Ancient Greek & Roman · Anglo-Saxon · Medieval · Tudor & Elizabethan ·
Metaphysical & Cavalier · Romantic · Victorian · American

**If you introduce a new category you MUST also add it to `CATEGORY_ORDER` and
`CATEGORY_SLUGS` in `app.js`**, or poets in it become invisible on the home page.

"**Epics**" is a ninth, cross-cutting home tile. It is *derived*, not stored:
`isEpicWork(w) = /\b(epic|heroic poem)\b/i.test(w.type)`. Set a work's `type` to
"Epic poem" / "Heroic poem" / "Historical epic" to include it.

---

## 4. Routes (all hash-based, in `app.js`)

`#/` home (era tiles) · `#/poems` full archive · `#/poets` · `#/poet/<slug>` ·
`#/poem/<authorSlug>/<n>` · `#/poem/<oldNumericIndex>` (legacy, see below) ·
`#/work/<slug>` (contents) · `#/work/<slug>/<i>` (one section) ·
`#/category/<slug>` · `#/topics` · `#/about`

**Legacy links:** before the September 2026 data-layer split, poem links were a bare
array index into a single `poems[]` array (`#/poem/137`). Those numbers are now frozen
forever in `data/legacy_index.json` / `data/index.json`'s `legacyIndex[]`, mapping each
old index to its new stable id. `app.js` detects the old numeric route
(`#/poem/(\d+)$`), looks it up in `legacyIndex`, and `location.replace()`s to the new
`#/poem/<authorSlug>/<n>` URL — so any old bookmark or external link someone saved still
works. Never reuse or repurpose these numbers; new poems only ever get new stable ids.

**Search limitation:** because `data/index.json` holds only a 3-line excerpt of each poem
(not the full text — that's the whole point of the split), the `#/poems` search box
matches title + author + excerpt + subjects only. It will not find a poem by a word that
appears only later in its body. This is a known, accepted trade-off for load time.

---

## 5. ⚠️ Content rules — the most important part

Everything here is **public domain**, and it must stay that way.

1. **Original texts:** only authors long dead (this archive's newest are early-20th-c.).
   Original-language texts (Middle English, Old English, Elizabethan) are always safe.
2. **Translations are separate copyrighted works.** A 2,800-year-old Greek poem is public
   domain; a 1999 translation of it is not. Only use translations that are **published
   pre-1929** (verify from the source's own front matter / Gutenberg metadata).
   - ✅ Used here: Butler (1898/1900), Pope (1715–20), Gummere (1910), Evelyn-White (1914),
     Riley (1851), Ridley (1896), Southey (1808), Wharton (1885), Gordon (1926),
     Spaeth (1921), Cook & Tinker (1902), Weston (1898), Jewett (1908).
   - ❌ Never use: Heaney, Armitage, Tolkien, Borroff, Fagles, Wilson, Crossley-Holland,
     Alexander, Liuzza, Bradley, or any modern named translator. Also avoid modern
     *critical editions* (e.g. Agnes Latham's 1951 Raleigh) — the editorial layer is
     in copyright even when the poem isn't.
   - **If you cannot verify a translation's date, use the original-language text or skip it.**
3. **Always record the `translator` field** on translated poems/works.
4. **Poems only.** Never ingest as "poems": editors' introductions, footnotes, glossaries,
   textual-variant apparatus, transcriber's notes, publisher pages, tables of contents,
   biographies, letters, prose essays, or stage plays. Several sources bundle plays with
   poems (Shakespeare, Jonson, Marlowe, Greene, Lodge) — take the verse only.
5. **Images:** portraits from Wikipedia/Wikimedia (public domain). For anonymous poets,
   use a *relevant historical artifact* instead of a portrait (Beowulf Poet → Sutton Hoo
   helmet; Gawain Poet → Cotton Nero A.x manuscript; El Cid → the Tizona sword) and say
   so honestly in `credit`. `portrait: null` falls back to a monogram tile — that's fine.

---

## 6. Proven extraction methodology

Sources: **Project Gutenberg** (`https://gutendex.com/books?search=...` to find IDs —
it rate-limits, use 60s timeouts and retry; then
`https://www.gutenberg.org/cache/epub/<id>/pg<id>.txt`) and **EEBO-TCP**
(`https://raw.githubusercontent.com/textcreationpartnership/<TCP-ID>/master/<TCP-ID>.xml`,
catalogue at `textcreationpartnership/Texts/master/TCP.csv`, `Status == "Free"` = public domain).

Hard-won lessons — these bugs all actually happened here:

- Work only between Gutenberg's `*** START OF ...` / `*** END OF ...` markers.
- **Front matter vs. real text:** a book's table of contents lists the same headings that
  later mark the real poems. Find a heading's **second occurrence** to locate where the
  body starts. Verify what follows is verse, not another TOC line.
- **Heading detection:** a title is a short (<70 char) blank-line-bounded line, Title-Case
  or ALL-CAPS, not ending in `,;:`, **containing no internal sentence break** (a line with
  `.`/`!`/`?` followed by a capital is mid-poem text, not a title), not mostly lowercase.
- **Double-spaced sources:** some editions put a blank line between *every* verse line.
  There, 1 blank = line break and 2+ blanks = stanza break. Detect before splitting.
- **Truncation:** some sources print only an epigraph under a title and the body elsewhere
  (this silently broke Wilde's *Ballad of Reading Gaol*, Carroll's *Snark*, and others until
  a QA pass caught it). Sanity-check that famous poems are their expected length.
- **Some sources deliberately abridge** (one Seafarer edition stopped at line 64 of ~124).
- **Duplicates:** overlapping volumes by the same poet produce the same poem twice.
- **Untitled poems** (Dickinson, Rossetti's *Sing-Song*, many riddles): use first-line-as-title.
- **Always spot-check 3–5 extracted poems per source** — does each title actually match the
  text under it? **Publishing garbled data is worse than publishing nothing.** If a source
  resists clean parsing after a couple of honest attempts, skip it and say so.

---

## 7. Workflow

```bash
python dev_server.py                       # local preview at :8777
# ...make changes, verify in the browser...
git add -A
git commit -m "Add X"
git push                                   # this deploys
```

Commit and push **incrementally** (after each poet/work), not in one big batch at the end —
long ingestion jobs get interrupted and uncommitted work is lost. Every content commit
should include the regenerated `data/index.json` alongside the `data/poets/`/`data/works/`
file you changed — run `tools/build_index.py` before committing, every time.

**Do not run two agents against this repo at once.** Concurrent edits to the same poet or
work file, or to `data/index.json`, collide. Finish or stop one before starting another.

---

## 8. Current state & known gaps

**Data layer:** as of September 2026 content lives in `data/poets/*.json` (107 files) and
`data/works/*.json` (39 files), full text included, with `data/index.json` (~4.5 MB) as a
lightweight generated startup index. This replaced the single ~30 MB `poems.json` (which
was approaching GitHub's 50 MB warning threshold and 100 MB hard limit as the archive
grew) — see section 2 and 3 above for the new layout, and `tools/verify_split.py` for the
integrity check that green-lit the migration. `poems.json` itself was deleted from the
working tree after verifying every poem/work byte-for-byte against it; it is still
recoverable from git history at or before commit `b38eab4` if ever needed.

Not yet done, in rough priority order:
- Minor Tudor poets: Henry Lok, Deloney, Howell, Griffin, Barnes, Googe, Turberville
- ~23 obscure Victorian poets (only OCR sources found so far — handle front matter carefully)
- Chaucer's *Troilus and Criseyde*, *House of Fame*, *Legend of Good Women*
- Gawain Poet's *Patience* and *Cleanness*
- Old English: *Descent into Hell*, *Resignation*, *Solomon and Saturn I/II*, and ~60 more
  Exeter Book riddles (only riddles with unambiguous numbering were added — 34 of ~95)
- Oliver Wendell Holmes and Phillis Wheatley (prose/verse interleaving defeated parsing)
- Poet bios are factual placeholders the owner may want to replace with his own text
- Custom domain **poetrycodex.com** is not connected yet (would need the domain purchased,
  a `CNAME` file in this repo, and DNS records pointed at GitHub Pages)
