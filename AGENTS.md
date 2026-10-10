# Poetry Codex — Agent Briefing

This file is the onboarding document for any AI coding agent working on this repo
(OpenAI Codex reads `AGENTS.md` automatically; Claude Code reads `CLAUDE.md`, which
points here). Read it fully before making changes.

**Live site:** https://poetrycodex.com (GitHub Pages origin behind Cloudflare; the old
address https://huskoras.github.io/poetrycodex/ redirects there)
**Repo:** https://github.com/huskoras/poetrycodex
**AI engine:** https://poetrycodex-engine.poetrycodex.workers.dev (Cloudflare Worker, `worker/`)
**Contact:** admin@poetrycodex.com
**Owner:** a non-technical user. Explain things in plain language, avoid jargon, and
do the technical work yourself rather than handing them instructions to run. He enters
API keys, secrets, payments and dashboard settings himself — never ask him to paste a key.

---

## 1. What this project is

A curated archive of **public-domain poetry** — currently **12,346 poems, 158 poets,
45 multi-section works** (as of 10 Oct 2026), spanning Cædmon (~7th c.) and Homer
(~8th c. BC) through early-20th-century British, American and Turkish poets — plus an
AI reading engine ("Read with the Codex" on every poem, and the Oracle, see §4b).

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
- `tools/build_search_index.py` — regenerates `data/search.json` (the Oracle's
  lookup table) from `data/index.json`. Run it after `build_index.py` on every
  content change, or the Oracle will recommend poems that have moved.
- `tools/build_index.py` — regenerates `data/index.json` from `data/poets/*.json` +
  `data/works/*.json`. Run this after any content edit.
- `tools/verify_split.py` — integrity check. Self-contained (does **not** need the old
  `poems.json`): it verifies the poet/work files and `data/index.json` agree with each
  other — poem counts, sequential unique ids, index stubs matching their source poems,
  `subjects[]` tallies, per-poet `poemCount`/`workCount`, work section titles, that every
  `legacy_index` entry still resolves, that no poem/section text is empty, that every
  non-null `portrait` file exists, and that every poet's `category` is one that actually
  appears in `CATEGORY_ORDER` in `app.js` (so a poet can't silently vanish from the home
  page). Run it after `build_index.py` on every content change; it exits non-zero on error.
- `tools/build_pages.py` — generates the **static HTML pages search engines index**:
  `poem/<slug>/<n>/index.html` (full text + canonical URL), `poet/<slug>/index.html`,
  the sitemap index `sitemap.xml` + `sitemap-1..13.xml`, and the plain poet-link list in
  the home-page footer. `poem/` and `poet/` are generated — never edit them by hand. Run it
  after `build_index.py` on every content change (works-only poets get no poem pages).
- `robots.txt` — allows everything and points to the sitemap. `CNAME` — `poetrycodex.com`.
- `poets/*.jpg` — portrait/illustration images (unrelated to `data/poets/`; note the
  singular/plural difference — this is the images folder, `data/poets/` is poem data).
- `worker/` — the Cloudflare Worker that holds the API key and talks to Claude (§4b).
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

**Domain, DNS, email (set up 8–9 Oct 2026):** `poetrycodex.com` is registered at Namecheap
(renews 10 Sep 2027). DNS is on **Cloudflare** (Free plan; nameservers leo/meiling), SSL
mode **Full**, Always-HTTPS on, HSTS 6 months (no subdomains, no preload), DNSSEC off. The
site's A/www records are proxied (orange); the mail records are DNS-only (grey) — making
them orange breaks mail. Mail is Namecheap Private Email (`admin@poetrycodex.com`). A full
record list is kept outside the repo in `../poetrycodex-notlar/poetrycodex-dns-yedek.txt`.

**Search engines:** Google Search Console is verified for the domain; the home page is
indexed. The sitemap kept showing "Couldn't fetch" in Search Console (Oct 2026) even though
every sitemap file returns 200 to Googlebot — hence the footer poet links as a second
crawl path. If this recurs, check Cloudflare → Security → Events for blocked Googlebot.

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
Every poet has a `category`, one of the eleven in `CATEGORY_ORDER` in `app.js`:
Ancient Greek & Roman · Anglo-Saxon · Medieval · Tudor & Elizabethan ·
Metaphysical & Cavalier · Restoration & Augustan · Romantic · Victorian · American ·
Modern · Turkish & Ottoman

