// poetrycodex-site: serves poetrycodex.com from the R2 bucket that tools/sync_r2.py fills.
//
// The site outgrew GitHub Pages (1.5 GB, 107,000 files; Pages publishes at most 1 GB) and
// Cloudflare Pages (at most 100,000 files and 25 MiB a file), so the published files live in
// R2 and this Worker answers every request the way GitHub Pages did:
//   /                -> index.html
//   /poem/keats/0/   -> poem/keats/0/index.html
//   /poem/keats/0    -> 301 to /poem/keats/0/ (when that folder has an index.html)
//   anything missing -> 404.html with status 404
//   www.poetrycodex.com/... -> 301 to poetrycodex.com/...
// Responses are kept in Cloudflare's edge cache for a few minutes, so most visits never reach
// R2; a publish shows everywhere within CACHE_SECONDS.

const CACHE_SECONDS = 300;          // HTML and data: a new publish is live within 5 minutes
const ASSET_SECONDS = 86400;        // images, and app.js / styles.css (their ?v= changes on edit)
const TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8", txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", pdf: "application/pdf",
  woff2: "font/woff2",
};

function keyFor(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { p = pathname; }
  p = p.replace(/^\/+/, "");
  if (p.split("/").some((seg) => seg === "..")) return null;
  if (p === "" || p.endsWith("/")) p += "index.html";
  return p;
}

function headersFor(key, object) {
  const h = new Headers();
  object.writeHttpMetadata(h);
  const ext = (key.match(/\.([a-z0-9]+)$/i) || [])[1];
  if (ext && TYPES[ext.toLowerCase()]) h.set("content-type", TYPES[ext.toLowerCase()]);
  h.set("etag", object.httpEtag);
  const long = /\.(png|jpe?g|webp|gif|svg|ico|woff2)$/i.test(key) || /^(app\.js|styles\.css)$/.test(key);
  h.set("cache-control", `public, max-age=${long ? ASSET_SECONDS : CACHE_SECONDS}`);
  h.set("x-content-type-options", "nosniff");
  return h;
}

async function serve(env, key, request, status = 200) {
  const object = await env.SITE.get(key, { onlyIf: request.headers });
  if (object === null) return null;
  const headers = headersFor(key, object);
  if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (request.method === "GET" && !request.headers.get("if-none-match")) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
    const key = keyFor(url.pathname);
    let res = key ? await serve(env, key, request) : null;
    if (!res && key && !/\.[a-z0-9]+$/i.test(key)) {
      // A folder asked for without its slash: send the reader to the slashed address,
      // as GitHub Pages did, so relative links inside the page keep working.
      if (await env.SITE.head(key + "/index.html")) {
        url.pathname = url.pathname + "/";
        return Response.redirect(url.toString(), 301);
      }
    }
    if (!res) {
      const nf = await env.SITE.get("404.html");
      res = nf
        ? new Response(request.method === "HEAD" ? null : nf.body, { status: 404, headers: headersFor("404.html", nf) })
        : new Response("Not found", { status: 404 });
      return res;
    }
    if (request.method === "GET" && res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
