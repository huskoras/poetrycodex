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
- `app.js` — the whole app: hash routing + all render functions
- `poems.json` — **all content** (~30 MB)
- `poets/*.jpg` — portrait/illustration images
- `dev_server.py` — local no-cache dev server (`python dev_server.py` → http://localhost:8777)
- `BAŞLAT.bat` — double-click launcher for the owner (starts server + opens browser)

**Deploy:** GitHub Pages serves `main` directly. **Pushing to `main` IS deploying** —
the live site updates ~1 minute after a push. There is no build or deploy step.

**Cache-busting:** `index.html` loads `styles.css?v=N` and `app.js?v=N`. If you change
either file, bump `N` in `index.html` or returning visitors get a stale cached copy.

---

## 3. Data schema (`poems.json`)

Top level: `{ count, poets[], subjects[], poems[], works[], workCount }`

**Poet:**
```json
{ "slug": "keats", "name": "John Keats", "dates": "1795–1821",
  "era": "Romantic", "category": "Romantic",
  "portrait": "poets/keats.jpg",   // or null
  "credit": "Portrait of John Keats by William Hilton (c. 1822) · Public domain (Wikimedia Commons)",
  "bio": ["paragraph 1", "paragraph 2"],
  "poemCount": 3, "workCount": 0 }
```

**Poem** (flat, short-to-medium pieces):
```json
{ "title": "To Autumn", "authorSlug": "keats", "author": "John Keats",
  "primarySubject": "Nature", "subjects": ["Nature"],
  "collection": null,            // or e.g. "Hesperides (1648)"
  "note": "",                    // optional short critical "Codex Note"; "" hides the section
  "translator": "trans. ...",    // ONLY for translated works; omit for English originals
  "text": "line\nline\n\nnext stanza" }
```

**Work** (long texts split into sections):
```json
{ "slug": "iliad-butler", "title": "The Iliad", "subtitle": "...",
  "authorSlug": "homer", "author": "Homer", "year": "1898",
  "type": "Epic poem",                       // see "Epics" below
  "translator": "trans. Samuel Butler (1898)",
  "workGroup": "iliad",                      // shared by all translations of one original
  "note": "", "blurb": "one-sentence description",
  "sections": [ { "title": "Book I", "text": "..." } ] }
```

### Rules when you change data
- After adding/removing poems: recompute `count`, the `subjects[]` tallies, and each
  affected poet's `poemCount` / `workCount`. Do this programmatically, don't hand-edit.
- Poets are ordered **chronologically by birth**; insert new ones in the right position.
- Keep the file's `indent=1` pretty-printing (`json.dump(..., ensure_ascii=False, indent=1)`)
  so diffs stay readable. Do not collapse it to one line.
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
`#/poem/<index>` · `#/work/<slug>` (contents) · `#/work/<slug>/<i>` (one section) ·
`#/category/<slug>` · `#/topics` · `#/about`

Note `#/poem/<index>` is an **array index** into `poems[]`, so reordering the array
changes existing links. Prefer appending/grouping over reshuffling.

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
long ingestion jobs get interrupted and uncommitted work is lost.

**Do not run two agents against this repo at once.** `poems.json` is a single large file;
concurrent edits collide. Finish or stop one before starting another.

---

## 8. Current state & known gaps

**Size warning:** `poems.json` is ~30 MB. GitHub warns above 50 MB and hard-rejects files
over 100 MB. Before the archive grows much further, split it into per-poet or per-era JSON
files loaded on demand, and have `app.js` fetch an index first.

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