**If you introduce a new category you MUST also add it to `CATEGORY_ORDER` and
`CATEGORY_SLUGS` in `app.js`**, or poets in it become invisible on the home page.

"**Epics**" is a ninth, cross-cutting home tile. It is *derived*, not stored:
`isEpicWork(w) = /\b(epic|heroic poem)\b/i.test(w.type)`. Set a work's `type` to
"Epic poem" / "Heroic poem" / "Historical epic" to include it.

---

## 4. Routes (all hash-based, in `app.js`)

`#/` home (two "doors": Archive → `#/eras`, Oracle → `#/oracle`, plus era tiles) ·
`#/eras` · `#/poems` full archive (topic filters live here) · `#/poets` · `#/poet/<slug>` ·
`#/poem/<authorSlug>/<n>` · `#/poem/<oldNumericIndex>` (legacy, see below) ·
`#/work/<slug>` (contents) · `#/work/<slug>/<i>` (one section) ·
`#/category/<slug>` · `#/oracle` · `#/about`

Nav: Poems · Poets · Eras · The Oracle · About. The pre-redesign layout is tagged
`design-before-v2` in git if a rollback is ever wanted.

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

## 4b. The critical engine (`worker/`)

Live at `https://poetrycodex-engine.poetrycodex.workers.dev`, wired into
`ENGINE_URL` in `app.js`. A Cloudflare Worker: the static site cannot hold an
API key, so every Claude call goes through it.

- `POST /api/analyze` — a reading of a poem through one of eight critical
  traditions (formalist, historicist, feminist, psychoanalytic, postcolonial,
  ecocritical, marxist, reader-response).
- `POST /api/ask` — an answer to the reader's own question about that poem.
- `POST /api/compare` — a reading of two poems against each other.
- `POST /api/gloss` — Old/Middle English rendered line by line into modern
  English, plus a short note on the hard words. Long texts are cut at a line
  break and only the opening is glossed.
- `POST /api/oracle` — open conversation about the archive (the `#/oracle`
  page). The model cannot see the archive, so its prompt carries a catalogue of
  poets and works built from `index.json`, and it finds individual poems with a
  `search_archive` tool backed by `data/search.json`. **It is forbidden to name
  a poem the tool has not returned** — that rule is what keeps recommendations
  real, so do not loosen it. Carrying all 12,000+ titles in the prompt instead
  would cost about $0.65 per request.
- **The Oracle is currently PAUSED** (owner's decision, 8 Oct 2026, to stop API
  spending). Two switches, both off: `ORACLE_LIVE = false` in `app.js` and
  `ORACLE_ENABLED = "false"` under `[vars]` in `worker/wrangler.toml` (the route then
  answers 503 "The Oracle is resting"). The page, nav link and home door stay up and
  read "Resting". To re-enable: flip both, bump the cache-buster, redeploy the Worker.
  The per-poem panel (analyze/ask/compare/gloss) is **still live** and still spends.
- **Costs, measured 8 Oct 2026 on Opus:** Oracle ≈ $0.066 per question, lens reading
  ≈ $0.038, poem question ≈ $0.022, compare ≈ $0.04, gloss ≈ $0.05. Finished lens
  readings are cached in the KV namespace bound as `READINGS` (key = hash of poem +
  lens), so each is paid for once; free-text questions and truncated outputs are not
  cached. Never pre-generate readings for the whole archive (≈ $3,500) — on demand only.
- All five stream `data: {"t": "..."}` SSE lines, terminated by `[DONE]`;
  `/api/oracle` also sends `{"searching": "..."}` as it looks things up.

The panel renders on poem pages and on work sections (`renderDetailReady` and
`renderWorkSectionReady` in `app.js`). The **Modern English** button appears
only where `looksArchaic()` fires: a vocabulary of words that died out before
the 17th century, at 5+ hits per 1000 words, or a thorn/eth/ash character.
Measured over this archive, Middle English scores 9–59 and early modern verse
0–1.6, so Chaucer and Langland get the button and Shakespeare and Spenser do
not. Re-run `tools/`-style calibration before moving that threshold.

