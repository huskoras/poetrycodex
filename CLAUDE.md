# Poetry Codex

**Read [`AGENTS.md`](./AGENTS.md) first — it is the full briefing for this project**
(tech stack, data schema, content/copyright rules, extraction methodology,
deploy workflow, current state and known gaps).

`AGENTS.md` is the shared briefing for every AI coding tool used on this repo
(Claude Code, OpenAI Codex, Cursor, etc.). Keep it as the single source of truth —
if you learn something durable about this project, update `AGENTS.md`, not this file.

Quick reminders:
- Static site, no build step. Since 15 Oct 2026 it is served from Cloudflare R2 by
  `site-worker/`: publish = commit, `git push` (GitHub stays the master copy), then
  `python tools/sync_r2.py` (uploads the committed site to R2). See AGENTS.md "Deploy".
- Content lives in `data/poets/<slug>.json` + `data/works/<slug>.json` (full text).
  `data/index.json` is a generated startup index — after any content edit, run
  `python tools/build_index.py` (recomputes `count`, `subjects[]`, per-poet
  `poemCount`/`workCount`), then `python tools/build_search_index.py`, then
  `python tools/verify_split.py`, then commit the edited poet/work file together
  with the regenerated `data/index.json` and `data/search.json`.
- Then run `python tools/build_pages.py` — it regenerates the static poem and poet
  pages (`poem/`, `poet/`) and `sitemap.xml` that search engines index. Those
  folders are generated: never edit them by hand.
- Public domain only. Translations must be pre-1929 — record the `translator` field.
- Never ingest editorial notes, introductions, footnotes or stage plays as "poems". Exception (owner's ruling, 17 Oct 2026): a verse play or poetic prose work in the poetry tradition (e.g. Shakespeare's history plays, Blake's Marriage of Heaven and Hell) may come in as a WORK when an editor's item explicitly assigns it; never on an ingester's own initiative. Novels, history and ordinary prose stay out. Second exception (owner's ruling, 20 Oct 2026): the ANCIENT SOURCES of Greece and Rome (and the ancient Near East) come in whole, whether verse or prose: drama, history, biography, philosophy, oratory and letters (e.g. Herodotus, Thucydides, Plutarch, Livy, Tacitus, Plato, Aristophanes, Plautus), each as a WORK in a pre-1931 English translation with a named translator, when an editor's item assigns it.
- Spot-check extracted poems before committing; bad data is worse than no data.
- Bump the `?v=N` cache-buster in `index.html` when changing `app.js` or `styles.css`.
