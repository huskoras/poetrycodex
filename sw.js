// Poetry Codex service worker: a returning reader's browser opens the site from what it
// kept last time, then refreshes it quietly in the background.
//
//   pages (HTML)             network first; the kept copy if the network is slow (3 s) or down
//   app.js, styles.css (?v=) kept until the ?v= number changes (index.html bumps it)
//   data/*.json, images      the kept copy at once, refreshed in the background
//                            (stale-while-revalidate): the 32 MB index comes from the
//                            reader's own disk, and the next visit has the newer one
//   Google Fonts             kept, refreshed in the background
//   anything else (the Oracle's POSTs, other sites)   not touched
//
// Raise VERSION to throw every kept copy away (a broken file cached by mistake).
const VERSION = "pc-1";
const SHELL = ["./", "index.html", "data/home.json", "coin-68.webp", "archive-248.webp", "oracle-248.webp"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function fromNetwork(req) {
  return fetch(req).then((res) => {
    if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
}

function staleWhileRevalidate(req) {
  return caches.match(req).then((hit) => {
    const fresh = fromNetwork(req).catch(() => hit);
    return hit || fresh;
  });
}

function networkFirst(req) {
  return new Promise((resolve) => {
    let done = false;
    const fallback = () => caches.match(req).then((hit) => hit || caches.match("index.html"));
    const timer = setTimeout(() => {
      fallback().then((hit) => { if (hit && !done) { done = true; resolve(hit); } });
    }, 3000);
    fromNetwork(req).then((res) => {
      clearTimeout(timer);
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fallback().then((hit) => { if (!done) { done = true; resolve(hit || Response.error()); } });
    });
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (url.origin !== self.location.origin && !fonts) return;
  if (fonts) { e.respondWith(staleWhileRevalidate(req)); return; }
  if (req.mode === "navigate") { e.respondWith(networkFirst(req)); return; }
  if (/\.(js|css)$/.test(url.pathname) && url.search) {          // versioned app.js?v=N, styles.css?v=N
    e.respondWith(caches.match(req).then((hit) => hit || fromNetwork(req)));
    return;
  }
  if (/^\/(data|poets)\//.test(url.pathname) || /\.(webp|png|jpg|ico|json)$/.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req));
  }
});