Model `claude-opus-5-5`. Guardrails: origin allowlist, six requests per minute
per IP (`ANALYZE_LIMITER`) plus three per minute for the Oracle (`ORACLE_LIMITER`),
24,000-character text cap, output caps of 4,000 tokens (8,000 for gloss, 1,100 for
the Oracle), and a cache breakpoint on the stable half of the system prompt.

**The owner wants to co-write the Oracle's persona and every prompt himself.** The
prompts live in `worker/src/index.js` (`SYSTEM_ORACLE`, `SYSTEM_STABLE`, `SYSTEM_ASK`,
`SYSTEM_COMPARE`, `SYSTEM_GLOSS`, the eight `LENSES`); a readable export is kept in
`../poetrycodex-notlar/poetrycodex-promptlar.md`. Do not rewrite a prompt's voice
without him.

**The honesty rule is load-bearing.** All the system prompts forbid invented
quotations, dates, editions and attributed scholarly views. The engine may name
a critical tradition; it may not put a claim in a named scholar's mouth. Do not
relax this — fabricated citation would discredit the project with the
academic collaborators it is being built with. Real citation waits for the
retrieval layer over public-domain criticism and open-access scholarship.

Deploying: `cd worker && npx wrangler deploy`. The API key is an encrypted
Worker secret, never in this repo. See `worker/README.md`.

## 5. ⚠️ Content rules — the most important part

Everything here is **public domain**, and it must stay that way.

