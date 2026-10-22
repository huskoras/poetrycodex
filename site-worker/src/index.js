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
//   /api/...         -> reader accounts (src/accounts.js), from the D1 database
// Responses are kept in Cloudflare's edge cache, so most visits never reach R2; a publish shows
// everywhere within CACHE_SECONDS (EDGE_PAGE_SECONDS for the poem, poet and work pages).
//
// Cost (22 Oct 2026): R2 bills every read (Class B) past 10 million a month, and crawlers
// reading 100,000+ pages made most of them. So: the edge keeps the static pages a day; a
// revisit that asks "changed since?" is answered from the edge copy; misses (404) are kept
// an hour; query strings do not split the cache; SEO-tool scrapers are refused before R2.

import { handleApi } from "./accounts.js";

const CACHE_SECONDS = 300;          // HTML and data: a new publish is live within 5 minutes
const ASSET_SECONDS = 86400;        // images, fonts, and app.js / styles.css asked for without ?v=
const EDGE_PAGE_SECONDS = 86400;    // poem/, poet/, work/ ... pages at the edge (browsers still get CACHE_SECONDS)
const NOT_FOUND_SECONDS = 3600;     // a 404 at the edge, so probes for missing files do not read R2 again
const VERSIONED_SECONDS = 31536000; // app.js?v=N / styles.css?v=N: a year, immutable (index.html bumps N on
                                    // every edit, and scripts/publish.sh refuses a publish that forgets to)
const TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8", txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", pdf: "application/pdf",
  woff2: "font/woff2",
};

// Crawlers of SEO tools and bulk scrapers: no use to readers or search, many thousands of reads.
const REFUSED_BOTS = /AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|DataForSeoBot|BLEXBot|MegaIndex|serpstatbot|Barkrowler|Bytespider|ImagesiftBot|SeekportBot|Seekport|ZoominfoBot|Timpibot|omgili|Scrapy|python-requests|Go-http-client|AwarioBot|magpie-crawler/i;
const PAGE_DIRS = /^\/(poem|poet|work|guide|blog|eras|poets|privacy|terms)\//;

function keyFor(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (e) { p = pathname; }
  p = p.replace(/^\/+/, "");
  if (p.split("/").some((seg) => seg === "..")) return null;
  if (p === "" || p.endsWith("/")) p += "index.html";
  return p;
}

function headersFor(key, object, url) {
  const h = new Headers();
  object.writeHttpMetadata(h);
  const ext = (key.match(/\.([a-z0-9]+)$/i) || [])[1];
  if (ext && TYPES[ext.toLowerCase()]) h.set("content-type", TYPES[ext.toLowerCase()]);
  h.set("etag", object.httpEtag);
  // Cloudflare strips the ETag from HTML on the way out; Last-Modified survives, so a browser
  // asking again (If-Modified-Since) gets a 304 instead of the whole page.
  if (object.uploaded) h.set("last-modified", object.uploaded.toUTCString());
  const versioned = /^(app\.js|styles\.css)$/.test(key) && url && url.searchParams.has("v");
  const long = /\.(png|jpe?g|webp|gif|svg|ico|woff2)$/i.test(key) || /^(app\.js|styles\.css)$/.test(key);
  const page = url && PAGE_DIRS.test(url.pathname);
  h.set("cache-control", versioned ? `public, max-age=${VERSIONED_SECONDS}, immutable`
    : long ? `public, max-age=${ASSET_SECONDS}`
    : page ? `public, max-age=${CACHE_SECONDS}, s-maxage=${EDGE_PAGE_SECONDS}`
    : `public, max-age=${CACHE_SECONDS}`);
  h.set("x-content-type-options", "nosniff");
  return h;
}

async function serve(env, key, request, url, status = 200) {
  const object = await env.SITE.get(key, { onlyIf: request.headers });
  if (object === null) return null;
  const headers = headersFor(key, object, url);
  if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });
  // If-Modified-Since is to the second, R2's upload time to the millisecond: should R2 hand
  // back the body of a file not changed since that second, answer 304 here all the same.
  const ims = !request.headers.get("if-none-match") && Date.parse(request.headers.get("if-modified-since") || "");
  if (ims && object.uploaded && Math.floor(object.uploaded.getTime() / 1000) * 1000 <= ims) {
    try { object.body.cancel(); } catch (e) { /* nothing to release */ }
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    // Reader accounts (src/accounts.js): never cached, never served from R2.
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (e) {
        return new Response(JSON.stringify({ error: "server error" }), { status: 500,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    if (REFUSED_BOTS.test(request.headers.get("user-agent") || "")) {
      return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
    }
    const cache = caches.default;
    // The query string does not choose the file (only ?v= on app.js / styles.css matters), so
    // ?utm_... and the like must not make a fresh edge copy and a fresh R2 read.
    const ckUrl = new URL(url.toString());
    const v = ckUrl.searchParams.get("v");
    ckUrl.search = v && /^\/(app\.js|styles\.css)$/.test(ckUrl.pathname) ? `?v=${encodeURIComponent(v)}` : "";
    const cacheKey = new Request(ckUrl.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) {
      // A revisit asking "changed since?" (crawlers mostly) is answered from the edge copy:
      // 304 when the copy is no newer than the reader's, else the copy in full.
      const ims = Date.parse(request.headers.get("if-modified-since") || "");
      const lm = Date.parse(hit.headers.get("last-modified") || "");
      const inm = request.headers.get("if-none-match");
      const et = hit.headers.get("etag");
      if ((inm && et && inm === et) || (!inm && ims && lm && lm <= ims)) {
        return new Response(null, { status: 304, headers: hit.headers });
      }
      if (hit.status === 404 || request.method === "HEAD") {
        return new Response(request.method === "HEAD" ? null : hit.body, { status: hit.status, headers: hit.headers });
      }
      return hit;
    }
    const key = keyFor(url.pathname);
    let res = key ? await serve(env, key, request, url) : null;
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
      const h = nf ? headersFor("404.html", nf, url) : new Headers({ "content-type": "text/plain; charset=utf-8" });
      h.set("cache-control", `public, max-age=${CACHE_SECONDS}, s-maxage=${NOT_FOUND_SECONDS}`);
      h.delete("last-modified");
      res = new Response(nf ? nf.body : "Not found", { status: 404, headers: h });
      if (request.method === "GET") ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return request.method === "HEAD" ? new Response(null, { status: 404, headers: h }) : res;
    }
    if (request.method === "GET" && res.status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    // A conditional miss or a HEAD answered by R2 (304, or no body) is not kept; the next plain
    // GET fills the edge copy.
    return res;
  },
};
