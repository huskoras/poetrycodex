# Poetry Codex — critical engine

A single Cloudflare Worker. It holds the Anthropic API key (a static site cannot)
and streams critical readings back to `poetrycodex.com`.

```
browser  ──POST /api/analyze──►  Worker  ──►  Claude API
         ◄──── SSE text ───────          ◄──
```

## What it does

`POST /api/analyze` with `{ lens, title, author, text }` returns a
`text/event-stream` of `data: {"t":"…"}` lines, ending with `data: [DONE]`.
`GET /health` returns the model and the list of lenses.

Eight critical traditions are available: `formalist`, `historicist`, `feminist`,
`psychoanalytic`, `postcolonial`, `ecocritical`, `marxist`, `reader-response`.

## Guardrails

- **Origin allowlist** — requests from anywhere other than `poetrycodex.com`
  (or `localhost:8777` for development) are refused. Keep `ALLOWED_ORIGINS` in
  `src/index.js` in step with `ENGINE_URL` in `../app.js`.
- **Size caps** — poem text is truncated at 24,000 characters, `max_tokens` is
  capped at 2,000, so no single request can run away with the balance.
- **Prompt caching** — the stable half of the system prompt carries a cache
  breakpoint, so repeat traffic is cheaper.
- The key is only ever an encrypted Worker secret. It is never in this repo,
  never in `wrangler.toml`, and never sent to the browser.

## Deploying

From this directory:

```bash
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

`wrangler deploy` prints the live URL, e.g.
`https://poetrycodex-engine.<your-subdomain>.workers.dev`.

**Then paste that URL into `ENGINE_URL` in `../app.js`**, bump the `?v=` on
`app.js` in `../index.html`, and push. The reading panel renders only when
`ENGINE_URL` is set, so the site is safe to ship before the Worker exists.

Check it with:

```bash
curl https://poetrycodex-engine.<your-subdomain>.workers.dev/health
```

## Cost

One reading is roughly 1,500 input + 600 output tokens on `claude-opus-5-5` —
on the order of a cent. Lower `output_config.effort` from `high` to `medium` in
`src/index.js` to reduce it further.

Before this is linked from the live site, add a rate-limiting rule in the
Cloudflare dashboard (Security → WAF → Rate limiting rules), e.g. 10 requests
per minute per IP on `/api/analyze`. The caps above bound the cost of one
request; the WAF rule bounds how many a single visitor can make.
