// Reader accounts: "Continue with Google", and the reader's shelf, notes and reading places
// kept in the D1 database so they follow the reader to every device.
//
//   GET    /api/config        -> {googleClientId}            (public; the page needs it)
//   POST   /api/auth/google   {credential} -> sets the session cookie, returns /api/me
//   GET    /api/me            -> {signedIn, name, email, data: {key: {value, updated}}}
//   PUT    /api/data          {key: value, ...} -> {updated: {key: ms}}
//   POST   /api/auth/logout   -> ends this session
//   DELETE /api/account       -> deletes the reader, their sessions and all their data
//
// Sign-in uses Google Identity Services: the page receives a Google-signed ID token (a JWT)
// and sends it here; we check Google's signature (RS256, keys from Google's JWKS), the
// audience (our client id), the issuer and the expiry. No Google password, secret or access
// token ever passes through the site, and no client secret is needed.
// The session is a random 32-byte token in an HttpOnly, Secure, SameSite=Lax cookie; only
// its SHA-256 is stored. Every request that changes something must come from the site's own
// origin (Origin header) with a JSON body, which stops other sites acting for a reader.

const SESSION_DAYS = 180;
const COOKIE = "pc_session";
const KEYS = new Set(["shelf", "notes", "reading", "parallel", "marks", "readings"]);
const MAX_VALUE = 400 * 1024;          // bytes of JSON per kind (5,000-character notes: ~80 of them)
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

const enc = new TextEncoder();

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }, extra),
  });
}
const fail = (status, error) => json({ error }, status);

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJSON = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Google's signing keys, kept for as long as Google says (Cache-Control max-age).
let JWKS_MEMO = { keys: null, until: 0 };
async function googleKeys() {
  if (JWKS_MEMO.keys && Date.now() < JWKS_MEMO.until) return JWKS_MEMO.keys;
  const res = await fetch(GOOGLE_JWKS, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error("jwks " + res.status);
  const body = await res.json();
  const age = +((res.headers.get("cache-control") || "").match(/max-age=(\d+)/) || [])[1] || 3600;
  JWKS_MEMO = { keys: body.keys || [], until: Date.now() + Math.min(age, 86400) * 1000 };
  return JWKS_MEMO.keys;
}

// The claims of a valid Google ID token for clientId, or null. getKeys: () => [jwk].
export async function verifyGoogleToken(token, clientId, getKeys = googleKeys, now = Date.now()) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = b64urlJSON(parts[0]); claims = b64urlJSON(parts[1]); } catch (e) { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;
  const jwk = (await getKeys()).find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const sec = Math.floor(now / 1000);
  if (!ISSUERS.has(claims.iss)) return null;
  if (claims.aud !== clientId) return null;
  if (!(claims.exp > sec - 60) || (claims.iat && claims.iat > sec + 300)) return null;
  if (!claims.sub || !claims.email || claims.email_verified === false) return null;
  return claims;
}

function cookieToken(request) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([A-Za-z0-9_-]{20,})"));
  return m ? m[1] : null;
}
function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return token
    ? `${COOKIE}=${token}; Path=/api; HttpOnly${secure}; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
    : `${COOKIE}=; Path=/api; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}

async function currentReader(env, request) {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT r.id, r.email, r.name, s.token_hash FROM sessions s JOIN readers r ON r.id = s.reader_id
     WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256hex(token), Date.now()).first();
  return row || null;
}

async function readerData(env, id) {
  const { results } = await env.DB.prepare("SELECT key, value, updated_at FROM reader_data WHERE reader_id = ?").bind(id).all();
  const data = {};
  for (const r of results || []) {
    try { data[r.key] = { value: JSON.parse(r.value), updated: r.updated_at }; } catch (e) { /* skip a bad row */ }
  }
  return data;
}

// Requests that change something: our own origin only, JSON only.
function sameSite(request, env) {
  const origin = request.headers.get("origin");
  const allowed = (env.SITE_ORIGINS || "https://poetrycodex.com").split(",").map((s) => s.trim());
  return !!origin && allowed.includes(origin);
}