1. **Original texts:** only authors long dead (this archive's newest are early-20th-c.).
   Original-language texts (Middle English, Old English, Elizabethan) are always safe.
2. **Translations are separate copyrighted works.** A 2,800-year-old Greek poem is public
   domain; a 1999 translation of it is not. Only use translations that are **published
   pre-1929** (verify from the source's own front matter / Gutenberg metadata).
   - ✅ Used here: Butler (1898/1900), Pope (1715–20), Gummere (1910), Evelyn-White (1914),
     Riley (1851), Ridley (1896), Southey (1808), Wharton (1885), Gordon (1926),
     Spaeth (1921), Cook & Tinker (1902), Weston (1898), Jewett (1908),
     E. J. W. Gibb (1882/1900–09, Ottoman verse — OCR, not yet checked against print),
     Chodzko (1842, Köroğlu).
   - ❌ Never use: Heaney, Armitage, Tolkien, Borroff, Fagles, Wilson, Crossley-Holland,
     Alexander, Liuzza, Bradley, or any modern named translator. Also avoid modern
     *critical editions* (e.g. Agnes Latham's 1951 Raleigh) — the editorial layer is
     in copyright even when the poem isn't.
   - **If you cannot verify a translation's date, use the original-language text or skip it.**
3. **Always record the `translator` field** on translated poems/works.
3a. **Twentieth-century English-language poets** are allowed only if the book was
   **published before 1931 AND the poet died before 1956** (safe under both US and
   life+70 rules). Yeats, Lawrence etc.: pre-1929/pre-1923 books only. Excluded by this
   rule: Masefield, Sassoon, Graves, de la Mare, T. S. Eliot, Sitwell and anyone later.
3b. **Turkish & Ottoman ("Option 2", owner's decision 10 Oct 2026, replacing Option 1):**
   Turkish originals are allowed if **the author died before 1956** (more than 70 years
   ago — public domain in Turkey under FSEK art. 27); add a short English note. The
   publication year is no longer a bar: the owner was told that post-1930 publications
   stay technically protected in the US until 95 years after publication, and accepted
   that for Turkish originals. Ottoman classics may come through Gibb's translations.
   Explicitly wanted: the complete poems of Rüştü Onur (d. 1942) and Muzaffer Tayyip
   Uslu (d. 1946). Newly admissible: Orhan Veli (d. 1950), Sabahattin Ali (d. 1948),
   Kemalettin Kamu (d. 1948), Ömer Bedrettin Uşaklı (d. 1946), Neyzen Tevfik (d. 1953).
   **Refused and to stay refused:** Nazım Hikmet (d. 1963 — protected in Turkey until
   2034), Orhan Kemal (d. 1970), Dağlarca, Oktay Rifat, Melih Cevdet, Yahya Kemal (d. 1958),
   Cahit Sıtkı (d. 1956) and anyone who died in or after 1956. Do **not** scrape poetry
   websites; use Wikisource, scanned editions, or Gutenberg/Internet Archive with a
   visible publication date. 47 OCR-garbled candidates were rejected on quality in Oct
   2026 — do not re-add them unverified.
3c. **Other languages (Italian, French, Arabic, Nordic, …):** the original must be public
   domain **and** the English translation published before 1929; the translation is what
   the site shows, with `translator` set. Prefer sources where the original is also
   available in clean text.
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
- **Edit JSON surgically.** Loading a poet file and `json.dump`-ing it back rewrites and
  reflows the whole file, producing an unreadable diff and hiding mistakes. Append or
  patch only the lines you mean to change.
- **Prose that is really verse:** R. K. Gordon's 1926 Exeter riddles are printed as prose
  paragraphs — that is the edition, not truncation. Check the source before "fixing" it.

---

## 7. Workflow

```bash
python dev_server.py                       # local preview at :8777
# ...edit data/poets/<slug>.json or data/works/<slug>.json, verify in the browser...
python tools/build_index.py                # regenerates data/index.json
python tools/build_search_index.py         # regenerates data/search.json (Oracle lookup)
python tools/verify_split.py               # must print ALL CHECKS PASSED
python tools/build_pages.py                # regenerates poem/, poet/, sitemap*.xml, footer links
git add data/poets/<slug>.json data/index.json data/search.json poem poet sitemap*.xml index.html
git commit -m "Add X"
git push                                   # this deploys
```

Commit and push **incrementally** (after each poet/work), not in one big batch at the end —
long ingestion jobs get interrupted and uncommitted work is lost. Every content commit
should include the regenerated `data/index.json`, `data/search.json` and the static pages
alongside the `data/poets/`/`data/works/` file you changed. Stage the files you changed by
name rather than `git add -A`, so stray scratch files never reach the repo.

Worker changes: `cd worker && npx wrangler deploy` (wrangler is OAuth-logged-in on the
owner's PC; the API key is an encrypted Worker secret, never in this repo).

**Shared-file rule.** Several ingesters may write *different* new poet/work files at the
same time, but only **one** process may ever regenerate `data/index.json` /
`data/search.json` / `poem/` / `poet/` / `sitemap*.xml`, edit `app.js` or `index.html`, or
commit and push — the publisher, and only after every ingester has finished. Never run
two publishers, and never run a publisher while an ingester is still writing.

---

## 7b. The editorial team (`.claude/agents/`)

Since 10 Oct 2026 the archive is grown by a team of Claude Code agents, defined in
`.claude/agents/*.md` (each file is the agent's standing brief; edit the file to change
the agent). The owner has given the editor full authority to publish; he reviews the live
site afterwards and asks for changes.

| Agent | Model | Job |
|---|---|---|
| `william-hazlitt` | Fable 5.1 | Editor-in-chief. Decides what enters, creates categories, writes ingestion instructions, spot-checks every file against its source, passes/fixes/rejects. Writes no data himself. |
| `marlowe` | Fable 5.1 | English-literature scout. Audits the archive against the canon, finds missing poets/works/famous poems, sources clean texts. |
| `scout-turkish` | Haiku | Turkish & Ottoman scout (Option 2 rule above). |
| `scout-italian`, `scout-french`, `scout-arabic`, `scout-nordic` | Haiku | Per-language scouts: public-domain originals with pre-1929 English translations. |
| `poem-ingester` | Sonnet | Turns one approved poet/work into `data/poets/<slug>.json` (+ `data/works/`, portrait). Writes only its own files; never builds, never commits. |
| `publisher` | Sonnet | Runs alone after a batch passes: removes rejected files, registers new categories in `app.js`, runs the build/verify chain, commits one poet per commit, pushes, confirms the live site. |
| `site-improver` | Opus | Studies the site as a product and writes prioritised proposals (in Turkish) for the owner. Read-only. |

A round = scouts (parallel) → Hazlitt decides → ingesters (parallel, own files) → Hazlitt
checks each file, one fix round → publisher. Rounds repeat until the scouts run dry. Reports
and backlogs from each run are kept outside the repo in `../poetrycodex-notlar/`.

---

## 8. Current state & known gaps

**Data layer:** content lives in `data/poets/*.json` (158 files) and `data/works/*.json`
(45 files), full text included, with `data/index.json` (~5 MB) as a lightweight generated
startup index. Eight poets exist only through works and have no flat poems (cynewulf, homer,
ovid, lucan, beowulf-poet, el-cid-poet, langland, gawain-poet), which is why there are 150
static poet pages for 158 poets. This replaced the single ~30 MB `poems.json` (which
was approaching GitHub's 50 MB warning threshold and 100 MB hard limit as the archive
grew) — see section 2 and 3 above for the new layout, and `tools/verify_split.py` for the
integrity check that green-lit the migration. `poems.json` itself was deleted from the
working tree after verifying every poem/work byte-for-byte against it; it is still
recoverable from git history at or before commit `b38eab4` if ever needed.

**Done in October 2026:** custom domain + Cloudflare + HTTPS/HSTS; company email; the
Worker engine and the Oracle (paused); redesigned two-door home page; favicons/manifest/share
tags; static pages + sitemap + robots.txt; 58 Medieval short poems; the remaining Romantics
(Hunt, Hemans, Charlotte Smith, Beddoes); the **Modern** category (Owen, Brooke, Rosenberg,
Edward Thomas, Mew, Gurney, Yeats, Chesterton, Belloc, Lawrence, W. H. Davies, Binyon,
Ledwidge, McCrae); twelve more 18th-century poets; Phillis Wheatley (American); the
**Turkish & Ottoman** category (Yunus Emre, Fuzuli, Nedim, Şeyh Galip via Gibb; Köroğlu via
Chodzko; Ahmet Haşim and Mehmet Emin Yurdakul in Turkish).

Not yet done, in rough priority order:
- Owner decisions pending: whether the per-poem AI panel stays live (and Opus vs Sonnet);
  a monthly spend limit in the Anthropic Console; co-writing the Oracle persona.
- Turkish: ~125 more Köroğlu songs in Chodzko; Tevfik Fikret, Mehmet Akif, Ziya Gökalp
  book by book from pre-1931 editions; Karacaoğlan (3 songs in an 1842 book, attribution
  unverified). Spot-check the Gibb OCR against a printed copy.
- Minor Tudor poets: Henry Lok, Deloney, Howell, Griffin, Barnes, Googe, Turberville, Lyly, Dyer
- 18th c.: James Thomson (no clean source), Lady Mary Wortley Montagu, Mary Leapor (corrupt
  source), Gay's *Beggar's Opera* songs, Smart's *Jubilate Agno*
- ~20 obscure Victorian poets (only OCR sources found so far) and Hopkins (his mature poems
  are embedded in Bridges' 1918 editorial notes — needs per-poem work)
- Chaucer's *Troilus and Criseyde*, *House of Fame*, *Legend of Good Women*
- Gawain Poet's *Patience* and *Cleanness*
- Old English: *Descent into Hell*, *Resignation*, *Solomon and Saturn I/II*, and ~60 more
  Exeter Book riddles (only riddles with unambiguous numbering were added — 34 of ~95)
- William Browne (EEBO parser drops `<l>` lines inside `<sp>` speaker blocks — fix first)
- Oliver Wendell Holmes (prose/verse interleaving defeated parsing)
- Known defects: Arnold lacks "Dover Beach"; a Tennyson poem titled "Miscellaneous" should
  be "Tithonus"; Browning has ~40 bare Roman-numeral titles; Newbolt's 118 rebuilt poems
  deserve a human skim
- Codex Notes exist on 1,220 poems; imported poems stay blank by the owner's choice. A
  Batch-API + human-review pass is planned, not started.
- Poet bios are factual placeholders the owner may want to replace with his own text
- Later, at scale (~30k poems): replace the 5 MB `index.json` with a small cover file plus
  Worker-side listing/search; a citation layer over open-access criticism.
