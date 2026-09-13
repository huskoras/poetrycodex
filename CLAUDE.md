# Poetry Codex

**Read [`AGENTS.md`](./AGENTS.md) first — it is the full briefing for this project**
(tech stack, `poems.json` schema, content/copyright rules, extraction methodology,
deploy workflow, current state and known gaps).

`AGENTS.md` is the shared briefing for every AI coding tool used on this repo
(Claude Code, OpenAI Codex, Cursor, etc.). Keep it as the single source of truth —
if you learn something durable about this project, update `AGENTS.md`, not this file.

Quick reminders:
- Static site, no build step. `git push` to `main` **is** the deploy (GitHub Pages).
- All content lives in `poems.json` (~30 MB). Recompute `count`, `subjects[]`,
  and per-poet `poemCount`/`workCount` after any content change.
- Public domain only. Translations must be pre-1929 — record the `translator` field.
- Never ingest editorial notes, introductions, footnotes or stage plays as "poems".
- Spot-check extracted poems before committing; bad data is worse than no data.
- Bump the `?v=N` cache-buster in `index.html` when changing `app.js` or `styles.css`.