async function bodyJSON(request, limit) {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return null;
  const text = await request.text();
  if (text.length > limit) return undefined;
  try { return JSON.parse(text); } catch (e) { return null; }
}

export async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  if (!env.DB) return fail(503, "accounts are not set up");

  if (path === "/api/config" && method === "GET") {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || "" }, 200, { "cache-control": "public, max-age=300" });
  }
  if (method !== "GET" && !sameSite(request, env)) return fail(403, "wrong origin");

  if (path === "/api/auth/google" && method === "POST") {
    if (!env.GOOGLE_CLIENT_ID) return fail(503, "sign-in is not configured");
    const body = await bodyJSON(request, 8192);
    if (!body || typeof body.credential !== "string") return fail(400, "credential missing");
    let claims = null;
    try {
      // Local tests only: they sign their own tokens with a throwaway key (DEV_JWKS, set in
      // site-worker/.dev.vars, never deployed) for the test client id. The real client id never
      // starts with "test-client.", so on the real site Google's keys are always the ones used.
      const local = !!env.DEV_JWKS && env.GOOGLE_CLIENT_ID.startsWith("test-client.");
      claims = await verifyGoogleToken(body.credential, env.GOOGLE_CLIENT_ID,
        local ? async () => JSON.parse(env.DEV_JWKS).keys : googleKeys);
    } catch (e) { return fail(502, "could not check the sign-in with Google"); }
    if (!claims) return fail(401, "sign-in was not accepted");
    const now = Date.now();
    const name = String(claims.name || claims.given_name || "").slice(0, 200);
    const email = String(claims.email).slice(0, 320);
    const reader = await env.DB.prepare(
      `INSERT INTO readers (google_sub, email, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, last_seen = excluded.last_seen
       RETURNING id, email, name`).bind(String(claims.sub), email, name, now, now).first();
    const token = randomToken();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("INSERT INTO sessions (token_hash, reader_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256hex(token), reader.id, now, now + SESSION_DAYS * 86400000),
    ]);
    return json({ signedIn: true, name: reader.name, email: reader.email, data: await readerData(env, reader.id) },
      200, { "set-cookie": sessionCookie(token, request) });
  }

  const reader = await currentReader(env, request);

  if (path === "/api/me" && method === "GET") {
    if (!reader) return json({ signedIn: false });
    return json({ signedIn: true, name: reader.name, email: reader.email, data: await readerData(env, reader.id) });
  }
  if (!reader) return fail(401, "not signed in");

  if (path === "/api/data" && method === "PUT") {
    const body = await bodyJSON(request, KEYS.size * MAX_VALUE + 1024);
    if (body === undefined) return fail(413, "too large");
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad body");
    const now = Date.now();
    const writes = [], updated = {};
    for (const [key, value] of Object.entries(body)) {
      if (!KEYS.has(key)) return fail(400, "unknown key " + key);
      const text = JSON.stringify(value);
      if (text.length > MAX_VALUE) return fail(413, key + " is too large");
      writes.push(env.DB.prepare(
        `INSERT INTO reader_data (reader_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(reader_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(reader.id, key, text, now));
      updated[key] = now;
    }
    if (writes.length) await env.DB.batch(writes);
    return json({ updated });
  }
  if (path === "/api/auth/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(reader.token_hash).run();
    return json({ signedIn: false }, 200, { "set-cookie": sessionCookie(null, request) });
  }
  if (path === "/api/account" && method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM reader_data WHERE reader_id = ?").bind(reader.id),
      env.DB.prepare("DELETE FROM sessions WHERE reader_id = ?").bind(reader.id),
      env.DB.prepare("DELETE FROM readers WHERE id = ?").bind(reader.id),
    ]);
    return json({ deleted: true }, 200, { "set-cookie": sessionCookie(null, request) });
  }
  return fail(404, "no such endpoint");
}
