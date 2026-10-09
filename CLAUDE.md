# Poetry Codex

**Read [`AGENTS.md`](./AGENTS.md) first — it is the full briefing for this project**
(tech stack, data schema, content/copyright rules, extraction methodology,
deploy workflow, current state and known gaps).

`AGENTS.md` is the shared briefing for every AI coding tool used on this repo
(Claude Code, OpenAI Codex, Cursor, etc.). Keep it as the single source of truth —
if you learn something durable about this project, update `AGENTS.md`, not this file.

Quick reminders:
- Static site, no build step. `git push` to `main` **is** the deploy (GitHub Pages).
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
- Never ingest editorial notes, introductions, footnotes or stage plays as "poems".
- Spot-check extracted poems before committing; bad data is worse than no data.
- Bump the `?v=N` cache-buster in `index.html` when changing `app.js` or `styles.css`.
