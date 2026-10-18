(() => {
  "use strict";
  const app = document.getElementById("app");
  // "/?q=keats" (the search box in the static pages' top bar, a plain GET form) opens the
  // archive already searched, as "#/poems?q=keats" does.
  {
    const q = /^\?(?:.*&)?q=([^&#]*)/.exec(location.search);
    if (q && (!location.hash || /^#\/?(poems)?(\?.*)?$/.test(location.hash))) {
      history.replaceState(null, "", location.pathname + "#/poems?q=" + q[1]);
    }
  }
  let DATA = null;
  let query = "";            // the search as typed (folded only when matching)
  let filterSubject = "All";
  let filterForm = "All";    // "Sonnet", "Ode"… (the `form` that build_index.py reads off titles)
  // Long card lists are drawn PAGE cards at a time: the whole archive at once is
  // 60,000 elements, slow on a cheap phone. "Show more" adds the next PAGE.
  const PAGE = 60;
  let shown = PAGE;
  let SORTED = [];           // every poem, by title (built once the index arrives)
  const COLLATE = new Intl.Collator("en");
  let POETS = {};      // slug -> poet (index-level: metadata + counts, no full poems)
  let WORKS = {};      // slug -> work (index-level: metadata + section titles/stanzas, no text)
  let CATEGORY_STATS = {}; // category name -> { poems, works }
  // The fast first screen: data/home.json (tools/build_home.py) holds what the home page
  // shows, so it is drawn before the large index arrives (see "a fast first screen" below).
  let HOME = null;           // home.json once it is in
  let HOME_FAILED = false;   // home.json missing, broken, unreachable or slow: the home page says so while it waits
  let EARLY_HOME = "";       // the home page as drawn from home.json, while it is on screen
  let EARLY_DRAWN = "";     // the hash of a poem or book page drawn from its shard before the index
  let EARLY_REDRAW = false;  // ...and that page wants drawing again when the index comes (see loadIndex)
  let INDEX_ERROR = "";      // why data/index.json could not be loaded, if it could not

  // ---------- critical engine ----------
  // The reading panel stays hidden until this points at the deployed Worker
  // (see worker/README.md). Keep it in sync with ALLOWED_ORIGINS there.
  const ENGINE_URL = "https://poetrycodex-engine.poetrycodex.workers.dev";
  // Set to true (and ORACLE_ENABLED in worker/wrangler.toml) to wake the Oracle.
  const ORACLE_LIVE = false;

  // What the Oracle is reading over your shoulder, if anything.
  let ORACLE_CONTEXT = null;   // {id, title, author, text}
  const LENSES = [
    { id: "formalist", label: "Formalist" },
    { id: "historicist", label: "Historicist" },
    { id: "feminist", label: "Feminist" },
    { id: "psychoanalytic", label: "Psychoanalytic" },
    { id: "postcolonial", label: "Postcolonial" },
    { id: "ecocritical", label: "Ecocritical" },
    { id: "marxist", label: "Materialist" },
    { id: "reader-response", label: "Reader-Response" },
  ];

  // ---------- on-demand data fetching (poet/work full text, cached in memory) ----------
  const POET_CACHE = new Map();  // slug -> Promise<{slug, poems:[...]}>
  const WORK_CACHE = new Map();  // slug -> Promise<full work with sections[].text>
  function fetchPoetFile(slug) {
    if (!POET_CACHE.has(slug)) {
      POET_CACHE.set(slug, fetch(`data/poets/${encodeURIComponent(slug)}.json`)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch((e) => { POET_CACHE.delete(slug); throw e; }));
    }
    return POET_CACHE.get(slug);
  }
  // data/sources/<poet>.json (tools/build_sources.py): the printed book each group of poems
  // and each work comes from. Missing for a poet -> {} (the page simply shows no book line).
  const SRC_CACHE = new Map();
  function fetchSources(slug) {
    if (!SRC_CACHE.has(slug)) {
      SRC_CACHE.set(slug, fetch(`data/sources/${encodeURIComponent(slug)}.json`)
        .then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
    }
    return SRC_CACHE.get(slug);
  }
  const poemSource = (d, p) => ((d && d.poems) || []).find((x) =>
    x.c === (p.collection || "") && x.t === (p.translator || "")) || null;
  function fetchWorkFile(slug) {
    if (!WORK_CACHE.has(slug)) {
      WORK_CACHE.set(slug, fetch(`data/works/${encodeURIComponent(slug)}.json`)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch((e) => { WORK_CACHE.delete(slug); throw e; }));
    }
    return WORK_CACHE.get(slug);
  }
  // work/works.json (tools/build_pages.py): every work as the index lists it (metadata and
  // its parts' titles and sizes, no text; about 150 KB compressed against the index's 9 MB).
  // A work's contents page, a part's "Also in this archive" and the side-by-side view are
  // drawn from it without the index. Resolves true when WORKS is filled (from this file or
  // from the index), false when the file is missing (an older build): then the index it is.
  let WORKS_LIST = null;
  function loadWorks() {
    if (DATA) return Promise.resolve(true);
    if (!WORKS_LIST) {
      WORKS_LIST = fetch("work/works.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((list) => {
          if (!Array.isArray(list)) return false;
          if (!DATA) list.forEach((w) => { if (w && w.slug && !WORKS[w.slug]) WORKS[w.slug] = w; });
          return true;
        });
    }
    return WORKS_LIST;
  }
  const worksList = () => (DATA ? DATA.works || [] : Object.values(WORKS));
  // ---------- shards: one poem or one book opens without the index ----------
  // tools/build_shards.py (run by tools/sync_r2.py into the copy on Cloudflare) cuts every
  // poet into files of POEM_SHARD poems (data/c/<poet>/<k>.json) and every work into one file
  // per section (data/ws/<work>/<i>.json). A poem page or a book page is drawn from its shard
  // at once, before data/index.json (32 MB) has arrived; when the index is in, the page is
  // drawn again in place with what only the index knows (related poems, other translations).
  // Where there are no shards (a local copy, GitHub Pages) the whole poet or work file is
  // fetched as before.
  const POEM_SHARD = 50;
  const SHARD_CACHE = new Map();
  function fetchShard(path) {
    if (!SHARD_CACHE.has(path)) {
      SHARD_CACHE.set(path, fetch(path).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    }
    return SHARD_CACHE.get(path);
  }
  // Before the index, the poet's own record stands in for its index entry (name, dates,
  // category for the language tag, portrait).
  function notePoet(slug, rec) {
    if (!POETS[slug] && rec) POETS[slug] = Object.assign({ slug }, rec, { poems: undefined });
  }
  // {slug, poems}: the poems of this shard at their places in an array as long as the poet's
  // list, with the titles either side of it for Previous / Next; or the whole poet file.
  function loadPoemPage(slug, n) {
    const k = Math.floor(n / POEM_SHARD);
    return fetchShard(`data/c/${encodeURIComponent(slug)}/${k}.json`).then((s) => {
      if (!s || !Array.isArray(s.poems)) {
        return fetchPoetFile(slug).then((f) => { notePoet(slug, f); return f; });
      }
      notePoet(slug, s.poet);
      const poems = new Array(s.total);
      s.poems.forEach((p, j) => { poems[s.start + j] = p; });
      if (s.before != null) poems[s.start - 1] = { title: s.before };
      if (s.after != null) poems[s.start + s.poems.length] = { title: s.after };
      return { slug, poems };
    });
  }
  // The work with section i in full and the titles either side; or the whole work file.
  function loadSectionPage(slug, i) {
    return fetchShard(`data/ws/${encodeURIComponent(slug)}/${i}.json`).then((s) => {
      if (!s || !s.work || !s.section) return fetchWorkFile(slug);
      const sections = new Array(s.count);
      sections[i] = s.section;
      if (s.prev != null) sections[i - 1] = { title: s.prev };
      if (s.next != null) sections[i + 1] = { title: s.next };
      return Object.assign({}, s.work, { sections });
    });
  }
  function renderLoading() { app.innerHTML = `<p class="loading">Loading…</p>`; }
  function renderFetchError(e) {
    app.innerHTML = `<p class="empty">Could not load this text (${esc(e.message)}).<br>Check your connection and try again.</p>`;
  }

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Counts are printed with commas ("12,041 poems"). Never used for a total of poets: the
  // site does not print one anywhere (owner's rule).
  const num = (n) => Number(n || 0).toLocaleString("en-US");

  // ---------- search folding ----------
  // Search ignores case, accents, apostrophes and the Turkish dotted and dotless i, and
  // spells out the old letters, so "hasim" finds Haşim, "caedmon" Cædmon, "isik" IŞIK and
  // "maarri" al-Ma'arri. The query and what it is matched against both pass through here.
  const FOLD_LETTERS = { "æ": "ae", "œ": "oe", "þ": "th", "ð": "d", "ø": "o", "ł": "l",
                         "ß": "ss", "ſ": "s", "ı": "i", "đ": "d", "ƿ": "w" };
  const fold = (s) => String(s || "").toLocaleLowerCase("tr").normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[æœþðøłßſıđƿ]/g, (c) => FOLD_LETTERS[c])
    .replace(/['‘’ʼʾʿ`]/g, "")
    .replace(/\s+/g, " ");
  // A search is its words: each must appear somewhere, in any order ("keats ode").
  const searchWords = (q) => fold(q).split(" ").filter(Boolean);
  const hasAll = (hay, words) => words.every((w) => hay.includes(w));

  // ---------- tab title ----------
  // Each page names itself in the browser tab, history and bookmarks, in the same form
  // as the static pages ("Ode on a Grecian Urn — John Keats · Poetry Codex").
  const SITE_TITLE = document.title;
  const setTitle = (t) => { document.title = t ? t + " · Poetry Codex" : SITE_TITLE; };

  // ---------- "Suggest a poem" ----------
  // A plain email with a short form in it (footer and About page): no form on the site,
  // nothing sent anywhere but the reader's own mail program. Every a[data-suggest] gets it.
  const SUGGEST_URL = "mailto:admin@poetrycodex.com?subject=" +
    encodeURIComponent("Suggest a poem for Poetry Codex") + "&body=" + encodeURIComponent([
      "Poem (title or first line):",
      "Poet:",
      "Translator and year, if it is a translation:",
      "Where it can be read (book, edition or link), if you know:",
      "",
      "Why it belongs in the archive (optional):",
      "",
    ].join("\r\n"));
  document.querySelectorAll("a[data-suggest]").forEach((a) => { a.href = SUGGEST_URL; });

  // ---------- attribution ----------
  // The data stores translators as "trans. Name (year)". Pages spell that out;
  // cards drop the trailing date, which the card already shows as the year.
  const translatedBy = (t) => String(t).replace(/^trans\.\s*/i, "Translated by ");
  const translatorShort = (t) => String(t).replace(/\s*\([^)]*\)\s*$/, "");
  // "Translated by … · From <book>", under the author line; empty when neither is known.
  // The poet's dates after the byline of a poem or a work's part ("by John Keats 1795–1821").
  const datesHTML = (slug) => {
    const d = (POETS[slug] || {}).dates;
    return d ? ` <span class="detail-dates">${esc(d)}</span>` : "";
  };
  // extra: the reading time on a book or a long poem ("about 22 min"), last on the line.
  function sourceLine(translator, collection, extra) {
    const parts = [translator && translatedBy(translator), collection && "From " + collection, extra].filter(Boolean);
    return parts.length ? `<p class="detail-source">${parts.map(esc).join(" · ")}</p>` : "";
  }
  // ---------- citation ----------
  // "Cite this poem" gives MLA (9th ed.) and Chicago (bibliography) entries that point at
  // the page's permanent address (/poem/keats/0/, the static page search engines index),
  // never at the #/ address, which Google counts as the home page.
  const SITE = "https://poetrycodex.com";
  // Surname first, as both styles want. Titles (Sir) are dropped; names with no
  // surname to invert (Homer, Yunus Emre, "Anonymous (Old English)") stay as written.
  const CITE_NAMES = {
    "Alfred, Lord Tennyson": "Tennyson, Alfred, Lord",
    "Lord Byron": "Byron, George Gordon, Lord",
    "Dante Alighieri": "Dante Alighieri",
    "Jean de La Fontaine": "La Fontaine, Jean de",
    "William Drummond of Hawthornden": "Drummond, William, of Hawthornden",
    "Abu al-Ala al-Ma'arri": "al-Ma'arri, Abu al-Ala",
    "Yunus Emre": "Yunus Emre", "Namık Kemal": "Namık Kemal", "Şeyh Galip": "Şeyh Galip",
  };
  function citeName(name) {
    name = String(name || "").trim();
    if (CITE_NAMES[name]) return CITE_NAMES[name];
    if (/[()]|^anonymous|\bpoets?$/i.test(name)) return name;
    const [person, rest] = name.split(/,\s*(.*)/);           // "Henry Howard, Earl of Surrey"
    const parts = person.replace(/^Sir\s+/, "").split(/\s+/);
    if (parts.length < 2) return name;
    return parts.pop() + ", " + parts.join(" ") + (rest ? ", " + rest : "");
  }
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
                  "August", "September", "October", "November", "December"];
  const MLA_MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July",
                      "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  // o: {author, title, work?, path, translator?} -> [{style, html, text}]; `title` is the
  // poem (quoted) or, with `work`, the part of a long work (the work is italic).
  function citations(o) {
    const d = new Date();
    const url = SITE + o.path;
    const tr = o.translator ? translatorShort(o.translator).replace(/^trans\.\s*/i, "").replace(/\s*&\s*/g, " and ") : "";
    const by = tr ? ` Translated by ${esc(tr)}.` : "";
    // One closing full stop: none after ? or !, and a stray trailing comma or colon in
    // the data ("Ad Amicum Litigantem,") gives way to it.
    const end = (s) => { s = String(s).replace(/[\s,;:]+$/, ""); return /[.?!]$/.test(s) ? s : s + "."; };
    const what = !o.work ? `“${esc(end(o.title))}”`
      : o.title && o.title !== o.work ? `<i>${esc(o.work)}</i>, ${esc(end(o.title))}`
      : `<i>${esc(end(o.work))}</i>`;
    // With the printed source known, the book is the container (MLA) or the "In" (Chicago),
    // and its translator goes there; the strings come ready-made from build_sources.py.
    const lead = o.src ? `${esc(end(citeName(o.author)))} ${what}` : `${esc(end(citeName(o.author)))} ${what}${by}`;
    // o.loc ("lines 1–7", "para. 3"), for a quotation: it closes the element before the site;
    // after a quoted title ("“Ode.”") or a ? or ! it stands as its own element ("Lines 1–7.").
    const loc = (s) => !o.loc ? s + " "
      : /[.?!]”$|[?!](<\/i>)?$/.test(s) ? `${s} ${esc(o.loc[0].toUpperCase() + o.loc.slice(1))}. `
      : `${s.replace(/\.(<\/i>)?$/, "$1")}, ${esc(o.loc)}. `;
    const mla = loc(o.src ? `${lead} ${end(o.src.mla)}` : lead) +
      `<i>Poetry Codex</i>, ${esc(url.replace(/^https:\/\//, ""))}. Accessed ${d.getDate()} ${MLA_MONTHS[d.getMonth()]} ${d.getFullYear()}.`;
    const chicago = loc(o.src ? `${lead} ${o.src.chi}` : lead) +
      `Poetry Codex. Accessed ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}. ${esc(url)}.`;
    const plain = (h) => h.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return [{ style: "MLA", html: mla, text: plain(mla) }, { style: "Chicago", html: chicago, text: plain(chicago) }];
  }
  // "Source: <the printed book>. Digital text: <where>." under a poem or a part of a work.
  // src.line is HTML built from the bibliography (titles in <i>, the rest escaped).
  function bookSourceHTML(src) {
    return "";   // the owner asked (17 Oct 2026) that the source books not be shown on the page
    if (!src) return "";
    const txt = src.text ? ` Digital text: ${src.url ? `<a href="${esc(src.url)}" rel="noopener">${esc(src.text)}</a>` : esc(src.text)}.` : "";
    const unsure = src.sure ? "" : ` <span class="bs-note">(details from catalogue records, not yet checked against the title page)</span>`;
    return `<p class="book-source"><span class="bs-label">Source</span> ${src.line}.${txt}${unsure}</p>`;
  }
  // Fill the source line and redo the citations once data/sources/<poet>.json is in.
  function applySource(o, src, here) {
    if (!src || location.hash !== here) return;
    const slot = app.querySelector(".book-source-slot");
    if (slot) slot.outerHTML = bookSourceHTML(src);
    o.src = src;
    citations(o).forEach((c, i) => { const el = document.getElementById("cite-" + i); if (el) el.innerHTML = c.html; });
  }
  // The row under a text: Save to shelf and Add a note (when `entry` is given), Cite,
  // Copy link; the note opens under the row.
  function citeHTML(o, entry) {
    return `
      <div class="cite-row">
        ${entry ? shelfButtonHTML(entry, true) : ""}
        <button class="cite-toggle" type="button" aria-expanded="false" aria-controls="cite-box">Cite this ${o.work ? "text" : "poem"}</button>
        <button class="cite-link" type="button" data-url="${esc(SITE + o.path)}">Copy link</button>
      </div>
      ${entry ? `<p class="shelf-msg" hidden>${VISIT_ONLY}</p>${noteBoxHTML(entry)}` : ""}
      <div class="cite-box" id="cite-box" hidden>
        ${citations(o).map((c, i) => `
          <div class="cite-entry">
            <p class="cite-style">${c.style}</p>
            <p class="cite-text" id="cite-${i}">${c.html}</p>
            <button class="cite-copy" type="button" data-i="${i}">Copy</button>
          </div>`).join("")}
      </div>`;
  }
  // Copies as formatted text where the browser allows (italics survive into Word), else
  // plain; with no clipboard at all, selects the text for Ctrl+C.
  function copyText(text, html, fallbackNode) {
    const c = navigator.clipboard;
    if (c && html && window.ClipboardItem) {
      return c.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]).catch(() => c.writeText(text));
    }
    if (c) return c.writeText(text);
    if (fallbackNode) {
      const r = document.createRange(); r.selectNodeContents(fallbackNode);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    return Promise.reject(new Error("no clipboard"));
  }
  function flash(btn, label) {
    const was = btn.dataset.label || (btn.dataset.label = btn.textContent);
    btn.textContent = label;
    clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = was; }, 1600);
  }
  function bindCite(o) {
    const toggle = app.querySelector(".cite-toggle");
    if (!toggle) return;
    const box = app.querySelector(".cite-box");
    toggle.addEventListener("click", () => {
      box.hidden = !box.hidden;
      toggle.setAttribute("aria-expanded", String(!box.hidden));
    });
    const link = app.querySelector(".cite-link");
    link.addEventListener("click", () => copyText(link.dataset.url)
      .then(() => flash(link, "Link copied"), () => flash(link, link.dataset.url)));
    app.querySelectorAll(".cite-copy").forEach((b) => b.addEventListener("click", () => {
      const c = citations(o)[+b.dataset.i];   // o.src may arrive after binding
      copyText(c.text, c.html, document.getElementById("cite-" + b.dataset.i))
        .then(() => flash(b, "Copied"), () => flash(b, "Press Ctrl+C"));
    }));
  }

  // ---------- the reader's shelf and private notes ----------
  // "Save to shelf" keeps a poem, a long work or one book of it, and "Add a note" a note
  // on a poem or a book, in this browser's localStorage; a reader who signs in (see "reader
  // accounts" below) also keeps them in their account, so they follow them to every device.
  // Nothing is ever shared or shown to anyone else.
  // Where the browser keeps no site data (some private windows, storage switched off, or
  // full) the shelf lasts for this visit only, and the shelf page says so and offers the
  // download. Ids are the Codex's own: "keats/0" (a poem), "work:iliad-pope" (a work),
  // "work:iliad-pope/5" (one part of it); each entry keeps the title it was saved under.
  const SHELF_KEY = "pc-shelf";
  const NOTES_KEY = "pc-notes";
  const NOTE_MAX = 5000;
  // Reader accounts (below). The kinds kept in the account and the browser key of each.
  const GOOGLE_CLIENT = (document.querySelector('meta[name="pc-google-client"]') || {}).content || "";
  const ACCOUNT_KEY = "pc-account";   // {name, email} while signed in: the pages' hint (the session is an HttpOnly cookie)
  const SYNC_KEY = "pc-sync";         // {at: {kind: server ms}, dirty: {kind: n}}
  const SYNC_KINDS = { shelf: "pc-shelf", notes: "pc-notes", reading: "pc-reading", parallel: "pc-parallel",
                       marks: "pc-marks", readings: "pc-readings" };
  const KIND_OF = { "pc-shelf": "shelf", "pc-notes": "notes", "pc-reading": "reading", "pc-parallel": "parallel",
                    "pc-marks": "marks", "pc-readings": "readings" };
  let SYNCING = false;                // true while the account's copy is written into the browser
  const STORE_OK = (() => {
    try { localStorage.setItem("pc-test", "1"); localStorage.removeItem("pc-test"); return true; }
    catch (e) { return false; }
  })();
  const MEMORY = {};   // this visit's copy of anything the browser would not keep
  function readStore(key) {
    let raw = MEMORY[key];
    if (raw === undefined && STORE_OK) { try { raw = localStorage.getItem(key); } catch (e) { raw = null; } }
    try { const v = raw ? JSON.parse(raw) : null; return v && typeof v === "object" ? v : {}; }
    catch (e) { return {}; }
  }
  // Returns false when the browser refused it: kept for this visit only.
  function writeStore(key, value) {
    const raw = JSON.stringify(value);
    if (KIND_OF[key] && !SYNCING) noteChange(KIND_OF[key]);
    if (STORE_OK) {
      try { localStorage.setItem(key, raw); delete MEMORY[key]; return true; } catch (e) { /* full */ }
    }
    MEMORY[key] = raw;
    return false;
  }
  const visitOnly = () => Object.keys(MEMORY).length > 0 || !STORE_OK;
  // This browser's own settings (pc-prefs): the Aa choices, the line-number and study-note
  // switches, the "Return to your marks" card's state. Not a synced kind.
  const PREFS_KEY = "pc-prefs";
  const prefs = () => readStore(PREFS_KEY);
  const setPrefs = (change) => writeStore(PREFS_KEY, Object.assign(prefs(), change));
  function shelfItems() {
    const s = readStore(SHELF_KEY);
    return Array.isArray(s.items) ? s.items.filter((it) => it && typeof it.id === "string") : [];
  }
  const onShelf = (id) => shelfItems().some((it) => it.id === id);
  // entry: {id, kind: "poem" | "work" | "part", title, author, translator}
  function toggleShelf(entry) {
    const s = shelfStore(), items = s.items;
    const at = items.findIndex((it) => it.id === entry.id);
    if (at >= 0) items.splice(at, 1);
    else { items.unshift(Object.assign({}, entry, { saved: new Date().toISOString() })); keepOffline(entry.id); }
    const kept = writeStore(SHELF_KEY, s);
    updateShelfNav();
    return { on: at < 0, kept };
  }

  // ---------- shelf collections and reading status ----------
  // The shelf can be sorted into the reader's own collections ("Week 4", "Essay on elegy"),
  // and each saved text can carry a reading status: to read, reading, read, learning. Both
  // live in pc-shelf beside the items, so they follow a signed-in reader (MERGE.shelf below
  // keeps them): {v, items: [{…, status, statusAt}], collections: [{id, name, at, items:
  // [{ref, l, title, author, translator, kind, loc, first}]}], dropped: {collection id: when
  // deleted}}. A collection item is a shelf id (ref) or, with l ("120-160", counted as
  // "Link to lines" counts them), a passage of it; each keeps the title it was added under.
  // A text can be in several collections; deleting a collection never touches the shelf.
  const STATUSES = [["to-read", "To read"], ["reading", "Reading"], ["read", "Read"], ["learning", "Learning"]];
  const STATUS_NAME = Object.fromEntries(STATUSES);
  const COL_NAME_MAX = 80;
  function shelfCollections() {
    const c = readStore(SHELF_KEY).collections;
    return Array.isArray(c) ? c.filter((x) => x && typeof x.id === "string" && Array.isArray(x.items))
      .map((x) => Object.assign({}, x, { name: String(x.name || "Untitled"), items: x.items.filter((it) => it && typeof it.ref === "string") })) : [];
  }
  // The whole shelf, ready to change and write back.
  function shelfStore() {
    const d = readStore(SHELF_KEY).dropped;
    const s = { v: 1, items: shelfItems(), collections: shelfCollections() };
    if (d && typeof d === "object" && !Array.isArray(d)) s.dropped = d;
    return s;
  }
  function saveShelf(s) {
    if (!s.collections.length) delete s.collections;
    const kept = writeStore(SHELF_KEY, s);
    updateShelfNav();
    return kept;
  }
  const statusOf = (id) => ((shelfItems().find((it) => it.id === id) || {}).status || "");
  // A status saves the text to the shelf if it is not there yet; "" clears it.
  function setStatus(entry, status) {
    const s = shelfStore();
    let it = s.items.find((x) => x.id === entry.id);
    if (!it && !status) return;
    if (!it) { it = Object.assign({}, entry, { saved: new Date().toISOString() }); s.items.unshift(it); keepOffline(entry.id); }
    if (STATUS_NAME[status]) it.status = status; else delete it.status;
    it.statusAt = new Date().toISOString();
    return saveShelf(s);
  }
  const colKey = (x) => x.ref + (x.l ? "@" + x.l : "");
  function newCollection(name, items) {
    const s = shelfStore();
    const c = { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                name: String(name).trim().slice(0, COL_NAME_MAX) || "Untitled", at: new Date().toISOString(), items: items || [] };
    s.collections.push(c);
    saveShelf(s);
    return c;
  }
  // Changes one collection: fn(collection) edits it in place.
  function editCollection(id, fn) {
    const s = shelfStore();
    const c = s.collections.find((x) => x.id === id);
    if (!c) return null;
    fn(c);
    c.at = new Date().toISOString();
    saveShelf(s);
    return c;
  }
  function deleteCollection(id) {
    const s = shelfStore();
    s.collections = s.collections.filter((x) => x.id !== id);
    s.dropped = Object.assign({}, s.dropped, { [id]: new Date().toISOString() });
    saveShelf(s);
  }
  // item: {ref, l?, title, author, translator, kind, loc?, first?}. A whole text put in a
  // collection is saved to the shelf as well; a passage is not.
  function toggleInCollection(id, item) {
    let added = false;
    editCollection(id, (c) => {
      const k = colKey(item), at = c.items.findIndex((x) => colKey(x) === k);
      if (at >= 0) c.items.splice(at, 1);
      else { c.items.push(item); added = true; }
    });
    if (added && !item.l && !onShelf(item.ref)) toggleShelf({ id: item.ref, kind: item.kind, title: item.title, author: item.author, translator: item.translator || "" });
    return added;
  }
  // id -> {id, kind, title, author, translator, text, updated}
  function allNotes() {
    const n = readStore(NOTES_KEY).notes;
    return n && typeof n === "object" && !Array.isArray(n) ? n : {};
  }
  // An empty note is no note. Returns false when kept for this visit only.
  function setNote(entry, text) {
    const notes = allNotes();
    text = String(text || "").slice(0, NOTE_MAX);
    const now = new Date().toISOString(), was = notes[entry.id];
    if (text.trim()) notes[entry.id] = Object.assign({}, entry, { text, created: (was && (was.created || was.updated)) || now, updated: now });
    else delete notes[entry.id];
    const kept = writeStore(NOTES_KEY, { v: 1, notes });
    updateShelfNav();
    return kept;
  }
  // The top bar's "Shelf" appears once there is something on it.
  function updateShelfNav() {
    const show = shelfItems().length > 0 || shelfCollections().length > 0 || Object.keys(allNotes()).length > 0 || markCount() > 0 || /^#\/shelf/.test(location.hash);
    document.querySelectorAll('[data-nav="shelf"]').forEach((a) => { a.hidden = !show; });
  }
  const shelfPath = (id) => id.startsWith("work:") ? "/work/" + id.slice(5) + "/" : "/poem/" + id + "/";
  const VISIT_ONLY = "This browser is not keeping data for this site, so your shelf lasts for this visit only. Download it from your shelf before you close the tab.";
  const NOTE_KEPT_LOCAL = "Private: kept in this browser only, never sent to Poetry Codex. It also appears on your shelf.";
  const NOTE_KEPT_ACCOUNT = "Private: kept in your account and in this browser, never shown to anyone. It also appears on your shelf.";
  const noteKept = () => (signedIn() ? NOTE_KEPT_ACCOUNT : NOTE_KEPT_LOCAL);
  const NOTE_VISIT = "This browser is not keeping data for this site, so this note lasts for this visit only. Download it from your shelf before you close the tab.";
  function shelfButtonHTML(entry, noteable) {
    const on = onShelf(entry.id);
    const note = noteable && allNotes()[entry.id];
    return `<span class="shelf-split"><button class="shelf-toggle" type="button" aria-pressed="${on}">${shelfLabel(entry.id)}</button><button
      class="shelf-more" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Collections and reading status"
      title="Collections and reading status"><span aria-hidden="true">▾</span></button></span>
      <a class="shelf-view" href="#/shelf"${on ? "" : " hidden"}>View shelf →</a>
      ${noteable ? `<button class="note-toggle" type="button" aria-expanded="${!!note}" aria-controls="note-box">${note ? "Your note" : "Add a note"}</button>` : ""}`;
  }
  // The note under a poem or a book of a long work: open when there is one.
  function noteBoxHTML(entry) {
    const note = allNotes()[entry.id];
    return `
      <div class="note-box" id="note-box"${note ? "" : " hidden"}>
        <label class="section-label" for="note-input">Your note</label>
        <textarea class="note-input" id="note-input" rows="4" maxlength="${NOTE_MAX}"
                  placeholder="A private note on this text: what struck you, a line to come back to\u2026">${esc(note ? note.text : "")}</textarea>
        <p class="note-status">${visitOnly() && !signedIn() ? NOTE_VISIT : noteKept()}</p>
        ${note ? `<p class="note-date">${esc(writtenLine(note))}</p>` : ""}
      </div>`;
  }
  // Saved as it is typed, so leaving the page never loses a word.
  function bindNote(entry) {
    const toggle = app.querySelector(".note-toggle");
    if (!toggle) return;
    const box = document.getElementById("note-box");
    const input = box.querySelector(".note-input");
    const status = box.querySelector(".note-status");
    toggle.addEventListener("click", () => {
      box.hidden = !box.hidden;
      toggle.setAttribute("aria-expanded", String(!box.hidden));
      if (!box.hidden) input.focus();
    });
    input.addEventListener("input", () => {
      const kept = setNote(entry, input.value);
      toggle.textContent = input.value.trim() ? "Your note" : "Add a note";
      status.textContent = kept || signedIn() ? noteKept() : NOTE_VISIT;
    });
  }
  function bindShelfButton(entry) {
    const btn = app.querySelector(".shelf-toggle");
    if (!btn) return;
    const show = () => {
      const on = onShelf(entry.id);
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = shelfLabel(entry.id);
      app.querySelector(".shelf-view").hidden = !on;
    };
    btn.addEventListener("click", () => {
      const r = toggleShelf(entry);
      show();
      const msg = app.querySelector(".shelf-msg");
      if (msg) msg.hidden = r.kept;
    });
    // The arrow beside it: the collections and the reading status (shelfMenu below).
    const more = app.querySelector(".shelf-more");
    if (more) more.addEventListener("click", () => {
      if (more.getAttribute("aria-expanded") === "true") { closeShelfMenu(true); return; }
      openShelfMenu(more, more.getBoundingClientRect(), { entry }, show);
    });
  }
  const shelfLabel = (id) => {
    if (!onShelf(id)) return "Save to shelf";
    const st = statusOf(id);
    return st ? "On your shelf · " + STATUS_NAME[st] : "On your shelf";
  };

  // ---------- the shelf menu: collections and status for a text, or a passage ----------
  // Opened from the arrow beside "Save to shelf" (a text: every collection as a checkbox,
  // "New collection…" and the four statuses) or from "Add passage to…" in the selection bar
  // (a passage: the collections only). A menu button's menu: arrow keys move, Escape closes
  // and gives the focus back, a click elsewhere closes it. Changes are saved at once.
  let shelfMenuEl = null, shelfMenuFrom = null;
  function closeShelfMenu(refocus) {
    if (!shelfMenuEl) return;
    shelfMenuEl.remove(); shelfMenuEl = null;
    document.removeEventListener("mousedown", shelfMenuOutside, true);
    if (shelfMenuFrom) {
      shelfMenuFrom.setAttribute("aria-expanded", "false");
      if (refocus && shelfMenuFrom.isConnected) shelfMenuFrom.focus();
    }
    shelfMenuFrom = null;
  }
  function shelfMenuOutside(e) {
    if (shelfMenuEl && !shelfMenuEl.contains(e.target) && !(shelfMenuFrom && shelfMenuFrom.contains(e.target))) closeShelfMenu(false);
  }
  // target: {entry} for a text, {entry, l, loc, first} for a passage; onChange redraws the button.
  function openShelfMenu(from, rect, target, onChange) {
    closeShelfMenu(false);
    const { entry } = target;
    const item = { ref: entry.id, title: entry.title, author: entry.author, translator: entry.translator || "", kind: entry.kind };
    if (target.l) Object.assign(item, { l: target.l, loc: target.loc || "", first: target.first || "" });
    const what = target.l ? (target.loc || "this passage") : "this text";
    const el = shelfMenuEl = document.createElement("div");
    el.className = "shelf-menu";
    shelfMenuFrom = from;
    const draw = (focusKey) => {
      const cols = shelfCollections(), k = colKey(item), st = statusOf(entry.id);
      el.setAttribute("role", "menu");
      el.setAttribute("aria-label", target.l ? "Add " + what + " to a collection" : "Collections and reading status");
      el.innerHTML = `
        <div role="group" aria-label="Collections">
          <p class="sm-head" aria-hidden="true">${target.l ? "Add " + esc(what) + " to" : "Collections"}</p>
          ${cols.map((c) => `<button type="button" role="menuitemcheckbox" class="sm-item" data-col="${esc(c.id)}"
            aria-checked="${c.items.some((x) => colKey(x) === k)}" tabindex="-1">${esc(c.name)}</button>`).join("")}
          <button type="button" role="menuitem" class="sm-item sm-new" data-new="1" tabindex="-1">New collection…</button>
        </div>
        ${target.l ? "" : `<div role="group" aria-label="Reading status">
          <p class="sm-head" aria-hidden="true">Reading status</p>
          ${STATUSES.map(([v, name]) => `<button type="button" role="menuitemradio" class="sm-item sm-st" data-st="${v}"
            aria-checked="${st === v}" tabindex="-1">${name}</button>`).join("")}
        </div>`}`;
      const items = [...el.querySelectorAll('[role^="menuitem"]')];
      const f = (focusKey && items.find((b) => (b.dataset.col || b.dataset.st || "new") === focusKey)) || items[0];
      place();
      f.tabIndex = 0; f.focus({ preventScroll: true });
    };
    // Under what opened it, or above it when there is no room below; inside the screen.
    const top0 = window.scrollY;
    const place = () => {
      const width = document.documentElement.clientWidth, h = el.offsetHeight, w = el.offsetWidth;
      const below = rect.bottom + 6 + h <= window.innerHeight || rect.top - 6 - h < 0;
      el.style.top = (top0 + (below ? rect.bottom + 6 : rect.top - 6 - h)) + "px";
      el.style.left = (window.scrollX + Math.max(8, Math.min(rect.left, width - w - 8))) + "px";
    };
    // "New collection…": the menu turns into a small form, then back into the menu.
    const askName = () => {
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-label", "New collection");
      el.innerHTML = `
        <form class="sm-form">
          <label class="sm-head" for="sm-name">Name of the new collection</label>
          <input id="sm-name" class="sm-name" type="text" maxlength="${COL_NAME_MAX}" autocomplete="off" placeholder="Week 4: the elegy">
          <div class="sm-acts"><button type="submit" class="sm-ok">Create</button><button type="button" class="sm-cancel">Cancel</button></div>
        </form>`;
      const input = el.querySelector(".sm-name");
      place();
      input.focus({ preventScroll: true });
      el.querySelector(".sm-cancel").addEventListener("click", () => draw("new"));
      el.querySelector(".sm-form").addEventListener("submit", (e) => {
        e.preventDefault();
        if (!input.value.trim()) { input.focus(); return; }
        const c = newCollection(input.value);
        toggleInCollection(c.id, item);
        announce(`Collection “${c.name}” made, with ${what} in it.`);
        if (onChange) onChange();
        draw(c.id);
      });
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".sm-item");
      if (!b) return;
      if (b.dataset.new) { askName(); return; }
      if (b.dataset.col) {
        const added = toggleInCollection(b.dataset.col, item);
        const c = shelfCollections().find((x) => x.id === b.dataset.col);
        announce((added ? "Added to " : "Taken out of ") + (c ? c.name : "the collection") + ".");
        if (onChange) onChange();
        draw(b.dataset.col);
        return;
      }
      if (b.dataset.st) {
        const now = statusOf(entry.id) === b.dataset.st ? "" : b.dataset.st;   // pressed again: no status
        setStatus(entry, now);
        announce(now ? "Status: " + STATUS_NAME[now] + "." : "Status cleared.");
        if (onChange) onChange();
        draw(b.dataset.st);
      }
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeShelfMenu(true); return; }
      if (e.key === "Tab" && el.getAttribute("role") === "menu") { closeShelfMenu(false); return; }
      const items = [...el.querySelectorAll('[role^="menuitem"]')];
      const at = items.indexOf(document.activeElement);
      if (at < 0) return;
      let to = -1;
      if (e.key === "ArrowDown") to = (at + 1) % items.length;
      else if (e.key === "ArrowUp") to = (at - 1 + items.length) % items.length;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = items.length - 1;
      if (to < 0) return;
      e.preventDefault();
      items.forEach((b, i) => { b.tabIndex = i === to ? 0 : -1; });
      items[to].focus();
    });
    document.body.appendChild(el);
    if (from) from.setAttribute("aria-expanded", "true");
    draw();
    document.addEventListener("mousedown", shelfMenuOutside, true);
  }
  window.addEventListener("hashchange", () => closeShelfMenu(false));
  // ---------- notes on lines ----------
  // Select a line, or a few words of one, in a poem or a book of a long work, and "Note on
  // this line" appears under the selection. The note keeps the lines it covers (data-i, each
  // line's place in the text as poemHTML numbers them) and the words selected; those lines
  // get a gold mark in the margin, which opens the note again, also in a facing-page or
  // side-by-side column of the same text. Prose texts take no line notes. pc-marks: {v, marks: {entry id: {title, author, kind,
  // translator, items: [{id, a, b, quote, text, updated}]}}}, kept like the other notes (this
  // browser, and the account of a signed-in reader); listed on the shelf and the account page.
  const MARKS_KEY = "pc-marks";
  const writtenLine = (n) => {
    if (!n || !n.updated) return "";
    const first = shortDate(n.created || n.updated), last = shortDate(n.updated);
    return "Written " + first + (last !== first ? " \u00b7 edited " + last : "");
  };
  const MARK_MAX = 2000;
  function allMarks() {
    const m = readStore(MARKS_KEY).marks;
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  }
  const marksOf = (id) => ((allMarks()[id] || {}).items || []);
  const markCount = () => Object.values(allMarks()).reduce((n, g) => n + ((g && g.items) || []).length, 0);
  function putMark(entry, mark) {          // empty text: the note is deleted
    const marks = allMarks();
    const g = marks[entry.id] || { title: entry.title, author: entry.author, kind: entry.kind, translator: entry.translator || "", items: [] };
    g.items = (g.items || []).filter((x) => x.id !== mark.id);
    const text = String(mark.text || "").slice(0, MARK_MAX);
    const now = new Date().toISOString();
    if (text.trim()) g.items.push(Object.assign({}, mark, { text, created: mark.created || mark.updated || now, updated: now }));
    g.items.sort((x, y) => x.a - y.a);
    if (g.items.length) marks[entry.id] = g; else delete marks[entry.id];
    writeStore(MARKS_KEY, { v: 1, marks });
    updateShelfNav();
  }
  let MARK_CTX = null;                     // {entry, root} while a text that takes line notes is shown
  let markBtn = null, selTimer = 0;
  // ---------- marks in every text on screen: alone, facing pages, two translations ----------
  // A page can show more than one text that takes marks: the facing pages (the original and
  // its translation, each column its own text) and #/work/.../with/... (two translations).
  // Each is a "mark text" {entry, root, lines (takes line notes), col (a facing-page column),
  // lay (its layout, below), noQuote, noMargin}; HL_ALL lists those on screen and HL_CTX is
  // the one the reader is working in. A mark is kept under the text it was made in, not the
  // view: a highlight in the translation column is the same as one made on the translation's
  // own page, so it shows in both, and one in the Old English column goes with the Old
  // English text's own page. Offsets are always counted in the text as its own page lays it
  // out (textLayout), so a column's text nodes are given those offsets (colNodes).
  let HL_ALL = [], SOLO_CTX = null;
  const liveCtxs = () => HL_ALL.filter((c) => c.root.isConnected);
  function bindMarks(entry) {
    const root = app.querySelector(".text-solo .poem-text") || app.querySelector(".poem-text");
    SOLO_CTX = root ? { entry, root, lines: !root.classList.contains("is-prose") && !!root.querySelector(".ln[data-i]") } : null;
    MARK_CTX = SOLO_CTX && SOLO_CTX.lines ? SOLO_CTX : null;
    // With the facing pages open the columns already hold the marks (bindFacing).
    if (!app.querySelector(".fx-slot:not([hidden]) .fx")) useMarkTexts(SOLO_CTX ? [SOLO_CTX] : []);
  }
  // The texts now on screen: their line notes, then the editors' study notes, then highlights.
  function useMarkTexts(ctxs) {
    HL_ALL = ctxs;
    HL_CTX = ctxs[0] || null;
    hideMarkButton();
    hideHlBar();
    drawMarks();
    Promise.all(ctxs.map(drawGlosses)).then(drawHighlights);
  }
  // The text as its own page lays it out (poemHTML): the characters of its text nodes in a row
  // (flat), where each line, as textUnits counts them, begins there (start) and the spaces a
  // prose line loses at its start when its lines are joined into paragraphs (lead).
  function textLayout(text, prose) {
    const us = textUnits(text), start = [], lead = [];
    let flat = "";
    if (!prose) us.forEach((u) => { start.push(flat.length); lead.push(0); flat += u.t; });
    else {
      // As proseHTML joins them: the trimmed lines of a paragraph with a space between.
      const lens = trimmedLines(text).map((l) => l.length).sort((a, b) => a - b);
      const width = lens[Math.floor(lens.length * 0.9)] || 0;
      let k = 0;
      for (const st of String(text || "").split(/\n\s*\n/)) {
        let open = false;
        for (const l of trimmedLines(st)) {
          if (open) flat += " ";
          start.push(flat.length);
          lead.push(us[k] ? us[k].t.length - us[k].t.trimStart().length : 0);
          flat += l; k++;
          open = !(l.length > 200 || l.length < width - 15);
        }
      }
    }
    return { flat, start, lead };
  }
  // A facing-page column's text nodes, each with its offset in the text's own layout. Each
  // line or piece of a paragraph there carries data-e (the text's entry id), data-u (its line
  // in that text, from 0) and data-off (where a paragraph cut in two resumes); the other
  // column, line numbers (drawn by the stylesheet) and the translator's book headings are
  // not in it, so the two columns are walked apart even when interleaved on a phone.
  function colNodes(ctx) {
    const out = [], { start, lead } = ctx.lay;
    ctx.root.querySelectorAll(`[data-u][data-e="${CSS.escape(ctx.entry.id)}"]`).forEach((el) => {
      const k = +el.dataset.u;
      if (start[k] == null) return;
      let pos = start[k] + (+el.dataset.off || 0) - lead[k];
      hlNodes(el).forEach(({ n }) => { out.push({ n, s: pos }); pos += n.nodeValue.length; });
    });
    return out;
  }
  const ctxNodes = (ctx) => (ctx.col ? colNodes(ctx) : hlNodes(ctx.root));
  const ctxFull = (ctx, nodes) => (ctx.col ? ctx.lay.flat : nodes.map((x) => x.n.nodeValue).join(""));
  const ctxLines = (ctx) => [...ctx.root.querySelectorAll(ctx.col ? `[data-u][data-e="${CSS.escape(ctx.entry.id)}"]` : ".ln[data-i]")];
  const ctxLine = (ctx, i) => ctx.root.querySelector(ctx.col ? `[data-u="${i}"][data-e="${CSS.escape(ctx.entry.id)}"]` : `.ln[data-i="${i}"]`);
  // The mark text a selection belongs to: inside one text's root, or (facing pages) begun or
  // ended in a line of that column.
  function rangeCtx(r) {
    const unit = (node) => { const el = node.nodeType === 1 ? node : node.parentElement; return el && el.closest("[data-u][data-e]"); };
    return liveCtxs().find((c) => {
      if (!c.col) return c.root.contains(r.startContainer) && c.root.contains(r.endContainer);
      if (!c.root.contains(r.startContainer) || !c.root.contains(r.endContainer)) return false;
      const u = unit(r.startContainer) || unit(r.endContainer);
      return !!u && u.dataset.e === c.entry.id;
    }) || null;
  }
  // The facing pages as mark texts: one per text that has lines in the columns. texts: {entry
  // id: {entry, text, translator}} (poemFacing, workFacing).
  function facingCtxs(fx, texts) {
    return Object.keys(texts || {}).filter((id) => fx.querySelector(`[data-u][data-e="${CSS.escape(id)}"]`)).map((id) => {
      const t = texts[id], prose = isProse(t.text, t.translator);
      return { entry: t.entry, root: fx, col: true, lines: !prose, lay: textLayout(t.text, prose), noQuote: true, noMargin: true };
    });
  }
  function drawMarks() {
    liveCtxs().filter((c) => c.lines).forEach((ctx) => {
      const { entry } = ctx;
      ctxLines(ctx).forEach((l) => { l.classList.remove("has-mark"); l.querySelectorAll(".mark-dot").forEach((d) => d.remove()); });
      marksOf(entry.id).filter((m) => m.kind !== "hl").forEach((m) => {
        for (let i = m.a; i <= m.b; i++) {
          const l = ctxLine(ctx, i);
          if (l) l.classList.add("has-mark");
        }
        const first = ctxLine(ctx, m.a);
        if (!first) return;
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "mark-dot";
        dot.title = "Your note";
        dot.setAttribute("aria-label", "Your note on this line");
        dot.addEventListener("click", (e) => { e.preventDefault(); MARK_CTX = ctx; openMarkEditor(m, false); });
        first.appendChild(dot);
      });
    });
  }
  function hideMarkButton() { if (markBtn) markBtn.hidden = true; }
  // The lines a selection touches, within the text on screen; a drag that ends at the very
  // start of the next line does not take that line.
  function selectedLines() {
    if (!MARK_CTX || !MARK_CTX.root.isConnected) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!MARK_CTX.root.contains(r.commonAncestorContainer) && !r.intersectsNode(MARK_CTX.root)) return null;
    const lines = [...MARK_CTX.root.querySelectorAll(".ln[data-i]")].filter((l) => r.intersectsNode(l) && l.textContent.trim());
    if (lines.length > 1 && r.endOffset === 0 && lines[lines.length - 1].contains(r.endContainer)) lines.pop();
    if (!lines.length) return null;
    const quote = sel.toString().replace(/\s+/g, " ").trim().slice(0, 300);
    if (!quote) return null;
    return { a: +lines[0].dataset.i, b: +lines[lines.length - 1].dataset.i, quote, rect: r.getBoundingClientRect() };
  }
  function checkSelection() {
    const sel = selectedLines();
    if (!sel) { hideMarkButton(); return; }
    if (!markBtn) {
      markBtn = document.createElement("button");
      markBtn.type = "button";
      markBtn.className = "mark-add";
      markBtn.addEventListener("mousedown", (e) => e.preventDefault());   // keeps the selection
      markBtn.addEventListener("click", () => {
        const got = selectedLines() || markBtn.sel;
        hideMarkButton();
        if (got) openMarkEditor({ id: "m" + Date.now().toString(36), a: got.a, b: got.b, quote: got.quote, text: "" }, true);
      });
      document.body.appendChild(markBtn);
    }
    markBtn.sel = sel;
    markBtn.textContent = sel.a === sel.b ? "Note on this line" : `Note on these ${sel.b - sel.a + 1} lines`;
    const width = document.documentElement.clientWidth;
    markBtn.style.top = (window.scrollY + sel.rect.bottom + 10) + "px";
    markBtn.style.left = Math.max(8, Math.min(window.scrollX + sel.rect.left, window.scrollX + width - 210)) + "px";
    markBtn.hidden = false;
  }
  document.addEventListener("selectionchange", () => { clearTimeout(selTimer); selTimer = setTimeout(checkHlSelection, 220); });
  // The note under the last line it covers: a new one, or one opened from its mark.
  function openMarkEditor(m, isNew) {
    if (!MARK_CTX) return;
    const { entry, root } = MARK_CTX;
    root.querySelectorAll(".mark-pop").forEach((p) => p.remove());
    const last = ctxLine(MARK_CTX, m.b);
    const stanza = last && (last.closest(".stanza") || last.closest(".fx-row"));
    const pop = document.createElement("div");
    pop.className = "mark-pop";
    pop.innerHTML = `
      <p class="mark-quote">\u201c${esc(m.quote)}\u201d</p>
      ${isNew ? "" : `<p class="mark-date">${esc(writtenLine(m))}</p>`}
      <textarea class="mark-input" rows="3" maxlength="${MARK_MAX}" aria-label="Your note"
        placeholder="Your note on ${m.a === m.b ? "this line" : "these lines"}\u2026">${esc(m.text || "")}</textarea>
      <div class="mark-actions">
        <button type="button" class="mark-save">Save note</button>
        <button type="button" class="mark-cancel">${isNew ? "Cancel" : "Close"}</button>
        ${isNew ? "" : `<button type="button" class="mark-delete">Delete</button>`}
        <span class="mark-where">${signedIn() ? "Private: kept in your account" : "Private: kept in this browser"}</span>
      </div>`;
    if (stanza) stanza.after(pop); else root.appendChild(pop);
    window.getSelection().removeAllRanges();
    const input = pop.querySelector(".mark-input");
    input.focus();
    pop.querySelector(".mark-save").addEventListener("click", () => {
      putMark(entry, Object.assign({}, m, { text: input.value }));
      pop.remove();
      drawMarks();
    });
    pop.querySelector(".mark-cancel").addEventListener("click", () => pop.remove());
    const del = pop.querySelector(".mark-delete");
    if (del) del.addEventListener("click", () => { putMark(entry, Object.assign({}, m, { text: "" })); pop.remove(); drawMarks(); });
  }
  // Every note on a line, newest first: [{id (the text's), g (its group), m}]
  function markRows() {
    const rows = [];
    Object.entries(allMarks()).forEach(([id, g]) => ((g && g.items) || []).forEach((m) => rows.push({ id, g, m })));
    return rows.sort((x, y) => String(y.m.updated).localeCompare(String(x.m.updated)));
  }
  const markRowHTML = ({ id, g, m }) => `
      <li class="mark-row${m.kind === "hl" ? " is-hl" : ""}">
        <p class="mark-row-quote">${m.kind === "hl" ? `<span class="hl-chip hl-${esc(HL_COLORS.includes(m.color) ? m.color : "yellow")}"></span>` : ""}\u201c${esc(m.quote)}\u201d</p>
        ${m.text ? `<p class="mark-row-note">${esc(m.text)}</p>` : ""}
        <p class="mark-row-src"><a href="${esc(routeFor(id))}">${esc(g.title || "")}</a>${g.author ? ` \u00b7 ${esc(g.author)}` : ""} \u00b7 ${esc(writtenLine(m))}</p>
      </li>`;

  // ---------- highlights: coloured, with an optional note, on any text ----------
  // Select words in a poem or a book of a long work (verse or prose) and a small bar offers
  // four colours and a note. Kept with the line notes (pc-marks, synced to the account) as
  // items {id, kind: "hl", s, e (character offsets in the text), quote, color, text}; a: -1
  // keeps them out of the line-note drawing of older copies of this script.
  const HL_COLORS = ["yellow", "green", "blue", "pink"];
  const HL_NAMES = { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink" };
  let HL_CTX = null, hlBar = null, hlPop = null;
  const hlOf = (id) => marksOf(id).filter((m) => m.kind === "hl");
  function putHighlight(entry, h, remove) {
    const marks = allMarks();
    const g = marks[entry.id] || { title: entry.title, author: entry.author, kind: entry.kind, translator: entry.translator || "", items: [] };
    g.items = (g.items || []).filter((x) => x.id !== h.id);
    const now = new Date().toISOString();
    if (!remove) g.items.push({ id: h.id, kind: "hl", a: -1, s: h.s, e: h.e, quote: String(h.quote || "").slice(0, 600),
      color: HL_COLORS.includes(h.color) ? h.color : "yellow", text: String(h.text || "").slice(0, MARK_MAX),
      created: h.created || now, updated: now, ...(h.rv ? { rv: h.rv } : {}) });   // rv: its review schedule, kept
    if (g.items.length) marks[entry.id] = g; else delete marks[entry.id];
    writeStore(MARKS_KEY, { v: 1, marks });
    updateShelfNav();
  }
  // The text nodes of the text on screen with their offsets (pop-ups and buttons left out).
  function hlNodes(root) {
    const nodes = []; let pos = 0;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) =>
      n.parentElement && n.parentElement.closest(".mark-pop, .mark-dot, .mn-col") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push({ n, s: pos }); pos += n.nodeValue.length; }
    return nodes;
  }
  function pointOffset(nodes, container, offset) {
    if (container.nodeType === 3) { const f = nodes.find((x) => x.n === container); if (f) return f.s + offset; }
    const r = document.createRange(); r.setStart(container, offset);
    const f = nodes.find((x) => r.comparePoint(x.n, 0) >= 0);
    return f ? f.s : (nodes.length ? nodes[nodes.length - 1].s + nodes[nodes.length - 1].n.nodeValue.length : 0);
  }
  function wrapSpan(nodes, s, e, make) {
    nodes.forEach(({ n, s: ns }) => {
      const ne = ns + n.nodeValue.length;
      if (ne <= s || ns >= e) return;
      let node = n; const a = Math.max(s, ns) - ns, b = Math.min(e, ne) - ns;
      if (b < node.nodeValue.length) node.splitText(b);
      if (a > 0) node = node.splitText(a);
      if (!node.nodeValue.trim()) return;
      const m = make(); node.parentNode.insertBefore(m, node); m.appendChild(node);
    });
  }
  // Where a highlight stands in the text now ([s, e]): at its offsets if its words are still
  // there, else at the nearest place within 500 characters where they are; null when they are
  // not (it is left off the page, and #/notes lists it as "the text has changed").
  function markSpan(full, h) {
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const q = norm(h.quote), s = +h.s || 0, e = +h.e || 0;
    if (e > s && norm(full.slice(s, e)) === q) return [s, e];
    if (!q) return null;
    const head = q.slice(0, 80);
    let best = -1;
    for (let k = full.indexOf(head, Math.max(0, s - 500)); k >= 0 && k <= s + 500; k = full.indexOf(head, k + 1)) {
      if (best < 0 || Math.abs(k - s) < Math.abs(best - s)) best = k;
    }
    return best < 0 ? null : [best, best + q.length];
  }
  function drawHighlights() {
    const ctxs = liveCtxs();
    new Set(ctxs.map((c) => c.root)).forEach((root) => {
      root.querySelectorAll("mark.hl").forEach((m) => m.replaceWith(...m.childNodes));
      root.normalize();
    });
    ctxs.forEach((ctx) => hlOf(ctx.entry.id).forEach((h) => {
      const nodes = ctxNodes(ctx);
      const at = markSpan(ctxFull(ctx, nodes), h);
      if (!at) return;
      const [s, e] = at;
      wrapSpan(nodes, s, e, () => {
        const m = document.createElement("mark");
        if (h.text) m.dataset.note = "1";
        m.className = "hl hl-" + (HL_COLORS.includes(h.color) ? h.color : "yellow") + (h.text ? " has-note" : "");
        m.dataset.hl = h.id;
        if (h.text) m.title = "Your note: " + h.text.slice(0, 120);
        return m;
      });
    }));
    drawMarginNotes();
  }
  // On a screen wide enough, each highlight with a note shows its note as a card in the right
  // margin, level with its first words (pushed down when two would overlap); a click on the
  // card opens it for editing, also in the margin. Narrower screens keep the pop-up.
  const MARGIN_W = 250;
  // Only a text alone has the margin: the columns and side-by-side panes use the pop-up.
  const marginCtx = () => liveCtxs().find((c) => !c.noMargin) || null;
  function marginRoom(ctx) {
    ctx = ctx || marginCtx();
    if (!ctx || ctx.noMargin || !ctx.root.isConnected) return false;
    const r = ctx.root.getBoundingClientRect();
    return document.documentElement.clientWidth - r.right >= MARGIN_W + 70;
  }
  function drawMarginNotes() {
    const ctx = marginCtx();
    if (!ctx) return;
    const root = ctx.root;
    root.querySelectorAll(".mn-col").forEach((c) => c.remove());
    if (!marginRoom(ctx)) return;
    const col = document.createElement("div");
    col.className = "mn-col";
    const base = root.getBoundingClientRect().top;
    let floor = 0;
    hlOf(ctx.entry.id).filter((h) => h.text).map((h) => {
      const m = root.querySelector(`mark.hl[data-hl="${h.id}"]`);
      return m ? { h, top: m.getBoundingClientRect().top - base } : null;
    }).filter(Boolean).sort((a, b) => a.top - b.top).forEach(({ h, top }) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "mn-card hl-edge-" + (HL_COLORS.includes(h.color) ? h.color : "yellow");
      card.dataset.hl = h.id;
      card.innerHTML = `<span class="mn-text">${esc(h.text)}</span>`;
      col.appendChild(card);
      const y = Math.max(top, floor);
      card.style.top = y + "px";
      floor = y + card.offsetHeight + 10;
      card.addEventListener("click", (e) => { e.stopPropagation(); HL_CTX = ctx; openHlPop(h); });
      card.addEventListener("mouseenter", () => root.querySelectorAll(`mark.hl[data-hl="${h.id}"]`).forEach((x) => x.classList.add("is-hover")));
      card.addEventListener("mouseleave", () => root.querySelectorAll(`mark.hl.is-hover`).forEach((x) => x.classList.remove("is-hover")));
    });
    if (col.children.length) root.appendChild(col);
  }
  let mnTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(mnTimer); mnTimer = setTimeout(drawMarginNotes, 150); });
  function hideHlBar() { if (hlBar) hlBar.hidden = true; }
  // The selection, as offsets in the text it was made in (which becomes HL_CTX).
  function hlSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0), ctx = rangeCtx(r);
    if (!ctx) return null;
    if (!sel.toString().trim()) return null;
    HL_CTX = ctx;
    const nodes = ctxNodes(ctx);
    if (!nodes.length) return null;
    let s = pointOffset(nodes, r.startContainer, r.startOffset), e = pointOffset(nodes, r.endContainer, r.endOffset);
    const full = ctxFull(ctx, nodes);
    while (s < e && /\s/.test(full[s])) s++;
    while (e > s && /\s/.test(full[e - 1])) e--;
    if (e <= s) return null;
    return { s, e, ctx, quote: full.slice(s, e).replace(/\s+/g, " ").trim().slice(0, 600), rect: r.getBoundingClientRect() };
  }
  function checkHlSelection() {
    const sel = hlSelection();
    if (!sel) { hideHlBar(); return; }
    if (!hlBar) {
      hlBar = document.createElement("div");
      hlBar.className = "hl-bar";
      hlBar.setAttribute("role", "toolbar");
      hlBar.setAttribute("aria-label", "Highlight, quote or look up");
      hlBar.innerHTML = `<span class="hl-bar-group">` + HL_COLORS.map((c) => `<button type="button" class="hl-swatch hl-${c}" data-c="${c}" aria-label="Highlight in ${HL_NAMES[c].toLowerCase()}" title="${HL_NAMES[c]}"></button>`).join("")
        + `<button type="button" class="hl-note-btn" data-c="note">Note</button></span>`
        + `<span class="hl-bar-group hl-bar-acts">
             <button type="button" class="hl-act" data-act="quote">Copy quote</button>
             <button type="button" class="hl-act" data-act="link">Link to lines</button>
             <button type="button" class="hl-act" data-act="lookup">Look up</button>
             <button type="button" class="hl-act" data-act="passage" aria-haspopup="menu" aria-expanded="false">Add passage to…</button>
             <button type="button" class="hl-act" data-act="learn" aria-haspopup="dialog">Learn by heart</button></span>`;
      hlBar.addEventListener("mousedown", (e) => e.preventDefault());   // keeps the selection
      hlBar.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.stopPropagation(); hideHlBar(); }
      });
      hlBar.addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b || !HL_CTX) return;
        if (b.dataset.act) {                       // Copy quote, Link to lines, Look up
          const q = quoteSelection() || hlBar.q, hadFocus = hlBar.contains(document.activeElement);
          const rect = hlBar.getBoundingClientRect();
          hideHlBar();
          // "Add passage to…": the lines selected, into one of the shelf's collections.
          if (q && b.dataset.act === "passage") {
            window.getSelection().removeAllRanges();
            openShelfMenu(null, rect, { entry: HL_CTX.entry, l: q.a === q.b ? String(q.a) : q.a + "-" + q.b,
              loc: q.loc, first: q.plain.replace(/\s+/g, " ").slice(0, 90) });
            return;
          }
          // "Learn by heart": the lines selected, in the learning view (openLearn).
          if (q && b.dataset.act === "learn") {
            window.getSelection().removeAllRanges();
            const lang = HL_CTX.root.getAttribute("lang");
            openLearn([{ label: "", entry: HL_CTX.entry, text: SEL_CTX.text, translator: SEL_CTX.translator,
                         lang: lang ? ` lang="${esc(lang)}"` : "", ok: true, own: true }], 0, { a: q.a, b: q.b }, null);
            return;
          }
          if (q) quoteAction(b.dataset.act, q, hadFocus);
          return;
        }
        const got = hlSelection() || hlBar.sel; hideHlBar();
        if (!got) return;
        HL_CTX = got.ctx;
        const h = { id: "h" + Date.now().toString(36), s: got.s, e: got.e, quote: got.quote, color: b.dataset.c === "note" ? "yellow" : b.dataset.c, text: "" };
        putHighlight(HL_CTX.entry, h);
        window.getSelection().removeAllRanges();
        drawHighlights();
        if (b.dataset.c === "note") openHlPop(h, true);
      });
      document.body.appendChild(hlBar);
    }
    hlBar.sel = sel;
    hlBar.q = quoteSelection();
    const look = hlBar.q && lookupWords(hlBar.q);
    const lb = hlBar.querySelector('[data-act="lookup"]');
    lb.hidden = !look;
    if (look) { lb.title = "Look up “" + look.join(" ") + "” in " + DICTS[lookupDict()].name; lb.setAttribute("aria-label", lb.title + " (opens a new tab)"); }
    hlBar.querySelector(".hl-bar-acts").hidden = !hlBar.q || !SEL_CTX;
    hlBar.querySelector('[data-act="learn"]').hidden = !(hlBar.q && !hlBar.q.prose && SEL_CTX && SEL_CTX.text
      && hlBar.q.b - hlBar.q.a < LEARN_PASSAGE_MAX);
    const width = document.documentElement.clientWidth;
    // On a phone the bar sits at the foot of the screen, clear of the system's own
    // selection handles and menu; elsewhere under the selection.
    hlBar.classList.toggle("is-docked", width < 640);
    hlBar.hidden = false;
    if (width < 640) { hlBar.style.top = ""; hlBar.style.left = ""; return; }
    hlBar.style.top = (window.scrollY + sel.rect.bottom + 10) + "px";
    hlBar.style.left = Math.max(8, Math.min(window.scrollX + sel.rect.left, window.scrollX + width - hlBar.offsetWidth - 8)) + "px";
  }
  // A highlight clicked (or just made with "Note"): its colour, its note, or remove it.
  function openHlPop(h, focusNote) {
    if (!HL_CTX) return;
    closeHlPop();
    const el = HL_CTX.root.querySelector(`mark.hl[data-hl="${CSS.escape(h.id)}"]`);
    if (!el) return;
    hlPop = document.createElement("div");
    hlPop.className = "hl-pop";
    hlPop.innerHTML = `
      <p class="mark-quote">“${esc(h.quote.length > 160 ? h.quote.slice(0, 160) + "…" : h.quote)}”</p>
      <div class="hl-colors">${HL_COLORS.map((c) => `<button type="button" class="hl-swatch hl-${c}" data-c="${c}" aria-pressed="${h.color === c}" aria-label="${HL_NAMES[c]}"></button>`).join("")}</div>
      <textarea class="mark-input" rows="3" maxlength="${MARK_MAX}" aria-label="Your note" placeholder="A note on these words…">${esc(h.text || "")}</textarea>
      <div class="mark-actions">
        <button type="button" class="mark-save">Save</button>
        <button type="button" class="mark-cancel">Close</button>
        <button type="button" class="mark-delete">Remove highlight</button>
        <span class="mark-where">${signedIn() ? "Private: kept in your account" : "Private: kept in this browser"}</span>
      </div>`;
    document.body.appendChild(hlPop);
    const r = el.getBoundingClientRect(), width = document.documentElement.clientWidth;
    if (marginRoom(HL_CTX)) {
      const tr = HL_CTX.root.getBoundingClientRect();
      hlPop.classList.add("in-margin");
      hlPop.style.top = (window.scrollY + r.top - 6) + "px";
      hlPop.style.left = (window.scrollX + tr.right + 46) + "px";
    } else {
      hlPop.style.top = (window.scrollY + r.bottom + 8) + "px";
      hlPop.style.left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + width - Math.min(380, width - 16) - 8)) + "px";
    }
    const input = hlPop.querySelector(".mark-input");
    if (focusNote) input.focus();
    let color = h.color;
    hlPop.querySelectorAll(".hl-colors button").forEach((b) => b.addEventListener("click", () => {
      color = b.dataset.c;
      hlPop.querySelectorAll(".hl-colors button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      putHighlight(HL_CTX.entry, Object.assign({}, h, { color, text: input.value })); drawHighlights();
    }));
    hlPop.querySelector(".mark-save").addEventListener("click", () => { putHighlight(HL_CTX.entry, Object.assign({}, h, { color, text: input.value })); closeHlPop(); drawHighlights(); });
    hlPop.querySelector(".mark-cancel").addEventListener("click", closeHlPop);
    hlPop.querySelector(".mark-delete").addEventListener("click", () => { putHighlight(HL_CTX.entry, h, true); closeHlPop(); drawHighlights(); });
  }
  function closeHlPop() { if (hlPop) { hlPop.remove(); hlPop = null; } }

  // ---------- quoting a selection: copy with its citation, link to the lines, look up ----------
  // The highlight bar also offers "Copy quote" (the words as laid out, then the MLA entry with
  // the lines: "…, lines 1–7. Poetry Codex, …"; the confirmation offers Chicago instead),
  // "Link to lines" (this page's address with ?l=FIRST-LAST, counted in the order the lines
  // stand, data-i + 1, or paragraphs in a prose text) and, for one to three words, "Look up"
  // in a dictionary of the text's language, in a new tab. Nothing is stored or sent anywhere.
  // A page opened with ?l= scrolls to those lines and lights them for three seconds.
  // Shift+F10 or the menu key brings the bar up for a keyboard selection.
  let SEL_CTX = null;                  // {cite, dict} for the text on screen
  const DICTS = {
    en: { name: "Wiktionary", url: (w) => "https://en.wiktionary.org/wiki/" + w.map((x) => encodeURIComponent(x.toLowerCase())).join("_") },
    ang: { name: "Bosworth-Toller", url: (w) => "https://bosworthtoller.com/search?q=" + encodeURIComponent(w.join(" ").toLowerCase()) },
    enm: { name: "the Middle English Compendium", url: (w) => "https://quod.lib.umich.edu/m/middle-english-dictionary/dictionary?utf8=%E2%9C%93&search_field=hnf&q=" + encodeURIComponent(w.join(" ").toLowerCase()) },
    tr: { name: "TDK Sözlük", url: (w) => "https://sozluk.gov.tr/?ara=" + encodeURIComponent(w.join(" ").toLocaleLowerCase("tr")) },
  };
  // The dictionary follows the text's own language: Old English and Middle English originals
  // by the poet's era (or, on a page drawn before the index, by their letters), Turkish as
  // langAttr marks it; translations and everything else are English.
  function bindQuoteTools(cite, authorSlug, translator, text) {
    const cat = (POETS[authorSlug] || {}).category || "";
    const own = !String(translator || "").trim(), sample = String(text || "").slice(0, 4000);
    let dict = "en";
    if (own && (cat === "Anglo-Saxon" || (!cat && /[æðÆÐ]/.test(sample)))) dict = "ang";
    else if (own && (cat === "Medieval" || (!cat && looksArchaic(sample)))) dict = "enm";
    else if (langAttr(authorSlug, translator) || (own && !cat && /[ğışĞİŞ]/.test(sample))) dict = "tr";
    SEL_CTX = { cite, dict, text, translator };   // the text: "Learn by heart" on a selected passage
  }
  const lookupDict = () => (SEL_CTX && SEL_CTX.dict) || "en";
  // The words of a short selection, stripped of punctuation; null for none or over three.
  function lookupWords(q) {
    const w = q.plain.split(/\s+/).map((x) => x.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, "")).filter(Boolean);
    return w.length >= 1 && w.length <= 3 ? w : null;
  }
  // What the selection covers: the lines (verse) or paragraphs (prose) it touches, the words
  // as laid out, the place to cite (loc) and the units to link (a, b, counted from 1).
  function quoteSelection() {
    if (!HL_CTX || HL_CTX.noQuote || !HL_CTX.root.isConnected) return null;   // the page's own text only
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0), root = HL_CTX.root;
    if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
    const prose = root.classList.contains("is-prose");
    const all = [...root.querySelectorAll(prose ? ":scope > p" : ".ln[data-i]")];
    const units = all.filter((u) => r.intersectsNode(u));
    if (units.length > 1 && r.endOffset === 0 && units[units.length - 1].contains(r.endContainer)) units.pop();
    const parts = units.map((u) => {
      const ur = document.createRange(); ur.selectNodeContents(u);
      if (u.contains(r.startContainer)) ur.setStart(r.startContainer, r.startOffset);
      if (u.contains(r.endContainer)) ur.setEnd(r.endContainer, r.endOffset);
      return { u, t: ur.toString() };
    }).filter((p) => p.t.trim());
    if (!parts.length) return null;
    const first = parts[0].u, last = parts[parts.length - 1].u;
    let text, a, b, loc;
    if (prose) {
      text = parts.map((p) => p.t.replace(/\s+/g, " ").trim()).join("\n\n");
      if (parts.length === 1) text = "“" + text + "”";
      a = all.indexOf(first) + 1; b = all.indexOf(last) + 1;
      if (root.classList.contains("greek-lines") && first.dataset.n) {
        // Murray's Homer: the Greek line each paragraph begins at, to the next one's.
        const ga = +first.dataset.n, next = all[b], gb = next && next.dataset.n ? +next.dataset.n - 1 : 0;
        loc = gb > ga ? `lines ${ga}–${gb}` : gb === ga ? `line ${ga}` : `lines ${ga} ff.`;
      } else loc = a === b ? `para. ${a}` : `paras. ${a}–${b}`;
    } else {
      if (parts.length === 1) text = "“" + parts[0].t.replace(/\s+/g, " ").trim() + "”";
      else text = parts.map((p, k) => {
        const line = k === 0 ? p.t.trim() : p.t.replace(/\s+$/, "");
        const gap = k > 0 && p.u.closest(".stanza") !== parts[k - 1].u.closest(".stanza");
        return (gap ? "\n" : "") + line;
      }).join("\n");
      a = +first.dataset.i + 1; b = +last.dataset.i + 1;
      // Cited by the edition's count (headings left out); a text with none, by its order.
      const counted = parts.map((p) => +p.u.dataset.c).filter(Boolean);
      const ca = counted.length ? counted[0] : a, cb = counted.length ? counted[counted.length - 1] : b;
      loc = ca === cb ? `line ${ca}` : `lines ${ca}–${cb}`;
    }
    return { text, plain: parts.map((p) => p.t).join(" ").trim(), a, b, loc, prose };
  }
  const hashBase = () => (location.hash || "#/").replace(/\?.*$/, "");
  const linePath = (q) => "/" + hashBase() + "?l=" + (q.a === q.b ? q.a : q.a + "-" + q.b);
  // The quotation and its entry, as plain text and as HTML (Word keeps the line breaks).
  function quoteClip(q, style) {
    const all = citations(Object.assign({}, SEL_CTX.cite, { path: linePath(q), loc: q.loc }));
    const c = all.find((x) => x.style === style) || all[0];
    const html = q.text.split(/\n\n/).map((p) => `<p>${p.split("\n").map((l) => esc(l).replace(/^ +/, (s) => " ".repeat(s.length))).join("<br>")}</p>`).join("")
      + `<p>${c.html}</p>`;
    return { text: q.text + "\n\n" + c.text, html };
  }
  function quoteAction(act, q, hadFocus) {
    if (!SEL_CTX) return;
    if (act === "lookup") {
      const w = lookupWords(q);
      if (w) window.open(DICTS[lookupDict()].url(w), "_blank", "noopener");
      return;
    }
    if (act === "link") {
      const url = SITE + linePath(q);
      copyText(url).then(() => selToast(`Link to ${q.loc} copied.`, null, hadFocus), () => copyBox(url, hadFocus));
      return;
    }
    const copy = (style) => {
      const c = quoteClip(q, style);
      copyText(c.text, c.html).then(() => selToast(`Quotation copied with its ${style} citation.`,
        style === "MLA" ? { label: "Chicago instead", run: () => copy("Chicago") } : null, hadFocus),
        () => copyBox(c.text, hadFocus));
    };
    copy("MLA");
  }
  // A small notice at the foot of the screen; also read out by the live region.
  let toastEl = null, toastTimer = 0, liveEl = null;
  function announce(msg) {
    if (!liveEl) {
      liveEl = document.createElement("div");
      liveEl.className = "visually-hidden"; liveEl.setAttribute("aria-live", "polite"); liveEl.setAttribute("role", "status");
      document.body.appendChild(liveEl);
    }
    liveEl.textContent = "";
    setTimeout(() => { liveEl.textContent = msg; }, 50);
  }
  function closeToast() { clearTimeout(toastTimer); if (toastEl) { toastEl.remove(); toastEl = null; } }
  function selToast(msg, action, focus, body) {
    closeToast();
    toastEl = document.createElement("div");
    toastEl.className = "sel-toast";
    toastEl.tabIndex = -1;
    toastEl.setAttribute("aria-label", "Notice");
    toastEl.innerHTML = `<p class="sel-toast-msg">${esc(msg)}</p>${body || ""}
      <div class="sel-toast-acts">${action ? `<button type="button" class="sel-toast-act">${esc(action.label)}</button>` : ""}
      <button type="button" class="sel-toast-close">Close</button></div>`;
    document.body.appendChild(toastEl);
    if (action) toastEl.querySelector(".sel-toast-act").addEventListener("click", action.run);
    toastEl.querySelector(".sel-toast-close").addEventListener("click", closeToast);
    toastEl.addEventListener("keydown", (e) => { if (e.key === "Escape") closeToast(); });
    announce(msg);
    // It stays while the reader is in it; otherwise it goes after a few seconds.
    const later = () => { clearTimeout(toastTimer); toastTimer = setTimeout(closeToast, body ? 30000 : 7000); };
    toastEl.addEventListener("mouseenter", () => clearTimeout(toastTimer));
    toastEl.addEventListener("focusin", () => clearTimeout(toastTimer));
    toastEl.addEventListener("mouseleave", later);
    later();
    if (focus) (toastEl.querySelector(".sel-toast-act") || toastEl).focus();
    return toastEl;
  }
  // The browser refused the clipboard: the text in a box, selected, for Ctrl+C.
  function copyBox(text, focus) {
    const t = selToast("Your browser did not allow copying. The text is selected below: press Ctrl+C (or ⌘C).", null, false,
      `<textarea class="sel-toast-box" readonly rows="5" aria-label="Text to copy">${esc(text)}</textarea>`);
    const box = t.querySelector("textarea");
    box.focus(); box.select();
  }
  document.addEventListener("keydown", (e) => {
    if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
    if (!hlSelection()) return;
    e.preventDefault();
    checkHlSelection();
    if (hlBar && !hlBar.hidden) hlBar.querySelector("button").focus();
  });
  window.addEventListener("hashchange", () => { closeToast(); LINES_SHOWN = ""; });

  // ---------- a link to lines: #/work/iliad-murray/0?l=120-124 ----------
  // The page scrolls the first line to about a third of the way down and lights the lines for
  // three seconds (a class, not a highlight). With the facing pages shown, the lines are found
  // again in whichever column holds this text, and the rows they stand in are lit beside
  // them. A range outside the text is ignored. Back, a reload and the redraw when the index
  // arrives keep the reader's own scroll.
  let LINES_SHOWN = "";
  function linkedRange() {
    const m = /[?&]l=(\d+)(?:-(\d+))?(?:&|$)/.exec(location.hash);
    if (!m) return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
    return { a: Math.min(a, b), b: Math.max(a, b) };
  }
  function facingLines(slot, targets) {
    const norm = (t) => t.replace(/\s+/g, " ").trim();
    const want = targets.map((t) => norm(t.textContent));
    for (const sel of [".fx-o .ln", ".fx-t .ln, .fx-t > p"]) {
      const cands = [...slot.querySelectorAll(sel)];
      const k = cands.findIndex((c, x) => want.every((w, j) => cands[x + j] && norm(cands[x + j].textContent) === w));
      if (k >= 0) return cands.slice(k, k + want.length);
    }
    return [];
  }
  function showLinkedLines() {
    const r = linkedRange();
    const root = app.querySelector(".text-solo .poem-text") || app.querySelector(".poem-text");
    if (!r || !root) return;
    const prose = root.classList.contains("is-prose");
    const units = [...root.querySelectorAll(prose ? ":scope > p" : ".ln[data-i]")];
    if (r.a < 1 || r.b > units.length) return;
    let lit = units.slice(r.a - 1, r.b);
    const slot = app.querySelector(".fx-slot:not([hidden])");
    if (slot) {
      const found = facingLines(slot, lit);
      if (!found.length) return;
      lit = found.concat(found.map((el) => el.closest(".fx-t") && el.closest(".fx-row").querySelector(".fx-o")).filter(Boolean));
    }
    const what = `Linked ${prose ? "paragraph" : "line"}${r.a === r.b ? " " + r.a : `s ${r.a} to ${r.b}`}`;
    let desc = document.getElementById("linked-desc");
    if (!desc) { desc = document.createElement("span"); desc.id = "linked-desc"; desc.className = "visually-hidden"; root.before(desc); }
    desc.textContent = what;
    (slot || root).setAttribute("aria-describedby", "linked-desc");
    if (LINES_SHOWN === location.hash) return;     // drawn again in place: the reader's scroll stands
    LINES_SHOWN = location.hash;
    const st = history.state;
    const target = lit.find((el) => el.getClientRects().length);
    if (!target) return;
    if (!(st && typeof st.y === "number")) jumpTo(Math.max(0, window.scrollY + target.getBoundingClientRect().top - window.innerHeight * 0.3));
    lit.forEach((el) => el.classList.add("ln-linked"));
    setTimeout(() => lit.forEach((el) => el.classList.remove("ln-linked")), 3000);
    announce(what + ".");
  }

  // ---------- study notes: the editors' glosses on a work ----------
  // For the works in GLOSSED, data/glosses/<slug>/<book>.json holds the notes on that book:
  // [{id, anchor, occurrence, kind, title, greek, ref, short, body, sources: [{cite, url}], see}].
  // Each anchor is underlined in the text; a click opens the note. Readers can hide them.
  // Every text on screen that has notes shows them: alone, in its facing-page column, or as
  // one of two translations side by side (each with its own count above it and list below).
  const GLOSSED = new Set(["iliad-murray", "paradise-lost", "odyssey-murray", "aeneid-mackail", "gilgamish-thompson"]);
  const GLOSS_OFF_KEY = "pc-gloss-off";
  const glossOff = () => prefs().gloss === false;   // pc-prefs (was pc-gloss-off, read once by the Aa section)
  const GLOSS_CACHE = {};
  let GLOSS_NOW = null, glPop = null;
  // Single poems with notes are listed in data/glosses/poems/index.json (["keats/0", ...]);
  // their notes are in data/glosses/poems/<poet>/<n>.json.
  let GLOSSED_POEMS = null;
  const glossedPoems = () => GLOSSED_POEMS || (GLOSSED_POEMS = fetch("data/glosses/poems/index.json")
    .then((r) => r.ok ? r.json() : []).catch(() => []).then((a) => new Set(Array.isArray(a) ? a : [])));
  async function glossUrl(entry) {
    const id = (entry && entry.id) || "";
    const m = /^work:([^/]+)\/(\d+)$/.exec(id);
    if (m) return GLOSSED.has(m[1]) ? `data/glosses/${m[1]}/${m[2]}.json` : null;
    if (/^[\w-]+\/\d+$/.test(id) && (await glossedPoems()).has(id)) return `data/glosses/poems/${id}.json`;
    return null;
  }
  async function drawGlosses(ctx) {
    if (!ctx) return;
    const entry = ctx.entry;
    const url = await glossUrl(entry);
    if (!url) return;
    const notes = await (GLOSS_CACHE[url] || (GLOSS_CACHE[url] = fetch(url).then((r) => r.ok ? r.json() : []).catch(() => [])));
    if (!HL_ALL.includes(ctx) || !ctx.root.isConnected || !Array.isArray(notes) || !notes.length) return;
    const root = ctx.root;
    // Drawn again (the facing pages turned off and on): the count and the list are made anew.
    if (ctx.glBar) ctx.glBar.remove();
    if (ctx.glList) ctx.glList.remove();
    const set = { notes, byId: new Map(notes.map((n) => [n.id, n])), ctx };
    ctx.gloss = GLOSS_NOW = set;
    const on = !glossOff();
    if (on) {
      notes.forEach((g) => {
        if (!g.anchor) return;
        const nodes = ctxNodes(ctx);
        const full = ctxFull(ctx, nodes);
        let at = -1;
        for (let c = 0; c < (g.occurrence || 1); c++) { at = full.indexOf(g.anchor, at + 1); if (at < 0) break; }
        if (at < 0) return;
        const end = at + g.anchor.length;
        if (nodes.some(({ n, s }) => s < end && s + n.nodeValue.length > at && n.parentElement.closest(".gl"))) return;
        wrapSpan(nodes, at, end, () => {
          const b = document.createElement("span");
          b.className = "gl"; b.dataset.g = g.id; b.tabIndex = 0; b.setAttribute("role", "button");
          b.setAttribute("aria-label", "Study note: " + g.title);
          return b;
        });
      });
    }
    const bar = document.createElement("div");
    bar.className = "gl-count";
    bar.innerHTML = `<span class="gl-count-label">Study notes</span> <span>${num(notes.length)} note${notes.length === 1 ? "" : "s"} on this ${/^work:/.test(entry.id) ? "book" : "poem"} by the editors${on ? ": click an underlined word" : ""}.</span>
      <button type="button" class="gl-flip" aria-pressed="${on}">${on ? "Hide them" : "Show them"}</button>
      <a class="gl-all" href="#gl-list">All notes ↓</a>`;
    root.before(bar);
    ctx.glBar = bar;
    bar.querySelector(".gl-all").addEventListener("click", (e) => { e.preventDefault(); list.scrollIntoView({ behavior: "smooth" }); });
    bar.querySelector(".gl-flip").addEventListener("click", () => {
      setReadPref({ gloss: !on });
      const y = window.scrollY; window.dispatchEvent(new HashChangeEvent("hashchange")); setTimeout(() => window.scrollTo(0, y), 60);
    });
    const list = document.createElement("section");
    list.className = "gl-list";
    if (!document.getElementById("gl-list")) list.id = "gl-list";
    list.innerHTML = `<h2 class="section-label">Study notes on this ${/^work:/.test(entry.id) ? "book" : "poem"}</h2><ol>${notes.map((g) =>
      `<li><button type="button" class="gl-li" data-g="${esc(g.id)}"><span class="gl-li-t">${esc(g.title)}</span>${g.ref ? ` <span class="gl-li-r">${esc(g.ref)}</span>` : ""}</button><span class="gl-li-s">${esc(g.short || "")}</span></li>`).join("")}</ol>`;
    root.after(list);
    ctx.glList = list;
    list.querySelectorAll(".gl-li").forEach((b) => b.addEventListener("click", () => openGloss(b.dataset.g, b, set)));
  }
  // The notes an underlined word belongs to: those of the text (or column) it stands in.
  function glossSetAt(el) {
    const line = el.closest("[data-e]");
    const c = liveCtxs().find((x) => x.gloss && x.root.contains(el) && (!x.col || (line && line.dataset.e === x.entry.id)));
    return c ? c.gloss : GLOSS_NOW;
  }
  function openGloss(id, el, set) {
    set = set || glossSetAt(el);
    if (!set) return;
    const g = set.byId.get(id);
    if (!g) return;
    closeGloss();
    glPop = document.createElement("aside");
    glPop.className = "gl-pop";
    glPop.setAttribute("role", "dialog");
    glPop.setAttribute("aria-label", "Study note: " + g.title);
    const see = (g.see || []).map((x) => set.byId.get(x)).filter(Boolean);
    glPop.innerHTML = `
      <button type="button" class="gl-close" aria-label="Close">×</button>
      <p class="gl-kind">${esc(g.kind || "note")}${g.ref ? ` · ${esc(g.ref)}` : ""}</p>
      <h3 class="gl-title">${esc(g.title)}</h3>
      ${g.greek ? `<p class="gl-greek">${esc(g.greek)}</p>` : ""}
      ${g.short ? `<p class="gl-short">${esc(g.short)}</p>` : ""}
      <div class="gl-body">${String(g.body || "").split(/\n\s*\n/).map((t) => `<p>${esc(t)}</p>`).join("")}</div>
      ${see.length ? `<p class="gl-see">See also: ${see.map((x) => `<button type="button" class="gl-see-b" data-g="${esc(x.id)}">${esc(x.title)}</button>`).join(", ")}</p>` : ""}
      ${(g.sources || []).length ? `<details class="gl-src"><summary>Sources</summary><ul>${g.sources.map((x) =>
        `<li>${x.url ? `<a href="${esc(x.url)}" rel="noopener" target="_blank">${esc(x.cite)}</a>` : esc(x.cite)}</li>`).join("")}</ul></details>` : ""}`;
    document.body.appendChild(glPop);
    if (window.matchMedia("(max-width: 760px)").matches) glPop.classList.add("gl-sheet");
    else {
      const r = el.getBoundingClientRect(), width = document.documentElement.clientWidth;
      glPop.style.top = (window.scrollY + r.bottom + 8) + "px";
      glPop.style.left = Math.max(8, Math.min(window.scrollX + r.left - 20, window.scrollX + width - Math.min(460, width - 16) - 8)) + "px";
    }
    glPop.querySelector(".gl-close").addEventListener("click", closeGloss);
    glPop.querySelectorAll(".gl-see-b").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = set.ctx.root.querySelector(`.gl[data-g="${CSS.escape(b.dataset.g)}"]`);
      if (t) t.scrollIntoView({ block: "center" });
      openGloss(b.dataset.g, t || el, set);
    }));
  }
  function closeGloss() { if (glPop) { glPop.remove(); glPop = null; } }
  document.addEventListener("click", (e) => {
    const t = e.target.closest ? e.target : e.target.parentElement;
    if (!t) return;
    const m = t.closest("mark.hl");
    if (m && window.getSelection().isCollapsed) {
      // The text it was made in: a column of the facing pages, one of two translations, or the text alone.
      const ctx = liveCtxs().find((c) => c.root.contains(m) && hlOf(c.entry.id).some((x) => x.id === m.dataset.hl));
      const h = ctx && hlOf(ctx.entry.id).find((x) => x.id === m.dataset.hl);
      if (h) { e.preventDefault(); closeGloss(); HL_CTX = ctx; openHlPop(h); return; }
    }
    if (hlPop && !hlPop.contains(t) && !t.closest(".mn-card, .hl-bar")) closeHlPop();   // the bar's Note just opened it
    const g = t.closest(".gl[data-g]");
    if (g && window.getSelection().isCollapsed) { openGloss(g.dataset.g, g); return; }
    if (glPop && !glPop.contains(t) && !t.closest(".gl-li, .gl-see-b")) closeGloss();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeGloss(); closeHlPop(); }
    const g = e.target.closest && e.target.closest(".gl[data-g]");
    if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openGloss(g.dataset.g, g); }
  });
  window.addEventListener("hashchange", () => { closeHlPop(); hideHlBar(); closeGloss(); });

  // ---------- the reader's readings with the Codex ----------
  // Each reading, answer, gloss or comparison the engine writes for this reader is kept (the
  // last READINGS_MAX, each up to 6,000 characters), so the account page can show them again.
  // pc-readings: {v, items: [{id, kind, label, title, author, text, at}]}.
  const READINGS_KEY = "pc-readings";
  const READINGS_MAX = 30;
  function allReadings() {
    const r = readStore(READINGS_KEY).items;
    return Array.isArray(r) ? r.filter((x) => x && x.id && x.text) : [];
  }
  function recordReading(piece, path, label, text) {
    if (!piece || !piece.id || !String(text || "").trim()) return;
    const kind = path.replace("/api/", "");
    const items = allReadings().filter((x) => !(x.id === piece.id && x.kind === kind && x.label === label));
    items.unshift({ id: piece.id, kind, label, title: piece.title, author: piece.author,
                    text: String(text).slice(0, 6000), at: new Date().toISOString() });
    writeStore(READINGS_KEY, { v: 1, items: items.slice(0, READINGS_MAX) });
  }
  const READING_KINDS = { analyze: "Reading", ask: "Question", gloss: "Gloss", compare: "Comparison" };

  window.addEventListener("storage", (e) => {      // saved or removed in another tab
    if (e.key !== SHELF_KEY && e.key !== NOTES_KEY && e.key !== null) return;
    updateShelfNav();
    if (DATA && /^#\/shelf/.test(location.hash)) renderShelf();
  });

  // ---------- where the reader is in a long work ----------
  // The last book opened in each work and how far into it the reader had read, so the
  // work's contents page and the poet page can offer "Continue reading". Kept in this
  // browser only (pc-reading), like the shelf: {v, works: {slug: {i, frac, at}}}.
  // The same store keeps the place in single poems over LONG_POEM lines (poems: {id: {frac,
  // at, title, author}}, the newest POEMS_MAX), the last RECENT_MAX texts opened (recent:
  // [{id, kind, title, author, at}], poems of any length and books of works) and when that
  // list was last cleared (cleared), so the home page can offer them; all of it is synced
  // with the account under "reading" (MERGE.reading below knows each part).
  const READING_KEY = "pc-reading";
  const LONG_POEM = 60, POEMS_MAX = 40, RECENT_MAX = 20;
  const objOr = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
  function readingWorks() { return objOr(readStore(READING_KEY).works); }
  function readingPoems() { return objOr(readStore(READING_KEY).poems); }
  function readingRecent() {
    const r = readStore(READING_KEY).recent;
    return Array.isArray(r) ? r.filter((it) => it && typeof it.id === "string") : [];
  }
  // Writes one part of the store and keeps the others as they are.
  function writeReading(part) {
    writeStore(READING_KEY, Object.assign({}, readStore(READING_KEY), { v: 1 }, part));
  }
  const roundFrac = (frac) => Math.round(Math.min(1, Math.max(0, frac || 0)) * 1000) / 1000;
  // The record for a work, if its book still exists.
  function readingOf(slug) {
    const r = readingWorks()[slug];
    const w = WORKS[slug];
    return r && w && Number.isInteger(r.i) && w.sections[r.i] ? r : null;
  }
  // more: {title, author, part, n} for the home page, which may be drawn before works.json.
  function setReading(slug, i, frac, more) {
    const works = readingWorks();
    works[slug] = Object.assign({}, works[slug], more, { i, frac: roundFrac(frac), at: new Date().toISOString() });
    writeReading({ works });
  }
  function forgetReading(slug) {
    const works = readingWorks();
    delete works[slug];
    writeReading({ works });
  }
  function setPoemPlace(id, frac, title, author) {
    const poems = readingPoems();
    poems[id] = { frac: roundFrac(frac), at: new Date().toISOString(), title, author };
    const keep = Object.keys(poems).sort((a, b) => String(poems[b].at).localeCompare(String(poems[a].at))).slice(0, POEMS_MAX);
    writeReading({ poems: Object.fromEntries(keep.map((k) => [k, poems[k]])) });
  }
  function forgetPoemPlace(id) {
    const poems = readingPoems();
    delete poems[id];
    writeReading({ poems });
  }
  // it: {id, kind: "poem" | "work", title, author, i?, part?}; a work is one entry, its last book.
  function noteRecent(it) {
    const recent = readingRecent().filter((r) => r.id !== it.id);
    recent.unshift(Object.assign({}, it, { at: new Date().toISOString() }));
    writeReading({ recent: recent.slice(0, RECENT_MAX) });
  }
  function clearRecent() { writeReading({ recent: [], cleared: new Date().toISOString() }); }

  // ---------- reader accounts: the shelf on every device ----------
  // "Continue with Google" (Google Identity Services, loaded only when the reader opens the
  // account page) gives the page a Google-signed token; the site's own Worker checks it at
  // /api/auth/google and sets an HttpOnly session cookie (site-worker/src/accounts.js). From
  // then on the shelf, the notes, the reading places and the facing-page settings are kept in
  // the account as well as here. The browser copy is still the one every page reads: the
  // account's copy is pulled after the first paint and whenever the reader comes back to the
  // tab, and each change is pushed a moment after it is made. A kind changed here since the
  // last sync is merged with the account's (shelf and notes by entry, the newer one winning);
  // one not changed here simply takes the account's copy, so a removal on one device reaches
  // the others. GOOGLE_CLIENT (a meta tag in index.html) empty = no sign-in anywhere.
  const signedIn = () => !!(GOOGLE_CLIENT && readStore(ACCOUNT_KEY).email);
  const syncState = () => { const s = readStore(SYNC_KEY); s.at = s.at || {}; s.dirty = s.dirty || {}; return s; };
  const hasContent = (v) => !!v && Object.keys(v).some((k) => k !== "v" && v[k] && (typeof v[k] !== "object" || Object.keys(v[k]).length));
  const MERGE = {
    shelf(local, server) {
      const items = [], seen = new Set();
      [].concat((local && local.items) || [], (server && server.items) || []).forEach((it) => {
        if (it && typeof it.id === "string" && !seen.has(it.id)) { seen.add(it.id); items.push(it); }
      });
      // A text on both sides keeps the reading status set most recently, on either.
      const theirs = new Map(((server && server.items) || []).filter((it) => it && typeof it.id === "string").map((it) => [it.id, it]));
      items.forEach((it, k) => {
        const o = theirs.get(it.id);
        if (o && o !== it && String(o.statusAt || "") > String(it.statusAt || "")) {
          const c = items[k] = Object.assign({}, it, { statusAt: o.statusAt });
          if (o.status) c.status = o.status; else delete c.status;
        }
        // Learning by heart: each part's newer progress, from either side (mergeLearn).
        if (o && o !== it && o.learn) items[k] = Object.assign({}, items[k], { learn: mergeLearn(items[k].learn, o.learn) });
      });
      items.sort((a, b) => String(b.saved || "").localeCompare(String(a.saved || "")));
      // Collections by id, the more recently changed one winning; one deleted on either side
      // after its last change stays deleted (the newest 100 deletions are remembered).
      const dropped = Object.assign({}, (server && server.dropped) || {});
      Object.entries((local && local.dropped) || {}).forEach(([id, t]) => { if (String(t) > String(dropped[id] || "")) dropped[id] = t; });
      const cols = new Map();
      [].concat((local && local.collections) || [], (server && server.collections) || []).forEach((c) => {
        if (!c || typeof c.id !== "string" || !Array.isArray(c.items)) return;
        const o = cols.get(c.id);
        if (!o || String(c.at || "") > String(o.at || "")) cols.set(c.id, c);
      });
      const collections = [...cols.values()].filter((c) => !(dropped[c.id] && String(dropped[c.id]) >= String(c.at || "")));
      const out = { v: 1, items };
      if (collections.length) out.collections = collections;
      const gone = Object.keys(dropped).sort((a, b) => String(dropped[b]).localeCompare(String(dropped[a]))).slice(0, 100);
      if (gone.length) out.dropped = Object.fromEntries(gone.map((id) => [id, dropped[id]]));
      return out;
    },
    notes(local, server) {
      const notes = Object.assign({}, (server && server.notes) || {});
      Object.entries((local && local.notes) || {}).forEach(([id, n]) => {
        if (!notes[id] || String(n.updated || "") >= String(notes[id].updated || "")) notes[id] = n;
      });
      return { v: 1, notes };
    },
    // Works and long poems by entry, the newer place winning; the recent list as one list,
    // newest first, without what either side cleared.
    reading(local, server) {
      const newer = (part) => {
        const out = Object.assign({}, (server && server[part]) || {});
        Object.entries((local && local[part]) || {}).forEach(([k, r]) => {
          if (r && typeof r === "object" && (!out[k] || String(r.at || "") >= String(out[k].at || ""))) out[k] = r;
        });
        Object.keys(out).forEach((k) => { if (!out[k] || typeof out[k] !== "object") delete out[k]; });
        return out;
      };
      const works = newer("works"), poems = newer("poems");
      const keep = Object.keys(poems).sort((a, b) => String(poems[b].at).localeCompare(String(poems[a].at))).slice(0, POEMS_MAX);
      const cleared = [local && local.cleared, server && server.cleared].map((c) => String(c || "")).sort().pop();
      const seen = new Map();
      [].concat((local && local.recent) || [], (server && server.recent) || []).forEach((r) => {
        if (!r || typeof r.id !== "string" || String(r.at || "") <= cleared) return;
        const o = seen.get(r.id);
        if (!o || String(r.at || "") > String(o.at || "")) seen.set(r.id, r);
      });
      const recent = [...seen.values()].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, RECENT_MAX);
      const out = { v: 1, works, poems: Object.fromEntries(keep.map((k) => [k, poems[k]])), recent };
      if (cleared) out.cleared = cleared;
      return out;
    },
    // This browser's facing-page choices; the Aa choices (aa, see "Aa" below) the newer side's.
    parallel(local, server) {
      const out = Object.assign({}, server || {}, local || {});
      const a = objOr(local && local.aa), b = objOr(server && server.aa);
      if (a.at || b.at) out.aa = String(b.at || "") > String(a.at || "") ? b : a;
      return out;
    },
    marks(local, server) {
      const marks = JSON.parse(JSON.stringify((server && server.marks) || {}));
      Object.entries((local && local.marks) || {}).forEach(([id, g]) => {
        if (!g || !Array.isArray(g.items)) return;
        const into = marks[id] || Object.assign({}, g, { items: [] });
        const byId = new Map((into.items || []).map((m) => [m.id, m]));
        // The later edit wins; its review schedule ("Return to your marks") is the later review of the two.
        const rvAt = (m) => String((m.rv && m.rv.at) || "");
        g.items.forEach((m) => {
          const o = byId.get(m.id);
          if (!o) { byId.set(m.id, m); return; }
          const w = String(m.updated || "") >= String(o.updated || "") ? m : o, other = w === m ? o : m;
          byId.set(m.id, rvAt(other) > rvAt(w) ? Object.assign({}, w, { rv: other.rv }) : w);
        });
        into.items = [...byId.values()].sort((x, y) => x.a - y.a);
        marks[id] = into;
      });
      return { v: 1, marks };
    },
    readings(local, server) {
      const seen = new Map();
      [].concat((local && local.items) || [], (server && server.items) || []).forEach((r) => {
        if (!r || !r.id) return;
        const k = r.id + "|" + r.kind + "|" + r.label;
        const o = seen.get(k);
        if (!o || String(r.at || "") > String(o.at || "")) seen.set(k, r);
      });
      return { v: 1, items: [...seen.values()].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, READINGS_MAX) };
    },
  };
  let pushTimer = 0, pushing = false, lastPull = 0;
  function noteChange(kind) {
    if (!signedIn()) return;
    const s = syncState();
    s.dirty[kind] = (s.dirty[kind] || 0) + 1;
    writeStore(SYNC_KEY, s);
    schedulePush(1500);
  }
  function schedulePush(ms) { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, ms); }
  async function pushNow(keepalive) {
    if (!signedIn()) return;
    if (pushing) { schedulePush(2000); return; }
    const sent = syncState().dirty;
    const kinds = Object.keys(sent).filter((k) => sent[k] && SYNC_KINDS[k]);
    if (!kinds.length) return;
    const body = {};
    kinds.forEach((k) => { body[k] = readStore(SYNC_KINDS[k]); });
    pushing = true;
    try {
      const res = await fetch("/api/data", { method: "PUT", credentials: "same-origin", keepalive: !!keepalive,
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status === 401) { signedOutHere(); return; }
      if (!res.ok) throw new Error(res.status);
      const out = await res.json();
      const s = syncState();
      kinds.forEach((k) => {
        if (out.updated && out.updated[k]) s.at[k] = out.updated[k];
        if (s.dirty[k] === sent[k]) delete s.dirty[k];   // changed again meanwhile: it goes next time
      });
      writeStore(SYNC_KEY, s);
      if (Object.keys(s.dirty).length) schedulePush(1500);
    } catch (e) {
      schedulePush(30000);   // offline or a hiccup: kept here, tried again
    } finally { pushing = false; }
  }
  async function pullNow() {
    if (!signedIn()) return;
    lastPull = Date.now();
    let me;
    try {
      const r = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) return;
      me = await r.json();
    } catch (e) { return; }
    if (!me.signedIn) { signedOutHere(); return; }
    applyAccount(me);
  }
  // The account's copy into this browser (merging what changed here meanwhile).
  function applyAccount(me) {
    writeStore(ACCOUNT_KEY, { name: me.name || "", email: me.email || "" });
    const s = syncState();
    let changed = false, push = false;
    SYNCING = true;
    try {
      Object.entries(SYNC_KINDS).forEach(([kind, key]) => {
        const srv = me.data && me.data[kind];
        if (s.dirty[kind]) {
          writeStore(key, MERGE[kind](readStore(key), srv ? srv.value : null));
          changed = push = true;
        } else if (srv && srv.updated > (s.at[kind] || 0)) {
          writeStore(key, srv.value);
          s.at[kind] = srv.updated;
          changed = true;
        }
      });
    } finally { SYNCING = false; }
    writeStore(SYNC_KEY, s);
    if (changed) takeAccountPrefs();
    if (push) schedulePush(200);
    updateAccountNav();
    if (changed) {
      updateShelfNav();
      if (/^#\/(shelf|account)/.test(location.hash) && DATA) route();
      if (/^#\/notes/.test(location.hash)) { if (app.querySelector(".nb-out") && nbItems().length) nbLoad(); else renderNotes(); }
    }
  }
  function signedOutHere(clearLocal) {
    clearTimeout(pushTimer);
    const keys = [ACCOUNT_KEY, SYNC_KEY].concat(clearLocal ? Object.values(SYNC_KINDS) : []);
    keys.forEach((k) => { delete MEMORY[k]; try { localStorage.removeItem(k); } catch (e) { /* nothing kept */ } });
    updateAccountNav();
    updateShelfNav();
  }
  // The account button at the top right: "Sign in", or the reader's initial and first name.
  function updateAccountNav() {
    const acct = readStore(ACCOUNT_KEY);
    const on = signedIn();
    const first = (String(acct.name || "").split(/\s+/)[0] || "").slice(0, 14);
    document.querySelectorAll("[data-acct]").forEach((a) => {
      a.hidden = !GOOGLE_CLIENT;
      a.classList.toggle("is-in", on);
      a.title = on ? "Your library" : "Sign in";
      a.setAttribute("aria-label", on ? "Your library" + (acct.name ? ", " + acct.name : "") : "Sign in");
      a.querySelector(".tb-acct-av").textContent = on ? (first || acct.email || "?").charAt(0).toUpperCase() : "";
      a.querySelector(".tb-acct-l").textContent = on ? (first || "Library") : "Sign in";
    });
  }
  let GIS_LOADING = null;
  function loadGoogle() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (!GIS_LOADING) GIS_LOADING = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "https://accounts.google.com/gsi/client";
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => { GIS_LOADING = null; reject(new Error("not loaded")); };
      document.head.appendChild(el);
    });
    return GIS_LOADING;
  }
  const darkNow = () => (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  function showGoogleButton(box, status) {
    loadGoogle().then(() => {
      google.accounts.id.initialize({ client_id: GOOGLE_CLIENT, callback: (r) => onCredential(r, status),
        ux_mode: "popup", auto_select: false, use_fedcm_for_button: true, context: "signin" });
      box.innerHTML = "";
      google.accounts.id.renderButton(box, { type: "standard", theme: darkNow() ? "filled_black" : "outline",
        size: "large", text: "continue_with", shape: "pill", logo_alignment: "left", width: 280, locale: "en" });
    }).catch(() => {
      status.textContent = "Google sign-in could not be loaded. Check your connection (or any blocker that stops accounts.google.com) and try again.";
    });
  }
  async function onCredential(resp, status) {
    status.textContent = "Signing in\u2026";
    try {
      const r = await fetch("/api/auth/google", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: resp.credential }) });
      const me = await r.json().catch(() => ({}));
      if (!r.ok || !me.signedIn) throw new Error(me.error || "error " + r.status);
      writeStore(ACCOUNT_KEY, { name: me.name || "", email: me.email || "" });
      // What this browser already holds joins the account (merged, nothing lost).
      const s = syncState();
      Object.entries(SYNC_KINDS).forEach(([kind, key]) => { if (hasContent(readStore(key))) s.dirty[kind] = (s.dirty[kind] || 0) + 1; });
      writeStore(SYNC_KEY, s);
      applyAccount(me);
      route();
    } catch (e) {
      status.textContent = "Sign-in did not work (" + e.message + "). Please try again.";
    }
  }
  async function signOut(clearLocal) {
    await pushNow();
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }); }
    catch (e) { /* the cookie ends anyway when it expires; this browser forgets the account now */ }
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    signedOutHere(clearLocal);
  }
  async function deleteAccount() {
    const r = await fetch("/api/account", { method: "DELETE", credentials: "same-origin", headers: { "content-type": "application/json" } });
    if (!r.ok) throw new Error("error " + r.status);
    signedOutHere(false);
  }
  // Pulled after the first paint, and again on coming back to the tab (at most once a minute);
  // a change not yet sent goes out as the tab is hidden.
  document.addEventListener("visibilitychange", () => {
    if (!signedIn()) return;
    if (document.visibilityState === "visible") { if (Date.now() - lastPull > 60000) pullNow(); }
    else if (Object.keys(syncState().dirty).length) pushNow(true);
  });
  window.addEventListener("online", () => { if (signedIn()) schedulePush(500); });

  // The account page, #/account: the reader's library when signed in (what is saved, the
  // notes on poems and on lines, the readings the Codex wrote for them, then the account's
  // own settings); the sign-in page when not.
  function renderAccount() {
    const acct = readStore(ACCOUNT_KEY);
    setTitle(signedIn() ? "Your library" : "Sign in");
    const seal = `<img class="acct-seal" src="coin-300.webp" alt="" width="96" height="96" />`;
    if (!GOOGLE_CLIENT) {
      app.innerHTML = `<article class="acct"><header class="acct-head">${seal}<div class="acct-id">
        <h1 class="acct-name">Sign in</h1><p class="acct-mail">Accounts are not open yet. Your shelf and notes are kept in this browser meanwhile.</p>
        </div></header></article>`;
      return;
    }
    if (!signedIn()) {
      app.innerHTML = `
        <article class="acct acct-signin">
          <header class="acct-head">${seal}
            <div class="acct-id">
              <p class="acct-kicker">Poetry Codex</p>
              <h1 class="acct-name">Your library, on every device</h1>
              <p class="acct-mail">Signing in is optional: the whole archive is open without it.</p>
            </div>
          </header>
          <ul class="acct-perks">
            <li><span class="acct-perk-t">A shelf that follows you</span>
              <span class="acct-perk-d">Save poems and long works on your phone, read them on your laptop.</span></li>
            <li><span class="acct-perk-t">Notes on the lines</span>
              <span class="acct-perk-d">Select a line in any poem and write beside it; your notes wait for you.</span></li>
            <li><span class="acct-perk-t">Your readings with the Codex</span>
              <span class="acct-perk-d">Every reading and answer the engine writes for you, kept to read again.</span></li>
          </ul>
          <div class="acct-google"><p class="loading">Loading Google sign-in…</p></div>
          <p class="account-status" role="status"></p>
          <p class="acct-small">Poetry Codex keeps only your name, your email address and what you save. No password is ever
          given to the site, and nothing is shared or shown to anyone. By signing in you accept the <a href="/terms/">Terms of
          use</a> and the <a href="/privacy/">privacy notice</a>; you can delete your account at any time.</p>
        </article>`;
      showGoogleButton(app.querySelector(".acct-google"), app.querySelector(".account-status"));
      return;
    }
    const shelf = shelfItems();
    const notes = Object.values(allNotes()).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    const marks = markRows();
    const readings = allReadings();
    const stat = (n, one, many, jump) => `
      <button class="acct-stat" type="button" data-jump="${jump}">
        <span class="acct-stat-n">${num(n)}</span><span class="acct-stat-l">${n === 1 ? one : many}</span>
      </button>`;
    const empty = (t) => `<p class="acct-empty">${t}</p>`;
    const itemRow = (it) => `
      <li class="acct-row"><a href="${esc(routeFor(it.id))}"><span class="acct-row-t">${esc(it.title)}</span>
        <span class="acct-row-by">${esc(byLine(it))}</span></a></li>`;
    const noteRow = (n) => `
      <li class="mark-row"><p class="mark-row-note">${esc(n.text)}</p>
        <p class="mark-row-src"><a href="${esc(routeFor(n.id))}">${esc(n.title || "")}</a>${n.author ? ` · ${esc(n.author)}` : ""} · ${esc(shortDate(n.updated))}</p></li>`;
    const readingRow = (r, k) => `
      <li class="acct-reading">
        <details>
          <summary><span class="acct-r-kind">${esc(READING_KINDS[r.kind] || "Reading")}</span>
            <span class="acct-r-label">${esc(r.label || "")}</span>
            <span class="acct-r-src">${esc(r.title || "")}${r.author ? ` · ${esc(r.author)}` : ""} · ${esc(shortDate(r.at))}</span></summary>
          <div class="acct-r-text">${String(r.text).split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("")}
            <p class="acct-r-go"><a href="${esc(routeFor(r.id))}">Open the text →</a></p></div>
        </details>
      </li>`;
    app.innerHTML = `
      <article class="acct">
        <header class="acct-head">${seal}
          <div class="acct-id">
            <p class="acct-kicker">Your library</p>
            <h1 class="acct-name">${esc(acct.name || acct.email)}</h1>
            <p class="acct-mail">${esc(acct.email)}</p>
          </div>
          <a class="acct-open" href="#/shelf">Open your shelf <span aria-hidden="true">→</span></a>
        </header>
        <p class="acct-sync">Kept in your account and in this browser: sign in with the same Google account on any device
        and everything here is waiting. No one else can see it.</p>
        <div class="acct-stats">
          ${stat(shelf.length, "text saved", "texts saved", "acct-saved")}
          ${stat(notes.length, "note", "notes", "acct-notes")}
          ${stat(marks.length, "note on a line", "notes on lines", "acct-marks")}
          ${stat(readings.length, "reading with the Codex", "readings with the Codex", "acct-readings")}
        </div>

        <section class="acct-sec" id="acct-saved">
          <h2>Recently saved</h2>
          ${shelf.length ? `<ul class="acct-list">${shelf.slice(0, 6).map(itemRow).join("")}</ul>
            ${shelf.length > 6 ? `<p class="acct-more"><a href="#/shelf">All ${num(shelf.length)} on your shelf →</a></p>` : ""}`
            : empty(`Nothing saved yet: open a poem or a long work and press <strong>Save to shelf</strong>.`)}
        </section>
        <section class="acct-sec" id="acct-marks">
          <h2>Notes on lines</h2>
          ${marks.length ? `<ul class="mark-list">${marks.slice(0, 12).map(markRowHTML).join("")}</ul>
            <p class="acct-more"><a href="#/notes">All my notes and highlights${marks.length > 12 ? ` (${num(marks.length + notes.length)})` : ""} →</a></p>`
            : empty(`Select a line, or a few words, in any poem and choose <strong>Note on this line</strong>.`)}
        </section>
        <section class="acct-sec" id="acct-notes">
          <h2>Notes on poems</h2>
          ${notes.length ? `<ul class="mark-list">${notes.slice(0, 6).map(noteRow).join("")}</ul>`
            : empty(`Under any poem, <strong>Add a note</strong> keeps a private note on the whole text.`)}
        </section>
        <section class="acct-sec" id="acct-readings">
          <h2>Readings with the Codex</h2>
          ${readings.length ? `<ul class="acct-readings">${readings.map(readingRow).join("")}</ul>`
            : empty(`Open a poem and choose <strong>Read with the Codex</strong>: every reading, answer or gloss it writes for you is kept here.`)}
        </section>

        <section class="acct-sec acct-settings">
          <h2>Account</h2>
          <div class="acct-set-row">
            <div><p class="acct-set-t">Sign out</p>
              <label class="account-check"><input type="checkbox" class="account-clear"> Also remove my library from this
              browser (on a shared computer). It stays in your account.</label></div>
            <button class="acct-btn account-out" type="button">Sign out</button>
          </div>
          <div class="acct-set-row">
            <div><p class="acct-set-t">Delete my account</p>
              <p class="acct-set-d">Deletes your account and everything kept in it from Poetry Codex, at once and for good.
              What is in this browser stays until you remove it.</p></div>
            <button class="acct-btn acct-btn-quiet account-delete" type="button">Delete account</button>
          </div>
          <p class="account-status" role="status"></p>
          <p class="acct-small"><a href="/privacy/">Privacy and personal data</a> · <a href="/terms/">Terms of use</a></p>
        </section>
      </article>`;
    app.querySelectorAll(".acct-stat").forEach((b) => b.addEventListener("click", () => {
      const to = document.getElementById(b.dataset.jump);
      if (to) to.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    const status = app.querySelector(".account-status");
    app.querySelector(".account-out").addEventListener("click", async () => {
      status.textContent = "Signing out…";
      await signOut(app.querySelector(".account-clear").checked);
      route();
    });
    app.querySelector(".account-delete").addEventListener("click", async () => {
      if (!confirm("Delete your Poetry Codex account and everything kept in it? This cannot be undone.")) return;
      status.textContent = "Deleting…";
      try { await deleteAccount(); route(); status.textContent = ""; }
      catch (e) { status.textContent = "It could not be deleted just now (" + e.message + "). Please try again."; }
    });
  }

  // How far down the text the reader is: the point a third of the way down the window.
  // A long single poem is followed the same way, as {poem: id, title, author, el}.
  let READING_NOW = null;    // {slug, i, el} while a book of a work is on screen
  let pendingResume = null;  // {slug, i, frac} or {poem, frac} set by a "Continue reading" link
  let readingTimer = 0;
  function readingFrac(el) {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (window.innerHeight * 0.3 - r.top) / Math.max(1, r.height)));
  }
  function noteReading() {
    const n = READING_NOW;
    if (!n || !n.el.isConnected) return;
    if (n.poem) setPoemPlace(n.poem, readingFrac(n.el), n.title, n.author);
    else setReading(n.slug, n.i, readingFrac(n.el));
  }
  // Saved two seconds after the reader stops scrolling, and at once when the tab is hidden.
  window.addEventListener("scroll", () => {
    if (!READING_NOW) return;
    clearTimeout(readingTimer); readingTimer = setTimeout(noteReading, 2000);
    drawProgress();
  }, { passive: true });
  window.addEventListener("resize", () => { if (READING_NOW) drawProgress(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && READING_NOW) { clearTimeout(readingTimer); noteReading(); }
  });

  // The thin bar under the top edge of a book or a long poem: how much of the text block
  // (not the page) has been on screen, full once its last line is in view.
  const progressHTML = () => `<div class="read-progress" role="progressbar" aria-label="Reading progress"
    aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="read-progress-fill"></span></div>`;
  let progressFrame = 0;
  function drawProgress() {
    if (progressFrame) return;
    progressFrame = requestAnimationFrame(() => {
      progressFrame = 0;
      const bar = app.querySelector(".read-progress");
      const n = READING_NOW;
      if (!bar || !n || !n.el.isConnected) return;
      const r = n.el.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (window.innerHeight - r.top) / Math.max(1, r.height)));
      const pct = Math.round(frac * 100);
      bar.firstElementChild.style.transform = `scaleX(${frac})`;
      if (bar.getAttribute("aria-valuenow") !== String(pct)) bar.setAttribute("aria-valuenow", pct);
    });
  }

  // "about 22 min" for a book or a long poem: 25 lines a minute for verse, 200 words for prose.
  function readTime(text, prose) {
    const min = prose ? String(text || "").split(/\s+/).filter(Boolean).length / 200 : lineCount(text) / 25;
    return min < 1 ? "<1 min" : `about ${Math.round(min)} min`;
  }
  // What a work calls its parts, from a part's title ("Book I", "Canto 3"): "Book 7 of 24".
  function partCount(title, i, n) {
    const m = String(title || "").match(/^(book|canto|fitt|fytte|part|chapter|song|section|letter|day|duan)\b/i);
    const unit = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : "Part";
    return `${unit} ${i + 1} of ${n}`;
  }
  // The place to offer: the book left off in; the next one when that book was finished;
  // the first again when the whole work was.
  function resumePoint(w) {
    const r = readingOf(w.slug);
    if (!r) return null;
    const last = w.sections.length - 1;
    const done = r.frac >= 0.95;
    if (done && r.i < last) return { i: r.i + 1, frac: 0, after: w.sections[r.i].title, at: r.at };
    if (done) return { i: 0, frac: 0, again: true, at: r.at };
    return { i: r.i, frac: r.frac || 0, at: r.at };
  }
  // A "Continue reading" link. withTitle: name the work too (on the poet page).
  function continueHTML(w, withTitle) {
    const p = resumePoint(w);
    if (!p) return "";
    const part = w.sections[p.i].title;
    const meta = p.after ? `You finished ${esc(p.after)} · ${esc(shortDate(p.at))}`
      : p.again ? `You reached the end${w.sections.length > 1 ? " of " + esc(w.sections[w.sections.length - 1].title) : ""} · ${esc(shortDate(p.at))}`
      : (p.frac >= 0.05 ? `About ${Math.round(p.frac * 20) * 5}% through · ` : "") + `Last opened ${esc(shortDate(p.at))}`;
    const grouped = otherTranslations(w).length > 0;
    const label = (p.again ? "Read it again" : "Continue reading") +
      (withTitle ? " · " + w.title + (grouped ? ` (${verShort(w)})` : "") : "");
    return `
      <a class="continue" href="#/work/${esc(w.slug)}/${p.i}" data-resume="${esc(w.slug)}" data-i="${p.i}" data-frac="${p.frac}">
        <span class="continue-label">${esc(label)}</span>
        <span class="continue-part">${esc(part)} <span aria-hidden="true">→</span></span>
        <span class="continue-meta">${meta}</span>
      </a>`;
  }
  // The links remember where to scroll to: the book opens at the place it was left.
  function bindContinue() {
    app.querySelectorAll("a.continue").forEach((a) => a.addEventListener("click", () => {
      pendingResume = { slug: a.dataset.resume, i: +a.dataset.i, frac: +a.dataset.frac || 0 };
    }));
  }

  // ---------- the home page's "Continue reading" and "Recently read" ----------
  // Above the poem of the day: the one or two places last left in a work or a long poem
  // (a finished book offers the next; a finished work or poem is not offered), each with
  // "Forget"; under them a closed fold with the last ten texts opened and "Clear". Drawn
  // from pc-reading alone, so it is the same before and after the index arrives; nothing
  // at all when there is nothing to show.
  function homePlaces() {
    const places = [];
    Object.entries(readingWorks()).forEach(([slug, r]) => {
      if (!r || !Number.isInteger(r.i)) return;
      const w = WORKS[slug];
      let p;
      if (w) {
        p = resumePoint(w);
        if (!p || p.again) return;
        p = { i: p.i, frac: p.frac, n: w.sections.length, part: w.sections[p.i].title,
              title: r.title || w.title + (otherTranslations(w).length ? ` (${verShort(w)})` : ""), author: w.author };
      } else {
        if (!r.title || !r.n) return;
        const done = r.frac >= 0.95;
        if (done && r.i >= r.n - 1) return;
        p = done ? { i: r.i + 1, frac: 0, n: r.n, part: r.part } : { i: r.i, frac: r.frac || 0, n: r.n, part: r.part };
        p.title = r.title; p.author = r.author;
      }
      places.push(Object.assign(p, { slug, at: r.at || "" }));
    });
    Object.entries(readingPoems()).forEach(([id, r]) => {
      if (r && r.title && (r.frac || 0) < 0.95) places.push({ poem: id, frac: r.frac || 0, title: r.title, author: r.author, at: r.at || "" });
    });
    return places.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 2);
  }
  function homeReadingHTML() {
    const places = homePlaces(), recent = readingRecent().slice(0, 10);
    if (!places.length && !recent.length) return "";
    const pct = (f) => f >= 0.05 ? `${Math.round(f * 100)}% through` : "Just begun";
    const cards = places.map((p) => {
      const where = p.poem ? pct(p.frac)
        : [p.n > 1 ? partCount(p.part, p.i, p.n) : "", p.frac >= 0.05 ? pct(p.frac) : ""].filter(Boolean).join(" · ");
      const link = p.poem
        ? `href="#/poem/${esc(p.poem)}" data-resume-poem="${esc(p.poem)}" data-frac="${p.frac}"`
        : `href="#/work/${esc(p.slug)}/${p.i}" data-resume="${esc(p.slug)}" data-i="${p.i}" data-frac="${p.frac}"`;
      return `
        <div class="hc-item">
          <a class="continue" ${link}>
            <span class="continue-label">Continue reading</span>
            <span class="continue-part">${esc(p.title)} <span aria-hidden="true">→</span></span>
            <span class="continue-meta">${[p.author, where].filter(Boolean).map(esc).join(" · ")}</span>
          </a>
          <button class="continue-forget hc-forget" type="button" ${p.poem ? `data-poem="${esc(p.poem)}"` : `data-work="${esc(p.slug)}"`}
            aria-label="Forget my place in ${esc(p.title)}">Forget</button>
        </div>`;
    }).join("");
    const rows = recent.map((r) => {
      const work = r.kind === "work" && r.id.startsWith("work:");
      const href = work ? `#/work/${r.id.slice(5)}/${Number.isInteger(r.i) ? r.i : ""}`.replace(/\/$/, "") : `#/poem/${r.id}`;
      const title = work && r.part ? `${r.title} · ${r.part}` : r.title;
      return `<li><a href="${esc(href)}"><span class="rr-title">${esc(title)}</span>
        <span class="rr-by">${[r.author, shortDate(r.at)].filter(Boolean).map(esc).join(" · ")}</span></a></li>`;
    }).join("");
    return `
      <section class="home-reading" aria-label="Your reading">
        ${cards ? `<div class="hc-list">${cards}</div>` : ""}
        ${rows ? `<details class="recent-fold">
          <summary>Recently read</summary>
          <ul class="recent-list">${rows}</ul>
          <button class="continue-forget recent-clear" type="button">Clear this list</button>
        </details>` : ""}
      </section>`;
  }
  // One listener for every page: a "Continue reading" link (home, work contents, poet page)
  // remembers where to scroll to; Forget and Clear redraw the home section in place.
  app.addEventListener("click", (e) => {
    const a = e.target.closest("a.continue");
    if (a && a.dataset.resumePoem) pendingResume = { poem: a.dataset.resumePoem, frac: +a.dataset.frac || 0 };
    else if (a && a.dataset.resume) pendingResume = { slug: a.dataset.resume, i: +a.dataset.i, frac: +a.dataset.frac || 0 };
    const b = e.target.closest(".hc-forget, .recent-clear");
    const box = b && b.closest(".home-reading");
    if (!box) return;
    if (b.classList.contains("recent-clear")) clearRecent();
    else if (b.dataset.poem) forgetPoemPlace(b.dataset.poem);
    else forgetReading(b.dataset.work);
    const html = homeReadingHTML();
    if (!html) { box.remove(); const potd = app.querySelector(".potd"); if (potd) potd.focus(); return; }
    box.outerHTML = html;
    const next = app.querySelector(".home-reading .hc-forget, .home-reading summary");
    if (next) next.focus();
  });

  // Turkish & Ottoman poems with no translator are in Turkish (screen readers, hyphenation);
  // the page around them stays English. Same rule as text_lang in tools/build_pages.py.
  const langAttr = (authorSlug, translator) =>
    POETS[authorSlug] && POETS[authorSlug].category === "Turkish & Ottoman" && !String(translator || "").trim()
      ? ' lang="tr"' : "";

  // ---------- poem text ----------
  // Prose translations are printed as prose in their source editions, in two shapes:
  // one paragraph per line (Gordon's riddles, Kennedy's Cynewulf, Chodzko's Köroğlu,
  // Wharton's Sappho: most of the text in lines over 200 characters), or hard-wrapped at
  // about 70 characters (Butler's Homer, Riley's Ovid, Southey's Cid, Evelyn-White's
  // Hymns, Weston's Gawain: most lines start in lower case, which verse of this period
  // almost never does). Measured in October 2026 the two groups separate cleanly from
  // every verse text; Gummere's Beowulf starts lines in lower case but its lines are short.
  // Same rule as is_prose in tools/build_pages.py.
  const trimmedLines = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  function isProse(text, translator) {
    if (!String(translator || "").trim()) return false;
    const ls = trimmedLines(text);
    const all = ls.reduce((a, l) => a + l.length, 0);
    if (!all) return false;
    if (ls.reduce((a, l) => a + (l.length > 200 ? l.length : 0), 0) / all >= 0.5) return true;
    if (ls.length < 2) return false;
    const lens = ls.map((l) => l.length).sort((a, b) => a - b);
    return ls.filter((l) => /^[a-z]/.test(l)).length / ls.length >= 0.5 && lens[ls.length >> 1] >= 55;
  }
  const lineCount = (text) => trimmedLines(text).length;
  // Prose: hard-wrapped lines are joined back into paragraphs. A line well short of the
  // text's usual width (or a one-line paragraph over 200 characters) ends a paragraph.
  function proseHTML(text) {
    const lens = trimmedLines(text).map((l) => l.length).sort((a, b) => a - b);
    const width = lens[Math.floor(lens.length * 0.9)] || 0;
    const paras = [];
    for (const st of String(text || "").split(/\n\s*\n/)) {
      let cur = [];
      for (const l of trimmedLines(st)) {
        cur.push(l);
        if (l.length > 200 || l.length < width - 15) { paras.push(cur.join(" ")); cur = []; }
      }
      if (cur.length) paras.push(cur.join(" "));
    }
    return paras.map((p, k) => `<p data-n="${k + 1}">${esc(p)}</p>`).join("");
  }
  // Verse: stanzas become paragraphs and each line its own block (styles.css .ln: hanging
  // indent, leading spaces kept); every fifth line carries its number for the optional
  // gutter. Headings are shown but not counted: a line with no lower-case letter ("12",
  // "BOOK I.", "THE ARGUMENT.") and an Argument (a stanza opening "Argument", or the
  // stanza after a heading that is only "THE ARGUMENT."), as editions number them.
  // The <br> is hidden by the stylesheet; it keeps lines apart in reader modes.
  // Mirrors para_html in tools/build_pages.py (which does not number).
  const ARGUMENT = /^(the\s+)?argument\b/i;
  function poemHTML(text, prose) {
    if (prose) return proseHTML(text);
    const stanzas = String(text || "").split(/\n\s*\n/).filter((s) => s.trim());
    let n = 0, i = 0, skipNext = false;
    return stanzas.map((st) => {
      const ls = st.split("\n").filter((l) => l.trim());
      const first = ls[0].trim();
      const argument = skipNext || ARGUMENT.test(first);
      skipNext = ARGUMENT.test(first) && ls.length === 1;
      return `<p class="stanza">${ls.map((l) => {
        // data-c: every counted line's number (quotations cite it); data-n: the printed fifth.
        const c = !argument && /\p{Ll}/u.test(l) ? ++n : 0;
        return `<span class="ln" data-i="${i++}"${c ? ` data-c="${c}"` : ""}${c && c % 5 === 0 ? ` data-n="${c}"` : ""}>${esc(l.replace(/\s+$/, ""))}</span><br>`;
      }).join("")}</p>`;
    }).join("");
  }
  // Every verse poem of ten lines or more and every book of a work (its paragraphs, when it
  // is prose) is numbered, every fifth line (the owner's wish, 17 Oct 2026); a switch turns
  // the numbers off, and the reader's choice is remembered with the Aa choices (pc-prefs lines;
  // pc-line-numbers before, read once by the Aa section), so it follows a signed-in reader.
  const LN_KEY = "pc-line-numbers";
  const lineNumbersOn = () => prefs().lines !== false;
  // The text block with its label row. o: {label, translator, lang, work, parallel}
  // parallel: the "Read with the translation" control (parCtlHTML); the text then sits in
  // .text-solo, with an empty .fx-slot beside it for the facing pages.
  function poemBlock(text, o) {
    const prose = isProse(text, o.translator);
    const numberable = !prose && (o.work || lineCount(text) >= 10);
    const on = numberable && lineNumbersOn();
    const label = o.label ? `<p class="section-label">${o.label}</p>` : "";
    const head = numberable || o.parallel ? `
      <div class="ln-bar">${label}${o.parallel || ""}
        ${numberable ? `<span class="ln-ctl"><span class="ln-note"${on ? "" : " hidden"}>${prose ? "Paragraphs numbered" : "Numbered as printed in this edition"}</span>
        <button class="ln-toggle" type="button" aria-pressed="${on}">${prose ? "Paragraph numbers" : "Line numbers"}</button></span>` : ""}
      </div>` : label;
    const solo = `
      <div class="poem-text${prose ? " is-prose" : ""}${on ? " numbered" : ""}"${o.lang || ""}>${poemHTML(text, prose)}</div>
      ${prose ? `<p class="prose-note">This translation is printed as prose in its source edition.</p>` : ""}`;
    return `${head}${o.parallel ? `<div class="text-solo">${solo}</div><div class="fx-slot" hidden></div>` : solo}`;
  }
  // A prose translation with a line map (data/linemaps/<slug>.json, from the Perseus
  // edition's line markers: {book index: [the Greek line each paragraph begins at, to the
  // marker at or before it]}) shows those numbers in the margin, as the Loeb prints them.
  const LINEMAPPED = new Set(["iliad-murray", "odyssey-murray"]);
  const LINEMAP_CACHE = {};
  const lineMapOf = (slug) => { const url = `data/linemaps/${slug}.json`;
    return LINEMAP_CACHE[url] || (LINEMAP_CACHE[url] = fetch(url).then((r) => r.ok ? r.json() : {}).catch(() => ({}))); };
  function applyLineMap(slug, i) {
    if (!LINEMAPPED.has(slug)) return;
    lineMapOf(slug).then((map) => {
      const nums = map && map[i];
      const root = app.querySelector(".text-solo .poem-text.is-prose") || app.querySelector(".poem-text.is-prose");
      if (!Array.isArray(nums) || !root) return;
      const ps = root.querySelectorAll(":scope > p");
      if (ps.length !== nums.length) return;
      ps.forEach((p, k) => { p.dataset.n = nums[k]; });
      const on = lineNumbersOn();
      root.classList.toggle("numbered", on);
      root.classList.add("greek-lines");
      if (!app.querySelector(".ln-toggle")) {
        // The row "Listen" may already have made above the text is used, not a second one.
        const prev = root.previousElementSibling, made = prev && prev.classList.contains("ln-bar");
        const bar = made ? prev : document.createElement("div");
        bar.className = "ln-bar";
        bar.insertAdjacentHTML("beforeend", `<span class="ln-ctl"><span class="ln-note"${on ? "" : " hidden"}>Greek line numbers: where each paragraph begins, to the nearest five lines</span>
          <button class="ln-toggle" type="button" aria-pressed="${on}">Line numbers</button></span>`);
        if (!made) root.before(bar);
        bindLineNumbers();
      }
    });
  }
  function bindLineNumbers() {
    const btn = app.querySelector(".ln-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      app.querySelector(".poem-text").classList.toggle("numbered", on);
      app.querySelector(".ln-note").hidden = !on;
      setReadPref({ lines: on });
    });
  }

  // ---------- facing pages: the original beside its translation ----------
  // data/parallel.json (tools/build_parallel.py, from the Old English specialist's line maps
  // in data/parallel-oe.json) says which original faces which translation and how their
  // lines meet. A poem or a book with an entry gets "Read with the translation" (on the
  // original) or "Read with the original" (on a translation) beside its label, and the text
  // becomes two columns, Loeb fashion: the original always on the left with its line numbers
  // in the margin, lines facing lines ("lines") or a passage facing its paragraphs ("blocks",
  // for a prose translation). On a phone a switch shows the original, the translation, or
  // both, each line followed by its translation. The reader's choice is kept in this browser
  // (pc-parallel: {on, view: "orig" | "tr" | "both", pick: {id or "w:slug": the other's}}).
  const PAR_KEY = "pc-parallel";
  const LANG_NAMES = { ang: "Old English" };
  let PARALLEL = null;         // Promise of data/parallel.json; PAR_DATA once it is in
  let PAR_DATA = null;
  function fetchParallel() {
    if (!PARALLEL) {
      PARALLEL = fetch("data/parallel.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((d) => { PAR_DATA = d && typeof d === "object" ? d : {}; return PAR_DATA; })
        .catch(() => { PARALLEL = null; return {}; });   // no facing pages this time; a later page tries again
    }
    return PARALLEL;
  }
  const parList = (kind, key) => ((PAR_DATA && PAR_DATA[kind]) || {})[key] || [];
  const parPrefs = () => readStore(PAR_KEY);
  const setParPrefs = (change) => writeStore(PAR_KEY, Object.assign(parPrefs(), change));
  // Facing pages are the default (the owner's wish, 15 Oct 2026: the Old English on the left,
  // the translation on the right); only a reader who has turned them off reads one text.
  const parOn = () => parPrefs().on !== false;
  // The other text to open with, when facing pages are on: the one last chosen here, else
  // the first.
  function parPick(list, key) {
    const p = parPrefs();
    if (!parOn() || !list.length) return null;
    const want = p.pick && p.pick[key];
    return list.find((e) => e.with === want) || list[0];
  }
  // The other texts are fetched once and then kept, so the facing pages draw without a wait.
  const FX_READY = new Map();  // "poem:<id>" | "work:<slug>" -> the poem or the full work
  function loadPartner(kind, id) {
    const key = kind + ":" + id;
    if (FX_READY.has(key)) return Promise.resolve(FX_READY.get(key));
    const got = kind === "poem"
      ? loadPoemPage(id.split("/")[0], +id.split("/")[1]).then((f) => f.poems[+id.split("/")[1]])
      : fetchWorkFile(id);
    return got.then((d) => { if (!d) throw new Error("missing"); FX_READY.set(key, d); return d; });
  }

  // "Translated by R. K. Gordon (1926)": the name and the first year, without the book.
  const trCredit = (t) => {
    const s = trName(t), year = (s.match(/\b1\d{3}\b/) || [])[0];
    return "Translated by " + s.split(/,\s|\s\(/)[0] + (year ? ` (${year})` : "");
  };
  // One version of several ("Cædmon's Hymn: West Saxon Version (Old English)" -> "West Saxon Version").
  const versionName = (t) => String(t || "").replace(/\s*\(Old English\)\s*$/i, "").replace(/^.*?:\s+/, "");
  // A poem's index entry; without the index, the poem itself if it has been fetched.
  const indexPoem = (id) => (DATA && DATA.poems.find((q) => q.id === id)) || FX_READY.get("poem:" + id) || {};
  // The control beside the text's label. kind: "poems" | "works"; key: the poem id or work slug.
  function parCtlHTML(kind, key, list) {
    if (!list.length) return "";
    const isOrig = list[0].orig === key;
    const what = isOrig ? "Read with the translation" : "Read with the original";
    const btn = (e, label) => `<button class="par-toggle" type="button" aria-pressed="false" data-with="${esc(e.with)}">${esc(label)}</button>`;
    if (list.length === 1) return `<span class="par-ctl">${btn(list[0], what)}</span>`;
    const name = (e) => {
      const o = kind === "poems" ? indexPoem(e.with) : WORKS[e.with] || {};
      return isOrig ? (o.translator ? trCredit(o.translator).replace(/^Translated by /, "") : o.title || "")
                    : versionName(o.title);
    };
    return `<span class="par-ctl" role="group" aria-label="${what}"><span class="par-lbl">${what}:</span>${list.map((e) => btn(e, name(e))).join("")}</span>`;
  }

  // A text as its units: the non-empty lines, each marked when a blank line (a stanza
  // break) comes before it. The maps count these units from 1; k is the unit's place from 0
  // (poemHTML's data-i), which the facing pages carry so that marks find their lines.
  function textUnits(text) {
    const out = [];
    let gap = false;
    String(text || "").split("\n").forEach((l) => {
      if (!l.trim()) { gap = out.length > 0; return; }
      out.push({ t: l.replace(/\s+$/, ""), gap, k: out.length });
      gap = false;
    });
    return out;
  }
  // The original's line numbers: a line with a lower-case letter counts; a heading is shown,
  // not counted, and a bare numeral ("I", "II": the two Waldere fragments) starts again at 1.
  function numberUnits(us) {
    let n = 0;
    us.forEach((u) => {
      if (/\p{Ll}/u.test(u.t)) u.n = ++n;
      else { u.head = true; if (/^\s*[IVXL]+\.?\s*$/.test(u.t)) n = 0; }
    });
  }
  const span = (a, b) => { const r = []; for (let k = a; k <= b; k++) r.push(k); return r; };
  // Rows of the facing pages, as unit numbers: [{o: [..], t: [..]}]. map: [[oa, ob, ta, tb,
  // per?], ...] (null: line for line). In "lines" mode a segment of as many lines on each side
  // is a row per line, one of `per` translation lines to each original line is a row per
  // original line (Thorpe's half-lines stay with their line), anything else one row; rows
  // that share a line are one row (Waldere I.8 folded into the line before it). In "blocks"
  // mode each segment is one row, and a line two segments share (Seafarer 64, split at the
  // caesura) is shown in the first. Lines no segment names (a translator's heading, a
  // footnote) get rows of their own where they fall.
  function alignRows(nO, nT, map, blocks) {
    const segs = map || [[1, Math.min(nO, nT), 1, Math.min(nO, nT)]];
    const out = [];
    const shares = (a, b) => a.o.some((x) => b.o.includes(x)) || a.t.some((x) => b.t.includes(x));
    const join = (a, b) => [...new Set(a.concat(b))].sort((x, y) => x - y);
    const add = (g) => {
      while (!blocks && out.length && shares(out[out.length - 1], g)) {
        const h = out.pop();
        g = { o: join(h.o, g.o), t: join(h.t, g.t) };
      }
      out.push(g);
    };
    let oEnd = 0, tEnd = 0;
    segs.forEach(([oa, ob, ta, tb, per]) => {
      if (blocks) { oa = Math.max(oa, oEnd + 1); ta = Math.max(ta, tEnd + 1); }
      const o = span(Math.max(1, oa), Math.min(ob, nO)), t = span(Math.max(1, ta), Math.min(tb, nT));
      if (!o.length && !t.length) return;
      if (o.length) oEnd = Math.max(oEnd, o[o.length - 1]);
      if (t.length) tEnd = Math.max(tEnd, t[t.length - 1]);
      const k = !blocks && o.length && t.length && (t.length === o.length ? 1 : per && t.length === per * o.length ? per : 0);
      if (k) o.forEach((x, i) => add({ o: [x], t: t.slice(i * k, i * k + k) }));
      else add({ o, t });
    });
    const inO = new Set(out.flatMap((g) => g.o)), inT = new Set(out.flatMap((g) => g.t));
    const rows = [];
    let oi = 1, ti = 1;
    const fill = (oTo, tTo) => {
      for (; oi < oTo; oi++) if (!inO.has(oi)) rows.push({ o: [oi], t: [] });
      for (; ti < tTo; ti++) if (!inT.has(ti)) rows.push({ o: [], t: [ti] });
    };
    out.forEach((g) => {
      fill(g.o.length ? g.o[0] : oi, g.t.length ? g.t[0] : ti);
      rows.push(g);
      if (g.o.length) oi = Math.max(oi, g.o[g.o.length - 1] + 1);
      if (g.t.length) ti = Math.max(ti, g.t[g.t.length - 1] + 1);
    });
    fill(nO + 1, nT + 1);
    return rows;
  }
  // Unit numbers -> the units themselves (a missing line, a left-out running head drop out).
  const rowUnits = (rows, O, T) => rows.map((r) => ({
    o: r.o.map((k) => O[k - 1]).filter(Boolean),
    t: r.t.map((k) => T[k - 1]).filter((u) => u && !u.skip),
  })).filter((r) => r.o.length || r.t.length);

  // A poem and its partner (either may be the original).
  function poemFacing(cur, other, e) {
    const orig = e.orig === cur.id ? cur : other, tr = orig === cur ? other : cur;
    const O = textUnits(orig.text), T = textUnits(tr.text);
    numberUnits(O);
    O.forEach((u) => { u.src = orig.id; });
    T.forEach((u) => { u.src = tr.id; });
    const blocks = e.mode === "blocks";
    // Each column's text, for its highlights and notes (facingCtxs).
    const poemEntry = (q) => ({ id: q.id, kind: "poem", title: q.title, author: q.author || (POETS[q.authorSlug || String(q.id).split("/")[0]] || {}).name || "",
                                translator: q.translator || "" });
    const texts = {};
    [orig, tr].forEach((q) => { texts[q.id] = { entry: poemEntry(q), text: q.text, translator: q.translator }; });
    return { texts,
      rows: rowUnits(alignRows(O.length, T.length, e.map, blocks), O, T),
      blocks, lang: e.lang, prose: isProse(tr.text, tr.translator), translator: tr.translator,
      version: parList("poems", tr.id).length > 1 ? versionName(orig.title) : "",
      oHref: orig === cur ? "" : "#/poem/" + orig.id, tHref: tr === cur ? "" : "#/poem/" + tr.id,
    };
  }

  // ---- works: a book of a translation beside its stretch of the original, or the reverse ----
  // An original work's sections are titled by their line numbers ("Lines 126–259",
  // "Genesis A, lines 1–234"); the Meters of Boethius go meter by meter ("oes").
  const secRange = (title) => { const m = String(title || "").match(/(\d+)\s*[–-]\s*(\d+)\s*$/); return m ? [+m[1], +m[2]] : null; };
  const oeApplies = (s, w, j) => {
    if (s.oes != null) return s.oes === j;
    const r = w.sections[j] && secRange(w.sections[j].title);
    return !!(r && s.oe && r[0] <= s.oe[1] && r[1] >= s.oe[0]);
  };
  // The parallel entries that have something for this book.
  function workParList(slug, i, cur) {
    const w = WORKS[slug] || cur;   // cur: the work as loaded, before the index is in
    return w ? parList("works", slug).filter((e) =>
      e.sections.some((s) => (e.orig === slug ? oeApplies(s, w, i) : s.tr === i))) : [];
  }
  // The original's lines a..b of one parallel section, by number (index n - a). merged: lines
  // the text runs together (beowulf-oe 140 stands for 140-141): the next number stays empty
  // and the lines after it keep their own. A line past the end of the last section's own
  // range (Juliana's closing "Amen." after 731) is kept, unnumbered, after the rest.
  function oeLines(w, s, merged, slug) {
    const [a, b] = s.oe;
    const out = new Array(Math.max(0, b - a + 1));
    const put = (sec, from, to) => {
      let n = from - 1;
      const src = "work:" + slug + "/" + w.sections.indexOf(sec);   // the section's entry id: its marks
      textUnits(sec.text).forEach((u) => {
        u.src = src;
        n += 1;
        if (n >= a && n <= b) { u.n = n; out[n - a] = u; }
        else if (n > b && to === b) { u.n = b; u.nonum = true; out.push(u); }
        if (merged && merged.includes(n)) n += 1;
      });
    };
    if (s.oes != null) { if (w.sections[s.oes]) put(w.sections[s.oes], 1, b); }
    else w.sections.forEach((sec) => { const r = secRange(sec.title); if (r && r[1] >= a && r[0] <= b) put(sec, r[0], r[1]); });
    return out;
  }
  // The translation's units for one parallel section: the printed book's running heads and
  // footnotes marked to be left out, the translator's captions marked, and a paragraph in
  // which a chunk begins ("from") cut in two there. chunks -> [[oa, ob, ta, tb]] on the cut units.
  function trUnits(sec, s, src) {
    const us = textUnits(sec.text);
    us.forEach((u) => { u.src = src; });
    (s.skip || []).forEach((k) => { if (us[k - 1]) us[k - 1].skip = true; });
    (s.caps || []).forEach((k) => { if (us[k - 1]) us[k - 1].cap = true; });
    const chunks = (s.chunks || []).filter((c) => c.oe && c.paras);
    if (!chunks.length) return { units: us, map: null };
    const pieces = us.map((u) => [u]);
    chunks.forEach((c) => {
      const u = us[c.paras[0] - 1];
      const at = c.from && u && pieces[c.paras[0] - 1].length === 1 ? u.t.indexOf(c.from) : -1;
      if (at > 0) pieces[c.paras[0] - 1] = [Object.assign({}, u, { t: u.t.slice(0, at).trimEnd() }),
                                            Object.assign({}, u, { t: u.t.slice(at), gap: false, off: at })];
    });
    const flat = [], first = [];
    pieces.forEach((ps, k) => { first[k] = flat.length + 1; flat.push(...ps); });
    const cut = (p) => pieces[p - 1] && pieces[p - 1].length > 1;
    const map = chunks.filter((c) => first[c.paras[0] - 1] && first[c.paras[1] - 1]).map((c, x, all) => {
      const [p, q] = c.paras, next = all[x + 1];
      const start = first[p - 1] + (c.from && cut(p) ? 1 : 0);
      const end = first[q - 1] + (next && next.from && next.paras[0] === q && cut(q) ? 0 : pieces[q - 1].length - 1);
      return [c.oe[0], c.oe[1], start, end];
    });
    return { units: flat, map };
  }
  // The rows of one parallel section, in the original's own numbering.
  function sectionRows(e, s, wo, wt, oslug, tslug) {
    const sec = wt.sections[s.tr];
    if (!sec || !s.oe) return [];
    const a = s.oe[0];
    const O = oeLines(wo, s, e.merged, oslug), T = trUnits(sec, s, "work:" + tslug + "/" + s.tr);
    const local = (m) => m && m.map(([oa, ob, ta, tb, k]) => [oa - a + 1, ob - a + 1, ta, tb, k]);
    const rows = e.lfl ? alignRows(O.length, T.units.length, local(s.map), false)
      : alignRows(O.length, T.units.length, local(T.map) || [[1, O.length, 1, T.units.length]], true);
    return rowUnits(rows, O, T.units);
  }
  // On the original's page: only its own lines. A row with no original line (a caption, a
  // line the translator added) goes with the row before it, else the one after.
  function clipRows(rows, A, B) {
    const keep = rows.map((r) => (r.o.length ? r.o.some((u) => u.n >= A && u.n <= B) : null));
    keep.forEach((k, x) => {
      if (k !== null) return;
      let y = x - 1;
      while (y >= 0 && keep[y] === null) y--;
      if (y < 0) { y = x + 1; while (y < keep.length && keep[y] === null) y++; }
      keep[x] = y >= 0 && y < keep.length ? !!keep[y] : false;
    });
    return rows.filter((r, x) => keep[x]).map((r) => ({ o: r.o.filter((u) => u.n >= A && u.n <= B), t: r.t }));
  }
  // A book's entry (its shelf, notes and marks), as its own page makes it.
  const partEntry = (w, slug, k) => ({ id: "work:" + slug + "/" + k, kind: "part", author: w.author, translator: w.translator || "",
    title: w.sections.length > 1 ? w.title + " · " + ((w.sections[k] || {}).title || "") : w.title });
  function workFacing(cur, slug, i, other, e) {
    const isOrig = e.orig === slug;
    const wo = isOrig ? cur : other, wt = isOrig ? other : cur;
    const oslug = isOrig ? slug : e.with, tslug = isOrig ? e.with : slug;
    const secs = e.sections.filter((s) => (isOrig ? oeApplies(s, cur, i) : s.tr === i));
    const r = isOrig && secRange(cur.sections[i].title);
    let rows = [];
    secs.forEach((s) => {
      let part = sectionRows(e, s, wo, wt, oslug, tslug);
      if (r && s.oes == null) part = clipRows(part, r[0], r[1]);
      // On the original's page the translation's books are named where each begins.
      if (isOrig && wt.sections.length > 1 && part.length) part[0].head = wt.sections[s.tr].title;
      rows = rows.concat(part);
    });
    const trText = secs.map((s) => (wt.sections[s.tr] || {}).text || "").join("\n\n");
    // The other text's own page: the book of the translation, or the stretch of the original
    // where this book begins.
    const s0 = secs[0];
    const oeAt = !s0 ? -1 : s0.oes != null ? s0.oes
      : wo.sections.findIndex((sec) => { const q = sec && secRange(sec.title); return q && q[0] <= s0.oe[0] && s0.oe[0] <= q[1]; });
    // Each column's text, for its highlights and notes (facingCtxs): every section in it.
    const texts = {};
    [[wo, oslug], [wt, tslug]].forEach(([w, sl]) => w.sections.forEach((sec, k) => {
      texts["work:" + sl + "/" + k] = { entry: partEntry(w, sl, k), text: sec.text, translator: w.translator };
    }));
    return {
      texts, rows, blocks: !e.lfl, lang: e.lang, prose: isProse(trText, wt.translator), translator: wt.translator,
      skipped: secs.some((s) => s.skip && s.skip.length), drift: e.lfl && secs.some((s) => !s.map),
      oHref: isOrig || !s0 ? "" : `#/work/${e.with}` + (oeAt >= 0 ? "/" + oeAt : ""),
      tHref: isOrig && s0 ? `#/work/${e.with}/${s0.tr}` : "",
    };
  }

  // The facing pages. m: {rows, blocks, lang, prose, translator, version, oHref, tHref, skipped, drift}
  function facingHTML(m) {
    const view = ["orig", "tr", "both"].includes(parPrefs().view) ? parPrefs().view : "both";
    const langName = LANG_NAMES[m.lang] || "Original";
    const lang = m.lang ? ` lang="${esc(m.lang)}"` : "";
    // Each line (or piece of a paragraph) names its text and its place there, for marks.
    const at = (u) => (u.src != null ? ` data-e="${esc(u.src)}" data-u="${u.k}"${u.off ? ` data-off="${u.off}"` : ""}` : "");
    // Every fifth line is numbered, and in "blocks" mode the first line of each passage too.
    const oLine = (u, k) => {
      const shown = u.n && !u.nonum && (u.n % 5 === 0 || (m.blocks && k === 0));
      return `<span class="ln${k && u.gap ? " fx-gap" : ""}${u.head ? " fx-hd" : ""}"${shown ? ` data-n="${u.n}"` : ""}${at(u)}>${esc(u.t)}</span><br>`;
    };
    // A caption that is a fitt numeral comes out of the scan as "Ill"; it is "III".
    const capText = (t) => (/^[IVXl1]+$/.test(t.trim()) ? t.replace(/[l1]/g, "I") : t);
    // Prose sets as paragraphs beside a passage; facing line by line (Charm 10's prose close
    // in a verse translation) every unit is a line.
    const paras = m.prose && m.blocks;
    const tUnit = (u, k) => u.cap ? `<p class="fx-cap"${at(u)}>${esc(capText(u.t))}</p>`
      : `<span class="ln${k && u.gap ? " fx-gap" : ""}"${at(u)}>${esc(u.t)}</span><br>`;
    // Prose: a piece that starts in lower case goes on with the paragraph before it (the
    // printed book's page breaks cut Kennedy's paragraphs: "swiftly van-" / "ished ; light").
    // Each line stays a span of its own inside the paragraph, so marks can find it.
    const tCell = (us) => {
      if (!paras) return us.map(tUnit).join("");
      const out = [];
      us.forEach((u) => {
        const last = out[out.length - 1], prev = last && last.parts[last.parts.length - 1];
        if (last && !u.cap && !last.cap && /^[a-z]/.test(u.t)) {
          const hyph = /[a-z]-$/.test(prev.t);
          if (hyph) prev.t = prev.t.slice(0, -1);
          last.parts.push({ u, t: u.t, sep: hyph ? "" : " " });
        } else out.push({ cap: u.cap, parts: [{ u, t: u.t, sep: "" }] });
      });
      return out.map((p) => (p.cap ? tUnit(p.parts[0].u)
        : `<p>${p.parts.map((x) => esc(x.sep) + `<span${at(x.u)}>${esc(x.t)}</span>`).join("")}</p>`)).join("");
    };
    const rows = m.rows.map((r, x) => {
      const gap = x > 0 && !m.blocks && !r.head && ((r.o[0] && r.o[0].gap) || (r.t[0] && r.t[0].gap));
      // A book of the translation is named on a row of its own, so its first line still
      // faces the line it translates.
      const book = r.head ? `<div class="fx-row fx-bookrow"><div class="fx-o"></div><div class="fx-t"><p class="fx-book">${esc(r.head)}</p></div></div>` : "";
      return `${book}<div class="fx-row${gap ? " gap" : ""}"><div class="fx-o"${lang}>${r.o.map(oLine).join("")}</div><div class="fx-t">${tCell(r.t)}</div></div>`;
    }).join("");
    const open = (href) => (href ? ` <a class="fx-open" href="${esc(href)}">Its own page →</a>` : "");
    const notes = [
      `Line numbers are those of the ${esc(langName)} text.`,
      m.drift ? "The translation keeps the original’s line count; inside long speeches a line can run one or two ahead or behind." : "",
      m.blocks ? `Each passage of the ${esc(langName)} faces its translation.` : "",
      m.skipped ? "Page numbers, running heads and footnotes of the printed translation are left out here." : "",
    ].filter(Boolean).join(" ");
    const vbtn = (v, label) => `<button type="button" data-fx-view="${v}" aria-pressed="${view === v}">${esc(label)}</button>`;
    return `
      <div class="fx" data-view="${view}" data-mode="${m.blocks ? "blocks" : "lines"}" role="region"
        aria-label="${esc(langName)} facing ${esc(m.translator ? trCredit(m.translator).replace(/^Translated by /, "the translation by ") : "its translation")}">
        <div class="fx-switch" role="group" aria-label="Show">${vbtn("orig", langName)}${vbtn("tr", "Translation")}${vbtn("both", "Both")}</div>
        <div class="fx-row fx-head">
          <p class="fx-lbl">${esc(langName)}${m.version ? ` · ${esc(m.version)}` : ""}${open(m.oHref)}</p>
          <p class="fx-lbl">${esc(m.translator ? trCredit(m.translator) : "Translation")}${open(m.tHref)}</p>
        </div>
        ${rows}
        <p class="fx-note">${notes}</p>
      </div>`;
  }
  function bindFacingView(slot) {
    const fx = slot.querySelector(".fx");
    slot.querySelectorAll("[data-fx-view]").forEach((b) => b.addEventListener("click", () => {
      fx.dataset.view = b.dataset.fxView;
      slot.querySelectorAll("[data-fx-view]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      setParPrefs({ view: b.dataset.fxView });
    }));
  }
  // ctx: {kind: "poem" | "work", key (pick key), list, build(entry, other) -> model, onShow(el)}
  function bindFacing(ctx) {
    const bar = app.querySelector(".par-ctl");
    if (!bar) return;
    const solo = app.querySelector(".text-solo"), slot = app.querySelector(".fx-slot");
    const lnCtl = app.querySelector(".ln-ctl");
    const btns = [...bar.querySelectorAll(".par-toggle")];
    const show = (e) => {
      btns.forEach((b) => { b.setAttribute("aria-pressed", String(!!e && b.dataset.with === e.with)); b.disabled = false; });
      solo.hidden = !!e; slot.hidden = !e;
      if (lnCtl) lnCtl.hidden = !!e;
      if (!e) {
        slot.innerHTML = "";
        if (SOLO_CTX && SOLO_CTX.root.isConnected) useMarkTexts([SOLO_CTX]);   // back to the text alone
      }
      if (ctx.onShow) ctx.onShow(e ? slot : solo);
    };
    const open = (e) => {
      const other = FX_READY.get(ctx.kind + ":" + e.with);
      if (other) {
        const m = ctx.build(e, other);
        slot.innerHTML = facingHTML(m);
        bindFacingView(slot);
        show(e);
        // Highlights and notes in each column, kept under the text they belong to.
        useMarkTexts(facingCtxs(slot.querySelector(".fx"), m.texts));
        return;
      }
      const b = btns.find((x) => x.dataset.with === e.with);
      if (b) b.disabled = true;
      loadPartner(ctx.kind, e.with).then(() => {
        if (slot.isConnected && parOn()) open(e); else if (b) b.disabled = false;
      }).catch(() => { if (b) { b.disabled = false; flash(b, "Could not load it"); } });
    };
    btns.forEach((b) => b.addEventListener("click", () => {
      const e = ctx.list.find((x) => x.with === b.dataset.with);
      const on = b.getAttribute("aria-pressed") !== "true";
      const pick = Object.assign({}, parPrefs().pick);
      if (on) pick[ctx.key] = e.with;
      setParPrefs({ on, pick });
      if (on) open(e); else show(null);
    }));
    const start = parPick(ctx.list, ctx.key);
    if (start) open(start);
  }

  // ---------- "Aa": reading comfort ----------
  // The panel beside a poem or a book has a row of radio buttons for each choice: the theme
  // (Auto, Light, Paper, Dark, Black), the reading font (Book: Fraunces; Plain: the site's
  // sans; Legible: Atkinson Hyperlegible, fetched only once chosen), four text sizes, three
  // line spacings and three column widths (the facing pages and two translations side by side
  // ignore Narrow); "Reset" puts them all back. They are kept in pc-prefs ({text, theme, font,
  // lh, measure}, beside the line-number and study-note switches, lines and gloss) and put on
  // <html> as data-text, data-theme (light or dark), data-tone (paper or black, over light or
  // dark, so every dark rule in styles.css still holds for Black), data-font, data-lh and
  // data-measure, which styles.css reads. The small script at the top of index.html (and of
  // the static pages) applies pc-text and pc-theme before the page is drawn, so a night reader
  // never sees a white flash: those two keys still hold the nearest it knows (Paper as light,
  // Black as dark, the largest size as xl), and the rest is set here, before app.js draws
  // anything. A static page's Display switch changes pc-theme alone; when it no longer matches,
  // it wins. Signed in, each choice also goes into pc-parallel as aa: {choice: value, at} (the
  // Worker keeps only the kinds it knows; MERGE.parallel keeps the newer aa) and is taken from
  // there after each sync. The theme is the exception: Auto ("follow this device") is never
  // sent, and a device on Auto stays on Auto, so a phone that follows the system keeps doing so.
  const READ_PREFS = {
    theme: ["", "light", "paper", "dark", "black"], font: ["", "plain", "legible"],
    text: ["", "l", "xl", "xxl"], lh: ["snug", "", "airy"], measure: ["narrow", "", "wide"] };
  const RT_ROWS = [
    ["theme", "Theme", [["", "Auto", "Follow this device's light or dark setting"], ["light", "Light"], ["paper", "Paper", "Warm off-white, like a book's page"],
      ["dark", "Dark"], ["black", "Black", "Pure black, for OLED screens"]]],
    ["font", "Font", [["", "Book", "Fraunces, the Codex's serif"], ["plain", "Plain", "A plain sans-serif"],
      ["legible", "Legible", "Atkinson Hyperlegible, made for low vision"]]],
    ["text", "Text size", [["", "Standard text"], ["l", "Larger text"], ["xl", "Larger still"], ["xxl", "Largest text"]]],
    ["lh", "Spacing", [["snug", "Snug"], ["", "Standard"], ["airy", "Airy"]]],
    ["measure", "Width", [["narrow", "Narrow"], ["", "Standard"], ["wide", "Wide"]]],
  ];
  const readPref = (k) => READ_PREFS[k].includes(prefs()[k]) ? prefs()[k] : "";
  const themeFamily = (t) => t === "paper" ? "light" : t === "black" ? "dark" : t;
  const legacyGet = (key) => { try { return localStorage.getItem(key) || ""; } catch (e) { return ""; } };
  const legacySet = (key, v) => { try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } catch (e) { /* private window */ } };
  let LEGIBLE = false;
  function loadLegible() {
    if (LEGIBLE) return;
    LEGIBLE = true;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700&display=swap";
    document.head.appendChild(l);
  }
  function applyReadPrefs() {
    const root = document.documentElement;
    const put = (name, v) => { if (v) root.dataset[name] = v; else delete root.dataset[name]; };
    const theme = readPref("theme");
    put("theme", themeFamily(theme));
    put("tone", theme === "paper" || theme === "black" ? theme : "");
    ["text", "font", "lh", "measure"].forEach((k) => put(k, readPref(k)));
    if (readPref("font") === "legible") loadLegible();
  }
  // change: {theme: "paper", …}; fromAccount: taken from the account, so not sent back.
  function setReadPref(change, fromAccount) {
    setPrefs(change);
    if ("theme" in change) legacySet("pc-theme", themeFamily(readPref("theme")));
    if ("text" in change) legacySet("pc-text", readPref("text") === "xxl" ? "xl" : readPref("text"));
    applyReadPrefs();
    syncReadPanel();
    // Anything but the theme and the switches moves the text: the margin notes are placed again.
    if (Object.keys(change).some((k) => k !== "theme" && k !== "lines" && k !== "gloss")) window.dispatchEvent(new Event("resize"));
    if (fromAccount) return;
    const send = Object.assign({}, change);
    if (send.theme === "") delete send.theme;
    if (Object.keys(send).length) setParPrefs({ aa: Object.assign({}, objOr(parPrefs().aa), send, { at: new Date().toISOString() }) });
  }
  // After a sync: the account's choices, where they differ from this browser's.
  function takeAccountPrefs() {
    const aa = objOr(parPrefs().aa), change = {};
    Object.keys(aa).forEach((k) => {
      if (k === "lines" || k === "gloss") { if (typeof aa[k] === "boolean" && aa[k] !== (prefs()[k] !== false)) change[k] = aa[k]; return; }
      if (!READ_PREFS[k] || !READ_PREFS[k].includes(aa[k]) || aa[k] === readPref(k)) return;
      if (k === "theme" && !readPref("theme")) return;   // Auto here stays Auto
      change[k] = aa[k];
    });
    if (Object.keys(change).length) setReadPref(change, true);
  }
  // Once, on load: the older keys into pc-prefs, then everything onto <html>.
  {
    const p = prefs(), change = {};
    const t = legacyGet("pc-theme"), x = legacyGet("pc-text");
    if (themeFamily(p.theme || "") !== t) change.theme = t === "light" || t === "dark" ? t : "";
    if ((p.text === "xxl" ? "xl" : p.text || "") !== x) change.text = x === "l" || x === "xl" ? x : "";
    if (typeof p.lines !== "boolean") change.lines = legacyGet(LN_KEY) !== "0";
    if (typeof p.gloss !== "boolean") change.gloss = legacyGet(GLOSS_OFF_KEY) !== "1";
    if (Object.keys(change).length) setPrefs(change);
    // A theme or size chosen on a static page goes to the account too, or the next sync would undo it.
    const shown = {};
    if (change.theme) shown.theme = change.theme;
    if ("text" in change) shown.text = change.text;
    if (Object.keys(shown).length) setReadPref(shown); else applyReadPrefs();
  }
  // The top bar's Display switch (index.html) sets Light or Dark; Paper and Black are the panel's.
  window.pcSetTheme = (n) => setReadPref({ theme: n === "dark" ? "dark" : "light" });
  window.pcToggleTheme = () => window.pcSetTheme(document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) ? "light" : "dark");
  function syncReadPanel() {
    document.querySelectorAll('.rt-panel input[type="radio"]').forEach((i) => { i.checked = i.value === readPref(i.name.slice(3)); });
  }
  function readingToolsHTML() {
    const row = ([kind, legend, opts]) => `
          <fieldset class="rt-row rt-row-${kind}"><legend class="rt-label">${legend}</legend><span class="rt-opts">
            ${opts.map(([v, label, title], k) => kind === "text"
              ? `<label class="rt-opt"><input type="radio" name="rt-${kind}" value="${v}" aria-label="${label}"${readPref(kind) === v ? " checked" : ""}><span class="rt-a rt-a${k + 1}" aria-hidden="true">A</span></label>`
              : `<label class="rt-opt"${title ? ` title="${esc(title)}"` : ""}><input type="radio" name="rt-${kind}" value="${v}"${readPref(kind) === v ? " checked" : ""}><span>${label}</span></label>`).join("")}
          </span></fieldset>`;
    return `<div class="rt">
        <button class="rt-toggle" type="button" aria-expanded="false" aria-controls="rt-panel" aria-label="Reading settings: theme, font, size, spacing, width" title="Reading settings">Aa</button>
        <div class="rt-panel" id="rt-panel" hidden>${RT_ROWS.map(row).join("")}
          <button type="button" class="rt-reset">Reset</button>
        </div>
      </div>`;
  }
  function bindReadingTools() {
    const box = app.querySelector(".rt");
    if (!box) return;
    const btn = box.querySelector(".rt-toggle"), panel = box.querySelector(".rt-panel");
    btn.addEventListener("click", () => {
      box.classList.remove("rt-docked");     // opened here, under the button, not above the phone bar
      panel.hidden = !panel.hidden;
      btn.setAttribute("aria-expanded", String(!panel.hidden));
      const rbBtn = app.querySelector(".rb-aa");
      if (rbBtn) rbBtn.setAttribute("aria-expanded", "false");
    });
    panel.addEventListener("change", (e) => {
      const i = e.target;
      if (i.type === "radio" && /^rt-/.test(i.name)) setReadPref({ [i.name.slice(3)]: i.value });
    });
    panel.querySelector(".rt-reset").addEventListener("click", () => {
      setReadPref({ theme: "", font: "", text: "", lh: "", measure: "" });
      announce("Reading settings reset.");
    });
  }
  // A click outside the panel, or Escape, closes it (one listener for every page).
  function closeReadingTools(refocus) {
    const box = app.querySelector(".rt");
    if (!box || box.querySelector(".rt-panel").hidden) return;
    box.querySelector(".rt-panel").hidden = true;
    const btn = box.querySelector(".rt-toggle"), rbBtn = app.querySelector(".rb-aa");
    btn.setAttribute("aria-expanded", "false");
    if (rbBtn) rbBtn.setAttribute("aria-expanded", "false");
    // Opened from the phone's reading bar, the focus goes back there (not up to the title).
    const docked = box.classList.contains("rt-docked");
    box.classList.remove("rt-docked");
    if (refocus) (docked && rbBtn ? rbBtn : btn).focus();
  }
  document.addEventListener("click", (e) => {
    const box = app.querySelector(".rt");
    if (box && !box.contains(e.target) && !(e.target.closest && e.target.closest(".rb-aa"))) closeReadingTools(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeReadingTools(true); });

  // ---------- find in this text, go to a line, reading keys ----------
  // "Find" beside "Aa" (and among the tools of the side-by-side view) opens a slim bar under
  // the title: words looked for in the text on screen only (both columns of the facing pages
  // or of two translations, or just one of them), ignoring case and accents as the archive
  // search does, with "n of m", Previous/Next, and "Go to line" (the number printed in the
  // margin; on Murray's Homer, the paragraph holding that Greek line; in a prose translation,
  // the paragraph). Matches are painted with the browser's highlight API, so the text itself
  // is untouched and the highlights' offsets stay right; an older browser gets <mark
  // class="find"> spans, taken out again when the bar closes. A new page closes the bar.
  // Keys on a reading page, while no field has focus and no Ctrl/Alt/Cmd is held: left/right
  // the previous or next poem or book, f or / Find, g Go to line, n a note on the selected
  // words, t the Aa panel, ? the list of keys (also printed on the About page). Nothing is stored.
  const FIND_PAINT = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
  let FIND = null;             // {bar, btn, input, count, line, items, at, scope, key, timer} while open
  const findButtonHTML = (cls) => `<button class="find-open${cls ? " " + cls : ""}" type="button" aria-expanded="false" title="Find in this text (f)">Find</button>`;
  // The texts the bar can look in: one, or two with their names (facing pages, two translations).
  function findGroups() {
    const panes = [...app.querySelectorAll(".compare-pane .poem-text")];
    if (panes.length > 1) return { els: panes.map((p) => [p]),
      names: [...app.querySelectorAll(".compare-tr")].map((t) => t.firstChild.textContent.trim()) };
    const fx = app.querySelector(".fx-slot:not([hidden]) .fx");
    if (fx) {
      const orig = fx.querySelector('[data-fx-view="orig"]');
      return { els: [[...fx.querySelectorAll(".fx-row:not(.fx-head) > .fx-o")], [...fx.querySelectorAll(".fx-row:not(.fx-head) > .fx-t")]],
               names: [orig ? orig.textContent.trim() : "Original", "Translation"] };
    }
    const root = panes[0] || app.querySelector(".text-solo .poem-text") || app.querySelector(".detail .poem-text");
    return { els: root ? [[root]] : [], names: null };
  }
  // The chosen text(s), in page order.
  function findEls(g) {
    if (g.els.length < 2 || FIND.scope === "all") return g.els.flat().sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
    return g.els[FIND.scope] || [];
  }
  // The words of those texts folded as search folds them, each folded letter remembering the
  // text node and offset it came from; lines and paragraphs are joined by a space.
  function findIndex(els) {
    let s = "";
    const at = [];
    const gap = () => { if (s && s[s.length - 1] !== " ") { s += " "; at.push(null); } };
    els.forEach((el) => {
      let unit = null;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) =>
        n.parentElement && n.parentElement.closest(".mark-pop, .mark-dot, .mn-col") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const u = n.parentElement.closest(".ln, p") || el;
        if (u !== unit) gap();
        unit = u;
        let k = 0;
        for (const ch of n.nodeValue) {
          for (const c of /\s/.test(ch) ? " " : fold(ch)) {
            if (c === " " && (!s || s[s.length - 1] === " ")) continue;
            s += c; at.push([n, k, ch.length]);
          }
          k += ch.length;
        }
      }
      gap();
    });
    return { s, at };
  }
  // An older browser: the match wrapped in <mark class="find"> (last text node first, so the
  // ranges of earlier matches in the same node stay where they are).
  function findWrap(r) {
    const box = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer;
    const nodes = [], w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (r.intersectsNode(n)) nodes.push(n);
    const sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset;
    const out = [];
    nodes.reverse().forEach((n) => {
      const a = n === sc ? so : 0, b = n === ec ? eo : n.nodeValue.length;
      if (b <= a) return;
      let node = n;
      if (b < node.nodeValue.length) node.splitText(b);
      if (a > 0) node = node.splitText(a);
      const m = document.createElement("mark");
      m.className = "find";
      node.parentNode.insertBefore(m, node); m.appendChild(node);
      out.unshift(m);
    });
    return out;
  }
  function findClear() {
    if (FIND_PAINT) { CSS.highlights.delete("pc-find"); CSS.highlights.delete("pc-find-now"); }
    document.querySelectorAll("mark.find").forEach((m) => { const p = m.parentNode; m.replaceWith(...m.childNodes); p.normalize(); });
    if (FIND) { FIND.items = []; FIND.at = -1; }
  }
  // The "Look in" switch, when there are two texts.
  function findScopeUI(g) {
    const box = FIND.bar.querySelector(".find-scope");
    if (!g.names) { box.hidden = true; FIND.scope = "all"; FIND.key = ""; return; }
    const key = g.names.join("|");
    if (FIND.key !== key) {
      FIND.key = key;
      FIND.scope = "all";
      const opt = (v, label) => `<button type="button" data-scope="${v}" aria-pressed="${v === "all"}">${esc(label)}</button>`;
      box.innerHTML = `<span class="find-scope-label">Look in</span>${opt("all", "Both")}${opt(0, g.names[0])}${opt(1, g.names[1])}`;
      box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        FIND.scope = b.dataset.scope === "all" ? "all" : +b.dataset.scope;
        box.querySelectorAll("button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
        findRun();
      }));
    }
    box.hidden = false;
  }
  function findCount() {
    const q = fold(FIND.input.value).trim();
    FIND.count.textContent = q.length < 2 ? "" : FIND.items.length ? `${FIND.at + 1} of ${FIND.items.length}` : "0 of 0";
  }
  // Looks again (150 ms after the reader stops typing) and shows the first match from the
  // top of the screen down.
  function findRun() {
    if (!FIND) return;
    clearTimeout(FIND.timer);
    FIND.timer = 0;
    findClear();
    const g = findGroups();
    findScopeUI(g);
    const q = fold(FIND.input.value).trim();
    if (q.length < 2) { findCount(); return; }
    const { s, at } = findIndex(findEls(g));
    const seen = new Map();
    const shown = (el) => { if (!seen.has(el)) seen.set(el, el.getClientRects().length > 0); return seen.get(el); };
    const ranges = [];
    for (let x = s.indexOf(q); x >= 0 && ranges.length < 5000; x = s.indexOf(q, x + q.length)) {
      const a = at[x], b = at[x + q.length - 1];
      if (!a || !b || !shown(a[0].parentElement)) continue;   // a column hidden on a phone
      const r = document.createRange();
      r.setStart(a[0], a[1]); r.setEnd(b[0], b[1] + b[2]);
      ranges.push(r);
    }
    if (FIND_PAINT) {
      FIND.items = ranges.map((r) => ({ r }));
      if (ranges.length) CSS.highlights.set("pc-find", new Highlight(...ranges));
    } else {
      FIND.items = ranges.slice().reverse().map((r) => ({ r, els: findWrap(r) })).reverse();
    }
    if (!FIND.items.length) { findCount(); return; }
    const k = FIND.items.findIndex((it) => findEl(it).getBoundingClientRect().top >= 0);
    findShow(k < 0 ? 0 : k);
  }
  const findEl = (it) => (it.els && it.els[0]) || it.r.startContainer.parentElement;
  // The current match: marked more strongly, scrolled to the middle, its line briefly lit.
  function findShow(k) {
    const n = FIND.items.length;
    if (!n) return;
    FIND.at = ((k % n) + n) % n;
    const it = FIND.items[FIND.at];
    if (FIND_PAINT) CSS.highlights.set("pc-find-now", new Highlight(it.r));
    else {
      document.querySelectorAll("mark.find.is-now").forEach((m) => m.classList.remove("is-now"));
      it.els.forEach((m) => m.classList.add("is-now"));
    }
    findCount();
    findLight(findEl(it));
  }
  function findLight(el) {
    const root = document.documentElement;
    root.style.scrollBehavior = "auto";        // a jump, as jumpTo does: the page's smooth glide is slow over a long book
    void root.offsetHeight;
    el.scrollIntoView({ block: "center" });
    root.style.scrollBehavior = "";
    const line = el.closest(".ln, .poem-text > p, .fx-t > p, .fx-row") || el;
    line.classList.add("ln-linked");
    setTimeout(() => line.classList.remove("ln-linked"), 1800);
  }
  // Go to line: the line printed with that number, or the nearest numbered line below it;
  // facing pages count on from the original's printed fifths; Murray's Homer, the paragraph
  // the Greek line falls in; a prose translation without such numbers, its paragraphs.
  const lineRoot = () => app.querySelector(".compare-pane .poem-text") || app.querySelector(".text-solo .poem-text") || app.querySelector(".detail .poem-text");
  function lineTarget(n) {
    const fx = app.querySelector(".fx-slot:not([hidden]) .fx");
    if (fx) {
      const ls = [...fx.querySelectorAll(".fx-row:not(.fx-head) > .fx-o .ln:not(.fx-hd)")];
      let k = -1, v = 0;
      ls.forEach((l, x) => { if (l.dataset.n && +l.dataset.n <= n) { k = x; v = +l.dataset.n; } });
      let x = k + n - v;
      const next = ls.findIndex((l, y) => y > k && l.dataset.n);   // never past the next printed number
      if (next >= 0 && next < x) x = next;
      const el = ls[x];
      if (!el) return null;
      return el.getClientRects().length ? el : el.closest(".fx-row");
    }
    const root = lineRoot();
    if (!root) return null;
    if (root.classList.contains("is-prose")) {
      const ps = [...root.querySelectorAll(":scope > p[data-n]")];
      if (!root.classList.contains("greek-lines")) return ps.find((p) => +p.dataset.n === n) || null;
      let hit = null;
      ps.forEach((p) => { if (+p.dataset.n <= n) hit = p; });
      return hit || ps[0] || null;
    }
    return [...root.querySelectorAll(".ln[data-c]")].find((l) => +l.dataset.c >= n) || null;
  }
  const lineWord = () => {
    const root = lineRoot();
    return root && root.classList.contains("is-prose") && !root.classList.contains("greek-lines")
      && !app.querySelector(".fx-slot:not([hidden]) .fx") ? "paragraph" : "line";
  };
  // "Go to line" or "Go to paragraph", asked afresh: the Greek line map comes in after the
  // page is drawn, and the facing pages can be opened while the bar is open.
  const findLineLabel = () => { const w = lineWord(); FIND.bar.querySelector(".find-goto-word").textContent = w; return w; };
  function goToLine() {
    const n = parseInt(FIND.line.value, 10);
    if (!(n > 0)) return;
    const word = findLineLabel(), el = lineTarget(n);
    FIND.line.setAttribute("aria-invalid", String(!el));
    if (!el) { announce(`There is no ${word} ${n} in this text.`); return; }
    findLight(el);
    announce(`${word === "line" ? "Line" : "Paragraph"} ${n}.`);
  }
  // The bar, under the title; focus goes to the words (or to the line number, for g).
  function openFind(toLine) {
    if (FIND && !FIND.bar.isConnected) closeFind(false);
    if (!FIND) {
      const btn = app.querySelector(".find-open"), title = app.querySelector(".detail-title");
      if (!btn || !title) return;
      const bar = document.createElement("div");
      bar.className = "find-bar";
      bar.id = "find-bar";
      bar.setAttribute("role", "search");
      bar.setAttribute("aria-label", "Find in this text");
      bar.innerHTML = `
        <div class="find-row">
          <span class="find-field">
            <label class="visually-hidden" for="find-q">Find in this text</label>
            <input id="find-q" class="find-q" type="text" placeholder="Find in this text" autocomplete="off" spellcheck="false" enterkeyhint="search">
            <span class="find-count" aria-live="polite"></span>
          </span>
          <button type="button" class="find-step" data-step="-1" aria-label="Previous match" title="Previous (Shift+Enter)">↑</button>
          <button type="button" class="find-step" data-step="1" aria-label="Next match" title="Next (Enter)">↓</button>
          <button type="button" class="find-close" aria-label="Close Find" title="Close (Esc)">×</button>
          <form class="find-goto">
            <label for="find-ln"><span class="find-goto-pre">Go to </span><span class="find-goto-word"></span></label>
            <input id="find-ln" class="find-ln" type="number" inputmode="numeric" min="1" step="1" enterkeyhint="go">
            <button type="submit" class="find-go">Go</button>
          </form>
        </div>
        <div class="find-scope" role="group" aria-label="Look in" hidden></div>`;
      title.after(bar);
      FIND = { bar, btn, input: bar.querySelector(".find-q"), count: bar.querySelector(".find-count"),
               line: bar.querySelector(".find-ln"), items: [], at: -1, scope: "all", key: null, timer: 0 };
      // It stays in view under the sticky top bar while the reader moves through the matches.
      const head = document.querySelector(".site-head");
      // (On a phone with the reading bar, styles.css follows the top bar in and out instead.)
      bar.style.setProperty("--find-top", head && !document.body.classList.contains("rb-on") &&
        getComputedStyle(head).position === "sticky" ? head.offsetHeight + "px" : "0px");
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("aria-controls", "find-bar");
      const f = FIND;
      f.input.addEventListener("input", () => { clearTimeout(f.timer); f.timer = setTimeout(findRun, 150); });
      f.input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (f.timer || !f.items.length) findRun();      // typed, and not yet looked for
        else findShow(f.at + (e.shiftKey ? -1 : 1));
      });
      bar.querySelectorAll(".find-step").forEach((b) => b.addEventListener("click", () => {
        if (f.items.length && !f.timer) findShow(f.at + +b.dataset.step); else findRun();
      }));
      bar.querySelector(".find-goto").addEventListener("submit", (e) => { e.preventDefault(); goToLine(); });
      f.line.addEventListener("input", () => f.line.removeAttribute("aria-invalid"));
      bar.querySelector(".find-close").addEventListener("click", () => closeFind(true));
      bar.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeFind(true); } });
    }
    findScopeUI(findGroups());
    findLineLabel();
    const el = toLine ? FIND.line : FIND.input;
    el.focus(); el.select();
  }
  function closeFind(refocus) {
    if (!FIND) return;
    const { bar, btn } = FIND;
    clearTimeout(FIND.timer);
    findClear();
    FIND = null;
    bar.remove();
    // On a phone the focus goes back to the reading bar's Find, which is on screen (the one by
    // the title may be far above).
    const rb = document.body.classList.contains("rb-on") && app.querySelector(".rb-find");
    if (btn.isConnected) { btn.setAttribute("aria-expanded", "false"); btn.removeAttribute("aria-controls"); if (refocus && !rb) btn.focus(); }
    if (refocus && rb) rb.focus({ preventScroll: true });
  }
  function bindFind() {
    if (FIND) closeFind(false);                // drawn again: a fresh page
    const btn = app.querySelector(".find-open");
    if (btn) btn.addEventListener("click", () => { if (FIND && FIND.bar.isConnected) closeFind(true); else openFind(false); });
  }
  window.addEventListener("hashchange", () => closeFind(false));
  // The list of keys: a small dialog for ?, and the same list on the About page.
  const READING_KEYS = [
    [["←", "→"], "Previous or next poem or book"],
    [["f", "/"], "Find in this text"],
    [["g"], "Go to a line"],
    [["n"], "A note on the words you have selected"],
    [["t"], "Reading settings (Aa)"],
    [["Enter", "Shift+Enter"], "Next or previous match, in Find"],
    [["Esc"], "Close Find, a panel or this list"],
    [["?"], "This list of keys"],
  ];
  const keysListHTML = () => `<dl class="kb-list">${READING_KEYS.map(([ks, what]) =>
    `<div class="kb-row"><dt>${ks.map((k) => k.split("+").map((y) => `<kbd>${esc(y)}</kbd>`).join("+")).join(" ")}</dt><dd>${esc(what)}</dd></div>`).join("")}</dl>`;
  let keySheet = null;
  function openKeySheet() {
    if (!keySheet) {
      keySheet = document.createElement("dialog");
      keySheet.className = "kb-sheet";
      keySheet.setAttribute("aria-labelledby", "kb-title");
      keySheet.innerHTML = `<h2 id="kb-title">Keyboard shortcuts</h2>
        <p class="kb-sub">On a poem or a book, while you are not typing in a box. Ctrl+F stays your browser's own find.</p>
        ${keysListHTML()}
        <form method="dialog" class="kb-acts"><button type="submit">Close</button></form>`;
      keySheet.addEventListener("click", (e) => { if (e.target === keySheet) keySheet.close(); });   // a click outside it
      document.body.appendChild(keySheet);
    }
    if (keySheet.open) return;
    if (typeof keySheet.showModal === "function") keySheet.showModal(); else keySheet.setAttribute("open", "");
    keySheet.querySelector(".kb-acts button").focus();
  }
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='listbox'], [role='menu'], [role='tablist'], [role='radiogroup'], .hl-bar, .find-bar, .listen-bar, dialog")) return;
    const key = e.key;
    if (key === "?") { e.preventDefault(); openKeySheet(); return; }
    if (!app.querySelector(".detail .poem-text, .compare .poem-text")) return;   // reading pages only
    if (key === "/") { e.preventDefault(); openFind(false); return; }   // Shift+7 on a Turkish keyboard
    if (e.shiftKey) return;                    // Shift+arrows extend a selection
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const b = app.querySelector(`.detail-nav button${key === "ArrowRight" ? ".next" : ":not(.next)"}`);
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    } else if (key === "f" || key === "g") { e.preventDefault(); openFind(key === "g"); }
    else if (key === "t") {
      const b = app.querySelector(".rt-toggle");
      if (!b) return;
      e.preventDefault(); b.click();
      const panel = app.querySelector(".rt-panel");
      ((panel && !panel.hidden && panel.querySelector("input:checked")) || b).focus();
    } else if (key === "n") {
      if (!hlSelection()) { announce("Select some words in the text first, then press n."); return; }
      e.preventDefault();
      checkHlSelection();
      const b = hlBar && hlBar.querySelector(".hl-note-btn");
      if (b) b.click();
    }
  });

  // ---------- the phone reading bar ----------
  // On a poem, a book, the facing pages and two translations side by side, on a screen up to
  // 780px wide (where the top bar becomes three rows): once the reader has scrolled down past
  // the title the top bar slides away; scrolling back up by 40px or more, or reaching the end,
  // brings it back together with a bar at the foot of the screen: Previous · Aa · Find ·
  // Contents (a book) or Save (a poem) · Next, each an icon with its name under it. The
  // reading-progress line rides on that bar's top edge, the "Read with the Codex" cue goes
  // below the text, and a note's dot in the margin is easier to hit. A tap in the text never
  // shows or hides anything (taps belong to highlights and study notes). The bar never hides
  // while the focus is in it, while the Aa panel it opened is up, or while a dialog is open;
  // it steps aside for the on-screen keyboard (Find, a note) and for a pop-over (the
  // selection bar, a study note, a highlight's note, the shelf menu). Nothing is stored.
  // (styles.css: body.rb-on on such a page, rb-hide while scrolled away, rb-off while it steps aside.)
  const RB_PHONE = window.matchMedia("(max-width: 780px)");
  let RB = null;             // {nav, kind, last, turn, kb} for the reading page on screen
  const RB_ICON = {
    prev: '<path d="M15 5l-7 7 7 7"/>',
    next: '<path d="M9 5l7 7-7 7"/>',
    find: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    contents: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".9"/><circle cx="4.5" cy="12" r=".9"/><circle cx="4.5" cy="18" r=".9"/>',
    save: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
  };
  const rbIcon = (k) => `<svg class="rb-ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RB_ICON[k]}</svg>`;
  // opts: {contents: "#/work/<slug>"} on a book or the side-by-side view; none on a poem.
  function bindReadingBar(opts) {
    const page = app.querySelector("article.detail, article.compare");
    if (!page) return;
    const o = opts || {};
    const prev = app.querySelector(".detail-nav button:not(.next)"), next = app.querySelector(".detail-nav button.next");
    const shelf = !o.contents && app.querySelector(".shelf-toggle");
    const item = (cls, icon, label, attrs) =>
      `<button type="button" class="rb-btn ${cls}"${attrs || ""}>${icon}<span class="rb-l">${label}</span></button>`;
    const nav = document.createElement("nav");
    nav.className = "rb";
    nav.setAttribute("aria-label", "Reading");
    nav.innerHTML = [
      item("rb-prev", rbIcon("prev"), "Previous", prev && !prev.disabled ? "" : " disabled"),
      app.querySelector(".rt") ? item("rb-aa", '<span class="rb-aa-ic" aria-hidden="true">Aa</span>', "Text",
        ' aria-expanded="false" aria-controls="rt-panel" aria-label="Reading settings"') : "",
      app.querySelector(".find-open") ? item("rb-find", rbIcon("find"), "Find", ' aria-expanded="false"') : "",
      o.contents ? `<a class="rb-btn rb-contents" href="${esc(o.contents)}">${rbIcon("contents")}<span class="rb-l">Contents</span></a>`
        : shelf ? item("rb-save", rbIcon("save"), "Save", ` aria-pressed="${shelf.getAttribute("aria-pressed") === "true"}"`) : "",
      item("rb-next", rbIcon("next"), "Next", next && !next.disabled ? "" : " disabled"),
    ].join("");
    page.appendChild(nav);   // after the text, for a screen reader; fixed to the foot by styles.css
    nav.querySelector(".rb-prev").addEventListener("click", () => { if (prev && !prev.disabled) prev.click(); });
    nav.querySelector(".rb-next").addEventListener("click", () => { if (next && !next.disabled) next.click(); });
    const aa = nav.querySelector(".rb-aa");
    if (aa) aa.addEventListener("click", () => {
      const box = app.querySelector(".rt"), panel = box && box.querySelector(".rt-panel");
      if (!panel) return;
      if (!panel.hidden) { closeReadingTools(true); return; }
      box.classList.add("rt-docked");      // the panel opens just above the bar
      panel.hidden = false;
      aa.setAttribute("aria-expanded", "true");
      box.querySelector(".rt-toggle").setAttribute("aria-expanded", "true");
      (panel.querySelector("input:checked") || panel.querySelector("input")).focus({ preventScroll: true });
    });
    const find = nav.querySelector(".rb-find");
    if (find) find.addEventListener("click", () => {
      if (FIND && FIND.bar.isConnected) { closeFind(false); find.focus(); } else openFind(false);
      rbSync();
    });
    const save = nav.querySelector(".rb-save");
    if (save) save.addEventListener("click", () => { shelf.click(); rbSync(); });
    RB = { nav, kind: o.contents ? "work" : "poem", last: window.scrollY, turn: window.scrollY, kb: false };
    placeCue();
    rbSync();
  }
  // The Codex cue: under the text on a phone, above it (where the page draws it) on a wider screen.
  function placeCue() {
    const cue = app.querySelector(".detail > .engine-cue"), panel = cue && cue.nextElementSibling;
    if (!cue || !panel || !panel.classList.contains("engine")) return;
    const below = RB_PHONE.matches, slot = app.querySelector(".detail > .book-source-slot"), rule = app.querySelector(".detail > hr.rule");
    if (below === cue.classList.contains("is-below") || !slot || !rule) return;
    if (below) slot.before(cue, panel); else rule.after(cue, panel);
    cue.classList.toggle("is-below", below);
  }
  // The on-screen keyboard: a box to type in has the focus (outside the bar).
  const rbTyping = (el) => !!(el && el.matches && el.matches("textarea, select, [contenteditable]:not([contenteditable='false']), input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit'])"));
  // The page's state, put on <body> for styles.css.
  function rbSync() {
    const body = document.body;
    const on = !!(RB && RB.nav.isConnected && RB_PHONE.matches);
    body.classList.toggle("rb-on", on);
    if (!on) { body.classList.remove("rb-hide", "rb-off"); return; }
    const head = document.querySelector(".site-head");
    if (head) document.documentElement.style.setProperty("--rb-head", head.offsetHeight + "px");
    const pop = document.querySelector(".hl-bar:not([hidden]), .gl-pop, .hl-pop, .shelf-menu");
    const typing = document.activeElement;
    RB.kb = rbTyping(typing);
    body.classList.toggle("rb-off", RB.kb || !!pop);
    // Typing in Find, the top bar goes too: the keyboard leaves little enough room for the text.
    if (RB.kb && typing.closest(".find-bar")) body.classList.add("rb-hide");
    if (rbKeep()) body.classList.remove("rb-hide");
    const find = RB.nav.querySelector(".rb-find");
    if (find) find.setAttribute("aria-expanded", String(!!(FIND && FIND.bar.isConnected)));
    // Save follows the button under the text (pressed there, or from the shelf menu).
    const save = RB.nav.querySelector(".rb-save"), shelf = app.querySelector(".shelf-toggle");
    if (save && shelf) {
      const saved = shelf.getAttribute("aria-pressed") === "true";
      save.setAttribute("aria-pressed", String(saved));
      save.querySelector(".rb-l").textContent = saved ? "Saved" : "Save";
    }
  }
  // Reasons the bar stays on screen whatever the scrolling. The focus counts only when it was
  // put there from the keyboard: a tapped button keeps the focus, and the bar would never go.
  function rbKeep() {
    const panel = app.querySelector(".rt.rt-docked .rt-panel"), f = document.activeElement;
    let keyed = true;
    try { keyed = f.matches(":focus-visible"); } catch (e) { /* an older browser: any focus counts */ }
    return (RB.nav.contains(f) && keyed) || !!(panel && !panel.hidden) || !!document.querySelector("dialog[open]");
  }
  // Down past the title hides the top bar and this one; up by 40px, or the end, brings them back.
  window.addEventListener("scroll", () => {
    if (!RB || !document.body.classList.contains("rb-on")) return;
    if (!RB.nav.isConnected) { rbSync(); return; }
    const y = window.scrollY, body = document.body;
    const title = app.querySelector(".detail-title");
    const top = title ? title.getBoundingClientRect().bottom + y : 0;
    const end = y + window.innerHeight >= document.documentElement.scrollHeight - 4;
    if (y > RB.last) RB.turn = y;              // going down: the lowest point so far
    if (y <= top || end) { if (!RB.kb) body.classList.remove("rb-hide"); }
    else if (y > RB.last + 2) { if (!rbKeep()) body.classList.add("rb-hide"); }
    else if (RB.turn - y >= 40 && !RB.kb) body.classList.remove("rb-hide");
    RB.last = y;
  }, { passive: true });
  document.addEventListener("focusin", () => { if (RB) rbSync(); });
  document.addEventListener("focusout", () => { if (RB) setTimeout(() => { if (RB) rbSync(); }, 0); });
  // Pop-overs come and go with a selection, a click or Escape: looked at once those have run.
  const rbLater = () => { if (RB) setTimeout(rbSync, 0); };
  document.addEventListener("selectionchange", rbLater);
  document.addEventListener("click", rbLater);
  document.addEventListener("keyup", (e) => { if (e.key === "Escape") rbLater(); });
  {
    const turned = () => { if (RB && RB.nav.isConnected) { placeCue(); rbSync(); } };
    if (RB_PHONE.addEventListener) RB_PHONE.addEventListener("change", turned); else RB_PHONE.addListener(turned);   // Safari 13
  }
  window.addEventListener("hashchange", () => { RB = null; rbSync(); });

  // ---------- learn by heart ----------
  // "Learn by heart" (beside Find on a verse poem or book of 4 to 60 lines, and in the
  // selection bar for up to 40 selected lines of verse) opens the text full screen, in the
  // reader's Aa size and theme, at five levels: 1 Read; 2 every third word hidden (a different
  // third each round); 3 each word as its first letter; 4 each line hidden behind its first
  // word; 5 Recite (only the line numbers). Punctuation always stays. A hidden word or line is
  // a button: a tap, Enter or Space shows it, and Space anywhere shows the next one. Each
  // stanza has its own level: from level 3 the reader says "Had it" or "Missed some" under it,
  // and "Next round" moves on the stanzas they had (stanzas at 1 and 2 always move on). No
  // timer and no score beyond "Stanzas at level 5: 3 of 4".
  // Progress is kept on the text's shelf item as learn: {last, parts: {"" (the whole text) or
  // "12-20" (a passage, its lines counted as "Link to lines" counts them): {lv: [level of each
  // stanza], round, at}}}, so it follows a signed-in reader (MERGE.shelf merges it part by
  // part, mergeLearn). A text not yet on the shelf is offered a place there as "Learning";
  // until the reader takes it, its progress lasts for this visit. With the facing pages open,
  // the original can be learned instead of the translation (or the reverse). A link with
  // ?learn=1 (the shelf's "Learn by heart", on texts marked Learning) opens the view at once.
  const LEARN_MIN = 4, LEARN_MAX = 60, LEARN_PASSAGE_MAX = 40, LEARN_PARTS_MAX = 20;
  const LEARN_LEVELS = ["Read", "Some words hidden", "First letters", "Lines hidden", "Recite"];
  const LEARN_HELP = [
    "Read the stanzas through, aloud if you can.",
    "Every third word is hidden: say it, then tap it to check.",
    "Each word shows its first letter. Tap a word to see it whole.",
    "Each line shows its first word. Say the rest, then tap to check.",
    "Recite from memory, line by line. Tap a line to check it.",
  ];
  const LEARN_WORD = /([\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*)/u;   // split: words at the odd places
  const LEARN_VISIT = {};      // "id|part" -> {lv, round}: progress on a text that is not on the shelf
  let LEARN = null;            // the open view
  let LEARN_LINKED = "";       // the ?learn=1 address already opened (the page is drawn twice)
  const LEARN_DECLINED = new Set();   // texts whose shelf offer the reader put off, this visit
  const learnable = (text, translator) => { const n = lineCount(text); return n >= LEARN_MIN && n <= LEARN_MAX && !isProse(text, translator); };
  const learnButtonHTML = () => `<button class="learn-open" type="button" aria-haspopup="dialog" aria-label="Learn by heart"
    title="Learn by heart"><span class="learn-long">Learn by heart</span><span class="learn-short">By heart</span></button>`;
  // The text as stanzas of lines, numbered exactly as poemHTML numbers them (i: data-i + 1,
  // c: the printed count); range {a, b} keeps only those lines.
  function learnStanzas(text, range) {
    const box = document.createElement("div");
    box.innerHTML = poemHTML(text, false);
    return [...box.querySelectorAll(".stanza")].map((st) => [...st.querySelectorAll(".ln")]
      .map((l) => ({ t: l.textContent, i: +l.dataset.i + 1, c: +(l.dataset.c || 0) }))
      .filter((l) => !range || (l.i >= range.a && l.i <= range.b))).filter((st) => st.length);
  }
  function learnPart(id, key, n) {
    const it = shelfItems().find((x) => x.id === id);
    const p = (it && it.learn && it.learn.parts && it.learn.parts[key]) || LEARN_VISIT[id + "|" + key];
    const ok = p && Array.isArray(p.lv) && p.lv.length === n;   // a text re-cut since: start again
    return { lv: ok ? p.lv.map((v) => Math.min(5, Math.max(1, +v || 1))) : Array(n).fill(1), round: ok ? +p.round || 0 : 0 };
  }
  // Kept on the shelf item when the text is on the shelf; returns whether it was.
  function saveLearn(entry, key, part) {
    const at = new Date().toISOString(), rec = { lv: part.lv.slice(), round: part.round, at };
    LEARN_VISIT[entry.id + "|" + key] = rec;
    const s = shelfStore(), it = s.items.find((x) => x.id === entry.id);
    if (!it) return false;
    const parts = Object.assign({}, it.learn && it.learn.parts, { [key]: rec });
    const keep = Object.keys(parts).sort((a, b) => String(parts[b].at || "").localeCompare(String(parts[a].at || ""))).slice(0, LEARN_PARTS_MAX);
    it.learn = { last: at, parts: Object.fromEntries(keep.map((k) => [k, parts[k]])) };
    saveShelf(s);
    return true;
  }
  // Two devices' progress on one text: each part the more recently practised one.
  function mergeLearn(a, b) {
    if (!a || typeof a !== "object") return b;
    if (!b || typeof b !== "object") return a;
    const parts = Object.assign({}, a.parts);
    Object.entries(b.parts || {}).forEach(([k, p]) => {
      if (p && (!parts[k] || String(p.at || "") > String(parts[k].at || ""))) parts[k] = p;
    });
    return { last: [a.last, b.last].map((x) => String(x || "")).sort().pop(), parts };
  }
  const learnScore = (lv) => `Stanzas at level 5: ${lv.filter((v) => v >= 5).length} of ${lv.length}`;
  // One stanza at its level. Hidden things carry their words in data-t, shown when pressed.
  function learnStanzaHTML(st, s) {
    const lv = LEARN.lv[s], round = LEARN.round, shown = LEARN.shown;
    const hid = (k, t, cls, label, face, w) => shown.has(k) ? `<span class="lb-rev">${esc(t)}</span>`
      : `<button type="button" class="lb-hid ${cls}" data-k="${k}" data-t="${esc(t)}" aria-label="${esc(label)}"${w ? ` style="--w:${w}"` : ""}>${face}</button>`;
    let w = 0;
    const lines = st.map((l, j) => {
      const toks = l.t.split(LEARN_WORD), k = s + "." + j;
      const num = lv === 5 ? `<span class="lb-n" aria-hidden="true">${l.c || ""}</span>` : "";
      let body;
      if (lv >= 4) {
        const lead = lv === 4 ? toks.findIndex((x, y) => y % 2 === 1) : -1;
        const cue = lead >= 0 ? toks.slice(0, lead + 1).join("") : "";
        const rest = lead >= 0 ? toks.slice(lead + 1).join("") : l.t;
        body = esc(cue) + (LEARN_WORD.test(rest) ? hid(k, rest, "lb-line", lv === 4 ? "rest of line hidden, press to reveal"
          : `line${l.c ? " " + l.c : ""} hidden, press to reveal`, "", Math.min(40, rest.trim().length)) : esc(rest));
      } else {
        body = toks.map((x, y) => {
          if (y % 2 === 0) return esc(x);           // spaces and punctuation
          const at = w++;
          if (lv === 2 && at % 3 === round % 3) return hid(k + "." + y, x, "lb-word", "hidden word, press to reveal", "", x.length);
          if (lv === 3 && [...x].length > 1) {
            const first = [...x][0];
            return hid(k + "." + y, x, "lb-word lb-first", `hidden word, starts with ${first}, press to reveal`,
              esc(first) + "_".repeat([...x].length - 1), 0);
          }
          return esc(x);
        }).join("");
      }
      return `<span class="lb-ln">${num}${body}</span>`;
    }).join("");
    const mixed = new Set(LEARN.lv).size > 1;
    const judge = lv >= 3 ? `<div class="lb-judge" role="group" aria-label="Stanza ${s + 1}: how did it go?">
        <button type="button" data-judge="had" data-s="${s}" aria-pressed="${LEARN.judged[s] === "had"}">Had it</button>
        <button type="button" data-judge="missed" data-s="${s}" aria-pressed="${LEARN.judged[s] === "missed"}">Missed some</button>
      </div>` : "";
    return `<div class="lb-stanza lb-lv${lv}" data-s="${s}">
        ${mixed ? `<p class="lb-st-lv">Stanza ${s + 1} · Level ${lv}: ${LEARN_LEVELS[lv - 1]}</p>` : ""}
        <p class="lb-lines">${lines}</p>${judge}</div>`;
  }
  function learnDraw(focusTop) {
    const L = LEARN, dlg = L.dlg, low = Math.min(...L.lv), mixed = new Set(L.lv).size > 1;
    dlg.querySelector(".lb-text").innerHTML = L.stanzas.map(learnStanzaHTML).join("");
    // Stanzas at different levels: no level is checked, so any one chosen puts them all there.
    dlg.querySelectorAll('.lb-levels input').forEach((r) => { r.checked = !mixed && +r.value === low; });
    dlg.querySelector(".lb-help").textContent = mixed
      ? "Each stanza is at its own level. Choosing a level puts them all there." : LEARN_HELP[low - 1];
    dlg.querySelector(".lb-score").textContent = learnScore(L.lv) + (L.round ? ` · Round ${L.round + 1}` : "");
    if (focusTop) dlg.scrollTop = 0;
  }
  function learnOffer() {
    const L = LEARN, e = L.texts[L.pick].entry, box = L.dlg.querySelector(".lb-offer");
    const on = onShelf(e.id), st = statusOf(e.id);
    box.hidden = st === "learning" || LEARN_DECLINED.has(e.id);
    if (box.hidden) return;
    box.querySelector(".lb-offer-msg").textContent = on
      ? `Mark “${e.title}” as Learning on your shelf, so you can come back to it from there?`
      : `Keep your progress: add “${e.title}” to your shelf as Learning.`;
    box.querySelector(".lb-offer-yes").textContent = on ? "Mark as Learning" : "Add to shelf";
  }
  // texts: [{label, entry, text, translator, lang}] (two with the facing pages); pick: the one
  // to open with; range {a, b}: a passage; from: the button to give the focus back to.
  function openLearn(texts, pick, range, from) {
    if (LEARN) return;
    hideHlBar();
    closeFind(false);
    const dlg = document.createElement("dialog");
    dlg.className = "lb";
    dlg.tabIndex = -1;   // a click on the text keeps the focus here, not on the page's own shortcuts
    dlg.setAttribute("aria-labelledby", "lb-title");
    LEARN = { dlg, texts, pick, range, from, lv: [], round: 0, judged: {}, shown: new Set() };
    dlg.innerHTML = `
      <div class="lb-body">
        <div class="lb-head">
          <div class="lb-head-t">
            <p class="lb-kicker">Learn by heart</p>
            <h2 class="lb-title" id="lb-title" tabindex="-1"></h2>
            <p class="lb-by"></p>
          </div>
          <button type="button" class="lb-close">Close</button>
        </div>
        ${texts.length > 1 ? `<div class="lb-which" role="group" aria-label="Text to learn">${texts.map((t, k) =>
          `<button type="button" data-pick="${k}" aria-pressed="false"${t.ok ? "" : " disabled"}>${esc(t.label)}</button>`).join("")}</div>` : ""}
        <div class="lb-offer" hidden>
          <p class="lb-offer-msg"></p>
          <div class="lb-offer-acts"><button type="button" class="lb-offer-yes"></button><button type="button" class="lb-offer-no">Not now</button></div>
        </div>
        <fieldset class="lb-levels">
          <legend>Level</legend>
          ${LEARN_LEVELS.map((name, k) => `<label class="lb-lvl"><input type="radio" name="lb-level" value="${k + 1}"><span><b>${k + 1}</b> ${name}</span></label>`).join("")}
        </fieldset>
        <p class="lb-help"></p>
        <div class="lb-text"></div>
        <div class="lb-foot">
          <p class="lb-score" aria-live="polite"></p>
          <button type="button" class="lb-next">Next round</button>
          <p class="lb-foot-help">Next round moves on the stanzas you had, and those at levels 1 and 2. Space shows the next hidden word or line.</p>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    learnLoad(pick);
    dlg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.classList.contains("lb-hid")) { learnReveal(b, e.detail === 0); return; }
      if (b.classList.contains("lb-close")) { dlg.close(); return; }
      if (b.dataset.pick) { learnLoad(+b.dataset.pick); b.focus(); return; }
      if (b.dataset.judge) {
        const s = +b.dataset.s;
        LEARN.judged[s] = LEARN.judged[s] === b.dataset.judge ? "" : b.dataset.judge;
        b.parentNode.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(LEARN.judged[s] === x.dataset.judge)));
        return;
      }
      if (b.classList.contains("lb-offer-yes")) {
        const t = LEARN.texts[LEARN.pick];
        setStatus(t.entry, "learning");
        saveLearn(t.entry, LEARN.key, LEARN);
        learnOffer();
        announce(`“${t.entry.title}” is on your shelf as Learning.`);
        dlg.querySelector(".lb-close").focus();
        return;
      }
      if (b.classList.contains("lb-offer-no")) {
        LEARN_DECLINED.add(LEARN.texts[LEARN.pick].entry.id);
        learnOffer();
        dlg.querySelector(".lb-close").focus();
        return;
      }
      if (b.classList.contains("lb-next")) learnNextRound();
    });
    // A level chosen: every stanza goes there, and the round starts again.
    dlg.querySelector(".lb-levels").addEventListener("change", (e) => {
      const v = +e.target.value;
      if (!v) return;
      LEARN.lv = LEARN.lv.map(() => v);
      LEARN.judged = {}; LEARN.shown = new Set();
      saveLearn(LEARN.texts[LEARN.pick].entry, LEARN.key, LEARN);
      learnDraw(false);
      announce(`Level ${v}: ${LEARN_LEVELS[v - 1]}.`);
    });
    // Space shows the hidden word or line in focus, else the first one still hidden.
    dlg.addEventListener("keydown", (e) => {
      if (e.key !== " " || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (t.closest("input, textarea, select") || (t.closest("button") && !t.closest(".lb-hid"))) return;
      e.preventDefault();
      const all = [...dlg.querySelectorAll(".lb-hid, .lb-rev")], from = t.closest(".lb-rev");
      const b = t.closest(".lb-hid") || (from && all.slice(all.indexOf(from)).find((x) => x.classList.contains("lb-hid")))
        || dlg.querySelector(".lb-hid");
      if (b) learnReveal(b, true); else announce("Nothing is hidden now. Next round when you are ready.");
    });
    dlg.addEventListener("close", () => {
      const { from: back, leaving } = LEARN;
      LEARN = null;
      dlg.remove();
      if (leaving) return;
      // The page's shelf button may now read "On your shelf · Learning".
      const id = (texts.find((t) => t.own) || texts[0]).entry.id, b = app.querySelector(".shelf-toggle");
      if (b) {
        b.textContent = shelfLabel(id); b.setAttribute("aria-pressed", String(onShelf(id)));
        const v = app.querySelector(".shelf-view"); if (v) v.hidden = !onShelf(id);
      }
      const f = back && back.isConnected ? back : app.querySelector(".learn-open");
      if (f) f.focus();
    });
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    dlg.querySelector(".lb-close").focus();
  }
  // Opens (or switches to) one of the texts: its stanzas and the progress kept for it.
  function learnLoad(k) {
    const L = LEARN, t = L.texts[k], dlg = L.dlg;
    L.pick = k;
    L.stanzas = learnStanzas(t.text, L.range);
    L.key = L.range ? L.range.a + "-" + L.range.b : "";
    const p = learnPart(t.entry.id, L.key, L.stanzas.length);
    L.lv = p.lv; L.round = p.round; L.judged = {}; L.shown = new Set();
    const nums = L.stanzas.flat().map((l) => l.c).filter(Boolean);
    const loc = !L.range ? "" : nums.length ? (nums[0] === nums[nums.length - 1] ? `line ${nums[0]}` : `lines ${nums[0]}–${nums[nums.length - 1]}`)
      : `lines ${L.range.a}–${L.range.b}`;
    dlg.querySelector(".lb-title").textContent = t.entry.title;
    dlg.querySelector(".lb-by").textContent = [t.entry.author, t.translator && translatorShort(t.translator), loc].filter(Boolean).join(" · ");
    const box = dlg.querySelector(".lb-text");
    const lang = /lang="([\w-]+)"/.exec(t.lang || "");
    if (lang) box.setAttribute("lang", lang[1]); else box.removeAttribute("lang");
    dlg.querySelectorAll("[data-pick]").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.pick === k)));
    learnOffer();
    learnDraw(true);
  }
  // Shows a hidden word or line; from the keyboard, the focus goes on to the next one.
  function learnReveal(b, keyboard) {
    const L = LEARN, all = [...L.dlg.querySelectorAll(".lb-hid")], at = all.indexOf(b);
    L.shown.add(b.dataset.k);
    const span = document.createElement("span");
    span.className = "lb-rev";
    span.textContent = b.dataset.t;
    span.tabIndex = -1;
    const had = document.activeElement === b;
    b.replaceWith(span);
    if (!keyboard) { if (had) span.focus({ preventScroll: true }); return; }   // Space then goes on from here
    const next = all[at + 1];
    if (next) { next.focus(); return; }
    const judge = span.closest(".lb-stanza").querySelector(".lb-judge button");
    (judge || L.dlg.querySelector(".lb-next")).focus();
  }
  function learnNextRound() {
    const L = LEARN;
    L.lv = L.lv.map((v, s) => (v < 3 || (L.judged[s] === "had" && v < 5) ? v + 1 : v));
    L.round++;
    L.judged = {}; L.shown = new Set();
    saveLearn(L.texts[L.pick].entry, L.key, L);
    learnDraw(true);
    announce(`Round ${L.round + 1}. ${learnScore(L.lv)}.`);
    L.dlg.querySelector(".lb-title").focus();
  }
  // The page's texts: its own, and with the facing pages open the text it faces; the column
  // the reader has chosen on a phone (Old English or Translation) is the one opened.
  function learnTexts(ctx) {
    const own = { label: "", entry: ctx.entry, text: ctx.text, translator: ctx.translator, lang: ctx.lang, ok: true, own: true };
    const fx = app.querySelector(".fx-slot:not([hidden]) .fx"), on = app.querySelector('.par-toggle[aria-pressed="true"]');
    const e = fx && on && (ctx.par || []).find((x) => x.with === on.dataset.with);
    const other = e && FX_READY.get("poem:" + e.with);
    if (!other || !other.text) return { texts: [own], pick: 0 };
    const mate = { label: "", entry: { id: other.id, kind: "poem", title: other.title, author: other.author || ctx.entry.author,
                   translator: other.translator || "" }, text: other.text, translator: other.translator, lang: "", ok: learnable(other.text, other.translator) };
    const ownIsOrig = e.orig === ctx.entry.id, orig = ownIsOrig ? own : mate, tr = ownIsOrig ? mate : own;
    orig.label = LANG_NAMES[e.lang] || "Original"; tr.label = "Translation";
    if (e.lang) orig.lang = ` lang="${esc(e.lang)}"`;
    const sw = fx.querySelector(".fx-switch"), view = sw && sw.getClientRects().length ? fx.dataset.view : "";
    const want = view === "orig" ? orig : view === "tr" ? tr : own;
    return { texts: [orig, tr], pick: want.ok ? (want === orig ? 0 : 1) : (own === orig ? 0 : 1) };
  }
  // ctx: {entry, text, translator, lang, par}
  function bindLearn(ctx) {
    const btn = app.querySelector(".learn-open");
    if (btn) btn.addEventListener("click", () => { const t = learnTexts(ctx); openLearn(t.texts, t.pick, null, btn); });
    // Opened from the shelf: #/poem/keats/0?learn=1, or a passage with ?l=12-20&learn=1.
    if (!/[?&]learn=1(?:&|$)/.test(location.hash) || LEARN_LINKED === location.hash) return;
    LEARN_LINKED = location.hash;
    const r = linkedRange(), own = [{ label: "", entry: ctx.entry, text: ctx.text, translator: ctx.translator, lang: ctx.lang, ok: true, own: true }];
    if (r && r.b - r.a < LEARN_PASSAGE_MAX && !isProse(ctx.text, ctx.translator)) openLearn(own, 0, r, null);
    else if (!r && learnable(ctx.text, ctx.translator)) openLearn(own, 0, null, null);
  }
  window.addEventListener("hashchange", () => { LEARN_LINKED = ""; if (LEARN) { LEARN.leaving = true; LEARN.dlg.close(); } });
  // The shelf's way back in: "Learn by heart" beside a text marked Learning (and a passage
  // of it in a collection), with its progress.
  function shelfLearnHTML(id, l) {
    if (statusOf(id) !== "learning" || /^work:[^/]+$/.test(id)) return "";
    if (l && (() => { const m = /^(\d+)(?:-(\d+))?$/.exec(l); return !m || (+(m[2] || m[1]) - +m[1]) >= LEARN_PASSAGE_MAX; })()) return "";
    const it = shelfItems().find((x) => x.id === id), p = it && it.learn && it.learn.parts && it.learn.parts[l || ""];
    const href = routeFor(id) + (l ? "?l=" + l + "&learn=1" : "?learn=1");
    return `<span class="shelf-learn"><a href="${esc(href)}">Learn by heart</a>${p && Array.isArray(p.lv) ? ` <span class="shelf-learn-score">${esc(learnScore(p.lv))}</span>` : ""}</span>`;
  }

  // ---------- era/category taxonomy ----------
  // Umbrella categories applied to every poet's `category` field (see data/poets/<slug>.json).
  // Order here is the display/chronological order used on the home page.
  const CATEGORY_ORDER = [
    "Ancient Greek & Roman",
    "Ancient Near East",
    "Anglo-Saxon",
    "Medieval",
    "Tudor & Elizabethan",
    "Metaphysical & Cavalier",
    "Restoration & Augustan",
    "Romantic",
    "Victorian",
    "American",
    "Modern",
    "Turkish & Ottoman",
    "Arabic & Persian",
    "Hebrew",
    "Indian",
    "Italian",
    "French",
    "Nordic",
    "German",
    "Spanish & Portuguese",
    "Chinese & Japanese",
    "Celtic",
    "Russian & Slavic",
    "Hungarian",
  ];
  const CATEGORY_SLUGS = {
    "Ancient Greek & Roman": "ancient-greek-roman",
    "Ancient Near East": "ancient-near-east",
    "Anglo-Saxon": "anglo-saxon",
    "Medieval": "medieval",
    "Tudor & Elizabethan": "tudor-elizabethan",
    "Metaphysical & Cavalier": "metaphysical-cavalier",
    "Restoration & Augustan": "restoration-augustan",
    "Romantic": "romantic",
    "Victorian": "victorian",
    "American": "american",
    "Modern": "modern",
    "Turkish & Ottoman": "turkish-ottoman",
    "Arabic & Persian": "arabic-persian",
    "Hebrew": "hebrew",
    "Indian": "indian",
    "Italian": "italian",
    "French": "french",
    "Nordic": "nordic",
    "German": "german",
    "Spanish & Portuguese": "spanish-portuguese",
    "Chinese & Japanese": "chinese-japanese",
    "Celtic": "celtic",
    "Russian & Slavic": "russian-slavic",
    "Hungarian": "hungarian",
  };
  const SLUG_TO_CATEGORY = Object.fromEntries(Object.entries(CATEGORY_SLUGS).map(([k, v]) => [v, k]));
  const EPICS_SLUG = "epics";
  // "Epics" is a cross-cutting tag derived from each work's existing `type` field
  // (e.g. "Epic poem", "Heroic poem", "Historical epic") rather than a duplicated
  // boolean flag in the data — one regex here keeps the work files untouched.
  const isEpicWork = (w) => /\b(epic|heroic (?:poems?|lays?))\b/i.test(w.type || "");
  // How many epics, counting the translations of one original once (as on the Epics page).
  const epicCount = (works) => new Set((works || []).filter(isEpicWork).map((w) => w.workGroup || w.slug)).size;

  // ---------- a fast first screen ----------
  // data/index.json is large (about 25 MB), and on a phone the home page used to wait 10 to
  // 40 seconds for it. The home page needs only the counts and the poem of the day, which
  // data/home.json holds (about 80 KB, written by tools/build_home.py from the same index):
  // the home page is drawn from it at once while the index loads. Every other page waits for
  // the index as before ("Opening the archive…"). If home.json is missing or broken, the
  // home page waits for the index too, as it always did; if it is slow (1.5 s), the home
  // page says "Opening the archive…" meanwhile, and is still drawn from it if it comes first.
  // The request is started by a line in the <head> of index.html (window.pcHome), so it runs
  // while app.js is still loading; a <link rel=preload> did the same but the service worker
  // could not hand its copy to this fetch, and the file came down twice.
  // Poem pages, books of works and contents pages never ask for the index by themselves
  // (only the home page does, after its first paint): a reader who opens one poem gets that
  // poem and not 9 MB of index. It is fetched when something needs it (the search box, the
  // lists, Poets, Eras, a category, the shelf; see routeEarly and loadIndex's callers).
  const homeFetch = (window.pcHome && typeof window.pcHome.then === "function")
    ? window.pcHome : fetch("data/home.json", { priority: "high" });
  homeFetch
    .then((r) => (r && r.ok ? r.json() : null))
    .then((h) => {
      if (h && typeof h.count === "number" && h.eras) HOME = h; else HOME_FAILED = true;
    }, () => { HOME_FAILED = true; })
    .then(() => {
      if (DATA) return;                       // the index won the race: nothing to do
      const fc = document.getElementById("foot-count");
      if (HOME && fc && !fc.textContent) fc.textContent = num(HOME.count);
      if (isHomeHash(location.hash) || isTodayHash(location.hash)) route(); // other pages already say "Opening the archive…"
      if (isHomeHash(location.hash)) afterPaint(loadIndex);
    });
  setTimeout(() => {
    if (HOME || DATA || HOME_FAILED) return;
    HOME_FAILED = true;
    if (isHomeHash(location.hash) || isTodayHash(location.hash)) { loadIndex(); route(); }
  }, 1500);

  // The index (32 MB; reading it holds the page up for half a second or more on a phone) is
  // fetched after the home page's first paint (drawn from home.json), and by any page that
  // needs it (routeEarly). A poem, a book of a work or a contents page never fetches it by
  // itself: it is drawn from its shard (or work/works.json) and stays as it is; what only the
  // index can do there (the "Compare with another poem" picker) asks for it when used, and
  // whenIndex() runs its callbacks once it is in.
  let INDEX_STARTED = false;
  const INDEX_WAITERS = [];
  const whenIndex = (fn) => { if (DATA || INDEX_ERROR) fn(); else INDEX_WAITERS.push(fn); };
  function loadIndex() {
    if (INDEX_STARTED) return;
    INDEX_STARTED = true;
    fetch("data/index.json", { priority: "low" })   // after the home file and any shard
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((d) => {
        DATA = d;
        d.poets.forEach((p) => { POETS[p.slug] = p; });
        (d.works || []).forEach((w) => { WORKS[w.slug] = w; });
        d.poets.forEach((p) => {
          if (!p.category) return;
          const s = (CATEGORY_STATS[p.category] = CATEGORY_STATS[p.category] || { poems: 0, works: 0 });
          s.poems += p.poemCount || 0;
          s.works += p.workCount || 0;
        });
        // Since C2 the index leaves out what it can derive: the poet's slug (the first half of
        // the id), the author (the poet's name), subjects when only the primary one, and empty
        // collection / translator. Filled back in here, so the rest of the app is unchanged; an
        // older index that still has them all works the same.
        d.poems.forEach((p) => {
          if (!p.authorSlug) p.authorSlug = p.id.slice(0, p.id.lastIndexOf("/"));
          if (!p.author) p.author = (POETS[p.authorSlug] || {}).name || "";
          if (!p.subjects) p.subjects = [p.primarySubject];
          if (p.collection === undefined) p.collection = null;
        });
        // Sorted by title once; every list filters this and so keeps the order.
        d.poems.forEach((p) => { p._sk = sortKey(p.title); });
        SORTED = d.poems.slice().sort((a, b) => COLLATE.compare(a._sk, b._sk));
        const fc = document.getElementById("foot-count"); if (fc) fc.textContent = num(d.count);
        wireSearch();
        // A home page already drawn from home.json stays as it is, and where the reader has
        // scrolled it to, unless the index tells a different story (a home.json older than
        // the index): then it is redrawn in place.
        if (EARLY_HOME && isHomeHash(location.hash)) {
          const html = homeHTML();
          if (html !== EARLY_HOME) app.innerHTML = html;
          EARLY_HOME = "";
        } else if (EARLY_DRAWN && EARLY_DRAWN === location.hash) {
          // A page drawn without the index stays as it is (the reader may be typing in it),
          // with the poem's form added to its label; a book whose other translations were not
          // known (no work/works.json) is drawn again in place, where the reader is.
          if (EARLY_REDRAW) {
            const y = window.scrollY;
            route();
            restoreY = y;
            jumpTo(y);
          } else {
            upgradeEarly();
            EARLY_DRAWN = "";
          }
        } else route();
        INDEX_WAITERS.splice(0).forEach((fn) => { try { fn(); } catch (err) { /* one slip does not stop the rest */ } });
      })
      .catch((e) => {
        INDEX_ERROR = String(e && e.message || e);
        EARLY_HOME = "";
        // A page drawn without the index keeps its text; only what was waiting hears of it.
        if (!(EARLY_DRAWN && EARLY_DRAWN === location.hash)) app.innerHTML = indexErrorHTML();
        INDEX_WAITERS.splice(0).forEach((fn) => { try { fn(); } catch (err) { /* as above */ } });
      });
  }
  const afterPaint = (fn) => requestAnimationFrame(() => setTimeout(fn, 60));
  // A poem page drawn without the index, once it is in: the poem's form ("Sonnet") in its label.
  function upgradeEarly() {
    const m = location.hash.match(/^#\/poem\/([\w-]+\/\d+)(?:\?[\w=&-]*)?$/);
    const label = m && app.querySelector(".detail .detail-subject");
    if (!label || label.dataset.form) return;
    const form = indexPoem(m[1]).form;
    if (form) { label.dataset.form = form; label.textContent += " · " + form; }
  }
  // A signed-in reader: the account's copy is pulled after the first paint (reader accounts).
  updateAccountNav();
  if (signedIn()) setTimeout(pullNow, 1200);   // a timer, not a frame: it runs in a background tab too
  const indexErrorHTML = () => `<p class="empty">Could not load the archive (${esc(INDEX_ERROR)}).<br>Serve this through a local server, not a file:// path.</p>`;

  // ---------- search: suggestions as you type, a results page, a work's translations ----------
  // Every search box shows suggestions under it as the reader types (works, poets, poems),
  // from two small files built by tools/build_suggest.py: data/suggest/core.json (every work,
  // translations grouped, and every poet) and data/suggest/p/<abc>.json (the poem titles
  // with a word that begins with those letters). Enter, or "See all results", opens
  // #/search?q=, drawn from the same files. Neither needs the archive index.
  let SG_CORE = null;
  const SG_SHARDS = {};
  const sgFold = (s) => fold(s).replace(/^(the|a|an) /, "");
  function sgCore() {
    return SG_CORE || (SG_CORE = fetch("data/suggest/core.json").then((r) => r.ok ? r.json() : []).catch(() => [])
      .then((rows) => rows.map(([k, label, sub, href, weight, extra]) => ({ k, label, sub, href, weight, extra, f: sgFold(label), full: fold(label) }))));
  }
  function sgShard(key) {
    return SG_SHARDS[key] || (SG_SHARDS[key] = fetch(`data/suggest/p/${key}${["con", "prn", "aux", "nul"].includes(key) ? "_" : ""}.json`).then((r) => r.ok ? r.json() : []).catch(() => []));
  }
  const sgWords = (q) => fold(q).split(" ").filter(Boolean);
  // Every word of the search begins a word of the text ("grec ur" finds "Ode on a Grecian Urn").
  const sgHasAll = (text, words) => { const ws = text.split(" "); return words.every((w) => ws.some((t) => t.startsWith(w))); };
  function sgScoreCore(e, q, words) {
    if (e.f === q || e.full === q) return 0;
    if (e.f.startsWith(q) || e.full.startsWith(q)) return 1;
    if (e.k === "p" && e.full.split(" ").pop().startsWith(q)) return 1.5;   // a surname: "keats"
    if (sgHasAll(e.full, words)) return 2;
    return -1;
  }
  async function sgFind(qRaw, limits) {
    const q = fold(qRaw), words = sgWords(qRaw);
    if (!q) return { works: [], poets: [], poems: [] };
    const core = await sgCore();
    const ranked = core.map((e) => [sgScoreCore(e, q, words), e]).filter((x) => x[0] >= 0)
      .sort((a, b) => a[0] - b[0] || b[1].weight - a[1].weight || a[1].label.length - b[1].label.length).map((x) => x[1]);
    const works = ranked.filter((e) => e.k === "w").slice(0, limits.works);
    const poets = ranked.filter((e) => e.k === "p").slice(0, limits.poets);
    let poems = [];
    const long = words.filter((w) => w.length >= 3).sort((a, b) => b.length - a.length)[0];
    if (long) {
      const rows = await sgShard(long.slice(0, 3));
      const qs = sgFold(qRaw);
      const seen = new Set();
      poems = rows.map((r) => {
        const t = fold(r[0]), ts = sgFold(r[0]);
        let s;
        if (ts === qs || t === q) s = 0;
        else if (ts.startsWith(qs) || t.startsWith(q)) s = 1;
        else if (t.includes(q)) s = 2;
        else if (sgHasAll(t, words)) s = 3;
        else if (sgHasAll(t + " " + fold(r[1]), words)) s = 4;
        else return null;
        return [s, r];
      }).filter(Boolean).sort((a, b) => a[0] - b[0] || a[1][0].length - b[1][0].length)
        .map((x) => x[1]).filter((r) => !seen.has(r[2]) && seen.add(r[2])).slice(0, limits.poems);
    }
    return { works, poets, poems };
  }
  const poemHref = (id) => "#/poem/" + id;
  // ----- the dropdown under a search box -----
  function attachSuggest(input) {
    if (input.dataset.sg) return;
    input.dataset.sg = "1";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    const box = document.createElement("div");
    box.className = "sg-box"; box.hidden = true; box.setAttribute("role", "listbox");
    box.id = "sg-" + Math.random().toString(36).slice(2, 8);
    input.setAttribute("aria-controls", box.id);
    (input.closest("form") || input.parentNode).appendChild(box);
    let seq = 0, active = -1, items = [];
    const close = () => { box.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
    const go = (href) => { close(); input.blur(); location.hash = href.replace(/^#/, ""); };
    const setActive = (k) => {
      active = k;
      items.forEach((a, j) => a.classList.toggle("is-active", j === k));
      if (items[k]) { input.setAttribute("aria-activedescendant", items[k].id); items[k].scrollIntoView({ block: "nearest" }); }
    };
    async function update() {
      const v = input.value.trim(), my = ++seq;
      if (fold(v).length < 2) { close(); return; }
      const r = await sgFind(v, { works: 4, poets: 4, poems: 6 });
      if (my !== seq) return;
      const row = (href, title, sub, kind) => `<a class="sg-item" role="option" href="${esc(href)}"><span class="sg-t">${title}</span>${sub ? `<span class="sg-s">${sub}</span>` : ""}${kind ? `<span class="sg-k">${kind}</span>` : ""}</a>`;
      const groups = [];
      if (r.works.length) groups.push(`<div class="sg-group"><p class="sg-head">Works</p>${r.works.map((e) => row(e.href, esc(e.label), esc(e.sub), esc(e.extra))).join("")}</div>`);
      if (r.poets.length) groups.push(`<div class="sg-group"><p class="sg-head">Poets</p>${r.poets.map((e) => row(e.href, esc(e.label), esc(e.sub), "")).join("")}</div>`);
      if (r.poems.length) groups.push(`<div class="sg-group"><p class="sg-head">Poems</p>${r.poems.map((p) => row(poemHref(p[2]), esc(p[0]), esc(p[1]), "")).join("")}</div>`);
      box.innerHTML = groups.join("") + `<a class="sg-item sg-all" role="option" href="#/search?q=${encodeURIComponent(v)}">See all results for “${esc(v)}” →</a>`;
      items = [...box.querySelectorAll(".sg-item")];
      items.forEach((a, j) => { a.id = box.id + "-" + j; });
      active = -1;
      box.hidden = false; input.setAttribute("aria-expanded", "true");
    }
    let t = 0;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(update, 90); });
    input.addEventListener("focus", () => { sgCore(); if (input.value.trim()) update(); });
    input.addEventListener("keydown", (e) => {
      if (box.hidden && e.key !== "Enter") return;
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(items.length - 1, active + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(-1, active - 1)); }
      else if (e.key === "Escape") { close(); }
      else if (e.key === "Enter" && active >= 0 && items[active]) { e.preventDefault(); go(items[active].getAttribute("href")); }
    });
    box.addEventListener("mousedown", (e) => e.preventDefault());     // the input keeps focus
    box.addEventListener("click", (e) => { const a = e.target.closest(".sg-item"); if (a) { e.preventDefault(); go(a.getAttribute("href")); } });
    input.addEventListener("blur", () => setTimeout(close, 120));
  }
  // ----- the results page: #/search?q= -----
  const SR_PAGE = 30;
  async function renderSearch(qRaw) {
    setRoute("poems", "sub");
    setTitle(qRaw ? `“${qRaw}” · Search` : "Search");
    document.querySelectorAll("input.search-input").forEach((i) => { if (document.activeElement !== i) i.value = qRaw; });
    if (!qRaw.trim()) { app.innerHTML = `<div class="page-head"><h1 class="page-title">Search</h1><p class="page-sub">Type a poem, a poet or a work in the box above.</p></div>`; return; }
    app.innerHTML = `<p class="loading">Searching…</p>`;
    const h = location.hash;
    const r = await sgFind(qRaw, { works: 40, poets: 40, poems: 400 });
    if (location.hash !== h) return;
    const top = [...r.works, ...r.poets].find((e) => sgScoreCore(e, fold(qRaw), sgWords(qRaw)) <= 1.5);
    const topW = top && top.k === "w" ? await topWorkHTML(top) : "";
    const topHTML = top ? (topW || `
      <a class="sr-top" href="${esc(top.href)}">
        <span class="sr-top-k">Poet</span>
        <span class="sr-top-t">${esc(top.label)}</span>
        <span class="sr-top-s">${esc([top.sub, top.extra].filter(Boolean).join(" · "))}</span>
        <span class="sr-top-go">See the poems →</span>
      </a>`) : "";
    const rest = (list) => list.filter((e) => e !== top);
    const row = (href, t, s, k) => `<li><a class="sr-row" href="${esc(href)}"><span class="sr-t">${t}</span><span class="sr-s">${s}</span>${k ? `<span class="sr-k">${k}</span>` : ""}</a></li>`;
    const works = rest(r.works), poets = rest(r.poets), poems = r.poems;
    const none = !top && !works.length && !poets.length && !poems.length;
    app.innerHTML = `
      <div class="sr">
        <div class="page-head"><p class="sr-label">Search</p><h1 class="page-title">“${esc(qRaw)}”</h1>
          <p class="page-sub">${none ? "Nothing found. Try fewer words, or another spelling." :
            [r.works.length && `${num(r.works.length)} work${r.works.length === 1 ? "" : "s"}`, r.poets.length && `${num(r.poets.length)} poet${r.poets.length === 1 ? "" : "s"}`,
             poems.length && `${poems.length >= 400 ? "400+" : num(poems.length)} poem${poems.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</p></div>
        ${topHTML}
        ${works.length ? `<section class="sr-sec"><h2 class="section-label">Works</h2><ul class="sr-list">${works.map((e) => row(e.href, esc(e.label), esc(e.sub), esc(e.extra))).join("")}</ul></section>` : ""}
        ${poets.length ? `<section class="sr-sec"><h2 class="section-label">Poets</h2><ul class="sr-list sr-cols">${poets.slice(0, 12).map((e) => row(e.href, esc(e.label), esc(e.sub), "")).join("")}</ul></section>` : ""}
        ${poems.length ? `<section class="sr-sec"><h2 class="section-label">Poems</h2><ul class="sr-list" id="sr-poems">${poems.slice(0, SR_PAGE).map((p) => row(poemHref(p[2]), esc(p[0]), esc(p[1]), "")).join("")}</ul>
          ${poems.length > SR_PAGE ? `<div class="more-row"><button class="more-btn sr-more" type="button">Show more poems</button></div>` : ""}</section>` : ""}
      </div>`;
    let shownP = SR_PAGE;
    const more = app.querySelector(".sr-more");
    if (more) more.addEventListener("click", () => {
      const ul = document.getElementById("sr-poems");
      ul.insertAdjacentHTML("beforeend", poems.slice(shownP, shownP + SR_PAGE).map((p) => row(poemHref(p[2]), esc(p[0]), esc(p[1]), "")).join(""));
      shownP += SR_PAGE;
      if (shownP >= poems.length) more.parentNode.remove();
    });
    restoreScroll();
  }
  // The top result for a work: its translations listed at once.
  async function topWorkHTML(e) {
    const m = /^#\/versions\/([\w-]+)$/.exec(e.href);
    if (!m) return "";
    await loadWorks();
    const vs = versionsOf(m[1]);
    if (!vs.length) return "";
    return `
      <section class="sr-top sr-top-work">
        <span class="sr-top-k">${esc(vs[0].type || "Work")}</span>
        <a class="sr-top-t" href="${esc(e.href)}">${esc(e.label)}</a>
        <span class="sr-top-s">${esc(e.sub)} · ${esc(e.extra)}</span>
        ${versionsListHTML(vs.slice(0, 6))}
        ${vs.length > 6 ? `<a class="sr-top-go" href="${esc(e.href)}">All ${num(vs.length)} versions →</a>` : ""}
      </section>`;
  }
  // ----- a work's translations: #/versions/<workGroup> -----
  function versionsOf(group) {
    return Object.values(WORKS).filter((w) => (w.workGroup || w.slug) === group)
      .sort((a, b) => (isRecommended(b) - isRecommended(a)) || (!a.translator ? -1 : !b.translator ? 1 : (verYear(a) || "9").localeCompare(verYear(b) || "9")));
  }
  const versionsListHTML = (vs) => `<ol class="vs-list">${vs.map((w) => `
      <li><a class="vs-row" href="#/work/${esc(w.slug)}">
        <span class="vs-name">${esc(w.translator ? translatorShort(trName(w.translator)) : (w.subtitle || "Original text"))}${recBadge(w)}</span>
        <span class="vs-meta">${esc([verYear(w) || w.year, w.sections && w.sections[0] && w.sections[0].prose ? "prose" : "verse", w.sections && w.sections.length > 1 ? `${num(w.sections.length)} books` : ""].filter(Boolean).join(" · "))}</span>
      </a></li>`).join("")}</ol>`;
  async function renderVersions(group) {
    setRoute("poems", "sub");
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    await loadWorks();
    if (location.hash !== h) return;
    const vs = versionsOf(group);
    if (!vs.length) { app.innerHTML = `<p class="empty">This work is not in the archive.</p>`; return; }
    if (vs.length === 1) { location.replace("#/work/" + vs[0].slug); return; }
    const title = vs.map((w) => w.title.replace(/\s*\([^)]*\)\s*$/, "")).sort((a, b) => a.length - b.length)[0];
    const lead = vs.find((w) => w.blurb) || vs[0];
    setTitle(`${title} — ${lead.author}`);
    app.innerHTML = `
      <article class="detail vs-page">
        <div class="detail-subject">${esc(lead.type || "Work")}</div>
        <h1 class="detail-title">${esc(title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(lead.authorSlug)}">${esc(lead.author)}</a></p>
        ${lead.blurb ? `<p class="note-block">${esc(lead.blurb)}</p>` : ""}
        <h2 class="section-label">${num(vs.filter((w) => w.translator).length)} translations in the archive</h2>
        ${versionsListHTML(vs)}
        <p class="vs-tip">Each book can be read beside another translation: open a book and choose “Compare side by side”.</p>
      </article>`;
    restoreScroll();
  }

  // ---------- installing the app ----------
  // Poetry Codex installs as an app (site.webmanifest, sw.js): on Android and on a laptop the
  // browser offers it and "Install the app" (footer) asks for it; on an iPhone or iPad, where
  // Safari has no such prompt, the same link shows how to add it to the Home Screen.
  let INSTALL_EVT = null;
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function showInstall() {
    const can = !isStandalone() && (!!INSTALL_EVT || isIOS());
    document.querySelectorAll(".install-app").forEach((b) => { b.hidden = !can; });
  }
  window.addEventListener("beforeinstallprompt", (e) => { INSTALL_EVT = e; showInstall(); });
  window.addEventListener("appinstalled", () => { INSTALL_EVT = null; showInstall(); });
  function iosGuide() {
    const d = document.createElement("div");
    d.className = "ios-guide"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Install Poetry Codex");
    d.innerHTML = `<div class="ios-card">
      <button type="button" class="gl-close" aria-label="Close">×</button>
      <p class="gl-kind">Install the app</p>
      <h3 class="gl-title">Poetry Codex on your iPhone or iPad</h3>
      <ol class="ios-steps">
        <li>In Safari, tap the <strong>Share</strong> button (the square with an arrow pointing up).</li>
        <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
        <li>Open Poetry Codex from its icon: it runs full screen, like any app, with your shelf, highlights and notes.</li>
      </ol></div>`;
    document.body.appendChild(d);
    const close = () => d.remove();
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest(".gl-close")) close(); });
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest && e.target.closest(".install-app");
    if (!b) return;
    e.preventDefault();
    if (INSTALL_EVT) { INSTALL_EVT.prompt(); try { await INSTALL_EVT.userChoice; } catch (err) { /* dismissed */ } INSTALL_EVT = null; showInstall(); }
    else if (isIOS()) iosGuide();
  });
  showInstall();
  // A text saved to the shelf is fetched at once, so the app keeps it for reading offline.
  function keepOffline(id) {
    const m = /^work:([^/]+)/.exec(id);
    const url = m ? `data/works/${encodeURIComponent(m[1])}.json` : `data/poets/${encodeURIComponent(id.split("/")[0])}.json`;
    fetch(url).catch(() => {});
  }
  // ---------- global search ----------
  // Typing redraws the list 150 ms after the last key, not on every key. Typing anywhere
  // but the archive goes to it; the top bar's box takes over at once, so the reader can
  // keep typing even though the box they started in (home page, Eras page) goes away.
  let searchTimer = 0;
  const onArchive = () => /^#\/poems(\?|$)/.test(location.hash);
  // (Before the index is in there is no list to redraw: route() draws it, with the search,
  // when the index arrives.)
  function freshList() { if (!DATA) return; shown = PAGE; renderList(); jumpTo(0); saveView(); }
  function wireSearch() {
    document.querySelectorAll("input.search-input").forEach((input) => {
      input.value = query;
      if (input.dataset.wired) return;          // safe to call again after a render
      input.dataset.wired = "1";
      // Suggestions under the box as the reader types (attachSuggest); Enter opens the
      // results page. Neither needs the archive index.
      attachSuggest(input);
    });
    document.querySelectorAll("form.search-form").forEach((form) => {
      if (form.dataset.wired) return;
      form.dataset.wired = "1";
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = form.querySelector("input.search-input");
        const v = input ? input.value.trim() : "";
        if (!v) return;
        if (input) input.blur();
        location.hash = "#/search?q=" + encodeURIComponent(v);
      });
    });
  }
  function syncSearchInput() {
    document.querySelectorAll("input.search-input").forEach((input) => {
      if (document.activeElement !== input) input.value = query;
    });
  }

  // ---------- coming back to where you were ----------
  // Each history entry remembers its scroll position and, on card lists, how many cards
  // were showing and what was searched, so Back from a poem lands on the card the reader
  // left. A new visit to a page starts at the top. The browser's own restoration is off:
  // it would scroll before the page is drawn.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  let viewTimer = 0;
  let restoreY = 0;          // poems and work sections load first; they scroll once drawn
  function saveView() {
    clearTimeout(viewTimer);
    // Nothing drawn yet whose place is worth keeping (a poem or a book drawn without the
    // index is: Back returns to the same line of it).
    if (!DATA && !EARLY_HOME && EARLY_DRAWN !== location.hash) return;
    try {
      history.replaceState(Object.assign({}, history.state,
        { y: Math.round(window.scrollY), shown, query, filterSubject, filterForm }), "");
    } catch (e) { /* too many saves in a row (Safari limits them): the next one will do */ }
  }
  window.addEventListener("scroll", () => {
    clearTimeout(viewTimer); viewTimer = setTimeout(saveView, 250);
  }, { passive: true });
  // Leaving by a link or button: save first, before the next page replaces this one.
  document.addEventListener("click", (e) => { if (e.target.closest("a, button")) saveView(); }, true);
  // The stylesheet scrolls smoothly (for in-page jumps); a new page should simply be there.
  function jumpTo(y) {
    const root = document.documentElement;
    root.style.scrollBehavior = "auto";
    void root.offsetHeight;   // apply it before scrolling, or Chrome still glides
    window.scrollTo(0, y);
    root.style.scrollBehavior = "";
  }
  function restoreScroll() { if (restoreY) jumpTo(restoreY); restoreY = 0; }

  // ---------- routing ----------
  window.addEventListener("hashchange", route);
  // The home page: "#/", no hash, or a query on it. (route() also sends unknown addresses
  // home once the index is in.)
  const isHomeHash = (h) => !h || /^#\/?(\?.*)?$/.test(h);
  const isTodayHash = (h) => h === "#/today";
  const EARLY_NAV = [[/^#\/category\b/, "eras"], [/^#\/(poems|poem|work|today)\b/, "poems"], [/^#\/poets?\b/, "poets"],
    [/^#\/topics/, "topics"], [/^#\/about/, "about"], [/^#\/shelf/, "shelf"], [/^#\/account/, "account"], [/^#\/oracle/, "oracle"], [/^#\/eras/, "eras"]];
  // Before the index is in: the home page from home.json if it has come (while it is on its
  // way the home page shows only the masthead), anything else "Opening the archive…".
  // route() draws the page properly when the index arrives.
  function routeEarly() {
    const h = location.hash;
    updateShelfNav();
    if (isHomeHash(h)) {
      setRoute("", "home");
      let html = "";
      if (HOME && !INDEX_ERROR) {
        try { html = homeHTML(); }
        catch (e) { HOME = null; HOME_FAILED = true; }   // a home.json it cannot read: wait for the index
      }
      EARLY_HOME = html;
      if (html) {
        setTitle("");
        app.innerHTML = html;
        const st = history.state;   // a reload or Back keeps its place, as route() does
        if (st && typeof st.y === "number") jumpTo(st.y);
      } else if (INDEX_ERROR) app.innerHTML = indexErrorHTML();
      else if (HOME_FAILED) app.innerHTML = `<p class="loading">Opening the archive…</p>`;
      return;
    }
    EARLY_HOME = "";
    // A poem or a book of a work is drawn from its shard at once, a work's contents and two
    // translations side by side from work/works.json, the poem of the day from home.json;
    // none of them waits for the index or asks for it.
    const st = history.state && typeof history.state.y === "number" ? history.state : null;
    // (The page scrolls to its saved place once drawn: restoreScroll(), in each renderer that
    // waits for a file, here for one that draws at once.)
    const early = (fn, drawsAtOnce) => {
      setRoute("poems", "sub"); restoreY = st ? st.y : 0; jumpTo(0); fn();
      if (drawsAtOnce) restoreScroll();
    };
    let m;
    if ((m = h.match(/^#\/poem\/([\w-]+)\/(\d+)(?:\?[\w=&-]*)?$/))) { early(() => renderDetail(m[1], parseInt(m[2], 10))); return; }
    if ((m = h.match(/^#\/work\/([\w-]+)\/(\d+)(?:\?[\w=&-]*)?$/))) { early(() => renderWorkSection(m[1], parseInt(m[2], 10))); return; }
    if (h === "#/today" && (HOME || !HOME_FAILED)) {
      if (HOME) early(renderToday);           // else home.json is on its way: its arrival routes again
      else { setRoute("poems", "sub"); app.innerHTML = `<p class="loading">Loading…</p>`; }
      return;
    }
    if ((m = h.match(/^#\/work\/([\w-]+)(?:\/(\d+)\/with\/([\w-]+)|\?list=\d+)?$/))) {
      setRoute("poems", "sub");
      if (!WORKS[m[1]]) app.innerHTML = `<p class="loading">Loading…</p>`;
      loadWorks().then((ok) => {
        if (location.hash !== h || DATA) return;            // moved on, or the index has drawn it
        if (ok && WORKS[m[1]]) {
          EARLY_DRAWN = h; EARLY_REDRAW = false;
          if (m[2]) early(() => renderCompare(m[1], parseInt(m[2], 10), m[3]));
          else early(() => renderWork(m[1]), true);
        } else {                                            // no works.json: the index it is
          loadIndex();
          app.innerHTML = INDEX_ERROR ? indexErrorHTML() : `<p class="loading">Opening the archive…</p>`;
        }
      });
      return;
    }
    // The reader's notes and highlights need only the texts they are on.
    if (/^#\/notes(?:$|[?/])/.test(h)) { setRoute("shelf", "sub"); jumpTo(st ? st.y : 0); renderNotes(); return; }
    loadIndex();
    const nav = EARLY_NAV.find(([re]) => re.test(h));
    setRoute(nav ? nav[1] : "", "sub");
    app.innerHTML = INDEX_ERROR ? indexErrorHTML() : `<p class="loading">Opening the archive…</p>`;
  }
  function route() {
    if (READING_NOW) { clearTimeout(readingTimer); noteReading(); READING_NOW = null; }
    {
      const h0 = location.hash || "", st0 = history.state && typeof history.state.y === "number" ? history.state : null;
      let m0;
      if ((m0 = h0.match(/^#\/search(?:\?q=(.*))?$/))) { restoreY = st0 ? st0.y : 0; jumpTo(0); renderSearch(decodeURIComponent((m0[1] || "").replace(/\+/g, " "))); return; }
      if ((m0 = h0.match(/^#\/versions\/([\w-]+)$/))) { restoreY = st0 ? st0.y : 0; jumpTo(0); renderVersions(m0[1]); return; }
      if ((m0 = h0.match(/^#\/surprise(?:\?([\w=&-]*))?$/))) { setRoute("poems", "sub"); jumpTo(0); renderSurprise(m0[1] || ""); return; }
      // an old link to the archive with a search goes to the results page
      if ((m0 = h0.match(/^#\/poems\?(?:.*&)?q=([^&]+)/))) { location.replace("#/search?q=" + m0[1]); return; }
    }
    if (!DATA) { routeEarly(); return; }
    const h = location.hash || "#/";
    // Back/Forward bring back the entry's saved view; anything else is a fresh visit.
    const st = history.state && typeof history.state.y === "number" ? history.state : null;
    shown = st && st.shown > PAGE ? st.shown : PAGE;
    if (st && /^#\/poems(\?|$)/.test(h)) {
      query = st.query || "";
      filterSubject = st.filterSubject || "All";
      filterForm = st.filterForm || "All";
    }
    let m;
    if (h === "#/today") { setRoute("poems", "sub"); renderToday(); }
    else if ((m = h.match(/^#\/poem\/(\d+)$/))) {
      // Legacy link: #/poem/<arrayIndex> from the old single-poems.json array.
      // Resolve via the frozen legacyIndex map and redirect to the new stable id.
      // The map is its own file (data/legacy_index.json, 180 KB), fetched only for such a
      // link; an index built before C2 still carries it as legacyIndex.
      setRoute("poems", "sub");
      const oldI = parseInt(m[1], 10);
      const go = (map) => {
        if (location.hash !== h) return;   // the reader has moved on meanwhile
        const id = map && map[oldI];
        if (id) location.replace(location.href.split("#")[0] + "#/poem/" + id);
        else app.innerHTML = `<p class="empty">That poem could not be found.</p>`;
      };
      if (DATA.legacyIndex) go(DATA.legacyIndex);
      else {
        renderLoading();
        fetch("data/legacy_index.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(go).catch(() => go(null));
      }
    }
    else if ((m = h.match(/^#\/poem\/([\w-]+)\/(\d+)(?:\?[\w=&-]*)?$/))) { setRoute("poems", "sub"); renderDetail(m[1], parseInt(m[2], 10)); }
    else if ((m = h.match(/^#\/work\/([\w-]+)\/(\d+)(?:\?[\w=&-]*)?$/))) { setRoute("poems", "sub"); renderWorkSection(m[1], parseInt(m[2], 10)); }
    else if ((m = h.match(/^#\/work\/([\w-]+)\/(\d+)\/with\/([\w-]+)$/))) { setRoute("poems", "sub"); renderCompare(m[1], parseInt(m[2], 10), m[3]); }
    else if ((m = h.match(/^#\/work\/([\w-]+)(?:\?list=\d+)?$/))) { setRoute("poems", "sub"); renderWork(m[1]); }
    else if ((m = h.match(/^#\/poet\/([\w-]+)$/))) { setRoute("poets", "sub"); renderPoet(m[1]); }
    else if ((m = h.match(/^#\/category\/([\w-]+)$/))) { setRoute("eras", "sub"); renderCategory(m[1]); }
    else if (h.startsWith("#/poets")) { setRoute("poets", "sub"); renderPoets(); }
    else if (h.startsWith("#/topics")) { setRoute("topics", "sub"); renderTopics(); }
    else if (h.startsWith("#/about")) { setRoute("about", "sub"); renderAbout(); }
    else if (h.startsWith("#/shelf")) { setRoute("shelf", "sub"); renderShelf(); }
    else if (h.startsWith("#/list")) { setRoute("", "sub"); renderReadingList(); }
    else if (h.startsWith("#/notes")) { setRoute("shelf", "sub"); renderNotes(); }
    else if (h.startsWith("#/account")) { setRoute("account", "sub"); renderAccount(); }
    else if (h.startsWith("#/oracle")) { setRoute("oracle", "sub"); renderOracle(); }
    else if (h.startsWith("#/eras")) { setRoute("eras", "sub"); renderEras(); }
    else if (h.startsWith("#/poems")) {
      // "#/poems?q=keats" (the 404 page's search box) opens the archive already searched.
      const q = h.match(/[?&]q=([^&]*)/);
      if (q) {
        try { query = decodeURIComponent(q[1].replace(/\+/g, " ")).trim(); } catch (e) { query = ""; }
        filterSubject = "All"; filterForm = "All";
        history.replaceState(null, "", "#/poems");
      }
      setRoute("poems", "sub"); renderList();
    }
    else { setRoute("", "home"); renderHome(); }
    syncSearchInput();
    updateShelfNav();
    jumpTo(st ? st.y : 0);
    restoreY = st ? st.y : 0;
  }
  function setRoute(navKey, mode) {
    document.body.dataset.route = mode;   // "home" shows hero; anything else hides it
    // One h1 a page: the hero's title is the home page's h1, and a plain paragraph (hidden
    // with the hero) on every other page, whose own title is its h1.
    const ht = document.querySelector(".hero-title");
    if (ht && (ht.tagName === "H1") !== (mode === "home")) {
      const el = document.createElement(mode === "home" ? "h1" : "p");
      el.className = ht.className;
      el.innerHTML = ht.innerHTML;
      ht.replaceWith(el);
    }
    document.querySelectorAll(".tb-nav a, .hero-nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
    document.querySelectorAll("[data-acct]").forEach((a) => a.classList.toggle("active", navKey === "account"));
  }

  // ---------- helpers ----------
  // words: searchWords(query). Full poem text is not in the index (that's the whole
  // point of the split), so search covers title, poet, translator, the opening lines
  // and subjects; the folded text is built the first time a poem is searched.
  function matches(p, words) {
    if (filterSubject !== "All" && p.primarySubject !== filterSubject) return false;
    if (filterForm !== "All" && p.form !== filterForm) return false;
    if (!words.length) return true;
    if (p._hay === undefined) {
      p._hay = fold([p.title, p.author, p.translator, p.excerpt, p.subjects.join(" ")].join(" "));
    }
    return hasAll(p._hay, words);
  }
  // Cards are links, so they open in a new tab and can be followed by search engines.
  // A card's excerpt is cut at about 300 characters (a prose poem's "three lines" can run to
  // thousands), at a word break.
  const EXCERPT_MAX = 300;
  const clipExcerpt = (s) => {
    s = String(s || "");
    if (s.length <= EXCERPT_MAX) return s;
    const cut = s.slice(0, EXCERPT_MAX), sp = cut.lastIndexOf(" ");
    return (sp > EXCERPT_MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—-]+$/, "") + "…";
  };
  const cardHTML = (p) => `
    <a class="card" href="#/poem/${esc(p.id)}">
      <div class="card-subject">${esc(p.primarySubject)}</div>
      <h2 class="card-title"${langAttr(p.authorSlug, p.translator)}>${esc(p.title)}</h2>
      <div class="card-author">${esc(p.author)}</div>
      <p class="card-excerpt"${langAttr(p.authorSlug, p.translator)}>${esc(clipExcerpt(p.excerpt))}</p>
    </a>`;
  // Search results by how well they match: the exact title first, then titles that hold the
  // search (poems that carry a Codex Note ahead, then titles that start with it, then the
  // shorter titles: "Grecian" puts "Ode on a Grecian Urn" before "Grecian Kindness"), then
  // poems whose poet matches, then the rest (opening lines, translator, subject). Within a
  // rank the title order of SORTED stands (the sort is stable).
  const titleFold = (s) => fold(s).replace(/^["'“‘]*(a|an|the)\s+/, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  function rankResults(results, words) {
    if (!words.length) return results;
    const phrase = titleFold(words.join(" "));
    const score = (p) => {
      const t = p._tf === undefined ? (p._tf = titleFold(p.title)) : p._tf;
      if (t === phrase) return 0;
      // A title that holds the search: the shorter the title, the more of it the search is.
      if (t.includes(phrase) || hasAll(t, words)) return (p.hasNote ? 1e6 : 2e6) + (t.startsWith(phrase) ? 0 : 1e5) + t.length;
      if (hasAll(fold(p.author), words)) return p.hasNote ? 3e6 : 4e6;
      return p.hasNote ? 5e6 : 6e6;
    };
    return results.map((p, k) => [score(p), k, p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  }

  // The first `shown` poems, and a "Show more" button for the rest.
  function pagedCards(poems) {
    return poems.slice(0, shown).map(cardHTML).join("");
  }
  function moreHTML(total) {
    const left = total - shown;
    return left > 0 ? `<div class="more-row"><button class="more-btn" type="button">Show ${Math.min(PAGE, left)} more<span class="more-left"> · ${num(left)} left</span></button></div>` : "";
  }
  // Adds the next PAGE cards in place (no redraw, so the page does not move) and hands
  // keyboard focus to the first of them.
  function bindMore(poems) {
    const btn = app.querySelector(".more-btn");
    if (!btn) return;
    const grid = app.querySelector(".grid");
    btn.addEventListener("click", () => {
      const last = grid.lastElementChild;
      const from = shown;
      shown += PAGE;
      grid.insertAdjacentHTML("beforeend", poems.slice(from, shown).map(cardHTML).join(""));
      const row = btn.parentNode;
      if (poems.length > shown) row.outerHTML = moreHTML(poems.length);
      else row.remove();
      bindMore(poems);
      const first = last ? last.nextElementSibling : grid.firstElementChild;
      if (first) first.focus({ preventScroll: true });
      saveView();
    });
  }

  // ---------- POEMS ----------
  const workCardHTML = (w) => `
    <a class="card work-card" href="#/work/${esc(w.slug)}">
      <div class="card-subject">${esc(w.type)} · ${esc(w.year)}</div>
      <h2 class="card-title">${esc(w.title)}</h2>
      <div class="card-author">${esc(w.author)}${w.translator ? " · " + esc(translatorShort(w.translator)) : ""}</div>
      <p class="card-excerpt">${esc(w.blurb || (w.sections.length + " cantos"))}</p>
      <span class="work-flag">${w.sections.length === 1 ? "Read" : `Read in ${num(w.sections.length)} parts`} →</span>
    </a>`;

  // ---------- HOME: browse by era ----------
  // The era grid, shared by the home page and #/eras. The counts come from the index, or,
  // for the home page drawn before it arrives, from home.json.
  function eraGridHTML(eraStats = CATEGORY_STATS, nEpics = epicCount(DATA.works)) {
    const tiles = CATEGORY_ORDER.map((cat) => {
      const stats = eraStats[cat] || { poems: 0, works: 0 };
      return `
        <a class="topic-card" href="#/category/${esc(CATEGORY_SLUGS[cat])}">
          <p class="tc-name">${esc(cat)}</p>
          <p class="tc-count">${[
            stats.poems ? num(stats.poems) + " poem" + (stats.poems === 1 ? "" : "s") : "",
          ].filter(Boolean).join(" \u00b7 ")}</p>
        </a>`;
    }).join("");
    return `
      <div class="topic-grid">
        ${tiles}
        <a class="topic-card epics-tile" href="#/category/${EPICS_SLUG}">
          <p class="tc-name">Epics</p>
          <p class="tc-count">${nEpics ? num(nEpics) + " epic" + (nEpics === 1 ? "" : "s") + " \u00b7 " : ""}every era</p>
        </a>
      </div>`;
  }

  function renderEras() {
    setTitle("Eras");
    app.innerHTML = `
      <div class="page-head archive-head">
        <h1 class="page-title">Eras</h1>
        <p class="page-sub">Explore poetry across eras, poets and themes.</p>
        <form class="archive-search search-form" autocomplete="off">
          <input class="search-input" type="search" placeholder="Search by poem or poet\u2026" aria-label="Search the archive" />
          <button type="submit" aria-label="Search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </form>
      </div>
      <p class="doors-or">Browse by era</p>
      ${eraGridHTML()}
      <div class="browse-all"><a href="#/poems" class="read-link">Or browse all ${num(DATA.count)} poems \u2192</a></div>`;
    wireSearch();
  }

  // The poem of the day: the same poem for every reader on a given (UTC) day, no server
  // involved. The pool is the poems with a Codex Note (`hasNote`, from build_index.py) or,
  // in an index built before that field, every poem whose opening lines fit a card. A prime
  // stride walks the pool so that one day's poet is not the next day's too.
  // tools/build_home.py writes the next 400 days of it into home.json by the same rule:
  // change both together.
  const utcDay = () => Math.floor(Date.now() / 864e5);
  let POTD_POOL = null;
  function poemOfTheDay(day = utcDay()) {
    if (!POTD_POOL) {
      const fits = (p) => p.excerpt && p.excerpt.split("\n").every((l) => l.length <= 90);
      POTD_POOL = DATA.poems.filter((p) => p.hasNote && fits(p));
      if (!POTD_POOL.length) POTD_POOL = DATA.poems.filter(fits);
    }
    if (!POTD_POOL.length) return null;
    return POTD_POOL[(day * 7919) % POTD_POOL.length];
  }
  // A day's row of home.json (today's by default), as an object like an index entry (plus
  // `lang`), or null. home.json starts on the day it was built and runs 400 days ahead.
  function homePoemOfTheDay(day = utcDay()) {
    const row = HOME && HOME.potd && day >= HOME.potdStart ? HOME.potd[day - HOME.potdStart] : null;
    if (!row) return null;
    const p = {};
    (HOME.potdFields || []).forEach((k, i) => { p[k] = row[i]; });
    return p.id && p.title ? p : null;
  }
  // The poem of a given day, from the index when it is in (as the home page does), else
  // from home.json.
  const potdFor = (day) => (DATA ? poemOfTheDay(day) : homePoemOfTheDay(day));
  const dayLabel = (day) => { const d = new Date(day * 864e5); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; };

  // ---------- #/today: the poem of the day in full, and the days before it ----------
  // The poem comes from its shard, so the page needs no index. The earlier days are in
  // home.json from the day it was built; days before that are worked out from the index by
  // the same rule, which is fetched only when the reader asks for them.
  const TODAY_BACK = 30;
  function renderToday() {
    const today = utcDay();
    const t = potdFor(today);
    if (!t) { location.replace(location.href.split("#")[0] + "#/"); return; }
    const requestedHash = location.hash;
    const slug = t.id.slice(0, t.id.lastIndexOf("/")), n = +t.id.slice(t.id.lastIndexOf("/") + 1);
    renderLoading();
    loadPoemPage(slug, n).then((f) => {
      if (location.hash !== requestedHash) return;
      const p = f.poems[n];
      if (!p || !p.text) { location.replace(location.href.split("#")[0] + "#/poem/" + t.id); return; }
      EARLY_DRAWN = DATA ? "" : location.hash;   // drawn without the index: it stays when the index comes
      EARLY_REDRAW = false;
      const lang = langAttr(p.authorSlug || slug, p.translator);
      setTitle("Poem of the day — " + p.title);
      app.innerHTML = `
      <article class="detail potd-page">
        <div class="detail-subject">Poem of the day · ${dayLabel(today)}</div>
        <h1 class="detail-title"${lang}>${esc(p.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(slug)}">${esc(p.author)}</a>${datesHTML(slug)}</p>
        ${sourceLine(p.translator, p.collection)}
        <hr class="rule">
        ${poemBlock(p.text, { label: "The Poem", translator: p.translator, lang })}
        ${p.note ? `<div class="rule-ornament">✦ ✦ ✦</div>
        <p class="section-label">Codex Note</p>
        <p class="note-block">${esc(p.note)}</p>` : ""}
        <div class="browse-all"><a href="#/poem/${esc(t.id)}" class="read-link">Open the poem’s page, to read it with the Codex →</a></div>
        <section class="poet-poems potd-earlier">
          <h2>Earlier poems of the day</h2>
          <div class="potd-days"></div>
        </section>
      </article>`;
      bindLineNumbers();
      drawTodayDays(today);
      restoreScroll();
    }).catch((e) => { if (location.hash === requestedHash) renderFetchError(e); });
  }
  function drawTodayDays(today) {
    const box = app.querySelector(".potd-days");
    if (!box) return;
    const rows = [];
    let missing = 0;
    for (let day = today - 1; day >= today - TODAY_BACK; day--) {
      const p = potdFor(day);
      if (p) rows.push({ day, p }); else missing++;
    }
    const more = missing && !DATA ? `<div class="more-row"><button class="more-btn" type="button">${rows.length ? "Show earlier days" : `Show the last ${TODAY_BACK} days`}</button></div>` : "";
    box.innerHTML = (rows.length ? `<ul class="poem-links">${rows.map(({ day, p }) => {
      const lang = p.lang !== undefined ? (p.lang ? ` lang="${esc(p.lang)}"` : "") : langAttr(p.authorSlug, p.translator);
      return `
        <li><a href="#/poem/${esc(p.id)}"><span class="pl-title"${lang}>${esc(p.title)}</span><span class="pl-sub">${esc(p.author)} · ${dayLabel(day)}</span></a></li>`;
    }).join("")}</ul>` : "") + more;
    const btn = box.querySelector(".more-btn");
    if (btn) btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Loading…";
      const here = location.hash;
      loadIndex();
      whenIndex(() => {
        if (location.hash !== here) return;
        if (DATA) drawTodayDays(today); else btn.textContent = "Could not load the earlier days";
      });
    });
  }
  // Its own card on the home page, under the two doors. p: poemOfTheDay() or homePoemOfTheDay().
  function poemOfTheDayHTML(p) {
    if (!p) return "";
    const d = new Date();
    const lang = p.lang !== undefined ? (p.lang ? ` lang="${esc(p.lang)}"` : "") : langAttr(p.authorSlug, p.translator);
    return `<a class="potd" href="#/poem/${esc(p.id)}">
        <span class="d-kicker">Poem of the day · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}</span>
        <span class="d-name"${lang}>${esc(p.title)}</span>
        <span class="d-by">${esc(p.author)}${p.translator ? " · " + esc(translatorShort(p.translator).replace(/^trans\.\s*/i, "trans. ")) : ""}</span>
        <span class="d-verse"${lang}>${esc(p.excerpt)}</span>
        <span class="d-go">Read the poem &rarr;</span>
      </a>`;
  }

  // ---------- Surprise me: a poem at random ----------
  // "Surprise me" under the poem of the day, on each era page and on the archive when a
  // subject or form is chosen, is a link to #/surprise (with ?era=<slug>, ?subject=<key>,
  // ?form=<name>). That page draws a poem at random from the index (within the era, subject
  // or form), leaving out the last RECENT_MAX texts read and poems over SURPRISE_MAX lines,
  // and replaces itself with the poem, #/poem/<id>?from=surprise&… (so Back goes to where the
  // reader was). The index does not know a poem's length: the drawn poem's shard is fetched
  // first (the poem page needs it anyway) and a long one is drawn again, up to SURPRISE_TRIES
  // times. A poem opened this way offers "Another" (surpriseBarHTML). Nothing is kept but
  // the usual recently-read entry.
  const SURPRISE_MAX = 200, SURPRISE_TRIES = 8;
  const subjectKey = (s) => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // "era=romantic&form=Sonnet" -> {era, subject, form}, only the parts it understands.
  function surpriseFilter(q) {
    const sp = new URLSearchParams(q || ""), f = {};
    if (SLUG_TO_CATEGORY[sp.get("era")]) f.era = sp.get("era");
    if (/^[a-z0-9-]+$/.test(sp.get("subject") || "")) f.subject = sp.get("subject");
    if (/^\w+$/.test(sp.get("form") || "")) f.form = sp.get("form");
    return f;
  }
  const surpriseParams = (f) => ["era", "subject", "form"].filter((k) => f[k]).map((k) => k + "=" + encodeURIComponent(f[k])).join("&");
  const surpriseHref = (f) => "#/surprise" + (surpriseParams(f) ? "?" + surpriseParams(f) : "");
  // "Sonnets · Love · Romantic": what the draw is limited to, for its labels ("" for none).
  function surpriseScope(f) {
    const sub = f.subject && DATA ? (DATA.subjects.find((s) => subjectKey(s.name) === f.subject) || {}).name : "";
    return [f.form ? formLabel(f.form) : "", sub || "", f.era ? SLUG_TO_CATEGORY[f.era] : ""].filter(Boolean).join(" · ");
  }
  function surprisePool(f, skipRecent) {
    const cat = f.era ? SLUG_TO_CATEGORY[f.era] : "";
    const recent = new Set(skipRecent ? readingRecent().map((r) => r.id) : []);
    return DATA.poems.filter((p) => (!cat || (POETS[p.authorSlug] || {}).category === cat)
      && (!f.subject || subjectKey(p.primarySubject) === f.subject)
      && (!f.form || p.form === f.form) && !recent.has(p.id));
  }
  // Each draw has its number: the index's arrival routes again, and "Try again" draws anew,
  // so only the latest draw may open its poem.
  let surpriseSeq = 0;
  function renderSurprise(q) {
    const f = surpriseFilter(q), here = location.hash, seq = ++surpriseSeq;
    setTitle("Surprise me");
    app.innerHTML = `<p class="loading">Finding a poem…</p>`;
    loadIndex();
    whenIndex(() => {
      if (location.hash !== here || seq !== surpriseSeq) return;   // the reader has moved on
      if (!DATA) { app.innerHTML = indexErrorHTML(); return; }
      // Everything read lately is left out, unless that leaves nothing (a small era).
      let pool = surprisePool(f, true);
      if (!pool.length) pool = surprisePool(f, false);
      const give = () => {
        app.innerHTML = `<div class="page-head"><h1 class="page-title">Surprise me</h1>
          <p class="page-sub">No short poem turned up${surpriseScope(f) ? " (" + esc(surpriseScope(f)) + ")" : ""} this time.</p></div>
          <p class="surprise-row"><a class="surprise-link" href="${esc(surpriseHref(f))}">Try again</a></p>`;
        // the link is this very page, so following it would change nothing: draw again here
        app.querySelector(".surprise-link").addEventListener("click", (e) => { e.preventDefault(); renderSurprise(q); });
      };
      const draw = (k) => {
        if (location.hash !== here || seq !== surpriseSeq) return;
        if (!pool.length || k >= SURPRISE_TRIES) { give(); return; }
        const j = Math.floor(Math.random() * pool.length), p = pool[j];
        pool.splice(j, 1);
        const cut = p.id.lastIndexOf("/"), n = parseInt(p.id.slice(cut + 1), 10);
        loadPoemPage(p.id.slice(0, cut), n).then((file) => {
          const po = file && file.poems[n];
          if (po && po.text && lineCount(po.text) <= SURPRISE_MAX) {
            if (location.hash === here && seq === surpriseSeq) location.replace("#/poem/" + p.id + "?from=surprise" + (surpriseParams(f) ? "&" + surpriseParams(f) : ""));
          } else draw(k + 1);
        }, () => draw(k + 1));
      };
      draw(0);
    });
  }
  // On a poem opened by "Surprise me": a slim row under "← The Archive" with "Another".
  function surpriseBarHTML() {
    const m = location.hash.match(/\?([\w=&-]*)$/);
    if (!m || new URLSearchParams(m[1]).get("from") !== "surprise") return "";
    const f = surpriseFilter(m[1]), scope = surpriseScope(f);
    return `<p class="surprise-bar"><span class="surprise-what">A poem at random${scope ? " · " + esc(scope) : ""}</span>
        <a class="surprise-link" href="${esc(surpriseHref(f))}">Another &rarr;</a></p>`;
  }

  function renderHome() {
    setTitle("");
    app.innerHTML = homeHTML();
  }
  // The home page's markup, from the index when it is in, else from home.json (the same
  // facts, so the page does not change when the index arrives; see "a fast first screen").
  function homeHTML() {
    const f = DATA
      ? { count: DATA.count, eras: CATEGORY_STATS, epics: epicCount(DATA.works), potd: poemOfTheDay() }
      : { count: HOME.count, eras: HOME.eras, epics: HOME.epics || 0, potd: homePoemOfTheDay() };
    // Two doors under one roof: the collection, and the way of asking about it.
    // The Oracle keeps its place even while it sleeps, so the shape of the site
    // does not change when it wakes. The poem of the day has its own card below.
    const potd = poemOfTheDayHTML(f.potd);
    return `
      <div class="doors${potd ? " has-potd" : ""}">
        <a class="door door-archive" href="#/eras">
          <img src="archive-248.webp" alt="" width="124" height="124" />
          <span class="d-name">The Archive</span>
          <span class="d-line">${num(f.count)} poems,
          from Homer and Anglo-Saxon verse to the early twentieth century \u2014 every one in the public domain.</span>
          <span class="d-go">Enter &rarr;</span>
        </a>
        <a class="door door-oracle${ORACLE_LIVE ? "" : " is-resting"}" href="#/oracle">
          <img src="oracle-248.webp" alt="" width="124" height="124" />
          <span class="d-name">The Oracle</span>
          <span class="d-line">Ask for a poem, an argument, or a place to start.
          It searches the collection before it answers.</span>
          <span class="d-go">${ORACLE_LIVE ? "Consult &rarr;" : "Resting"}</span>
        </a>
      </div>
      ${homeReadingHTML()}
      ${reviewSlotHTML("home")}
      ${potd}
      <p class="surprise-row surprise-home"><a class="surprise-link" href="#/surprise">Surprise me</a>
        <span class="surprise-what">a poem at random from the whole archive</span></p>

      <p class="doors-or">Or go straight to an era</p>
      ${eraGridHTML(f.eras, f.epics)}
      <div class="browse-all"><a href="#/poems" class="read-link">Browse all ${num(f.count)} poems \u2192</a></div>`;
  }

  // ---------- CATEGORY: filtered era (or cross-cutting "epics") view ----------
  function renderCategory(slug) {
    if (slug === EPICS_SLUG) { renderEpics(); return; }
    const catName = SLUG_TO_CATEGORY[slug];
    if (!catName) { location.hash = "#/"; return; }

    const works = (DATA.works || []).filter((w) => POETS[w.authorSlug] && POETS[w.authorSlug].category === catName);
    const poems = SORTED.filter((p) => POETS[p.authorSlug] && POETS[p.authorSlug].category === catName);
    const sub = `${num(poems.length)} poem${poems.length === 1 ? "" : "s"}.`;
    const lists = eraListsHTML(catName, slug);

    setTitle(catName + " poetry");
    app.innerHTML = `
      <button class="back" id="back">← Browse by Era</button>
      <div class="page-head"><h1 class="page-title">${esc(catName)}</h1><p class="page-sub">${sub}</p>
        ${poems.length ? `<p class="surprise-row"><a class="surprise-link" href="${esc(surpriseHref({ era: slug }))}">Surprise me from this era</a></p>` : ""}</div>
      ${slug === "ancient-greek-roman" ? AGATE_HTML : `<div id="era-art"></div>`}
      ${lists}
      ${lists && (works.length || poems.length) ? `<h2 class="section-label era-az">Every work and poem, A–Z</h2>` : ""}
      <div class="grid">
        ${works.map(workCardHTML).join("")}
        ${pagedCards(poems)}
        ${!works.length && !poems.length ? `<p class="empty">Nothing filed here yet.</p>` : ""}
      </div>
      ${moreHTML(poems.length)}`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/"; });
    bindMore(poems);
    fillEraArt(slug);
  }

  // Above an era's cards: its poets (name and dates, earliest first; where there are more
  // than ERA_POETS, the ERA_POETS with most poems, and a link to all of them on the Poets
  // page) and a few poems to begin with (each of the leading poets' first poem with a Codex
  // Note, else their first poem), in the poet-page list style.
  const ERA_POETS = 40, ERA_START = 10;
  const poetSize = (p) => (p.poemCount || 0) + (p.workCount || 0);
  let ERA_FIRSTS = null;   // poet slug -> the poem to begin with (built once)
  function eraListsHTML(catName, slug) {
    const all = DATA.poets.filter((p) => p.category === catName && poetSize(p) > 0);
    if (all.length < 2) return "";
    const byDate = (a, b) => (a.order ?? 0) - (b.order ?? 0);
    const bySize = all.slice().sort((a, b) => poetSize(b) - poetSize(a) || byDate(a, b));
    const poets = (all.length > ERA_POETS ? bySize.slice(0, ERA_POETS) : all.slice()).sort(byDate);
    if (!ERA_FIRSTS) {
      ERA_FIRSTS = new Map();
      DATA.poems.forEach((p) => {
        const f = ERA_FIRSTS.get(p.authorSlug);
        if (!f || (p.hasNote && !f.hasNote)) ERA_FIRSTS.set(p.authorSlug, p);
      });
    }
    const firsts = ERA_FIRSTS;
    const start = bySize.map((p) => firsts.get(p.slug)).filter(Boolean).slice(0, ERA_START)
      .sort((a, b) => byDate(POETS[a.authorSlug], POETS[b.authorSlug]));
    return `
      <section class="poet-poems era-lists">
        <h2>${all.length > ERA_POETS ? `The ${ERA_POETS} poets with most poems` : `Poets · ${num(all.length)}`}</h2>
        <ul class="poem-links">${poets.map((p) => `
          <li><a href="#/poet/${esc(p.slug)}"><span class="pl-title">${esc(p.name)}</span><span class="pl-sub">${esc(p.dates || "")}</span></a></li>`).join("")}
        </ul>
        ${all.length > ERA_POETS ? `<div class="browse-all"><a href="#/poets?era=${esc(slug)}" class="read-link">All ${num(all.length)} poets →</a></div>` : ""}
      </section>
      ${start.length ? `<section class="poet-poems era-lists">
        <h2>Poems to begin with</h2>
        <ul class="poem-links">${start.map((p) => `
          <li><a href="#/poem/${esc(p.id)}"><span class="pl-title"${langAttr(p.authorSlug, p.translator)}>${esc(p.title)}</span><span class="pl-sub">${esc(p.author)}</span></a></li>`).join("")}
        </ul>
      </section>` : ""}`;
  }

  // ---------- EPICS: the world's epics by tradition ----------
  // One card per epic: the translations of one original (a workGroup) share a card that
  // links to each of them, the original text first, then by year. The traditions are the
  // poets' categories, in the era order of the home page.
  function epicGroups() {
    const by = new Map();
    (DATA.works || []).filter(isEpicWork).forEach((w) => {
      const k = w.workGroup || w.slug;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(w);
    });
    return [...by.values()];
  }
  // The first year in the translator's closing parenthesis: "(1791; Southey’s edition, 1860)" → 1791.
  const verYear = (o) => {
    const par = (String(o.translator || "").match(/\(([^)]*)\)\s*$/) || [])[1] || "";
    return (par.match(/\d{4}(?:[–-]\d{2,4})?/) || [""])[0];
  };
  function verNames(o) {
    if (!o.translator) {
      const m = o.title.match(/\(([^)]+)\)\s*$/);
      return m ? m[1] + " text" : "Original text";
    }
    const t = translatorShort(trName(o.translator));
    const earl = t.match(/Earl of (\w+)/);
    if (earl) return earl[1];
    const parts = t.split(/\s*(?:,|\band\b|&)\s*/).map((s) => s.replace(/^with\s+/i, "").trim()).filter((s) => s && !/^(?:Jr|Sr)\.?$/.test(s))
      .map((s) => s.replace(/,?\s+(?:Jr|Sr)\.?$/, "").split(/\s+/).pop());
    return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] || t;
  }
  // The translation the editors recommend for a first reading (the owner's choice, 17 Oct
  // 2026): listed first, with a badge, wherever the translations of that work are listed.
  const RECOMMENDED = { iliad: "iliad-murray", odyssey: "odyssey-murray", aeneid: "aeneid-mackail", gilgamesh: "gilgamish-thompson" };
  const REC_WHY = {
    iliad: "The translation we recommend for a first reading and for study: close to the Greek line by line, plain and clear, with study notes and the Greek line numbers.",
    odyssey: "The translation we recommend for a first reading and for study: Murray's Loeb version, close to the Greek, plain and clear.",
    aeneid: "The translation we recommend for a first reading and for study: Mackail's prose keeps close to Virgil's Latin, sentence by sentence.",
    gilgamesh: "The translation we recommend: Campbell Thompson's version of all twelve tablets, the fullest made before 1931.",
  };
  const isRecommended = (w) => !!w && !!w.workGroup && RECOMMENDED[w.workGroup] === w.slug;
  const recBadge = (w) => isRecommended(w) ? ` <span class="rec-badge">Recommended</span>` : "";
  function epicCardHTML(ws) {
    if (ws.length === 1) return workCardHTML(ws[0]);
    const vs = ws.slice().sort((a, b) => (isRecommended(b) - isRecommended(a)) || (!a.translator ? -1 : !b.translator ? 1 : (verYear(a) || "9").localeCompare(verYear(b) || "9")));
    const title = vs.map((w) => w.title.replace(/\s*\([^)]*\)\s*$/, "")).sort((a, b) => a.length - b.length)[0];
    const lead = vs.find((w) => w.translator) || vs[0];
    const nTr = vs.filter((w) => w.translator).length;
    const what = nTr > 1 ? `${num(nTr)} translations` : nTr === 1 && vs.length > 1 ? "Original and translation" : `${num(vs.length)} versions`;
    return `
    <div class="card work-card epic-card">
      <div class="card-subject">${esc(lead.type)} · ${what}</div>
      <h2 class="card-title"><a href="#/work/${esc(lead.slug)}">${esc(title)}</a></h2>
      <div class="card-author">${esc(lead.author)}</div>
      <ul class="epic-versions">${vs.map((w) => `
        <li><a href="#/work/${esc(w.slug)}"${w.translator ? "" : langAttr(w.authorSlug, "")}>${esc(verNames(w))}${verYear(w) ? ` <span class="ev-year">${esc(verYear(w))}</span>` : ""}</a>${recBadge(w)}</li>`).join("")}
      </ul>
    </div>`;
  }
  function renderEpics() {
    const groups = epicGroups();
    const ord = (ws) => (POETS[ws[0].authorSlug] || {}).order ?? 0;
    const cats = CATEGORY_ORDER.map((cat) => ({
      cat,
      groups: groups.filter((ws) => (POETS[ws[0].authorSlug] || {}).category === cat)
        .sort((a, b) => ord(a) - ord(b) || sortKey(a[0].title).localeCompare(sortKey(b[0].title))),
    })).filter((c) => c.groups.length);
    setTitle("Epics");
    app.innerHTML = `
      <button class="back" id="back">← Browse by Era</button>
      <div class="page-head"><h1 class="page-title">Epics</h1>
        <p class="page-sub">The long heroic and sacred poems of the world, from Gilgamesh and Homer to the Kalevala and Hiawatha, each with every translation the archive holds.</p></div>
      <nav class="chips epic-jump" aria-label="Traditions">${cats.map((c, i) =>
        `<button type="button" class="chip" data-to="epics-${i}">${esc(c.cat)}</button>`).join("")}</nav>
      ${cats.map((c, i) => `
      <section class="epic-tradition" id="epics-${i}">
        <h2 class="section-label">${esc(c.cat)}</h2>
        <div class="grid">${c.groups.map(epicCardHTML).join("")}</div>
      </section>`).join("")}`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/"; });
    app.querySelectorAll(".epic-jump button").forEach((b) => b.addEventListener("click", () => {
      const s = document.getElementById(b.dataset.to);
      if (s) s.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  const sortKey = (s) => s.toLowerCase().replace(/^["'“‘]*(a|an|the)\s+/, "").replace(/^[^a-z0-9]+/, "").trim();
  // Forms (B3): build_index.py gives a poem a `form` when its title names one ("Sonnet 18",
  // "Ode to Psyche", "Tam Samson's Elegy") or, for sonnets, when it has the sonnet's shape
  // (14 lines as 8 + 6 or 4 + 4 + 3 + 3). An index built before that has no forms and no row.
  const FORM_PLURAL = { Sonnet: "Sonnets", Ode: "Odes", Ballad: "Ballads", Elegy: "Elegies", Hymn: "Hymns",
    Song: "Songs", Riddle: "Riddles", Epigram: "Epigrams", Epitaph: "Epitaphs", Ghazal: "Ghazals" };
  let FORM_COUNTS = null;
  function formCounts() {
    if (!FORM_COUNTS) {
      const n = {};
      DATA.poems.forEach((p) => { if (p.form) n[p.form] = (n[p.form] || 0) + 1; });
      FORM_COUNTS = Object.keys(n).sort((a, b) => n[b] - n[a]).map((name) => ({ name, count: n[name] }));
    }
    return FORM_COUNTS;
  }
  const formLabel = (f) => FORM_PLURAL[f] || f;
  function renderList() {
    const words = searchWords(query);
    const results = rankResults(SORTED.filter((p) => matches(p, words)), words);
    const works = filterSubject !== "All" || filterForm !== "All" ? [] : (DATA.works || []).filter((w) => {
      if (!words.length) return true;
      if (w._hay === undefined) w._hay = fold([w.title, w.author, w.translator].join(" "));
      return hasAll(w._hay, words);
    });
    let banner = "";
    if (query) banner = `<div class="filter-banner"><span class="lbl">Search</span> <span class="val">“${esc(query)}”</span><button data-clear="1">Clear ✕</button></div>`;
    const chips = [`<button class="chip ${filterSubject === "All" ? "active" : ""}" data-sub="All">All<span class="n">${num(DATA.count)}</span></button>`]
      .concat(DATA.subjects.map((s) => `<button class="chip ${filterSubject === s.name ? "active" : ""}" data-sub="${esc(s.name)}">${esc(s.name)}<span class="n">${num(s.count)}</span></button>`)).join("");
    const forms = formCounts();
    const formChips = forms.length ? `<div class="chips form-chips" role="group" aria-label="Form"><span class="chips-lbl">Form</span>`
      + [`<button class="chip ${filterForm === "All" ? "active" : ""}" data-form="All">Any form</button>`]
        .concat(forms.map((f) => `<button class="chip ${filterForm === f.name ? "active" : ""}" data-form="${esc(f.name)}">${esc(formLabel(f.name))}<span class="n">${num(f.count)}</span></button>`)).join("")
      + `</div>` : "";
    const what = filterForm !== "All" ? formLabel(filterForm) : "Poems";

    setTitle(query ? `\u201c${query}\u201d \u2014 Search` : filterSubject !== "All" ? `${what} on ${filterSubject}` : filterForm !== "All" ? what : "All poems");
    app.innerHTML = `
      <h1 class="visually-hidden">${query ? "Search the archive" : filterSubject !== "All" ? `${esc(what)} on ${esc(filterSubject)}` : filterForm !== "All" ? esc(what) : "All poems"}</h1>
      ${banner}
      ${query ? "" : `<div class="chips">${chips}</div>${formChips}`}
      <p class="result-meta">${num(results.length)} poem${results.length === 1 ? "" : "s"}${filterSubject !== "All" ? " · " + esc(filterSubject) : ""}${filterForm !== "All" ? " · " + esc(formLabel(filterForm)) : ""}${works.length ? ` · <a href="#list-works" class="works-jump">${num(works.length)} long work${works.length === 1 ? "" : "s"} ↓</a>` : ""}</p>
      ${!query && results.length && (filterSubject !== "All" || filterForm !== "All") ? `<p class="surprise-row surprise-list"><a class="surprise-link" href="${esc(surpriseHref({
        subject: filterSubject !== "All" ? subjectKey(filterSubject) : "", form: filterForm !== "All" ? filterForm : "" }))}">Surprise me from these</a></p>` : ""}
      <div class="grid">${results.length ? pagedCards(results) : works.length ? "" : `<p class="empty">No poems match.</p>`}</div>
      ${moreHTML(results.length)}
      ${works.length ? `
      <details class="list-works" id="list-works"${query || !results.length ? " open" : ""}>
        <summary class="section-label">Long works <span class="n">${num(works.length)}</span></summary>
        <div class="grid works-grid"></div>
        <div class="works-more"></div>
      </details>` : ""}`;

    app.querySelectorAll(".chip[data-sub]").forEach((c) => c.addEventListener("click", () => { filterSubject = c.dataset.sub; query = ""; syncSearchInput(); freshList(); }));
    app.querySelectorAll(".chip[data-form]").forEach((c) => c.addEventListener("click", () => { filterForm = c.dataset.form; query = ""; syncSearchInput(); freshList(); }));
    const clr = app.querySelector("[data-clear]");
    if (clr) clr.addEventListener("click", () => { query = ""; filterSubject = "All"; filterForm = "All"; syncSearchInput(); freshList(); });
    bindMore(results);
    bindListWorks(works);
  }
  // The long works under the poems, drawn only when their section is open, PAGE at a time.
  function bindListWorks(works) {
    const box = app.querySelector(".list-works");
    if (!box) return;
    const grid = box.querySelector(".works-grid"), more = box.querySelector(".works-more");
    let upto = 0;
    const page = () => {
      grid.insertAdjacentHTML("beforeend", works.slice(upto, upto + PAGE).map(workCardHTML).join(""));
      upto += PAGE;
      const left = works.length - upto;
      more.innerHTML = left > 0 ? `<div class="more-row"><button class="more-btn" type="button">Show ${Math.min(PAGE, left)} more<span class="more-left"> · ${num(left)} left</span></button></div>` : "";
      const b = more.querySelector("button");
      if (b) b.addEventListener("click", page);
    };
    const open = () => { if (box.open && !upto) page(); };
    box.addEventListener("toggle", open);
    open();
    const jump = app.querySelector(".works-jump");
    if (jump) jump.addEventListener("click", (e) => {
      e.preventDefault();             // the address stays #/poems
      box.open = true; open();
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ---------- portrait fallback (monogram) ----------
  function portraitImgHTML(p, cls) {
    if (p.portrait) return `<img class="${cls}" src="${esc(p.portrait)}" alt="Portrait of ${esc(p.name)}" loading="lazy" />`;
    const initial = esc(p.name.trim().charAt(0));
    return `<div class="${cls} pc-monogram" aria-label="No confirmed portrait of ${esc(p.name)}"><span>${initial}</span></div>`;
  }

  // ---------- POETS index ----------
  // Three thousand cards at once made a page 1.5 million pixels tall on a phone, so the page
  // shows one letter of the alphabet at a time (#/poets?l=K, by surname), or the poets whose
  // name matches the filter box (#/poets?q=keats). Poets with nothing to read are left out.
  // The surname: the last word of the name ("John Keats"), less "of Lesbos", "(attributed)",
  // ", Earl of Surrey" and "Jr."; a name with no surname to invert (Homer, "Anonymous …",
  // the traditions that put the family name first or have none) files under its first word.
  const FIRST_WORD_CATS = new Set(["Ancient Near East", "Turkish & Ottoman", "Arabic & Persian", "Hebrew", "Indian", "Chinese & Japanese"]);
  function poetSortName(p) {
    if (p._sn !== undefined) return p._sn;
    let n = String(p.name || "").trim();
    if (CITE_NAMES[n]) n = CITE_NAMES[n];
    else {
      n = n.replace(/\s*\([^)]*\)/g, "").split(",")[0].replace(/^(the|sir|saint|st\.)\s+/i, "").trim();
      if (!/^anonymous\b/i.test(n) && !FIRST_WORD_CATS.has(p.category)) {
        const parts = n.replace(/\s+of\s+.*$/i, "").split(/\s+/).filter(Boolean);
        while (parts.length > 1 && /^(jr\.?|sr\.?|[ivx]+\.?)$/i.test(parts[parts.length - 1])) parts.pop();
        if (parts.length > 1) n = parts.pop() + ", " + parts.join(" ");
      }
    }
    return (p._sn = fold(n).replace(/^[^a-z0-9]+/, ""));
  }
  const poetLetter = (p) => { const c = poetSortName(p).charAt(0).toUpperCase(); return c >= "A" && c <= "Z" ? c : "#"; };
  const POET_PAGE = 120;
  let POET_LIST = null;      // the poets with poems or works, by surname (built once)
  function poetList() {
    if (!POET_LIST) POET_LIST = DATA.poets.filter((p) => p.poemCount || p.workCount)
      .sort((a, b) => COLLATE.compare(poetSortName(a), poetSortName(b)));
    return POET_LIST;
  }
  const poetCountLine = (p) => p.poemCount
    ? num(p.poemCount) + " poem" + (p.poemCount === 1 ? "" : "s")
    : num(p.workCount) + " work" + (p.workCount === 1 ? "" : "s");
  const poetCardHTML = (p) => `
          <a class="poet-card" href="#/poet/${esc(p.slug)}">
            ${portraitImgHTML(p, "pc-img")}
            <div class="pc-body">
              <p class="pc-name">${esc(p.name)}</p>
              <p class="pc-dates">${esc(p.dates)}</p>
              <p class="pc-count">${poetCountLine(p)}</p>
            </div>
          </a>`;
  function renderPoets() {
    const all = poetList();
    const counts = {};
    all.forEach((p) => { const l = poetLetter(p); counts[l] = (counts[l] || 0) + 1; });
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat(counts["#"] ? ["#"] : []);
    const h = location.hash;
    const qm = h.match(/[?&]q=([^&]*)/), lm = h.match(/[?&]l=([^&]*)/);
    // "#/poets?era=romantic" (an era page's "All N poets"): that era's poets only.
    const era = SLUG_TO_CATEGORY[(h.match(/[?&]era=([\w-]+)/) || [])[1]];
    let q = "";
    if (qm) { try { q = decodeURIComponent(qm[1].replace(/\+/g, " ")); } catch (e) { q = ""; } }
    let letter = lm ? decodeURIComponent(lm[1]).toUpperCase() : "";
    if (!counts[letter]) letter = letters.find((l) => counts[l]) || "A";
    setTitle("Poets");
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Poets</h1><p class="page-sub">${num(all.length)} poets from Homer to the early twentieth century, by surname.</p></div>
      <div class="poet-tools">
        <nav class="az-strip" aria-label="Poets by surname">${letters.map((l) => counts[l]
          ? `<a class="az" href="#/poets?l=${encodeURIComponent(l)}" data-l="${esc(l)}">${esc(l)}</a>`
          : `<span class="az az-none" aria-hidden="true">${esc(l)}</span>`).join("")}</nav>
        <label class="poet-filter"><span class="visually-hidden">Filter poets by name</span>
          <input type="search" placeholder="Filter by name…" autocomplete="off" value="${esc(q)}" /></label>
      </div>
      <p class="result-meta poet-meta"></p>
      <div class="poet-grid"></div>
      <div class="poet-more"></div>`;
    const input = app.querySelector(".poet-filter input");
    const grid = app.querySelector(".poet-grid"), meta = app.querySelector(".poet-meta"), more = app.querySelector(".poet-more");
    let list = [], upto = 0;
    const page = () => {
      grid.insertAdjacentHTML("beforeend", list.slice(upto, upto + POET_PAGE).map(poetCardHTML).join(""));
      upto += POET_PAGE;
      const left = list.length - upto;
      more.innerHTML = left > 0 ? `<div class="more-row"><button class="more-btn" type="button">Show ${Math.min(POET_PAGE, left)} more<span class="more-left"> · ${num(left)} left</span></button></div>` : "";
      const b = more.querySelector("button");
      if (b) b.addEventListener("click", page);
    };
    const draw = () => {
      const words = searchWords(q);
      list = era ? all.filter((p) => p.category === era && (!words.length || hasAll(p._nh || (p._nh = fold(p.name)), words)))
        : words.length ? all.filter((p) => hasAll(p._nh || (p._nh = fold(p.name)), words)) : all.filter((p) => poetLetter(p) === letter);
      app.querySelectorAll(".az-strip a").forEach((a) => {
        const on = !words.length && a.dataset.l === letter;
        a.classList.toggle("active", on);
        if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
      });
      meta.textContent = words.length
        ? `${num(list.length)} poet${list.length === 1 ? "" : "s"} matching “${q.trim()}”`
        : era ? `${num(list.length)} ${era} poet${list.length === 1 ? "" : "s"}` : `${num(list.length)} poet${list.length === 1 ? "" : "s"} under ${letter}`;
      grid.innerHTML = list.length ? "" : `<p class="empty">No poet's name matches.</p>`;
      upto = 0;
      page();
    };
    draw();
    // The filter keeps its own address (#/poets?q=…) without a new history entry for each key.
    let t = 0;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        q = input.value;
        const addr = q.trim() ? "#/poets?q=" + encodeURIComponent(q.trim()) : "#/poets?l=" + encodeURIComponent(letter);
        try { history.replaceState(history.state, "", addr); } catch (e) { /* the list still changes */ }
        draw();
      }, 120);
    });
  }

  // ---------- POET page ----------
  // ---------- an object from the poems' world, framed beside them ----------
  // The Pylos Combat Agate on Homer's page and the Ancient Greek & Roman era page (the
  // owner's request, 17 Oct 2026). The photograph is the excavators'; the owner chose it and will take it down if they ask.
  // The same text is in tools/build_pages.py (AGATE_HTML) for the static Homer page.
  // Every other era page opens with its own showpiece (data/era-art.json: object, account,
  // photo credit; the images in eras/), fetched once when the first era page is opened.
  let ERA_ART = null;
  function fillEraArt(slug) {
    const box = document.getElementById("era-art");
    if (!box) return;
    (ERA_ART || (ERA_ART = fetch("data/era-art.json").then((r) => r.json()).catch(() => ({}))))
      .then((all) => { const a = all[slug]; if (a && box.isConnected) box.outerHTML = eraArtHTML(slug, a); });
  }
  function eraArtHTML(slug, a) {
    return `
      <figure class="artefact">
        <div class="artefact-case">
          <a class="artefact-img" href="eras/${slug}-1200.webp"><img src="eras/${slug}-640.webp" srcset="eras/${slug}-640.webp 640w, eras/${slug}-1200.webp 1200w" sizes="(max-width: 760px) 92vw, 720px" width="${a.w}" height="${a.h}" alt="${esc(a.title)}" /></a>
        </div>
        <figcaption>
          <div class="artefact-head">
            <p class="artefact-kicker">${esc(a.kicker)}</p>
            <h2 class="artefact-title">${esc(a.title)}</h2>
            <p class="artefact-meta">${a.meta.split(" · ").map(esc).join("<br>")}</p>
          </div>
          <div class="artefact-text">
            ${a.paras.map((t) => `<p>${esc(t)}</p>`).join("")}
            <p class="artefact-credit"><a href="${esc(a.page)}" rel="noopener">${esc(a.credit)}</a></p>
          </div>
        </figcaption>
      </figure>`;
  }
  const AGATE_HTML = `
      <figure class="artefact">
        <div class="artefact-case">
          <a class="artefact-img" href="agate2-1200.webp"><img src="agate2-640.webp" srcset="agate2-640.webp 640w, agate2-1200.webp 1200w" sizes="(max-width: 760px) 92vw, 720px" width="640" height="402" loading="lazy" alt="The Pylos Combat Agate: on an almond-shaped stone of banded agate, a warrior lunges over a great body-shield to drive his sword at the neck of a second, crested warrior, while a third lies dead beneath them" /></a>
          <div class="artefact-actual"><img src="agate2-240.webp" width="240" height="151" alt="" /><span>Actual size</span></div>
        </div>
        <figcaption>
          <div class="artefact-head">
            <p class="artefact-kicker">Before Homer</p>
            <h2 class="artefact-title">The Pylos Combat Agate</h2>
            <p class="artefact-meta">Minoan Crete, about 1450 BCE<br>Banded agate, 3.4 cm long</p>
          </div>
          <div class="artefact-text">
            <p>A warrior who has already struck down one enemy lunges over a great body-shield and drives his sword at the throat of a second, gripping the crest of the man’s helmet. The whole fight is cut into a sealstone smaller than a thumb, so finely that the muscles of the fighters and the patterns of their kilts can be read only under a lens.</p>
            <p>It was buried with a man of rank, the so-called Griffin Warrior, beside the Palace of Nestor at Pylos, and found in 2015 by the University of Cincinnati excavation led by Sharon Stocker and Jack Davis. Encrusted with limestone, it was first taken for a bead; cleaning revealed the scene in 2017, and it is now counted the finest engraving known from the Aegean Bronze Age.</p>
            <p>The <em>Iliad</em> would not be written down for another seven centuries, yet its world is already here: champions in single combat, crested helmets, the tall shields Homer still remembers in Ajax’s shield “like a tower”, and Pylos itself, the city of old Nestor.</p>
            <p class="artefact-credit">Photograph: Palace of Nestor Excavations, Department of Classics, University of Cincinnati.</p>
          </div>
        </figcaption>
      </figure>`;

  function renderPoet(slug) {
    const poet = POETS[slug];
    if (!poet) { location.hash = "#/poets"; return; }
    const poems = DATA.poems.filter((p) => p.authorSlug === slug);
    const works = (DATA.works || []).filter((w) => w.authorSlug === slug)
      .map((w, k) => [w, k]).sort((a, b) => (isRecommended(b[0]) - isRecommended(a[0])) || a[1] - b[1]).map((x) => x[0]);
    setTitle(poet.name);
    const started = works.filter((w) => readingOf(w.slug))
      .sort((a, b) => String(readingOf(b.slug).at).localeCompare(String(readingOf(a.slug).at)));
    const continueBlock = started.length ? `
            <div class="continue-list">${started.map((w) => continueHTML(w, true)).join("")}</div>` : "";
    const worksHTML = works.length ? `
        <section class="poet-poems">
          <h2>Major Works</h2>
          <ul class="poem-links">
            ${works.map((w) => `
              <li><a href="#/work/${esc(w.slug)}"><span class="pl-title">${esc(w.title)}${w.translator ? ` <span class="pl-tr">${esc(translatorShort(trName(w.translator)))}</span>` : ""}${recBadge(w)}</span><span class="pl-sub">${esc(w.type)} · ${esc(w.year)} · ${num(w.sections.length)} part${w.sections.length === 1 ? "" : "s"}</span></a></li>`).join("")}
          </ul>
        </section>` : "";
    app.innerHTML = `
      <article class="poet">
        <button class="back" id="back">← All poets</button>
        <div class="poet-top">
          <figure class="portrait-wrap" style="margin:0">
            ${poet.portrait ? `<img src="${esc(poet.portrait)}" alt="Portrait of ${esc(poet.name)}" />` : portraitImgHTML(poet, "pc-monogram-lg")}
            <figcaption class="portrait-credit">${esc(poet.credit)}</figcaption>
          </figure>
          <div>
            <p class="poet-era">${CATEGORY_SLUGS[poet.category]
              ? `<a href="#/category/${esc(CATEGORY_SLUGS[poet.category])}">${esc(poet.era)}</a>` : esc(poet.era)}</p>
            <h1 class="poet-name">${esc(poet.name)}</h1>
            <p class="poet-dates">${esc(poet.dates)}</p>${continueBlock}
            <div class="poet-bio">
              ${[].concat(poet.bio || []).map((para) => `<p>${para}</p>`).join("")}
            </div>
          </div>
        </div>
        ${slug === "homer" ? AGATE_HTML : ""}
        ${worksHTML}
        ${poems.length || !works.length ? `<section class="poet-poems">
          <h2>Poems · ${num(poems.length)}</h2>
          ${poems.length ? `<div class="cite-row poet-offline">${offlineHTML("poet:" + slug)}</div>` : ""}
          <ul class="poem-links">
            ${poems.map((p) => `
              <li><a href="#/poem/${esc(p.id)}"><span class="pl-title"${langAttr(p.authorSlug, p.translator)}>${esc(p.title)}</span><span class="pl-sub">${esc(p.primarySubject)}</span></a></li>`).join("")}
          </ul>
        </section>` : ""}
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/poets"; });
    bindOffline(`Poems of ${poet.name}`);
    bindContinue();
  }

  // ---------- WORK: table of contents ----------
  // "The Iliad — Homer, trans. Alexander Pope" when the archive holds more than one
  // translation of a work (as work_title in tools/build_pages.py).
  function workTitle(w) {
    const grouped = w.workGroup && worksList().some((o) => o.slug !== w.slug && o.workGroup === w.workGroup);
    return `${w.title} — ${w.author}` + (grouped && w.translator ? ", " + translatorShort(w.translator) : "");
  }

  // ---------- other translations of the same work ----------
  // Works sharing a workGroup with a different translator are translations of one original
  // (iliad-pope, iliad-butler). A group with one translator is a manuscript or a poem in
  // parts (the Junius poems, the three parts of Christ), not a set of translations.
  const trName = (t) => String(t || "").replace(/^trans\.\s*/i, "");          // "Samuel Butler (1898)"
  const trSurname = (t) => translatorShort(trName(t)).split(/\s+/).pop();      // "Butler"
  const trLabel = (t) => {                                   // "Samuel Butler’s translation (1898)"
    const year = (String(t || "").match(/\(([^)]*)\)\s*$/) || [])[1];
    return `${translatorShort(trName(t))}’s translation${year ? ` (${year})` : ""}`;
  };
  // A work with no translator in a group of translations is the original text (the Old
  // English Genesis beside Kennedy's Genesis): it pairs with every translation, and every
  // translation pairs with it, but two untranslated works never pair.
  const verLabel = (o) => o.translator ? trLabel(o.translator) : (o.subtitle || "Original text");
  const verShort = (o) => o.translator ? trSurname(o.translator) : "original";
  function otherTranslations(w) {
    if (!w || !w.workGroup) return [];
    const mine = w.translator ? translatorShort(trName(w.translator)) : "";
    return worksList().filter((o) => o.slug !== w.slug && o.workGroup === w.workGroup &&
      (o.translator ? translatorShort(trName(o.translator)) !== mine : !!w.translator));
  }
  // The same book in another translation: by its title ("Book VI"), else by position when
  // both have as many parts; -1 when there is no telling.
  const partKey = (t) => fold(t).replace(/[^a-z0-9]+/g, "");
  function matchingPart(w, o, i) {
    const k = partKey(w.sections[i] && w.sections[i].title);
    const j = k ? o.sections.findIndex((s) => partKey(s.title) === k) : -1;
    return j >= 0 ? j : o.sections.length === w.sections.length && o.sections[i] ? i : -1;
  }
  // "Also in this archive" under the translator line: each other translation (at the same
  // book, on a part page) and, on a part page, the two side by side. w: an index entry.
  // On a part page it is one folded line ("Also in 8 other translations"), so the verse
  // starts near the top: opened, each translation is one row of two short links.
  function otherTrHTML(w, i) {
    const others = otherTranslations(w);
    if (!others.length) return "";
    if (i != null) {
      const n = others.length;
      const kind = others.every((o) => o.translator) ? "translation" : "version";
      const rows = others.map((o) => {
        const j = matchingPart(w, o, i);
        return j >= 0
          ? `<li><a href="#/work/${esc(o.slug)}/${j}">${esc(verLabel(o))}</a>${recBadge(o)} <a class="also-cmp" href="#/work/${esc(w.slug)}/${i}/with/${esc(o.slug)}">compare</a></li>`
          : `<li><a href="#/work/${esc(o.slug)}">${esc(verLabel(o))} →</a>${recBadge(o)}</li>`;
      }).join("");
      return `
      <details class="also-tr also-fold">
        <summary>Also in ${n === 1 ? `one other ${kind}` : `${num(n)} other ${kind}s`}: ${esc(others.slice(0, 3).map(verShort).join(", "))}${n > 3 ? "…" : ""}</summary>
        <ul class="also-list">${rows}</ul>
      </details>`;
    }
    return `
      <div class="also-tr">
        <p class="section-label">Also in this archive</p>
        ${others.map((o) => {
          const j = i == null ? -1 : matchingPart(w, o, i);
          return `<p class="also-row">${j >= 0
            ? `<a href="#/work/${esc(o.slug)}/${j}">${esc(verLabel(o))} · ${esc(o.sections[j].title)}</a>
               <a class="compare-btn" href="#/work/${esc(w.slug)}/${i}/with/${esc(o.slug)}">Compare side by side</a>`
            : `<a href="#/work/${esc(o.slug)}">${esc(verLabel(o))} →</a>${recBadge(o)}`}</p>`;
        }).join("")}
      </div>`;
  }
  function renderWork(slug) {
    const w = WORKS[slug];
    if (!w) { location.hash = "#/"; return; }
    const entry = { id: "work:" + slug, kind: "work", title: w.title, author: w.author, translator: w.translator || "" };
    const place = readingOf(slug);
    setTitle(workTitle(w));
    app.innerHTML = `
      <article class="detail work-toc">
        <button class="back" id="back">← ${esc(w.author)}</button>
        <div class="detail-subject">${esc(w.type)} · ${esc(w.year)}</div>
        <h1 class="detail-title">${esc(w.title)}</h1>
        ${w.subtitle ? `<p class="work-subtitle">${esc(w.subtitle)}</p>` : ""}
        <p class="detail-author">by <a href="#/poet/${esc(w.authorSlug)}">${esc(w.author)}</a></p>
        ${sourceLine(w.translator)}
        ${isRecommended(w) ? `<p class="rec-line"><span class="rec-badge">Recommended</span> ${esc(REC_WHY[w.workGroup] || "The translation we recommend for a first reading and for study.")}</p>` : ""}
        ${w.blurb ? `<p class="note-block">${esc(w.blurb)}</p>` : ""}
        ${otherTrHTML(w)}
        ${place ? `<div class="continue-wrap">${continueHTML(w)}
          <button class="continue-forget" type="button">Forget my place</button></div>` : ""}
        <div class="cite-row toc-tools">${shelfButtonHTML(entry)}${offlineHTML("work:" + slug)}</div>
        <p class="shelf-msg" hidden>${VISIT_ONLY}</p>
        <hr class="rule">
        <p class="section-label">Contents · ${num(w.sections.length)} part${w.sections.length === 1 ? "" : "s"}</p>
        <ul class="poem-links">
          ${w.sections.map((s, i) => {
            const bits = [place && place.i === i ? '<span class="last-read">Last read</span>' : "", partSize(s)].filter(Boolean);
            return `
            <li><a href="#/work/${esc(w.slug)}/${i}"><span class="pl-title">${esc(s.title)}</span><span class="pl-sub">${bits.join(" · ")}</span></a></li>`;
          }).join("")}
        </ul>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/poet/" + w.authorSlug; });
    bindShelfButton(entry);
    bindOffline(workTitle(w));
    bindListNext();
    bindContinue();
    const forget = app.querySelector(".continue-forget");
    if (forget) forget.addEventListener("click", () => { forgetReading(slug); renderWork(slug); });
  }

  // ---------- WORK: one section (canto) reader ----------
  function renderWorkSection(slug, i) {
    if (DATA && !WORKS[slug]) { location.hash = "#/"; return; }
    if (EARLY_DRAWN !== location.hash) renderLoading();
    const requestedHash = location.hash;
    Promise.all([loadSectionPage(slug, i), fetchParallel()]).then(([w]) => {
      if (location.hash !== requestedHash) return null; // route changed while fetching
      if (!w.sections[i]) { location.hash = "#/work/" + slug; return null; }
      notePoet(w.authorSlug, { name: w.author });
      const pick = parPick(workParList(slug, i, w), "w:" + slug);   // as on a poem: the other text first
      // A work in a group (translations of one original) names them under its title: the
      // list of works comes from work/works.json when the index is not in.
      const works = w.workGroup || workParList(slug, i, w).length > 1 ? loadWorks() : Promise.resolve();
      return Promise.all([works, pick ? loadPartner("work", pick.with).catch(() => null) : null]).then(() => {
        if (location.hash === requestedHash) renderWorkSectionReady(w, slug, i);
      });
    }).catch((e) => { if (location.hash === requestedHash) renderFetchError(e); });
  }
  function renderWorkSectionReady(w, slug, i) {
    const s = w.sections[i];
    const wt = WORKS[slug] ? workTitle(WORKS[slug]) : `${w.title} — ${w.author}`;
    const cite = { author: w.author, work: w.title, title: w.sections.length > 1 ? s.title : "",
                   translator: w.translator, path: `/work/${slug}/${i}/` };
    const entry = { id: "work:" + slug + "/" + i, kind: "part", author: w.author, translator: w.translator || "",
                    title: w.sections.length > 1 ? w.title + " · " + s.title : w.title };
    const par = workParList(slug, i, w);
    EARLY_DRAWN = DATA ? "" : location.hash;   // drawn without the index
    // Its other translations unknown (no work/works.json): the index is fetched after the
    // first paint, as before, and the page drawn again with them when it is in.
    EARLY_REDRAW = !DATA && !!w.workGroup && !WORKS[slug];
    if (EARLY_REDRAW) setTimeout(loadIndex, 300);   // a timer, not a frame: it runs in a background tab too
    setTitle(w.sections.length > 1 ? wt.replace(w.title, w.title + ", " + s.title) : wt);
    app.innerHTML = `
      <article class="detail">
        ${progressHTML()}
        <button class="back" id="back">← ${esc(w.title)} · Contents</button>
        ${readingToolsHTML()}
        ${findButtonHTML()}
        ${learnable(s.text, w.translator) ? learnButtonHTML() : ""}
        <div class="detail-subject">${esc(w.title)} · ${esc(w.year)}</div>
        <h1 class="detail-title">${esc(s.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(w.authorSlug)}">${esc(w.author)}</a>${datesHTML(w.authorSlug)}</p>
        ${sourceLine(w.translator, "", readTime(s.text, isProse(s.text, w.translator)))}
        ${otherTrHTML(WORKS[slug], i)}
        <hr class="rule">
        ${enginePanel(s.text, { gloss: true })}
        ${poemBlock(s.text, { translator: w.translator, lang: langAttr(w.authorSlug, w.translator), work: true,
                              parallel: parCtlHTML("works", slug, par) })}
        <p class="book-source-slot" hidden></p>
        ${citeHTML(cite, entry)}
        ${w.sections.length > 1 ? `<p class="book-count">${esc(partCount(s.title, i, w.sections.length))}</p>` : ""}
        <div class="detail-nav">
          <button ${i === 0 ? "disabled" : ""} data-go="${i - 1}"><span class="dir">← Previous</span>${i > 0 ? esc(w.sections[i - 1].title) : ""}</button>
          <button class="next" ${i === w.sections.length - 1 ? "disabled" : ""} data-go="${i + 1}"><span class="dir">Next →</span>${i < w.sections.length - 1 ? esc(w.sections[i + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/work/" + slug; });
    bindEngine({ title: w.title + " \u00b7 " + s.title, author: w.author, text: s.text,
                 id: "work:" + slug + "/" + i });
    bindReadingTools();
    bindFind();
    bindLineNumbers();
    applyLineMap(slug, i);
    // The reading position follows whichever text is on screen, alone or facing its partner.
    bindFacing({ kind: "work", key: "w:" + slug, list: par, build: (e, other) => workFacing(w, slug, i, other, e),
                 onShow: (el) => { if (READING_NOW && READING_NOW.slug === slug) { READING_NOW.el = el; drawProgress(); } } });
    bindCite(cite);
    { const here = location.hash; fetchSources(w.authorSlug).then((d) => applySource(cite, d && d.works && d.works[slug], here)); }
    bindShelfButton(entry);
    bindListNext();
    bindNote(entry);
    bindMarks(entry);
    bindQuoteTools(cite, w.authorSlug, w.translator, s.text);
    bindListen(listenLang(w.authorSlug, w.translator, s.text));
    app.querySelectorAll(".detail-nav button").forEach((b) => b.addEventListener("click", () => { if (!b.disabled) location.hash = "#/work/" + slug + "/" + b.dataset.go; }));
    restoreScroll();
    // Reading position: opened from "Continue reading", the book scrolls to where it was
    // left; either way this book becomes the work's place, updated as the reader scrolls.
    const text = app.querySelector(".fx-slot:not([hidden])") || app.querySelector(".poem-text");
    const resume = pendingResume && pendingResume.slug === slug && pendingResume.i === i ? pendingResume.frac : 0;
    pendingResume = null;
    if (resume > 0) {
      const r = text.getBoundingClientRect();
      jumpTo(Math.max(0, window.scrollY + r.top + resume * r.height - window.innerHeight * 0.3));
    }
    READING_NOW = { slug, i, el: text };
    // Named as on the home page: "The Iliad (Murray)" when the work has other translations.
    const named = w.title + (otherTranslations(w).length ? ` (${verShort(w)})` : "");
    setReading(slug, i, resume > 0 ? resume : readingFrac(text),
               { title: named, author: w.author, n: w.sections.length, part: s.title });
    noteRecent({ id: "work:" + slug, kind: "work", i, part: w.sections.length > 1 ? s.title : "", title: named, author: w.author });
    drawProgress();
    showLinkedLines();
    bindLearn({ entry, text: s.text, translator: w.translator, lang: langAttr(w.authorSlug, w.translator), par: [] });
    bindReadingBar({ contents: "#/work/" + slug });
  }

  // How long a book or canto is, for the contents list: "about 540 lines" for verse (exact
  // under 100), "38 paragraphs" for a prose translation. build_index.py counts both (`lines`,
  // `prose`, `paras`) with the same rule as the page text; an older index without them shows
  // no count rather than a wrong one.
  function partSize(s) {
    if (s.prose) return s.paras ? `${s.paras} paragraph${s.paras === 1 ? "" : "s"}` : "";
    if (!s.lines) return "";
    if (s.lines < 100) return `${s.lines} line${s.lines === 1 ? "" : "s"}`;
    return `about ${Math.round(s.lines / 10) * 10} lines`;
  }

  // ---------- WORK: two translations side by side ----------
  // #/work/iliad-pope/5/with/iliad-butler: Book VI of Pope's Iliad beside the same book of
  // Butler's. On a wide screen each translation scrolls in its own column and, unless the
  // reader turns it off, the two keep in step by proportion (the translations differ in
  // length, so "in step" is approximate); on a phone they are stacked.
  function renderCompare(slug, i, oslug) {
    const a = WORKS[slug], b = WORKS[oslug];
    if (!a || !b || !otherTranslations(a).includes(b)) { location.hash = a ? "#/work/" + slug + "/" + i : "#/"; return; }
    renderLoading();
    const requestedHash = location.hash;
    Promise.all([fetchWorkFile(slug), fetchWorkFile(oslug)]).then(([wa, wb]) => {
      if (location.hash !== requestedHash) return;
      if (!wa.sections[i]) { location.hash = "#/work/" + slug; return; }
      renderCompareReady(wa, wb, slug, i, oslug);
    }).catch((e) => { if (location.hash === requestedHash) renderFetchError(e); });
  }
  function compareColHTML(w, k, id) {
    const s = w.sections[k];
    const prose = isProse(s.text, w.translator);
    return `
      <section class="compare-col" id="${id}">
        <header class="compare-head">
          <p class="compare-tr">${esc(w.translator ? trName(w.translator) : verLabel(w))}<span class="compare-part"> · ${esc(s.title)}</span></p>
          <a class="compare-open" href="#/work/${esc(w.slug)}/${k}">Read alone →</a>
        </header>
        <div class="compare-pane" tabindex="0" role="region" aria-label="${esc(verLabel(w))}, ${esc(s.title)}">
          <div class="poem-text${prose ? " is-prose" : ""}"${langAttr(w.authorSlug, w.translator)}>${poemHTML(s.text, prose)}</div>
          ${prose ? `<p class="prose-note">This translation is printed as prose in its source edition.</p>` : ""}
        </div>
      </section>`;
  }
  const WIDE = window.matchMedia("(min-width: 781px)");
  function fitPanes() {
    const panes = app.querySelectorAll(".compare-pane");
    if (!panes.length) return;
    panes.forEach((p) => { p.style.height = ""; });
    if (!WIDE.matches) return;
    const top = panes[0].getBoundingClientRect().top + window.scrollY;
    const h = Math.max(Math.round(window.innerHeight * 0.55), window.innerHeight - top - 20);
    panes.forEach((p) => { p.style.height = h + "px"; });
  }
  window.addEventListener("resize", () => { clearTimeout(fitPanes._t); fitPanes._t = setTimeout(fitPanes, 150); });
  function renderCompareReady(wa, wb, slug, i, oslug) {
    const a = WORKS[slug], b = WORKS[oslug];
    const j = matchingPart(a, b, i);
    const s = wa.sections[i];
    const sa = verShort(a), sb = verShort(b);
    const more = otherTranslations(a).filter((o) => o.slug !== oslug);
    const go = (k) => `#/work/${slug}/${k}/with/${oslug}`;
    setTitle(`${a.title}, ${s.title} — ${sa} and ${sb} side by side`);
    app.innerHTML = `
      <article class="compare">
        <button class="back" id="back">← ${esc(a.title)}, ${esc(s.title)} · ${esc(sa)}</button>
        <div class="detail-subject">${esc(a.title)} · Two translations</div>
        <h1 class="detail-title">${esc(s.title)}</h1>
        <div class="compare-top">
        <p class="detail-author">by <a href="#/poet/${esc(a.authorSlug)}">${esc(a.author)}</a> · ${esc(sa)} and ${esc(sb)}</p>
        <div class="compare-tools">
          <label class="compare-sync"><input type="checkbox" checked> Scroll together</label>
          ${findButtonHTML("compare-btn")}
          ${j >= 0 ? `<a class="compare-btn" href="#/work/${esc(oslug)}/${j}/with/${esc(slug)}">Swap sides</a>` : ""}
          ${more.map((o) => `<a class="compare-btn" href="#/work/${esc(slug)}/${i}/with/${esc(o.slug)}">Compare with ${esc(verShort(o))}</a>`).join("")}
          <button class="compare-jump" type="button" data-to="tr-b">Jump to ${esc(sb)} ↓</button>
        </div>
        </div>
        <div class="compare-grid">
          ${compareColHTML(wa, i, "tr-a")}
          ${j >= 0 ? compareColHTML(wb, j, "tr-b") : `
            <section class="compare-col" id="tr-b">
              <p class="empty">${esc(verLabel(b))} has no part matching ${esc(s.title)}.<br>
              <a href="#/work/${esc(oslug)}">Open its contents →</a></p>
            </section>`}
        </div>
        <div class="detail-nav">
          <button ${i === 0 ? "disabled" : ""} data-go="${i - 1}"><span class="dir">← Previous</span>${i > 0 ? esc(wa.sections[i - 1].title) : ""}</button>
          <button class="next" ${i === wa.sections.length - 1 ? "disabled" : ""} data-go="${i + 1}"><span class="dir">Next →</span>${i < wa.sections.length - 1 ? esc(wa.sections[i + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/work/" + slug + "/" + i; });
    bindFind();
    // Highlights, line notes and the editors' study notes in each column, kept under that
    // translation's own book (partEntry), so they are the same as on the book's own page.
    // Copying a quote stays with the book alone (noQuote); notes open as pop-ups (noMargin).
    useMarkTexts([[wa, slug, i, "tr-a"], [wb, oslug, j, "tr-b"]].filter((c) => c[2] >= 0).map(([w, sl, k, id]) => {
      const root = app.querySelector(`#${id} .poem-text`);
      return root && { entry: partEntry(w, sl, k), root, lines: !root.classList.contains("is-prose") && !!root.querySelector(".ln[data-i]"),
                       noQuote: true, noMargin: true };
    }).filter(Boolean));
    app.querySelectorAll(".detail-nav button").forEach((btn) => btn.addEventListener("click", () => { if (!btn.disabled) location.hash = go(btn.dataset.go); }));
    const jump = app.querySelector(".compare-jump");
    jump.addEventListener("click", () => {
      jumpTo(window.scrollY + document.getElementById(jump.dataset.to).getBoundingClientRect().top - 12);
      const bar = document.querySelector(".topbar");            // if it is still on screen
      const cover = bar ? bar.getBoundingClientRect().bottom : 0;
      if (cover > 0) jumpTo(window.scrollY - cover);
    });
    // On a wide screen the columns reach down to the bottom of the window.
    fitPanes();
    // Keeping in step: scrolling one column moves the other to the same proportion of its
    // length. Only the column the reader is moving drives; the other's echo is ignored.
    const panes = [...app.querySelectorAll(".compare-pane")];
    const sync = app.querySelector(".compare-sync input");
    let driver = null, release = 0;
    panes.forEach((p, k) => p.addEventListener("scroll", () => {
      if (!sync.checked || panes.length < 2 || (driver && driver !== p)) return;
      driver = p;
      clearTimeout(release); release = setTimeout(() => { driver = null; }, 150);
      const o = panes[1 - k];
      const f = p.scrollTop / Math.max(1, p.scrollHeight - p.clientHeight);
      o.scrollTop = f * (o.scrollHeight - o.clientHeight);
    }, { passive: true }));
    restoreScroll();
    bindReadingBar({ contents: "#/work/" + slug });
  }

  // ---------- TOPICS ----------
  function renderTopics() {
    setTitle("Topics");
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Topics &amp; Themes</h1><p class="page-sub">Browse the archive by subject.</p></div>
      <div class="topic-grid">
        ${DATA.subjects.map((s) => `
          <button class="topic-card" data-sub="${esc(s.name)}">
            <p class="tc-name">${esc(s.name)}</p>
            <p class="tc-count">${num(s.count)} poem${s.count === 1 ? "" : "s"}</p>
          </button>`).join("")}
      </div>`;
    app.querySelectorAll(".topic-card").forEach((c) => c.addEventListener("click", () => {
      filterSubject = c.dataset.sub; filterForm = "All"; query = ""; syncSearchInput(); location.hash = "#/poems";
    }));
  }

  // ---------- ABOUT ----------
  function renderAbout() {
    setTitle("About");
    app.innerHTML = `
      <article class="about">
        <img class="about-coin" src="coin-300.webp" alt="Gold medallion of Alexander the Great" />
        <h1>About Poetry Codex</h1>
        <p>Poetry Codex is a reading archive of poetry in the public domain — and the foundation of a
        larger project: a critical engine able to read these poems through the full range of methods
        that literary scholarship has developed over the past two centuries.</p>
        <p>The archive currently holds <strong>${DATA.count.toLocaleString("en-US")} poems</strong> in ${CATEGORY_ORDER.length} traditions, from the ancient world,
        the Greek and Roman epics and Anglo-Saxon verse through the Middle Ages, the Renaissance, the
        Romantics and the Victorians to the early twentieth century. Every text is reproduced in full
        and is free of copyright.</p>

        <h2>Why this exists</h2>
        <p>Great poems are easy to find online; informed readings of them are not. A reader is usually
        offered either a bare text or a single, unattributed interpretation presented as the meaning of
        the poem. Poetry Codex begins from a different premise: that a poem is best understood through
        more than one lens, and that a reader deserves to see the lens named.</p>

        <h2>The Critical Engine <span class="soon">Early version</span></h2>
        <p>We are building a reading system specialised entirely in poetry — not a general assistant —
        that can analyse any text in the archive through a chosen critical tradition: formalist,
        historicist, psychoanalytic, feminist, postcolonial, ecocritical, and others. An early version
        is already open on every poem page, under “Read with the Codex”. Ask how <em>Beowulf</em> reads
        through a feminist lens, or how a Donne lyric looks first to a New Critic and then to a
        historicist, and the answer should be an argument rather than a summary.</p>
        <p><strong>How the Codex reads.</strong> When you ask for a reading of a poem, a language model
        (Claude, made by Anthropic) reads the poem in front of you and writes a short critical response
        through the tradition you choose. It works from the poem and from what it learned in training,
        and it is instructed never to invent a quotation, a date, an edition, or the opinion of a named
        critic; it may name a critical tradition, but it does not put words in a scholar’s mouth. The
        engine does not claim to give the right reading, only a starting point for yours; machine-written
        readings can be shallow or wrong, and they are no substitute for a teacher, a good edition, or a
        library.</p>
        <p><strong>What comes next</strong> (a plan, not a feature): we are assembling a library of
        public-domain criticism and essays; once it is switched on, the engine will answer with real
        passages from that library in front of it, each quotation copied from the source and footnoted
        to the full article here — and it will say so when the library has nothing to offer.</p>
        <p>What the engine offers, and what it is growing into:</p>
        <ul class="about-list">
          <li><strong>Semantic search</strong> — find poems by what they are about, not by the words
          they happen to use: ask for poems on exile, or on grief that refuses consolation.${ORACLE_LIVE ? "" : " It comes with the Oracle, which is resting for now and will return later."}</li>
          <li><strong>Codex Notes</strong> — short critical readings, generated under scholarly
          constraints and reviewed before publication; a growing number of poems carry one.</li>
          <li><strong>Comparative reading</strong> — two poems placed side by side, with an account of
          what they share and where they part.</li>
          <li><strong>Modern-English gloss</strong> — line-by-line glosses for Old and Middle English
          verse, so that the earliest poetry in the archive stays readable.</li>
        </ul>

        <h2>Built with scholars</h2>
        <p>The engine is being developed together with academic collaborators, who define the critical
        frameworks, select the sources and review the readings it produces. Poetry Codex is built on the
        assumption that an interpretation is only as good as the tradition it can be held accountable to.</p>

        <h2>Reading with the keyboard</h2>
        <p>On a poem or a book of a long work, while you are not typing in a box, these keys work
        (Ctrl+F stays your browser's own find):</p>
        ${keysListHTML()}

        <h2>Texts &amp; images</h2>
        <p>Every poem here is in the public domain and is reproduced in full. Translations were published
        before 1931 and name their translator; where the book a poem comes from is recorded, its page names
        that too. Poet portraits are likewise public-domain works, courtesy of Wikimedia
        Commons, and each carries its credit.</p>
        <p>The gold medallion that is the Codex's emblem is the <a href="https://art.thewalters.org/object/59.1/" rel="noopener">Medallion with
        Alexander the Great</a>, Roman, about 215–243 CE, found at Aboukir in Egypt in 1902 and now in the Walters
        Art Museum, Baltimore (59.1). The museum has placed its photographs in the public domain, and we thank the
        Walters for its generosity.</p>

        <h2>Suggest a missing poem</h2>
        <p>If a poem you would expect to find here is missing, tell us. It can join the archive if
        it is in the public domain: by a poet who died long ago and, if it is a translation, in an
        English version published before 1931.
        <a data-suggest href="${esc(SUGGEST_URL)}">Suggest a poem</a> opens an email with a short
        form to fill in.</p>

        <h2>The emblem</h2>
        <p>The archive’s emblem is a Roman gold medallion depicting Alexander the Great — an image of
        inheritance and endurance, fitting for a collection that returns great poems to a single shelf.</p>

        <h2>Contact</h2>
        <p>Poetry Codex welcomes correspondence from scholars, teachers and readers:
        <a href="mailto:admin@poetrycodex.com">admin@poetrycodex.com</a>.</p>
      </article>`;
  }

  // ---------- SHELF: what the reader saved, in this browser ----------
  const shortDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
  };
  const byLine = (it) => [it.author, it.translator && translatorShort(it.translator)].filter(Boolean).join(" · ");
  // `it` a shelf entry or, for a note on a text not on the shelf, the note itself. A saved
  // text has its reading status beside it.
  function shelfRowHTML(it, note) {
    return `
      <li class="shelf-item">
        <a class="shelf-link" href="${esc(routeFor(it.id))}">
          <span class="shelf-title">${esc(it.title)}</span>
          <span class="shelf-by">${esc(byLine(it))}</span>
        </a>
        <span class="shelf-side">${it.saved ? `${shelfLearnHTML(it.id)}${OFF_OK && offRefFor(it.id) ? `
          <span class="offline-badge" title="Available offline on this device">Offline</span>` : ""}
          <span class="shelf-date">Saved ${esc(shortDate(it.saved))}</span>
          <select class="shelf-status" data-id="${esc(it.id)}" aria-label="Reading status of ${esc(it.title)}">
            <option value="">No status</option>${STATUSES.map(([v, name]) => `<option value="${v}"${it.status === v ? " selected" : ""}>${name}</option>`).join("")}
          </select>
          <button class="shelf-remove" type="button" data-id="${esc(it.id)}" aria-label="Remove ${esc(it.title)} from your shelf">Remove</button>`
          : `<span class="shelf-date">Note · ${esc(shortDate(note.updated))}</span>`}
        </span>
        ${note ? `<p class="shelf-note">${esc(note.text)}</p>` : ""}
      </li>`;
  }
  // Notes on texts that are not on the shelf, newest first.
  function looseNotes() {
    const notes = allNotes();
    const saved = new Set(shelfItems().map((it) => it.id));
    return Object.keys(notes).filter((id) => !saved.has(id)).map((id) => notes[id])
      .filter((n) => n && typeof n.text === "string" && typeof n.id === "string")
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }
  // The shelf shows everything (#/shelf), the texts with one status (#/shelf?s=reading) or
  // one collection (#/shelf?c=<id>), picked from the "Show" list at the top.
  let SHELF_FOCUS = "";                // what to give the focus to once the shelf is drawn again
  function renderShelf() {
    setTitle("Your shelf");
    const items = shelfItems();
    const notes = allNotes();
    const loose = looseNotes();
    const cols = shelfCollections();
    const q = location.hash.match(/[?&](s|c)=([\w-]+)/);
    const col = q && q[1] === "c" ? cols.find((c) => c.id === q[2]) : null;
    const status = q && q[1] === "s" && STATUS_NAME[q[2]] ? q[2] : "";
    const poems = items.filter((it) => it.kind === "poem");
    const works = items.filter((it) => it.kind !== "poem");
    const group = (name, list, noteOf) => list.length ? `
      <section class="shelf-group">
        <h2>${name} · ${list.length}</h2>
        <ul class="shelf-list">${list.map((it) => shelfRowHTML(it, noteOf(it))).join("")}</ul>
      </section>` : "";
    const savedNote = (it) => notes[it.id];
    const plural = (n, one, many) => num(n) + " " + (n === 1 ? one : many);
    const pick = items.length || cols.length ? `
        <div class="shelf-bar no-print">
          <label class="shelf-bar-label" for="shelf-pick">Show</label>
          <select id="shelf-pick" class="shelf-pick">
            <option value="">All (${num(items.length)})</option>
            ${STATUSES.map(([v, name]) => `<option value="s=${v}"${status === v ? " selected" : ""}>${name} (${num(items.filter((it) => it.status === v).length)})</option>`).join("")}
            ${cols.length ? `<optgroup label="Collections">${cols.map((c) => `<option value="c=${esc(c.id)}"${col === c ? " selected" : ""}>${esc(c.name)} (${num(c.items.length)})</option>`).join("")}</optgroup>` : ""}
          </select>
          <button class="shelf-dl shelf-newcol" type="button" aria-expanded="false" aria-controls="shelf-newcol-form">New collection</button>
        </div>
        <form class="col-form no-print" id="shelf-newcol-form" hidden>
          <label class="col-form-label" for="shelf-newcol-name">Name of the new collection</label>
          <input class="col-form-input" id="shelf-newcol-name" type="text" maxlength="${COL_NAME_MAX}" autocomplete="off" placeholder="Week 4: the elegy">
          <button class="shelf-dl" type="submit">Create</button>
          <button class="shelf-dl col-form-cancel" type="button">Cancel</button>
        </form>` : "";
    let body;
    if (col) body = collectionHTML(col);
    else if (status) {
      const list = items.filter((it) => it.status === status);
      body = list.length ? group(STATUS_NAME[status], list, savedNote) : `
        <p class="empty">Nothing marked “${STATUS_NAME[status]}” yet.</p>
        <p class="shelf-how">Under any text, the arrow beside <strong>Save to shelf</strong> sets its reading
        status; here, the list beside each text does.</p>`;
    } else body = items.length || loose.length || markCount() || cols.length ? (cols.length ? `
        <section class="shelf-group">
          <h2>Collections · ${cols.length}</h2>
          <ul class="shelf-list">${cols.map((c) => `
            <li class="shelf-item"><a class="shelf-link" href="#/shelf?c=${esc(c.id)}">
              <span class="shelf-title">${esc(c.name)}</span>
              <span class="shelf-by">${plural(c.items.length, "text", "texts")}</span></a></li>`).join("")}</ul>
        </section>` : "") + group("Poems", poems, savedNote) + group("Works", works, savedNote)
          + group("Your notes on other texts", loose, (n) => n)
          + (markCount() ? `
        <section class="shelf-group">
          <h2>Notes on lines · ${markCount()}</h2>
          <ul class="mark-list">${markRows().map(markRowHTML).join("")}</ul>
        </section>` : "") + `
        <section class="shelf-export">
          <h2>Take it with you</h2>
          <p>${signedIn() ? "Download a copy to keep, or to paste into your own notes." : "Your shelf is stored nowhere else. Download a copy to keep it, or to paste into your own notes."}</p>
          <div class="cite-row">
            <button class="shelf-dl" type="button" data-format="md">Download as Markdown</button>
            <button class="shelf-dl" type="button" data-format="json">Download as JSON</button>
          </div>
        </section>` : `
        <p class="empty">Nothing on your shelf yet.</p>
        <p class="shelf-how">Open any poem or long work and press <strong>Save to shelf</strong> under the text,
        or <strong>Add a note</strong> to write a private note on it. Both will wait for you here.
        <a href="#/poems">Browse the poems →</a></p>`;
    app.innerHTML = `
      <article class="shelf">
        <div class="page-head no-print">
          <h1 class="page-title">Your shelf</h1>
          <p class="page-sub">Poems and works you have saved, and your notes. ${signedIn()
            ? `They are kept in your account and in this browser, and no one else can see them. <a href="#/account">Your account →</a>`
            : `They are kept in this browser only: nothing is sent to Poetry Codex, and no one else can see them.${GOOGLE_CLIENT
              ? ` <a href="#/account">Sign in to keep them on all your devices →</a>` : ""}`}</p>
          <p class="nb-link"><a href="#/notes">All my notes and highlights <span aria-hidden="true">→</span></a></p>
        </div>
        ${visitOnly() ? `<p class="shelf-warn">This browser is not keeping data for this site (a private
          window, or site storage switched off or full), so your shelf will be gone when you close
          this tab. Download it below to keep a copy.</p>` : ""}
        ${pick}
        ${body}
      </article>`;
    app.querySelectorAll(".shelf-remove:not(.col-out)").forEach((b) => b.addEventListener("click", () => {
      const it = shelfItems().find((x) => x.id === b.dataset.id);
      if (it) toggleShelf(it);
      renderShelf();
    }));
    app.querySelectorAll(".shelf-status").forEach((s) => s.addEventListener("change", () => {
      const it = shelfItems().find((x) => x.id === s.dataset.id);
      if (it) { setStatus(it, s.value); announce(s.value ? "Status: " + STATUS_NAME[s.value] + "." : "Status cleared."); }
      if (status) { SHELF_FOCUS = "#shelf-pick"; renderShelf(); }   // it may have left this list
    }));
    app.querySelectorAll(".shelf-dl[data-format]").forEach((b) => b.addEventListener("click", () => {
      const day = new Date().toISOString().slice(0, 10);
      if (b.dataset.format === "json") {
        downloadFile(`poetry-codex-shelf-${day}.json`, "application/json", JSON.stringify(shelfExport(), null, 2));
      } else {
        downloadFile(`poetry-codex-shelf-${day}.md`, "text/markdown", shelfMarkdown());
      }
    }));
    const pickEl = document.getElementById("shelf-pick");
    if (pickEl) pickEl.addEventListener("change", () => {
      SHELF_FOCUS = "#shelf-pick";
      location.replace("#/shelf" + (pickEl.value ? "?" + pickEl.value : ""));
    });
    const newBtn = app.querySelector(".shelf-newcol"), newForm = document.getElementById("shelf-newcol-form");
    if (newBtn) {
      const input = newForm.querySelector("input");
      const shut = () => { newForm.hidden = true; newBtn.setAttribute("aria-expanded", "false"); newBtn.focus(); };
      newBtn.addEventListener("click", () => {
        newForm.hidden = !newForm.hidden;
        newBtn.setAttribute("aria-expanded", String(!newForm.hidden));
        if (!newForm.hidden) input.focus();
      });
      newForm.querySelector(".col-form-cancel").addEventListener("click", shut);
      newForm.addEventListener("keydown", (e) => { if (e.key === "Escape") shut(); });
      newForm.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!input.value.trim()) { input.focus(); return; }
        const c = newCollection(input.value);
        SHELF_FOCUS = "#shelf-pick";
        location.replace("#/shelf?c=" + c.id);
      });
    }
    if (col) bindCollection(col);
    if (SHELF_FOCUS) { const f = app.querySelector(SHELF_FOCUS); SHELF_FOCUS = ""; if (f) f.focus(); }
  }

  // ---------- one collection on the shelf ----------
  // Its texts and passages in the reader's order: a drag handle (mouse) and Up / Down
  // buttons (keyboard and touch) reorder them, and the new place is read out. Rename, delete
  // (the texts stay on the shelf), share as a reading-list link, print as a handout.
  const colItemHref = (x) => routeFor(x.ref) + (x.l ? "?l=" + x.l : "");
  const passageLabel = (x) => x.l ? (x.loc || "lines " + x.l.replace("-", "–")) : "";
  function collectionHTML(col) {
    const n = col.items.length;
    return `
        <section class="shelf-group col-view" aria-labelledby="col-name">
          <h2 class="col-name" id="col-name">${esc(col.name)}</h2>
          <p class="col-count">${num(n)} ${n === 1 ? "text" : "texts"}<span class="print-only"> · a reading list from Poetry Codex</span></p>
          <div class="cite-row col-tools no-print">
            <button class="shelf-dl col-share" type="button"${n ? "" : " disabled"}>Share as reading list</button>
            <button class="shelf-dl col-print" type="button"${n ? "" : " disabled"}>Print list</button>
            <button class="shelf-dl col-rename" type="button" aria-expanded="false" aria-controls="col-rename-form">Rename</button>
            <button class="shelf-dl col-delete" type="button">Delete collection</button>
          </div>
          <form class="col-form no-print" id="col-rename-form" hidden>
            <label class="col-form-label" for="col-rename-name">New name</label>
            <input class="col-form-input" id="col-rename-name" type="text" maxlength="${COL_NAME_MAX}" autocomplete="off" value="${esc(col.name)}">
            <button class="shelf-dl" type="submit">Save</button>
            <button class="shelf-dl col-form-cancel" type="button">Cancel</button>
          </form>
          ${n ? `<ol class="shelf-list col-list">${col.items.map((x, k) => `
            <li class="shelf-item col-item" data-k="${k}">
              <span class="col-grip no-print" draggable="true" title="Drag to reorder" aria-hidden="true">⠇</span>
              <a class="shelf-link" href="${esc(colItemHref(x))}">
                <span class="shelf-title">${esc(x.title)}</span>
                <span class="shelf-by">${esc(byLine(x))}</span>
                ${x.l ? `<span class="col-loc">${esc(passageLabel(x))}${x.first ? ` · “${esc(x.first)}…”` : ""}</span>` : ""}
              </a>
              <span class="shelf-side no-print">${shelfLearnHTML(x.ref, x.l)}
                <button class="col-move" type="button" data-k="${k}" data-d="-1" aria-label="Move ${esc(x.title)} up"${k === 0 ? " disabled" : ""}>Up</button>
                <button class="col-move" type="button" data-k="${k}" data-d="1" aria-label="Move ${esc(x.title)} down"${k === n - 1 ? " disabled" : ""}>Down</button>
                <button class="shelf-remove col-out" type="button" data-k="${k}" aria-label="Take ${esc(x.title)} out of this collection">Remove</button>
              </span>
            </li>`).join("")}</ol>
          <p class="print-only col-url">Online: ${esc(readingListURL(col.name, col.items).url)}</p>` : `
          <p class="shelf-how">Nothing in this collection yet. Under any text, the arrow beside <strong>Save to
          shelf</strong> puts it in a collection; select some lines and <strong>Add passage to…</strong> puts in just those.</p>`}
        </section>`;
  }
  function bindCollection(col) {
    const n = col.items.length;
    const move = (from, to, focusD) => {
      if (to < 0 || to >= n || to === from) return;
      const c = editCollection(col.id, (c) => { const [x] = c.items.splice(from, 1); c.items.splice(to, 0, x); });
      if (!c) return;
      SHELF_FOCUS = focusD ? `.col-move[data-k="${to}"][data-d="${to === 0 ? 1 : to === n - 1 ? -1 : focusD}"]` : `.col-item[data-k="${to}"] .shelf-link`;
      renderShelf();
      announce(`${c.items[to].title}: now ${to + 1} of ${n}.`);
    };
    app.querySelectorAll(".col-move").forEach((b) => b.addEventListener("click", () => move(+b.dataset.k, +b.dataset.k + +b.dataset.d, b.dataset.d)));
    app.querySelectorAll(".col-out").forEach((b) => b.addEventListener("click", () => {
      const k = +b.dataset.k, x = col.items[k];
      editCollection(col.id, (c) => { c.items.splice(k, 1); });
      SHELF_FOCUS = n > 1 ? `.col-item[data-k="${Math.min(k, n - 2)}"] .shelf-link` : "#shelf-pick";
      renderShelf();
      announce(`${x.title} taken out of ${col.name}.`);
    }));
    // Dragging by the handle; the whole row is the place to drop it.
    let dragFrom = -1;
    app.querySelectorAll(".col-item").forEach((li) => {
      const grip = li.querySelector(".col-grip");
      grip.addEventListener("dragstart", (e) => {
        dragFrom = +li.dataset.k;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragFrom));
        if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(li, 20, 20);
        li.classList.add("is-dragging");
      });
      grip.addEventListener("dragend", () => { li.classList.remove("is-dragging"); app.querySelectorAll(".col-item.is-over").forEach((x) => x.classList.remove("is-over")); });
      li.addEventListener("dragover", (e) => { if (dragFrom < 0) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; li.classList.add("is-over"); });
      li.addEventListener("dragleave", () => li.classList.remove("is-over"));
      li.addEventListener("drop", (e) => { e.preventDefault(); const from = dragFrom; dragFrom = -1; if (from >= 0) move(from, +li.dataset.k); });
    });
    const share = app.querySelector(".col-share");
    if (share) share.addEventListener("click", () => shareReadingList(col.name, col.items));
    const print = app.querySelector(".col-print");
    if (print) print.addEventListener("click", () => window.print());
    const ren = app.querySelector(".col-rename"), form = document.getElementById("col-rename-form");
    const input = form.querySelector("input");
    const shut = () => { form.hidden = true; ren.setAttribute("aria-expanded", "false"); ren.focus(); };
    ren.addEventListener("click", () => {
      form.hidden = !form.hidden;
      ren.setAttribute("aria-expanded", String(!form.hidden));
      if (!form.hidden) { input.focus(); input.select(); }
    });
    form.querySelector(".col-form-cancel").addEventListener("click", shut);
    form.addEventListener("keydown", (e) => { if (e.key === "Escape") shut(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim().slice(0, COL_NAME_MAX);
      if (!name) { input.focus(); return; }
      editCollection(col.id, (c) => { c.name = name; });
      SHELF_FOCUS = ".col-rename";
      renderShelf();
      announce(`Renamed ${name}.`);
    });
    app.querySelector(".col-delete").addEventListener("click", () => {
      if (!window.confirm(`Delete the collection “${col.name}”? The texts in it stay on your shelf.`)) return;
      deleteCollection(col.id);
      SHELF_FOCUS = "#shelf-pick";
      location.replace("#/shelf");
      announce(`Collection ${col.name} deleted.`);
    });
  }

  // ---------- reading lists: a collection shared as a link ----------
  // "Share as reading list" copies an address that carries the whole list:
  // #/list?t=<title>&i=<ref>,<ref>@120-160,… (a title of up to 80 characters, at most 60
  // items; a passage is its text's id @ the lines, counted as "Link to lines" counts them).
  // Nothing is stored anywhere for it. Whoever opens it sees a read-only page: the texts with
  // their poet, translator and first line (or the lines), "Read in order", "Save this list to
  // my shelf" (a new collection) and "Print list". An id that is not in the archive shows as
  // "not found" and is skipped. "Read in order" opens the first text with ?list=1 in its
  // address; while ?list= is there, the foot of the text offers the next one. The list being
  // read is kept for this tab only (sessionStorage), so the addresses stay short.
  const LIST_MAX = 60;
  const REF_RE = /^(?:work:[\w-]+(?:\/\d+)?|[\w-]+\/\d+)$/;
  function readingListURL(name, items) {
    const refs = items.slice(0, LIST_MAX).map((x) => x.ref + (x.l ? "@" + x.l : ""));
    const hash = "#/list?t=" + encodeURIComponent(String(name).slice(0, COL_NAME_MAX)) + "&i=" + refs.join(",");
    return { hash, url: SITE + "/" + hash, over: items.length > LIST_MAX };
  }
  function shareReadingList(name, items) {
    const { hash, url, over } = readingListURL(name, items);
    const msg = (over ? `A link holds at most ${LIST_MAX} texts, so this one has the first ${LIST_MAX} of ${num(items.length)}. ` : "")
      + "Link to the reading list copied. Whoever opens it sees the list; nothing is stored on Poetry Codex.";
    copyText(url).then(() => selToast(msg, { label: "Open it", run: () => { closeToast(); location.hash = hash; } }, true),
      () => copyBox(url, true));
  }
  function parseReadingList(h) {
    let t = "", raw = "";
    (h.split("?")[1] || "").split("&").forEach((kv) => {
      const at = kv.indexOf("="), k = kv.slice(0, at), v = kv.slice(at + 1);
      if (k === "t") { try { t = decodeURIComponent(v.replace(/\+/g, " ")); } catch (e) { t = v; } }
      else if (k === "i") { try { raw = decodeURIComponent(v); } catch (e) { raw = v; } }
    });
    const all = raw.split(",").map((x) => x.trim()).filter(Boolean);
    const items = all.slice(0, LIST_MAX).map((x) => {
      const at = x.lastIndexOf("@"), ref = at >= 0 ? x.slice(0, at) : x, l = at >= 0 ? x.slice(at + 1) : "";
      return { ref, l: /^\d+(?:-\d+)?$/.test(l) ? l : "" };
    });
    return { t: t.replace(/\s+/g, " ").trim().slice(0, COL_NAME_MAX) || "A reading list", items, over: all.length > LIST_MAX ? all.length : 0 };
  }
  // What the archive knows of a list item: null when it is not there.
  function listItemInfo(x) {
    if (!REF_RE.test(x.ref)) return null;
    let info;
    if (x.ref.startsWith("work:")) {
      const [slug, i] = x.ref.slice(5).split("/"), w = WORKS[slug];
      if (!w) return null;
      if (i === undefined) info = { kind: "work", title: w.title, author: w.author, translator: w.translator || "",
                                    first: w.sections.length > 1 ? num(w.sections.length) + " parts" : "" };
      else {
        const s = w.sections[+i];
        if (!s) return null;
        info = { kind: "part", title: w.sections.length > 1 ? w.title + " · " + s.title : w.title, author: w.author,
                 translator: w.translator || "", first: "", prose: !!s.prose };
      }
    } else {
      const p = DATA && DATA.poems.find((q) => q.id === x.ref);
      if (!p) return null;
      info = { kind: "poem", title: p.title, author: p.author, translator: p.translator || "",
               first: String(p.excerpt || "").split("\n").map((l) => l.trim()).find(Boolean) || "" };
    }
    if (x.l) info.loc = (info.prose ? "paragraphs " : "lines ") + x.l.replace("-", "–");
    return info;
  }
  const LIST_RUN_KEY = "pc-list-run";
  let LIST_RUN = null;                 // {t, from (the list page's address), items: [{ref, l, title}]}
  function listRun() {
    if (!LIST_RUN) { try { LIST_RUN = JSON.parse(sessionStorage.getItem(LIST_RUN_KEY) || "null"); } catch (e) { LIST_RUN = null; } }
    return LIST_RUN && Array.isArray(LIST_RUN.items) ? LIST_RUN : null;
  }
  function setListRun(run) {
    LIST_RUN = run;
    try { sessionStorage.setItem(LIST_RUN_KEY, JSON.stringify(run)); } catch (e) { /* this page only */ }
  }
  const listItemHref = (x, k) => routeFor(x.ref) + "?list=" + (k + 1) + (x.l ? "&l=" + x.l : "");
  function renderReadingList() {
    const list = parseReadingList(location.hash);
    setTitle(list.t);
    const rows = list.items.map((x) => ({ x, info: listItemInfo(x) }));
    const found = rows.filter((r) => r.info).map((r) => Object.assign({ ref: r.x.ref, l: r.x.l }, r.info));
    const missing = rows.length - found.length;
    setListRun({ t: list.t, from: location.hash, items: found.map((x) => ({ ref: x.ref, l: x.l, title: x.title, loc: x.loc })) });
    let k = -1;
    app.innerHTML = `
      <article class="shelf rlist">
        <div class="page-head">
          <p class="detail-subject">A reading list</p>
          <h1 class="page-title">${esc(list.t)}</h1>
          <p class="page-sub">${num(found.length)} ${found.length === 1 ? "text" : "texts"}. Shared as a link: the list travels in the
            address itself, and nothing about it is stored on Poetry Codex.</p>
        </div>
        ${found.length ? `<div class="cite-row rl-tools no-print">
          <a class="rl-read" href="${esc(listItemHref(found[0], 0))}">Read in order <span aria-hidden="true">→</span></a>
          <button class="shelf-dl rl-save" type="button">Save this list to my shelf</button>
          <button class="shelf-dl rl-print" type="button">Print list</button>
        </div>
        <p class="rl-saved no-print" hidden></p>` : ""}
        ${rows.length ? `<ol class="shelf-list rl-list">${rows.map(({ x, info }) => {
          if (!info) return `
          <li class="shelf-item rl-missing"><span class="shelf-link"><span class="shelf-title">Not found</span>
            <span class="shelf-by">${esc(x.ref)} · not in the archive, skipped</span></span></li>`;
          k++;
          return `
          <li class="shelf-item"><a class="shelf-link" href="${esc(listItemHref(x, k))}">
            <span class="shelf-title">${esc(info.title)}</span>
            <span class="shelf-by">${esc(byLine(info))}</span>
            ${info.loc || info.first ? `<span class="col-loc">${esc(info.loc || info.first)}</span>` : ""}
          </a></li>`;
        }).join("")}</ol>` : `<p class="empty">This reading list is empty.</p>`}
        ${missing ? `<p class="shelf-how no-print">${missing === 1 ? "One item was" : num(missing) + " items were"} not found in the archive and ${missing === 1 ? "is" : "are"} skipped.</p>` : ""}
        ${list.over ? `<p class="shelf-how">The link named ${num(list.over)} texts; a reading list holds at most ${LIST_MAX}, so only the first ${LIST_MAX} are shown.</p>` : ""}
        <p class="print-only col-url">Online: ${esc(SITE + "/" + location.hash)}</p>
      </article>`;
    const save = app.querySelector(".rl-save");
    if (save) save.addEventListener("click", () => {
      const c = newCollection(list.t, found.map((x) => ({ ref: x.ref, l: x.l || undefined, title: x.title, author: x.author,
        translator: x.translator, kind: x.kind, loc: x.l ? x.loc : undefined })));
      const done = app.querySelector(".rl-saved");
      done.innerHTML = `Saved as a collection on your shelf. <a href="#/shelf?c=${esc(c.id)}">Open it →</a>`;
      done.hidden = false;
      save.disabled = true;
      done.querySelector("a").focus();
      announce("Saved as a collection on your shelf.");
    });
    const print = app.querySelector(".rl-print");
    if (print) print.addEventListener("click", () => window.print());
  }
  // At the foot of a text opened from a reading list (?list=N): where it stands in the list
  // and the next text, or the end of the list.
  function bindListNext() {
    const m = /[?&]list=(\d+)/.exec(location.hash), run = m && listRun();
    const art = app.querySelector("article.detail");
    if (!run || !art || app.querySelector(".list-next")) return;
    const k = +m[1] - 1, n = run.items.length, next = run.items[k + 1];
    if (!run.items[k]) return;
    const nav = document.createElement("nav");
    nav.className = "list-next no-print";
    nav.setAttribute("aria-label", "Reading list");
    nav.innerHTML = `
      <p class="list-next-where">Reading list · <a href="${esc(run.from)}">${esc(run.t)}</a> · ${k + 1} of ${n}</p>
      ${next ? `<a class="list-next-go" href="${esc(listItemHref(next, k + 1))}"><span class="dir">Next in this list →</span>${esc(next.title)}${next.loc ? " (" + esc(next.loc) + ")" : ""}</a>`
        : `<p class="list-next-end">The end of the list. <a href="${esc(run.from)}">Back to the list</a></p>`}`;
    const before = art.querySelector(".detail-nav");
    if (before) art.insertBefore(nav, before); else art.appendChild(nav);
  }
  // What the downloads hold: every entry with its permanent address.
  function shelfExport() {
    const notes = allNotes();
    const row = (it) => {
      const n = notes[it.id];
      return { id: it.id, kind: it.kind, title: it.title, author: it.author,
        translator: it.translator || undefined, url: SITE + shelfPath(it.id), saved: it.saved || undefined,
        status: it.status || undefined, note: n ? n.text : undefined, noteUpdated: n ? n.updated : undefined };
    };
    return {
      format: "Poetry Codex shelf", version: 1, exported: new Date().toISOString(),
      shelf: shelfItems().map(row), notes: looseNotes().map(row),
      collections: shelfCollections().map((c) => ({ name: c.name, readingList: readingListURL(c.name, c.items).url,
        items: c.items.map((x) => ({ id: x.ref, title: x.title, author: x.author, lines: x.l || undefined, url: SITE + shelfPath(x.ref) })) })),
      lineNotes: markRows().map(({ id, g, m }) => ({ id, title: g.title, author: g.author, url: SITE + shelfPath(id),
        quote: m.quote, note: m.text, updated: m.updated })),
    };
  }
  function shelfMarkdown() {
    const md = (s) => String(s || "").replace(/([\\`*_[\]<>])/g, "\\$1");
    const items = shelfItems();
    const notes = allNotes();
    // A note is quoted under its text, line for line.
    const quote = (n) => n ? "\n" + n.text.split("\n").map((l) => "  > " + l).join("\n") + "\n" : "";
    const block = (name, list) => list.length ? `## ${name}\n\n` + list.map((it) =>
      `- **${md(it.title)}** — ${md(byLine(it))}  \n  ${SITE + shelfPath(it.id)}  \n  `
      + (it.saved ? `Saved ${shortDate(it.saved)}` : `Note written ${shortDate(it.updated)}`) + "\n"
      + quote(notes[it.id])).join("\n") + "\n" : "";
    return `# My Poetry Codex shelf\n\nExported ${shortDate(new Date().toISOString())} from ${SITE}\n\n`
      + block("Poems", items.filter((it) => it.kind === "poem"))
      + block("Works", items.filter((it) => it.kind !== "poem"))
      + block("Notes on other texts", looseNotes())
      + (markCount() ? "## Notes on lines\n\n" + markRows().map(({ id, g, m }) =>
        `- “${md(m.quote)}” — **${md(g.title)}**, ${md(g.author || "")}  \n  ${SITE + shelfPath(id)}\n  > ${m.text.split("\n").join("\n  > ")}\n`).join("\n") + "\n" : "");
  }
  function downloadFile(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- MY NOTES AND HIGHLIGHTS: #/notes ----------
  // Every highlight and line note (pc-marks) and every note on a whole text (pc-notes) on one
  // page, grouped by work and book (or poet and poem), in the order they stand in the text.
  // Each text is fetched as its own page would fetch it, so that every item can show its words
  // laid out as verse, the lines it covers ("lines 120–124", counted as "Copy quote" cites
  // them) and a "Go to" link that opens the page at those lines (?l=). A mark whose words are
  // no longer where they were is shown with the words it kept and a quiet "the text has
  // changed", never dropped. A search (folded like the archive's), colour chips, "Notes only",
  // one text, and sort by text or by date filter the list; the downloads (a Word-ready .html
  // file, Markdown) and Print take only what is shown, each quotation followed by its MLA
  // entry. Everything is made in the browser: nothing is sent anywhere.
  // The reader's own meanings for the colours ("Question", "Image"…) are kept in this browser
  // only (pc-hl-names): the account keeps only the kinds its Worker knows.
  const HL_NAMES_KEY = "pc-hl-names";
  const HL_SUGGEST = { yellow: "Question", green: "Image", blue: "Sound", pink: "Theme" };
  function hlMeanings() {
    const n = readStore(HL_NAMES_KEY);
    return Object.fromEntries(HL_COLORS.map((c) => [c, typeof n[c] === "string" ? n[c].trim().slice(0, 40) : ""]));
  }
  const NB_KINDS = HL_COLORS.concat(["line", "note"]);
  const nbKindName = (k, names) => k === "line" ? "Line note" : k === "note" ? "Note on the whole text"
    : HL_NAMES[k] + (names[k] ? " · " + names[k] : "");
  const NB = { q: "", kinds: [], notesOnly: false, sort: "text", text: "" };   // the filters, kept for the visit
  const NB_TEXTS = new Map();   // entry id -> Promise<the text as its page lays it out, or null>
  let NB_ITEMS = [], NB_READY = Promise.resolve(), nbTimer = 0;
  // The text behind an entry id, cut into the units its page numbers (verse lines, or
  // paragraphs of a prose translation) with where each starts in the page's running text.
  function nbText(tid) {
    if (NB_TEXTS.has(tid)) return NB_TEXTS.get(tid);
    const wm = /^work:([\w-]+)\/(\d+)$/.exec(tid), pm = /^([\w-]+)\/(\d+)$/.exec(tid);
    let p = Promise.resolve(null);
    if (wm) {
      const slug = wm[1], i = +wm[2];
      p = loadSectionPage(slug, i).then((w) => {
        const s = w && w.sections[i];
        if (!s || typeof s.text !== "string") return null;
        return Promise.all([fetchSources(w.authorSlug), LINEMAPPED.has(slug) ? lineMapOf(slug) : null]).then(([src, map]) =>
          nbLayout(s.text, { slug, title: s.title, work: w.title, author: w.author, authorSlug: w.authorSlug,
            translator: w.translator || "", one: w.sections.length <= 1,
            src: (src && src.works && src.works[slug]) || null, nums: map && map[i] }));
      });
    } else if (pm) {
      const slug = pm[1], n = +pm[2];
      p = loadPoemPage(slug, n).then((f) => {
        const po = f && f.poems[n];
        if (!po || typeof po.text !== "string") return null;
        return fetchSources(slug).then((src) => nbLayout(po.text, { slug, title: po.title,
          author: po.author || (POETS[slug] || {}).name || "", authorSlug: slug, translator: po.translator || "",
          src: poemSource(src, po) }));
      });
    }
    p = p.catch(() => null);
    NB_TEXTS.set(tid, p);
    return p;
  }
  function nbLayout(text, o) {
    const prose = isProse(text, o.translator);
    const box = document.createElement("div");
    box.innerHTML = poemHTML(text, prose);
    const units = [];
    let at = 0;
    const add = (el, st) => { const t = el.textContent; units.push({ t, s: at, st, c: +el.dataset.c || 0 }); at += t.length; };
    if (prose) [...box.children].forEach((el, k) => add(el, k));
    else [...box.children].forEach((st, k) => st.querySelectorAll(".ln").forEach((el) => add(el, k)));
    if (prose && Array.isArray(o.nums) && o.nums.length === units.length) units.forEach((u, k) => { u.n = +o.nums[k]; });
    return Object.assign(o, { prose, units, full: units.map((u) => u.t).join("") });
  }
  // Every mark and note as one list: kind is the colour, "line" or "note".
  function nbItems() {
    const items = [];
    Object.entries(allMarks()).forEach(([tid, g]) => ((g && g.items) || []).forEach((m) => {
      if (!m || !m.id) return;
      const hl = m.kind === "hl";
      items.push({ key: tid + "|" + m.id, tid, g, m, type: hl ? "hl" : "line",
        kind: hl ? (HL_COLORS.includes(m.color) ? m.color : "yellow") : "line",
        quote: String(m.quote || ""), note: String(m.text || ""), when: m.created || m.updated || "" });
    }));
    Object.values(allNotes()).forEach((n) => {
      if (!n || typeof n.id !== "string" || typeof n.text !== "string" || !n.text.trim()) return;
      items.push({ key: n.id + "|note", tid: n.id, g: n, m: n, type: "note", kind: "note",
        quote: "", note: n.text, when: n.created || n.updated || "" });
    });
    return items;
  }
  // Where an item stands in its text (tx, null until the text is in): its words as laid out,
  // the units to link (range, from 1), the place to cite (loc) and the order in the text.
  function nbPlace(it, tx) {
    Object.assign(it, { tx, changed: false, lines: null, range: null, loc: "", ord: it.type === "note" ? -1 : 0 });
    if (!tx || it.type === "note") return;
    const { units, full } = tx;
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const bare = (t) => String(t || "").replace(/\s+/g, "");
    const unitAt = (x) => { let k = 0; while (k + 1 < units.length && units[k + 1].s <= x) k++; return k; };
    let ua, ub, s, e;
    if (it.type === "line") {
      ua = it.m.a; ub = it.m.b;
      if (tx.prose || !(ua >= 0 && ub >= ua && ub < units.length)
          || !bare(units.slice(ua, ub + 1).map((u) => u.t).join("")).includes(bare(it.quote))) {
        it.changed = true; it.ord = Number.MAX_SAFE_INTEGER; return;
      }
      s = units[ua].s; e = units[ub].s + units[ub].t.length;
    } else {
      // As drawHighlights finds them: at their offsets, else where their words now stand.
      s = it.m.s; e = it.m.e;
      const q = norm(it.quote);
      if (!(e > s) || norm(full.slice(s, e)) !== q) {
        const k = q ? full.indexOf(q.slice(0, 80)) : -1;
        if (k < 0) { it.changed = true; it.ord = Number.MAX_SAFE_INTEGER; return; }
        s = k; e = k + q.length;
      }
      ua = unitAt(s); ub = unitAt(e - 1);
    }
    const lines = [];
    for (let k = ua; k <= ub; k++) {
      const u = units[k];
      let t = u.t.slice(Math.max(s, u.s) - u.s, Math.min(e, u.s + u.t.length) - u.s);
      t = k === ua || tx.prose ? t.trim() : t.replace(/\s+$/, "");
      if (!t.trim()) continue;
      if (lines.length && u.st !== units[k - 1].st) lines.push("");   // a new stanza or paragraph
      lines.push(t);
    }
    it.lines = lines.length ? lines : null;
    it.range = [ua + 1, ub + 1];
    it.ord = s;
    if (tx.prose) {
      const ga = units[ua].n, nx = units[ub + 1];
      if (ga) { const gb = nx && nx.n ? nx.n - 1 : 0; it.loc = gb > ga ? `lines ${ga}–${gb}` : gb === ga ? `line ${ga}` : `lines ${ga} ff.`; }
      else it.loc = ua === ub ? `para. ${ua + 1}` : `paras. ${ua + 1}–${ub + 1}`;
    } else {
      const counted = units.slice(ua, ub + 1).map((u) => u.c).filter(Boolean);
      const ca = counted.length ? counted[0] : ua + 1, cb = counted.length ? counted[counted.length - 1] : ub + 1;
      it.loc = ca === cb ? `line ${ca}` : `lines ${ca}–${cb}`;
    }
  }
  // The work (or poet) and the book (or poem) an item belongs to, with their order.
  function nbWhere(it) {
    const tx = it.tx, g = it.g || {};
    const [gWork, ...gRest] = String(g.title || "").split(" · ");
    const wm = /^work:([\w-]+)(?:\/(\d+))?$/.exec(it.tid);
    if (wm) {
      const tr = (tx ? tx.translator : g.translator) || "";
      const whole = wm[2] == null;
      return { top: "work:" + wm[1], topTitle: (tx && tx.work) || gWork || wm[1],
        topBy: [tx ? tx.author : g.author, tr && translatorShort(trName(tr))].filter(Boolean).join(" · "),
        sub: whole ? -1 : +wm[2], whole,
        subTitle: whole ? "The whole work" : tx ? (tx.one ? tx.work : tx.title) : (gRest.join(" · ") || g.title || "") };
    }
    const pm = /^([\w-]+)\/(\d+)$/.exec(it.tid) || [it.tid, it.tid, "0"];
    return { top: "poet:" + pm[1], topTitle: (tx && tx.author) || g.author || pm[1], topBy: "",
      sub: +pm[2], subTitle: (tx && tx.title) || g.title || "" };
  }
  function nbShown() {
    const words = searchWords(NB.q);
    return NB_ITEMS.filter((it) => (!NB.kinds.length || NB.kinds.includes(it.kind))
      && (!NB.notesOnly || it.note.trim())
      && (!NB.text || it.tid === NB.text || it.where.top === NB.text)
      && (!words.length || hasAll(fold([it.quote, (it.lines || []).join(" "), it.note, it.where.topTitle, it.where.subTitle].join(" ")), words)));
  }
  const nbOrder = (x, y) => x.ord - y.ord || String(x.when).localeCompare(String(y.when));
  // [{key, title, by, subs: [{tid, title, items}]}]: works and poets by title, books and poems
  // in their order, marks in reading order (a note on the whole text first).
  function nbGroups(list) {
    const tops = new Map();
    list.forEach((it) => {
      const w = it.where;
      let t = tops.get(w.top);
      if (!t) tops.set(w.top, (t = { key: w.top, title: w.topTitle, by: w.topBy, subs: new Map() }));
      let s = t.subs.get(it.tid);
      if (!s) t.subs.set(it.tid, (s = { tid: it.tid, title: w.subTitle, n: w.sub, items: [] }));
      s.items.push(it);
    });
    return [...tops.values()].sort((a, b) => COLLATE.compare(sortKey(a.title), sortKey(b.title)))
      .map((t) => Object.assign(t, { subs: [...t.subs.values()].sort((a, b) => a.n - b.n)
        .map((s) => Object.assign(s, { items: s.items.slice().sort(nbOrder) })) }));
  }
  const nbLabel = (it, names) => it.type !== "note" ? nbKindName(it.kind, names)
    : it.where.sub < 0 ? "Note on the whole work" : /^work:/.test(it.tid) ? "Note on the whole book" : "Note on the whole poem";
  const nbHref = (it) => routeFor(it.tid) + (it.range ? "?l=" + (it.range[0] === it.range[1] ? it.range[0] : it.range.join("-")) : "");
  function nbItemHTML(it, names, withSrc) {
    const w = it.where, tx = it.tx;
    const lang = tx ? langAttr(tx.authorSlug, tx.translator) : "";
    const chip = it.type === "hl" ? `<span class="hl-chip hl-${it.kind}" aria-hidden="true"></span>`
      : it.type === "line" ? `<span class="nb-dot" aria-hidden="true"></span>` : "";
    const kind = nbLabel(it, names);
    const ls = it.lines && !it.changed ? it.lines : [it.quote];
    const quote = it.type === "note" ? "" : `
        <blockquote class="nb-quote${tx && tx.prose ? " is-prose" : ""}"${lang}>${ls.map((l) => l
          ? `<span class="nb-l">${esc(l)}</span>` : `<span class="nb-gap"></span>`).join("")}</blockquote>`;
    const src = w.top.startsWith("work:") ? `${w.subTitle}${w.whole || w.subTitle === w.topTitle ? "" : " · " + w.topTitle}`
      : `${w.subTitle} · ${w.topTitle}`;
    return `
      <li class="nb-item nb-k-${it.kind}${it.type === "note" ? " nb-whole" : ""}">
        <p class="nb-meta">${chip}<span class="nb-kind">${esc(kind)}</span>${it.loc ? ` · ${esc(it.loc)}` : ""}${it.when ? ` · ${esc(shortDate(it.when))}` : ""}</p>
        ${withSrc ? `<p class="nb-src">${esc(src)}</p>` : ""}${quote}
        ${it.changed ? `<p class="nb-changed">The text has changed since you marked this: these are the words as you marked them.</p>` : ""}
        ${it.note.trim() ? `<p class="nb-note">${esc(it.note)}</p>` : ""}
        <p class="nb-cite">${nbCite(it).html}</p>
        <p class="nb-go"><a href="${esc(nbHref(it))}">${it.range ? "Go to " + esc(it.loc) : "Go to the text"}<span class="visually-hidden"> in ${esc(w.subTitle)}</span> <span aria-hidden="true">→</span></a></p>
      </li>`;
  }
  // The filters in words, for the count and the head of a download ("Yellow, Line notes · …").
  function nbFilterWords(names) {
    const parts = [];
    if (NB.kinds.length) parts.push(NB.kinds.map((k) => k === "line" ? "line notes" : k === "note" ? "notes on whole texts" : nbKindName(k, names)).join(", "));
    if (NB.notesOnly) parts.push("with a note");
    if (NB.text) { const it = NB_ITEMS.find((x) => x.tid === NB.text || x.where.top === NB.text); if (it) parts.push(it.tid === NB.text ? it.where.subTitle : it.where.topTitle); }
    if (NB.q.trim()) parts.push(`matching “${NB.q.trim()}”`);
    return parts.join(" · ");
  }
  function renderNotes() {
    setTitle("My notes and highlights");
    EARLY_DRAWN = DATA ? "" : location.hash;   // drawn without the index, which it does not need
    const head = `
        <div class="page-head">
          <h1 class="page-title">My notes and highlights</h1>
          <p class="page-sub">Everything you have marked, in the order it stands in each text. ${signedIn()
            ? "Kept in your account and in this browser." : "Kept in this browser only."} <a href="#/shelf">Your shelf →</a></p>
        </div>`;
    if (!nbItems().length) {
      app.innerHTML = `<article class="shelf nb">${head}
        <p class="empty">Nothing marked yet.</p>
        <p class="shelf-how">Select a few words in any poem or book and choose a colour to highlight them, or <strong>Note</strong>
        to write beside them. Everything you mark gathers here, to search, print or download with its citation.
        <a href="#/poems">Browse the poems →</a></p></article>`;
      return;
    }
    const names = hlMeanings();
    app.innerHTML = `
      <article class="shelf nb">${head}
        ${reviewSlotHTML("notes")}
        <div class="nb-bar">
          <div class="nb-row">
            <label class="visually-hidden" for="nb-q">Search your notes and highlights</label>
            <input id="nb-q" class="nb-q" type="search" placeholder="Search your notes and highlights" value="${esc(NB.q)}" autocomplete="off">
            <button class="nb-more" type="button" aria-expanded="false" aria-controls="nb-filters">Filters</button>
            <details class="nb-dl">
              <summary>Download</summary>
              <div class="nb-dl-menu">
                <button type="button" data-dl="html">Word document (.html)</button>
                <button type="button" data-dl="md">Markdown (.md)</button>
                <button type="button" data-dl="print">Print</button>
                <p class="nb-dl-note">Only what is shown, each quotation with its MLA citation.</p>
              </div>
            </details>
          </div>
          <div class="nb-filters" id="nb-filters">
            <div class="nb-chips" role="group" aria-label="Show only">
              ${NB_KINDS.map((k) => `<button type="button" class="chip nb-chip" data-k="${k}" aria-pressed="${NB.kinds.includes(k)}">${
                k === "line" ? `<span class="nb-dot" aria-hidden="true"></span>Line notes` : k === "note" ? "Notes on whole texts"
                : `<span class="hl-chip hl-${k}" aria-hidden="true"></span><span class="nb-chip-t">${esc(nbKindName(k, names))}</span>`}</button>`).join("")}
              <button type="button" class="nb-name">Name colours</button>
            </div>
            <div class="nb-row2">
              <label class="nb-check"><input type="checkbox" class="nb-only"${NB.notesOnly ? " checked" : ""}> Notes only</label>
              <label class="nb-sel"><span>Text</span> <select class="nb-text"></select></label>
              <label class="nb-sel"><span>Sort</span> <select class="nb-sort">
                <option value="text"${NB.sort === "text" ? " selected" : ""}>By text</option>
                <option value="date"${NB.sort === "date" ? " selected" : ""}>Newest first</option></select></label>
            </div>
          </div>
        </div>
        <p class="nb-count" role="status"></p>
        <div class="nb-out"></div>
        <dialog class="nb-dialog" aria-labelledby="nb-dlg-t">
          <form method="dialog">
            <h2 class="nb-dlg-t" id="nb-dlg-t">Name your colours</h2>
            <p class="nb-dlg-d">Give each colour a meaning of your own, if you like. It is shown with the colour here and in
            your downloads, and kept in this browser.</p>
            ${HL_COLORS.map((c) => `
            <label class="nb-dlg-row"><span class="hl-chip hl-${c}" aria-hidden="true"></span><span class="nb-dlg-c">${HL_NAMES[c]}</span>
              <input type="text" data-c="${c}" maxlength="40" placeholder="e.g. ${HL_SUGGEST[c]}" value="${esc(names[c])}"></label>`).join("")}
            <div class="mark-actions">
              <button value="save" class="mark-save">Save</button>
              <button value="cancel" class="mark-cancel">Cancel</button>
            </div>
          </form>
        </dialog>
      </article>`;
    const q = app.querySelector(".nb-q");
    q.addEventListener("input", () => { clearTimeout(nbTimer); nbTimer = setTimeout(() => { NB.q = q.value; nbDraw(); }, 150); });
    const more = app.querySelector(".nb-more"), filters = app.querySelector(".nb-filters");
    more.addEventListener("click", () => {
      const open = !filters.classList.contains("is-open");
      filters.classList.toggle("is-open", open);
      more.setAttribute("aria-expanded", String(open));
    });
    app.querySelectorAll(".nb-chip").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.k, on = !NB.kinds.includes(k);
      NB.kinds = on ? NB.kinds.concat(k) : NB.kinds.filter((x) => x !== k);
      b.setAttribute("aria-pressed", String(on));
      nbDraw();
    }));
    app.querySelector(".nb-only").addEventListener("change", (e) => { NB.notesOnly = e.target.checked; nbDraw(); });
    app.querySelector(".nb-text").addEventListener("change", (e) => { NB.text = e.target.value; nbDraw(); });
    app.querySelector(".nb-sort").addEventListener("change", (e) => { NB.sort = e.target.value; nbDraw(); });
    const dlg = app.querySelector(".nb-dialog");
    app.querySelector(".nb-name").addEventListener("click", () => {
      dlg.querySelectorAll("input").forEach((x) => { x.value = hlMeanings()[x.dataset.c]; });
      dlg.returnValue = "";
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    });
    dlg.addEventListener("close", () => {
      if (dlg.returnValue !== "save") return;
      const out = {};
      dlg.querySelectorAll("input").forEach((x) => { if (x.value.trim()) out[x.dataset.c] = x.value.trim().slice(0, 40); });
      writeStore(HL_NAMES_KEY, out);
      const now = hlMeanings();
      app.querySelectorAll(".nb-chip .nb-chip-t").forEach((t) => { t.textContent = nbKindName(t.parentNode.dataset.k, now); });
      nbDraw();
      app.querySelector(".nb-name").focus();
    });
    const dl = app.querySelector(".nb-dl");
    dl.addEventListener("keydown", (e) => { if (e.key === "Escape" && dl.open) { dl.open = false; dl.querySelector("summary").focus(); } });
    dl.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => {
      dl.open = false;
      const how = b.dataset.dl;
      NB_READY.then(() => {
        const list = nbShown(), t = new Date();
        const day = [t.getFullYear(), t.getMonth() + 1, t.getDate()].map((x) => String(x).padStart(2, "0")).join("-");
        if (how === "print") window.print();
        else if (how === "md") downloadFile(`poetry-codex-notes-${day}.md`, "text/markdown", nbMarkdown(list));
        else downloadFile(`poetry-codex-notes-${day}.html`, "text/html", nbWordHTML(list));
      });
    }));
    nbStickyTop();
    nbLoad();
  }
  // The marks again (on opening the page, and when the account's copy comes in), then each
  // text, after which the list is drawn again with lines and citations.
  function nbLoad() {
    NB_ITEMS = nbItems();
    NB_ITEMS.forEach((it) => { nbPlace(it, null); it.where = nbWhere(it); });
    const here = location.hash, items = NB_ITEMS;
    nbDraw(true);
    NB_READY = Promise.all([...new Set(items.map((it) => it.tid))].map((tid) => nbText(tid).then((tx) => {
      items.filter((it) => it.tid === tid).forEach((it) => { nbPlace(it, tx); it.where = nbWhere(it); });
    }))).then(() => {
      if (location.hash === here && NB_ITEMS === items && app.querySelector(".nb-out")) nbDraw();
    });
  }
  function nbDraw(waiting) {
    const out = app.querySelector(".nb-out");
    if (!out) return;
    const names = hlMeanings();
    // The "Text" choice: each work or poet, and under it each book or poem.
    const sel = app.querySelector(".nb-text");
    const groups = nbGroups(NB_ITEMS);
    if (NB.text && !NB_ITEMS.some((it) => it.tid === NB.text || it.where.top === NB.text)) NB.text = "";
    sel.innerHTML = `<option value="">All texts</option>` + groups.map((t) => `<option value="${esc(t.key)}">${esc(t.title)}</option>`
      + (t.subs.length > 1 || t.key.startsWith("poet:") ? t.subs.map((s) => `<option value="${esc(s.tid)}"> ${esc(s.title)}</option>`).join("") : "")).join("");
    sel.value = NB.text;
    const list = nbShown();
    const total = NB_ITEMS.length, n = list.length;
    const marked = (k) => `${num(k)} ${k === 1 ? "highlight or note" : "highlights and notes"}`;
    const filt = nbFilterWords(names);
    app.querySelector(".nb-count").textContent = (n === total ? marked(total) : `${num(n)} of ${marked(total)}: ${filt}`)
      + (waiting ? ". Finding each one in its text…" : "");
    const active = NB.kinds.length + (NB.notesOnly ? 1 : 0) + (NB.text ? 1 : 0);
    app.querySelector(".nb-more").textContent = active ? `Filters (${active})` : "Filters";
    if (!n) {
      out.innerHTML = `<p class="nb-none">Nothing matches these filters. <button type="button" class="nb-clear">Show everything</button></p>`;
      out.querySelector(".nb-clear").addEventListener("click", () => {
        Object.assign(NB, { q: "", kinds: [], notesOnly: false, text: "" });
        app.querySelector(".nb-q").value = "";
        app.querySelector(".nb-only").checked = false;
        app.querySelectorAll(".nb-chip").forEach((b) => b.setAttribute("aria-pressed", "false"));
        nbDraw();
        app.querySelector(".nb-q").focus();
      });
      return;
    }
    if (NB.sort === "date") {
      out.innerHTML = `<ul class="nb-list">${list.slice().sort((x, y) => String(y.when).localeCompare(String(x.when)))
        .map((it) => nbItemHTML(it, names, true)).join("")}</ul>`;
      return;
    }
    out.innerHTML = nbGroups(list).map((t) => `
      <section class="nb-group">
        <h2 class="nb-top">${esc(t.title)}${t.by ? ` <span class="nb-top-by">${esc(t.by)}</span>` : ""}</h2>
        ${t.subs.map((s) => `
          ${s.title && s.title !== t.title ? `<h3 class="nb-sub"><a href="${esc(routeFor(s.tid))}">${esc(s.title)}</a></h3>` : ""}
          <ul class="nb-list">${s.items.map((it) => nbItemHTML(it, names, false)).join("")}</ul>`).join("")}
      </section>`).join("");
  }
  // Above 780px the top bar sticks, and the filter bar sticks just under it.
  function nbStickyTop() {
    const bar = app.querySelector(".nb-bar"), head = document.querySelector(".site-head");
    if (bar) bar.style.setProperty("--nb-top", (head && getComputedStyle(head).position === "sticky" ? head.offsetHeight : 0) + "px");
  }
  window.addEventListener("resize", () => { if (app.querySelector(".nb-bar")) nbStickyTop(); });
  document.addEventListener("click", (e) => {
    const d = document.querySelector(".nb-dl[open]");
    if (d && !d.contains(e.target)) d.open = false;
  });
  // The MLA entry for one item: at its lines when they are known, else the text's address.
  function nbCite(it) {
    const tx = it.tx, g = it.g || {}, w = it.where, isWork = it.tid.startsWith("work:");
    const o = tx ? { author: tx.author, translator: tx.translator, src: tx.src,
        title: isWork ? (tx.one ? "" : tx.title) : tx.title, work: isWork ? tx.work : undefined }
      : { author: g.author, translator: g.translator, title: isWork ? (w.whole || w.subTitle === w.topTitle ? "" : w.subTitle) : g.title,
          work: isWork ? w.topTitle : undefined };
    o.path = it.range ? "/" + nbHref(it) : shelfPath(it.tid);
    if (it.range) o.loc = it.loc;
    return citations(o)[0];
  }
  const nbStanzas = (it) => (it.lines && !it.changed ? it.lines : [it.quote]).join("\n").split("\n\n").map((st) => st.split("\n"));
  const nbKindLabel = (it, names) => it.type === "hl" ? `Highlight, ${it.kind}${names[it.kind] ? ` (${names[it.kind]})` : ""}` : nbLabel(it, names);
  // A file Word and Google Docs open as a document: a heading for each text, the quotation
  // indented with its line breaks, the note, then the citation.
  function nbWordHTML(list) {
    const names = hlMeanings(), filt = nbFilterWords(names);
    const lineHTML = (l) => esc(l).replace(/^ +/, (s) => " ".repeat(s.length));
    const body = nbGroups(list).map((t) => `<h2>${esc(t.title)}${t.by ? ` <span class="by">— ${esc(t.by)}</span>` : ""}</h2>\n`
      + t.subs.map((s) => (s.title && s.title !== t.title ? `<h3>${esc(s.title)}</h3>\n` : "") + s.items.map((it) => {
        const c = nbCite(it);
        return `<p class="meta">${esc(nbKindLabel(it, names))}${it.loc ? " · " + esc(it.loc) : ""}</p>\n`
          + (it.type === "note" ? "" : `<blockquote>${nbStanzas(it).map((st) => `<p>${st.map(lineHTML).join("<br>")}</p>`).join("")}</blockquote>\n`)
          + (it.changed ? `<p class="meta">The text has changed since this was marked: these are the words as marked.</p>\n` : "")
          + (it.note.trim() ? `<p class="note">${esc(it.note.trim()).replace(/\n/g, "<br>")}</p>\n` : "")
          + `<p class="cite">${c.html}</p>\n`;
      }).join("")).join("")).join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>My notes and highlights · Poetry Codex</title>
<style>
body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.5; color: #000; max-width: 42em; margin: 2em auto; }
h1 { font-size: 20pt; font-weight: normal; margin: 0 0 4pt; }
h2 { font-size: 15pt; margin: 22pt 0 4pt; } h2 .by { font-weight: normal; font-size: 12pt; color: #444; }
h3 { font-size: 12.5pt; font-style: italic; font-weight: normal; margin: 14pt 0 4pt; }
p { margin: 0 0 6pt; } .intro { color: #444; font-size: 10.5pt; }
.meta { font-family: Arial, sans-serif; font-size: 9pt; color: #555; margin: 12pt 0 3pt; }
blockquote { margin: 0 0 6pt 0.5in; } blockquote p { margin: 0 0 6pt; }
.note { margin: 0 0 6pt 0.5in; } .cite { margin: 0 0 6pt 0.5in; font-size: 10.5pt; color: #333; }
</style></head><body>
<h1>My notes and highlights</h1>
<p class="intro">From Poetry Codex (poetrycodex.com), ${esc(shortDate(new Date().toISOString()))}${filt ? ". Only " + esc(filt) : ""}.</p>
${body}</body></html>`;
  }
  function nbMarkdown(list) {
    const names = hlMeanings(), filt = nbFilterWords(names);
    const md = (s) => String(s || "").replace(/([\\`*_[\]<>])/g, "\\$1");
    const mdCite = (h) => h.replace(/<\/?i>/g, "_").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return `# My notes and highlights\n\nFrom Poetry Codex (${SITE}), ${shortDate(new Date().toISOString())}${filt ? ". Only " + filt : ""}.\n\n`
      + nbGroups(list).map((t) => `## ${md(t.title)}${t.by ? " — " + md(t.by) : ""}\n\n`
        + t.subs.map((s) => (s.title && s.title !== t.title ? `### ${md(s.title)}\n\n` : "") + s.items.map((it) =>
          `*${md(nbKindLabel(it, names))}${it.loc ? " · " + it.loc : ""}*\n\n`
          + (it.type === "note" ? "" : nbStanzas(it).map((st) => st.map((l) => "> " + md(l).replace(/^ +/, (x) => " ".repeat(x.length))).join("  \n")).join("\n>\n") + "\n\n")
          + (it.changed ? "(The text has changed since this was marked: these are the words as marked.)\n\n" : "")
          + (it.note.trim() ? it.note.trim().split("\n").map(md).join("  \n") + "\n\n" : "")
          + mdCite(nbCite(it).html) + "\n\n").join("")).join("")).join("");
  }

  // ---------- "Return to your marks": the reader's own highlights, brought back ----------
  // On the home page (under "Continue reading", once there are three or more highlights or
  // line notes) and at the top of #/notes, one passage the reader marked comes back: its lines,
  // their note, where it stands and "Go to" (?l=). "Test me" hides its last word (its last line,
  // when it runs to several) until it is tapped. "Got it" brings it back later, "Again soon"
  // tomorrow: steps of 1, 3, 7, 16, 35 and 90 days, kept on the mark itself as rv: {due, step,
  // at} in pc-marks, so it follows a signed-in reader with no change to the Worker (MERGE.marks
  // takes the later of a mark's edit and its review). A new mark is first due two days after it
  // was made. Due passages come oldest first, at most three a day ("Another"); when nothing is
  // due the card is not there at all. "Hide this card" and its way back (on #/notes) and the
  // day's passages are kept in this browser only (pc-prefs). No counts, streaks or reminders.
  const RV_STEPS = [1, 3, 7, 16, 35, 90];
  const RV_PER_DAY = 3;
  const dayKey = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((x) => String(x).padStart(2, "0")).join("-");
  const addDays = (day, n) => { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() + n); return dayKey(d); };
  function rvDue(m) {
    if (m.rv && /^\d{4}-\d\d-\d\d$/.test(m.rv.due)) return m.rv.due;
    const made = new Date(m.created || m.updated || Date.now());
    return addDays(dayKey(isNaN(made) ? new Date() : made), 2);
  }
  // Today's passages so far: {day, seen: [item keys]}, the last one the passage on the card.
  function rvToday() {
    const r = prefs().review, day = dayKey(new Date());
    return r && r.day === day && Array.isArray(r.seen) ? r : { day, seen: [] };
  }
  // The highlights and line notes due today, oldest due first (then the oldest made).
  function rvDueItems() {
    const today = dayKey(new Date());
    return nbItems().filter((it) => it.type !== "note" && rvDue(it.m) <= today)
      .sort((x, y) => rvDue(x.m).localeCompare(rvDue(y.m)) || String(x.when).localeCompare(String(y.when)));
  }
  // The passage to show: the one on the card if it is still unanswered, else the next unseen
  // one while the day has room. another: skip the one on the card.
  function rvPick(another) {
    const st = rvToday(), due = rvDueItems(), last = st.seen[st.seen.length - 1];
    const cur = !another && last ? due.find((it) => it.key === last) : null;
    if (cur) return cur;
    if (st.seen.length >= RV_PER_DAY) return null;
    return due.find((it) => !st.seen.includes(it.key)) || null;
  }
  const rvHasAnother = () => rvToday().seen.length < RV_PER_DAY && rvDueItems().some((it) => !rvToday().seen.includes(it.key));
  // The empty place for the card, filled once the page is drawn (see the observer below).
  function reviewSlotHTML(where) {
    if (where === "home" && (prefs().reviewOff || markCount() < 3)) return "";
    if (where === "notes" && prefs().reviewOff) return `
        <p class="rv-off" data-rv-off>The “Return to your marks” card is hidden.
          <button type="button" class="rv-back">Show it again</button></p>`;
    return `<section class="rv" data-rv="${where}" aria-labelledby="rv-h" hidden></section>`;
  }
  // The passage's lines as nb-quote draws them; with test, the last word (or line) a blank.
  function rvQuoteHTML(it, test) {
    const ls = (it.lines && !it.changed ? it.lines : [it.quote]).slice();
    let k = ls.length - 1;
    while (k > 0 && !ls[k].trim()) k--;
    const several = ls.filter((l) => l.trim()).length > 1;
    const blank = (word, what) => `<button type="button" class="rv-blank" data-word="${esc(word)}" aria-label="${what}, show it"
      style="width:${Math.max(3, Array.from(word).length)}ch"></button>`;
    const lineHTML = (l, j) => {
      if (!l) return `<span class="nb-gap"></span>`;
      if (!test || j !== k) return `<span class="nb-l">${esc(l)}</span>`;
      if (several) { const lead = /^\s*/.exec(l)[0]; return `<span class="nb-l">${esc(lead)}${blank(l.trim(), "hidden line")}</span>`; }
      const m = /([\p{L}\p{M}\p{N}'’-]+)([^\p{L}\p{M}\p{N}]*)$/u.exec(l);
      if (!m) return `<span class="nb-l">${esc(l)}</span>`;
      return `<span class="nb-l">${esc(l.slice(0, m.index))}${blank(m[1], "hidden word")}${esc(m[2])}</span>`;
    };
    const tx = it.tx, lang = tx ? langAttr(tx.authorSlug, tx.translator) : "";
    return `<blockquote class="nb-quote${tx && tx.prose ? " is-prose" : ""}"${lang}>${ls.map(lineHTML).join("")}</blockquote>`;
  }
  // Fills a card (or says the day is done): fetches the passage's text, as #/notes does, for
  // its lines and its "Go to".
  function fillReview(box, it, focus) {
    box.dataset.filled = "1";
    if (!it) {
      if (!focus) { box.remove(); return; }
      box.innerHTML = `<p class="rv-done" tabindex="-1">That is all for today. Your marks will come back on another day.</p>`;
      box.hidden = false;
      box.querySelector(".rv-done").focus();
      return;
    }
    const st = rvToday();
    if (!st.seen.includes(it.key)) setPrefs({ review: { day: st.day, seen: st.seen.concat(it.key).slice(-RV_PER_DAY) } });
    nbPlace(it, null);
    nbText(it.tid).then((tx) => {
      if (!box.isConnected) return;
      nbPlace(it, tx);
      it.where = nbWhere(it);
      drawReview(box, it, false, focus);
    });
  }
  function drawReview(box, it, test, focus) {
    const w = it.where, g = it.g || {};
    const src = w.top.startsWith("work:") ? [w.subTitle !== w.topTitle && !w.whole ? w.subTitle : "", w.topTitle].filter(Boolean).join(" · ")
      : w.subTitle;
    const by = w.top.startsWith("work:") ? (it.tx ? it.tx.author : g.author) : w.topTitle;
    const step = it.m.rv && Number.isInteger(it.m.rv.step) ? it.m.rv.step : 0;
    const next = RV_STEPS[Math.min(RV_STEPS.length - 1, step + 1)];
    box.innerHTML = `
      <div class="rv-head">
        <h2 class="rv-h" id="rv-h" tabindex="-1">Return to your marks</h2>
        <button type="button" class="continue-forget rv-hide">Hide this card</button>
      </div>
      <div class="rv-body nb-k-${esc(it.kind)}">${rvQuoteHTML(it, test)}</div>
      ${it.note.trim() ? `<p class="rv-note">${esc(it.note)}</p>` : ""}
      <p class="rv-src"><span class="rv-title">${esc(src)}</span>${by ? ` · ${esc(by)}` : ""}
        <a class="rv-go" href="${esc(nbHref(it))}">${it.range ? "Go to " + esc(it.loc) : "Go to the text"}<span class="visually-hidden"> in ${esc(w.subTitle)}</span> <span aria-hidden="true">→</span></a></p>
      <div class="rv-actions">
        <button type="button" class="rv-test" aria-pressed="${test}">Test me</button>
        <button type="button" class="rv-again" aria-label="Again soon: bring this passage back tomorrow">Again soon</button>
        <button type="button" class="rv-got" aria-label="Got it: bring this passage back in ${next} days">Got it</button>
        ${rvHasAnother() ? `<button type="button" class="rv-another" aria-label="Another passage">Another</button>` : ""}
      </div>`;
    box.hidden = false;
    if (focus) box.querySelector(focus === "test" ? ".rv-test" : ".rv-h").focus();
    box.querySelectorAll(".rv-blank").forEach((b) => b.addEventListener("click", () => {
      b.textContent = b.dataset.word;
      b.classList.add("is-shown");
      b.removeAttribute("aria-label");
      b.removeAttribute("style");
    }));
    box.querySelector(".rv-test").addEventListener("click", () => drawReview(box, it, !test, "test"));
    box.querySelector(".rv-again").addEventListener("click", () => { rvAnswer(it, false); fillReview(box, rvPick(), true); });
    box.querySelector(".rv-got").addEventListener("click", () => { rvAnswer(it, true); fillReview(box, rvPick(), true); });
    const more = box.querySelector(".rv-another");
    if (more) more.addEventListener("click", () => fillReview(box, rvPick(true), true));
    box.querySelector(".rv-hide").addEventListener("click", () => {
      setPrefs({ reviewOff: true });
      if (box.dataset.rv === "notes") {          // on #/notes its way back takes its place
        const t = document.createElement("template");
        t.innerHTML = reviewSlotHTML("notes").trim();
        const off = t.content.firstChild;
        box.replaceWith(off);
        off.querySelector(".rv-back").focus();
        return;
      }
      box.innerHTML = `<p class="rv-done" tabindex="-1">Card hidden. You can bring it back from
        <a href="#/notes">My notes and highlights</a>.</p>`;
      box.querySelector(".rv-done").focus();
    });
  }
  // Moves the mark one step on ("Got it") or back to the first ("Again soon").
  function rvAnswer(it, got) {
    const marks = allMarks(), g = marks[it.tid];
    const m = g && (g.items || []).find((x) => x.id === it.m.id);
    if (!m) return;
    const was = m.rv && Number.isInteger(m.rv.step) ? m.rv.step : 0;
    const step = got ? Math.min(RV_STEPS.length - 1, was + 1) : 0;
    m.rv = { due: addDays(dayKey(new Date()), RV_STEPS[step]), step, at: new Date().toISOString() };
    writeStore(MARKS_KEY, { v: 1, marks });
    announce(got ? `It will come back in ${RV_STEPS[step]} days.` : "It will come back tomorrow.");
  }
  // Whenever a page with an empty card place is drawn (the home page has three ways of being
  // drawn: early, from the index, and on a route), the card is filled.
  new MutationObserver(() => {
    const box = app.querySelector(".rv[data-rv]:not([data-filled])");
    if (box) fillReview(box, rvPick(), false);
  }).observe(app, { childList: true, subtree: true });
  app.addEventListener("click", (e) => {
    const b = e.target.closest(".rv-back");
    if (!b) return;
    setPrefs({ reviewOff: false });
    const p = b.closest("[data-rv-off]"), it = rvPick();
    if (it) {
      const t = document.createElement("template");
      t.innerHTML = reviewSlotHTML("notes").trim();
      const box = t.content.firstChild;
      box.dataset.filled = "1";        // filled here, with the focus on its heading
      p.replaceWith(box);
      fillReview(box, it, true);
    }
    else {
      p.innerHTML = "The card is back. It will appear on the home page when a passage you marked is due.";
      p.tabIndex = -1; p.focus();
    }
  });


  // ---------- THE ORACLE ----------
  // Kept at module scope so leaving the page and coming back does not throw
  // the conversation away.
  let ORACLE_MSGS = [];          // [{role, content, searches?}]

  const ORACLE_OPENERS = [
    "Recommend me poems about nature, epic and heroes.",
    "I have never read poetry before. Where should I start?",
    "What makes a sonnet a sonnet?",
    "Which poem in this archive is the strangest?",
  ];

  // Escapes everything, then allows exactly three things back: bold, italic,
  // and links whose href is an internal route. Nothing else from the model
  // reaches the page as markup.
  function renderMarkdown(text) {
    let out = esc(text);
    out = out.replace(/\[([^\]\n]+)\]\(#\/([A-Za-z0-9\/_\-]+)\)/g,
      (m, label, href) => `<a href="#/${href}">${label}</a>`);
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return out.split(/\n{2,}/).filter(Boolean)
      .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`).join("");
  }

  // The searches behind an answer, kept visible. An archive's credibility
  // rests on being able to see what was looked up.
  function searchTrail(searches) {
    if (!searches || !searches.length) return "";
    return `<details class="o-trail"><summary>Searched the archive &middot; ${searches.length}
      ${searches.length === 1 ? "query" : "queries"}</summary>
      <p>${searches.map((q) => `<span>${esc(q)}</span>`).join("")}</p></details>`;
  }

  function oracleBubble(m) {
    return m.role === "user"
      ? `<div class="o-turn o-you"><blockquote class="o-q">${esc(m.content)}</blockquote></div>`
      : `<div class="o-turn o-codex"><div class="o-mark"><img src="oracle-248.webp" alt="" width="34" height="34" /></div>
         <div class="o-body">${renderMarkdown(m.content)}${searchTrail(m.searches)}</div></div>`;
  }

  function contextChip() {
    if (!ORACLE_CONTEXT) return "";
    return `<div class="o-context">
      <span class="oc-label">Reading</span>
      <span class="oc-title">${esc(ORACLE_CONTEXT.title)}</span>
      <span class="oc-by">${esc(ORACLE_CONTEXT.author)}</span>
      <button class="oc-clear" title="Ask about the whole archive instead">&times;</button>
    </div>`;
  }

  function renderOracleResting() {
    setTitle("The Oracle");
    app.innerHTML = `
      <section class="oracle">
        <header class="oracle-head">
          <img class="oracle-coin is-resting" src="oracle-248.webp" alt="Silver tetradrachm of Alexander the Great" />
          <h1>The Oracle</h1>
          <p>The Oracle is resting. It will answer again soon.</p>
        </header>
        <div class="o-resting">
          <p>The Oracle reads the archive and answers questions about it \u2014 which poem to
          start with, how a form works, what a period was arguing about. It is paused for
          the moment.</p>
          <p>Everything else is open: <a href="#/poems">${DATA.count.toLocaleString("en-US")} poems</a> by
          <a href="#/poets">poets of every age</a>, arranged
          <a href="#/eras">by era</a>, every one of them free to read.</p>
        </div>
      </section>`;
  }

  function renderOracle() {
    if (!ORACLE_LIVE) return renderOracleResting();
    setTitle("The Oracle");
    const empty = !ORACLE_MSGS.length;
    app.innerHTML = `
      <section class="oracle">
        <header class="oracle-head">
          <img class="oracle-coin" src="oracle-248.webp" alt="Silver tetradrachm of Alexander the Great" />
          <h1>The Oracle</h1>
          <p>Ask anything about poetry, or about what this archive holds. The Oracle
          searches the collection before it answers, and links to what it finds.</p>
        </header>
        ${contextChip()}
        ${empty ? `<div class="o-openers">${ORACLE_OPENERS.map((q) =>
          `<button class="o-opener">${esc(q)}</button>`).join("")}</div>` : ""}
        <div class="o-thread" id="o-thread">${ORACLE_MSGS.map(oracleBubble).join("")}</div>
        <form class="o-composer" autocomplete="off">
          <textarea class="o-input" rows="1" maxlength="2000"
                    placeholder="Ask the Oracle\u2026" aria-label="Ask the Oracle"></textarea>
          <button class="o-send" type="submit">Ask</button>
        </form>
        <p class="ask-hint">Press Enter to ask \u00b7 Shift + Enter for a new line \u00b7
        Answers are generated, and the archive ends where copyright begins.</p>
      </section>`;

    const thread = document.getElementById("o-thread");
    const form = app.querySelector(".o-composer");
    const input = app.querySelector(".o-input");
    const send = app.querySelector(".o-send");
    let running = false;

    const clear = app.querySelector(".oc-clear");
    if (clear) clear.addEventListener("click", () => { ORACLE_CONTEXT = null; renderOracle(); });

    // The composer grows with the question, up to a point.
    function grow() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 260) + "px";
    }
    input.addEventListener("input", grow);
    grow();
    input.focus();

    app.querySelectorAll(".o-opener").forEach((b) =>
      b.addEventListener("click", () => { input.value = b.textContent; grow(); ask(); }));

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
    });
    form.addEventListener("submit", (e) => { e.preventDefault(); ask(); });

    async function ask() {
      const question = input.value.trim();
      if (!question || running) return;
      running = true;
      input.value = ""; grow();
      input.disabled = true; send.disabled = true;
      const openers = app.querySelector(".o-openers");
      if (openers) openers.remove();

      ORACLE_MSGS.push({ role: "user", content: question });
      thread.insertAdjacentHTML("beforeend", oracleBubble(ORACLE_MSGS[ORACLE_MSGS.length - 1]));
      thread.insertAdjacentHTML("beforeend",
        `<div class="o-turn o-codex" id="o-live"><div class="o-mark"><img src="oracle-248.webp" alt="" width="34" height="34" /></div>
         <div class="o-body"><p class="o-status">Consulting the archive\u2026</p></div></div>`);
      const live = document.getElementById("o-live").querySelector(".o-body");
      live.scrollIntoView({ behavior: "smooth", block: "end" });

      const searches = [];
      let prose = "";
      try {
        const payload = { messages: ORACLE_MSGS.map((m) => ({ role: m.role, content: m.content })) };
        if (ORACLE_CONTEXT) {
          payload.context = {
            title: ORACLE_CONTEXT.title, author: ORACLE_CONTEXT.author,
            text: ORACLE_CONTEXT.text,
          };
        }
        const res = await fetch(ENGINE_URL + "/api/oracle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok || !res.body) {
          const info = await res.json().catch(() => ({}));
          throw new Error(info.error || "The Oracle could not answer.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const chunk = line.slice(6);
            if (chunk === "[DONE]") continue;
            let msg;
            try { msg = JSON.parse(chunk); } catch { continue; }
            if (msg.error) throw new Error(msg.error);
            if (msg.searching) {
              if (searches.indexOf(msg.searching) < 0) searches.push(msg.searching);
              if (!prose) {
                live.innerHTML = `<p class="o-status">Searching the archive for \u201c${esc(msg.searching)}\u201d\u2026</p>`;
              }
              continue;
            }
            prose += msg.t || "";
            if (prose) live.innerHTML = renderMarkdown(prose) + searchTrail(searches);
          }
        }
        if (!prose.trim()) throw new Error("The Oracle had nothing to say. Please try again.");
        ORACLE_MSGS.push({ role: "assistant", content: prose, searches });
      } catch (err) {
        live.innerHTML = `<p class="o-error">${esc(err.message || "The Oracle could not answer.")}</p>`;
        ORACLE_MSGS.pop();                       // drop the unanswered question
      } finally {
        const node = document.getElementById("o-live");
        if (node) node.removeAttribute("id");
        running = false;
        input.disabled = false; send.disabled = false;
        input.focus();
      }
    }
  }

  // ---------- POEM DETAIL ----------
  // id format: "<authorSlug>/<n>" where n is the poem's index within that
  // poet's own poems array (stable across content edits to OTHER poets).
  function renderDetail(slug, n) {
    if (DATA && !POETS[slug]) { location.hash = "#/"; return; }
    if (EARLY_DRAWN !== location.hash) renderLoading();   // a page drawn before the index is redrawn in place
    const requestedHash = location.hash;
    Promise.all([loadPoemPage(slug, n), fetchParallel()]).then(([poetFile]) => {
      if (location.hash !== requestedHash) return null; // route changed while fetching
      const p = poetFile.poems[n];
      if (!p) { location.hash = "#/poet/" + slug; return null; }
      // A reader who keeps facing pages on gets them at once: the other text comes first.
      // With several to choose from, all of them (their buttons are named from them when
      // the index is not in; they are short and mostly in the same shard).
      const list = parList("poems", p.id), pick = parPick(list, p.id);
      const want = list.length > 1 && !DATA ? list.map((e) => e.with) : pick ? [pick.with] : [];
      return Promise.all(want.map((id) => loadPartner("poem", id).catch(() => null))).then(() => {
        if (location.hash === requestedHash) renderDetailReady(poetFile, slug, n, p);
      });
    }).catch((e) => { if (location.hash === requestedHash) renderFetchError(e); });
  }
  // Everything the Codex can be pointed at: every poem, and every section of
  // every work. Built once, on first use.
  let ASK_ITEMS = null;
  function askItems() {
    if (ASK_ITEMS || !DATA) return ASK_ITEMS || [];
    ASK_ITEMS = DATA.poems.map((p) => ({
      id: p.id,
      label: p.title,
      author: p.author,
      lab: fold(p.title),
      hay: fold(p.title + " " + p.author),
    }));
    (DATA.works || []).forEach((w) => {
      (w.sections || []).forEach((sec, i) => {
        ASK_ITEMS.push({
          id: "work:" + w.slug + "/" + i,
          label: w.title + " \u00b7 " + sec.title,
          author: w.author,
          lab: fold(w.title + " · " + sec.title),
          hay: fold(w.title + " " + sec.title + " " + w.author),
        });
      });
    });
    return ASK_ITEMS;
  }

  // Where an ask-item lives.
  function routeFor(id) {
    return id.startsWith("work:")
      ? "#/work/" + id.slice(5)
      : "#/poem/" + id;
  }

  // The full text behind an ask-item, fetched on demand.
  function loadPiece(id) {
    if (id.startsWith("work:")) {
      const cut = id.lastIndexOf("/");
      const slug = id.slice(5, cut);
      const i = Number(id.slice(cut + 1));
      return fetchWorkFile(slug).then((w) => {
        const sec = w.sections[i];
        return sec && { title: w.title + " \u00b7 " + sec.title, author: w.author, text: sec.text };
      });
    }
    const parts = id.split("/");
    return fetchPoetFile(parts[0]).then((f) => {
      const po = f.poems[Number(parts[1])];
      return po && { title: po.title, author: po.author, text: po.text };
    });
  }

  // Type-ahead over poems and work sections. Title matches beat author
  // matches, and a title that starts with the query beats one that merely
  // contains it, so "paradise lost" leads with the poem of that name.
  function attachPoemPicker(input, hits, onPick, excludeId) {
    const close = () => { hits.hidden = true; hits.innerHTML = ""; };
    // The titles to pick from are the index's: a poem page drawn without it asks for it when
    // the reader comes to this box, and looks again when it is in.
    input.addEventListener("focus", loadIndex);
    let waiting = false;

    input.addEventListener("input", function search() {
      onPick(null);
      const q = fold(input.value.trim());
      if (q.length < 3) return close();
      if (!DATA) {
        loadIndex();
        hits.innerHTML = `<li class="hits-wait">${INDEX_ERROR ? "The list of titles could not be loaded." : "Loading the archive’s titles…"}</li>`;
        hits.hidden = false;
        if (!waiting && !INDEX_ERROR) {
          waiting = true;
          whenIndex(() => { waiting = false; if (document.activeElement === input && input.value.trim()) search(); });
        }
        return;
      }
      const scored = [];
      for (const it of askItems()) {
        if (it.id === excludeId) continue;
        let score;
        if (it.lab.startsWith(q)) score = 0;
        else if (it.lab.includes(q)) score = 1;
        else if (it.hay.includes(q)) score = 2;
        else continue;
        scored.push([score, it]);
        if (scored.length > 400) break;          // enough to rank well
      }
      if (!scored.length) return close();
      scored.sort((a, b) => a[0] - b[0]);
      const found = scored.slice(0, 8).map((x) => x[1]);
      hits.innerHTML = found.map((it) =>
        `<li data-id="${esc(it.id)}"><strong>${esc(it.label)}</strong> <span>${esc(it.author)}</span></li>`).join("");
      hits.hidden = false;
    });

    // mousedown, not click: blur would close the list first.
    hits.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (!li || !li.dataset.id) return;
      const it = askItems().find((x) => x.id === li.dataset.id);
      if (it) { input.value = it.label + " \u2014 " + it.author; onPick(it); }
      close();
    });

    input.addEventListener("blur", () => setTimeout(close, 140));
  }

  // The gloss button has to find Chaucer, Gower, Langland and Wyatt without
  // firing on Shakespeare or Spenser, whose spelling is old but readable.
  // Measured over the archive, Middle English texts score 9-59 hits per
  // thousand words on this vocabulary and early modern verse scores 0-1.6,
  // so the threshold sits in the gap.
  const ARCHAIC_WORDS = /\b(whan|swich|eek|nat|wol|quod|yclept|y-\w+|by-\w+|sithen|thilke|hire|nys|seyde|clepe[dn]?|licour|swoot|yern|mountaigne|leere|lynnen|aprilis|holt|heeth|croppes|yonge|sonne|halwes|ferne|straunge|sondry|corages|smale|foweles|slepen|nyght|eyen|bifil|wende[n]?|thanne|everich|certes|natheles|wight(?:es)?|sooth|ywis|parde|nolde|moot|mote|hadde|wolde|sholde|coude|seith|goth|doun|agayn|oother|peple|erthe|wordes|dayes|bettre|werk(?:es)?|icumen|ilast|iwis|lhude|cuccu|wude|fugheles|michel|nicht|hwil|mirie|murie|necheth|springth|groweth|bloweth|claymeth|longeth|saufly|noght|yeve|yede|consayl|rightwis|dedes|enclyne|determyne|vertu|vyces|gentilesse|trewe|soughte|herde|restles|complaininge)\b/gi;
  const ARCHAIC_PER_1000 = 5;
  function looksArchaic(text) {
    const sample = text.slice(0, 4000);
    if (/[\u00e6\u00fe\u00f0]/.test(sample)) return true;   // ash, thorn, eth
    const words = Math.max(sample.split(/\s+/).length, 1);
    return (sample.match(ARCHAIC_WORDS) || []).length / words * 1000 >= ARCHAIC_PER_1000;
  }

  // Markup for the critical-engine panel; empty while ENGINE_URL is unset.
  // opts.gloss adds the modern-English button (only where the text is archaic),
  // opts.compare the second-poem picker.
  function enginePanel(text, opts) {
    if (!ENGINE_URL) return "";
    const o = opts || {};
    const gloss = o.gloss && looksArchaic(text)
      ? `<button class="lens lens-alt" data-gloss="1">Modern English</button>` : "";
    const compare = o.compare ? `
      <form class="ask-form compare-form" autocomplete="off">
        <input class="ask-input compare-input" type="text" maxlength="120"
               placeholder="Compare with another poem\u2026" aria-label="Compare with another poem" />
        <button class="ask-send" type="submit">Compare</button>
        <ul class="compare-hits" hidden></ul>
      </form>` : "";
    return `
      <button class="engine-cue" type="button" aria-expanded="false">
        <span class="ec-mark">\u25c8</span>
        <span class="ec-label">Read with the Codex</span>
        <span class="ec-hint">Eight critical traditions, or a question of your own</span>
        <span class="ec-go">Open \u25be</span>
      </button>
      <section class="engine" hidden>
      <p class="section-label">Read with the Codex</p>
      <p class="engine-intro">Choose a critical tradition, or ask a question of your own.
      Readings are generated, and are meant to open an argument rather than settle one.</p>
      <div class="lens-row">${LENSES.map((l) =>
        `<button class="lens" data-lens="${esc(l.id)}">${esc(l.label)}</button>`).join("")}${gloss}</div>
      <form class="ask-form" autocomplete="off">
        <textarea class="ask-input" rows="3" maxlength="400"
                  placeholder="Ask the Codex about this poem \u2014 what it means, how it works, what a critic would say\u2026"
                  aria-label="Ask the Codex about this poem"></textarea>
        <button class="ask-send" type="submit">Ask</button>
      </form>
      <p class="ask-hint">Press Enter to ask \u00b7 Shift + Enter for a new line</p>
      ${compare}
      <div class="engine-out" id="engine-out" hidden></div>
      ${ORACLE_LIVE ? `<p class="engine-more">Or <button class="to-oracle" type="button">take this poem to the Oracle</button>
      for a longer conversation.</p>` : ""}
      </section>`;
  }

  // `piece` is {title, author, text, id?} - a poem, or one section of a work.
  function bindEngine(piece) {
    if (!ENGINE_URL) return;
    const out = document.getElementById("engine-out");
    const buttons = Array.from(app.querySelectorAll(".lens"));
    const askForm = app.querySelector(".ask-form:not(.compare-form)");
    const askInput = askForm.querySelector(".ask-input");
    const cmpForm = app.querySelector(".compare-form");
    const fields = Array.from(app.querySelectorAll(".ask-input, .ask-send"));
    let running = false;

    function setBusy(busy) {
      running = busy;
      buttons.forEach((b) => { b.disabled = busy; });
      fields.forEach((f) => { f.disabled = busy; });
    }

    // Streams one reading, answer, gloss or comparison into #engine-out.
    async function run(path, payload, credit, label) {
      if (running) return;
      setBusy(true);
      out.hidden = false;
      out.className = "engine-out is-loading";
      out.textContent = "Reading\u2026";
      let prose = "";
      let saved = false;     // the Worker replayed a stored reading ({cached: true})

      try {
        const res = await fetch(ENGINE_URL + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign(
            { title: piece.title, author: piece.author, text: piece.text }, payload)),
        });
        if (!res.ok || !res.body) {
          const info = await res.json().catch(() => ({}));
          throw new Error(info.error || "The reading could not be completed.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();                       // keep the partial last line
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const chunk = line.slice(6);
            if (chunk === "[DONE]") continue;
            let msg;
            try { msg = JSON.parse(chunk); } catch { continue; }
            if (msg.error) throw new Error(msg.error);
            if (msg.cached) saved = true;
            prose += msg.t || "";
            out.className = "engine-out" + (path === "/api/gloss" ? " is-gloss" : "");
            out.innerHTML = prose.split(/\n{2,}/).filter(Boolean)
              .map((para) => `<p>${esc(para)}</p>`).join("")
              + `<p class="engine-credit">${esc(credit)}${saved
                ? ` <span class="engine-saved" title="Written for an earlier reader and kept: everyone who asks for this reading gets the same text.">Saved reading</span>`
                : ""}</p>`;
          }
        }
        recordReading(piece, path, label || "", prose);
      } catch (err) {
        out.className = "engine-out is-error";
        out.textContent = err.message || "The reading could not be completed.";
      } finally {
        setBusy(false);
      }
    }

    buttons.forEach((btn) => btn.addEventListener("click", () => {
      if (running) return;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      askInput.value = "";
      if (btn.dataset.gloss) {
        // Mirrors MAX_GLOSS_CHARS in the Worker.
        const partial = piece.text.length > 6000;
        run("/api/gloss", {}, partial
          ? "Modern-English gloss of the opening lines, generated by the Poetry Codex critical engine."
          : "Modern-English gloss, generated by the Poetry Codex critical engine.", "Modern-English gloss");
      } else {
        run("/api/analyze", { lens: btn.dataset.lens },
            btn.textContent + " reading, generated by the Poetry Codex critical engine.", btn.textContent + " reading");
      }
    }));

    askInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askForm.requestSubmit(); }
    });

    askForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = askInput.value.trim();
      if (!question || running) return;
      buttons.forEach((b) => b.classList.remove("active"));
      run("/api/ask", { question },
          "In answer to: \u201c" + question + "\u201d \u2014 generated by the Poetry Codex critical engine.", question);
    });

    const panel = app.querySelector(".engine");
    const cue = app.querySelector(".engine-cue");
    if (cue) cue.addEventListener("click", () => {
      const open = !panel.hidden;
      panel.hidden = open;
      cue.setAttribute("aria-expanded", String(!open));
      cue.querySelector(".ec-go").textContent = open ? "Open \u25be" : "Close \u25b4";
      if (!open) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    const toOracle = app.querySelector(".to-oracle");
    if (toOracle) toOracle.addEventListener("click", () => {
      ORACLE_CONTEXT = { id: piece.id, title: piece.title, author: piece.author, text: piece.text };
      location.hash = "#/oracle";
    });

    if (cmpForm) bindCompare(cmpForm, piece, run, () => running, buttons);
  }

  // Compare box: same picker, then the chosen poem's full text.
  function bindCompare(form, piece, run, isRunning, buttons) {
    const input = form.querySelector(".compare-input");
    const hits = form.querySelector(".compare-hits");
    let chosen = null;
    attachPoemPicker(input, hits, (p) => { chosen = p; }, piece.id);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (isRunning() || !chosen) { input.focus(); return; }
      buttons.forEach((b) => b.classList.remove("active"));
      const other = await loadPiece(chosen.id).catch(() => null);
      if (!other) return;
      run("/api/compare",
          { otherTitle: other.title, otherAuthor: other.author, otherText: other.text },
          "A comparative reading with \u201c" + other.title + "\u201d by " + other.author
          + ", generated by the Poetry Codex critical engine.", "Compared with \u201c" + other.title + "\u201d");
    });
  }

  // "Read next": three poems on the same subject from the same era or tradition, the same
  // three every time a poem is opened (picked from the poem's id, no randomness), from other
  // poets where there are enough. If the era has fewer than three, the subject alone is used.
  let RELATED = null;   // "subject|category" -> poems, and "subject|" -> poems (built once)
  function relatedPoems(p) {
    if (!RELATED) {
      RELATED = new Map();
      const add = (k, q) => { if (!RELATED.has(k)) RELATED.set(k, []); RELATED.get(k).push(q); };
      DATA.poems.forEach((q) => {
        add(q.primarySubject + "|" + ((POETS[q.authorSlug] || {}).category || ""), q);
        add(q.primarySubject + "|", q);
      });
    }
    const cat = (POETS[p.authorSlug] || {}).category || "";
    let pool = (RELATED.get(p.primarySubject + "|" + cat) || []).filter((q) => q.id !== p.id);
    let label = cat ? `More ${cat} poems on ${p.primarySubject}` : "";
    if (pool.length < 3 || !cat) {
      pool = (RELATED.get(p.primarySubject + "|") || []).filter((q) => q.id !== p.id);
      label = `More poems on ${p.primarySubject}`;
    }
    if (!pool.length) return null;
    let h = 0;
    for (const ch of p.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const len = pool.length, start = h % len, step = len % 7919 ? 7919 : 1;
    const picked = [], poets = new Set([p.authorSlug]);
    // First pass: one poem each from other poets; second pass: anything left.
    for (const distinct of [true, false]) {
      for (let k = 0; k < len && picked.length < 3; k++) {
        const q = pool[(start + k * step) % len];
        if (picked.includes(q) || (distinct && poets.has(q.authorSlug))) continue;
        picked.push(q); poets.add(q.authorSlug);
      }
    }
    return { label, poems: picked };
  }
  function relatedHTML(p) {
    const r = relatedPoems(p);
    if (!r) return "";
    return `<section class="related" aria-label="${esc(r.label)}">
          <p class="section-label">Read next · ${esc(r.label)}</p>
          <div class="grid related-grid">${r.poems.map(cardHTML).join("")}</div>
        </section>`;
  }

  // "Read next" on a poem drawn without the index: three more poems by the same poet, from
  // those its shard holds (up to 50 around it), the same three every time.
  function poetNextHTML(poems, n, p) {
    const pool = [];
    poems.forEach((q, j) => { if (j !== n && q && q.text && q.id) pool.push(q); });
    if (!pool.length) return "";
    let h = 0;
    for (const ch of p.id || "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const step = Math.max(1, Math.floor(pool.length / 3)), start = h % pool.length, picked = [];
    for (let k = 0; k < pool.length && picked.length < 3; k++) {
      const q = pool[(start + k * step) % pool.length];
      if (!picked.includes(q)) picked.push(q);
    }
    const cards = picked.map((q) => {
      const lines = q.text.split("\n");
      return cardHTML(Object.assign({}, q, { authorSlug: q.authorSlug || p.authorSlug, author: q.author || p.author,
        excerpt: lines.slice(0, 3).join("\n") + (lines.length > 3 ? " …" : "") }));
    });
    const label = "More by " + p.author;
    return `<section class="related" aria-label="${esc(label)}">
          <p class="section-label">Read next · ${esc(label)}</p>
          <div class="grid related-grid">${cards.join("")}</div>
        </section>`;
  }
  function renderDetailReady(poetFile, slug, n, p) {
    const poems = poetFile.poems;
    const themes = p.subjects.length
      ? `<div class="themes">${p.subjects.map((s) => `<span class="theme-tag" data-sub="${esc(s)}">${esc(s)}</span>`).join("")}</div>` : "";
    const lang = langAttr(p.authorSlug, p.translator);
    const form = DATA ? (DATA.poems.find((q) => q.id === p.id) || {}).form : "";   // index only (B3)
    EARLY_DRAWN = DATA ? "" : location.hash;   // drawn without the index, which it does not fetch
    EARLY_REDRAW = false;
    const cite = { author: p.author, title: p.title, translator: p.translator, path: `/poem/${slug}/${n}/` };
    const entry = { id: slug + "/" + n, kind: "poem", title: p.title, author: p.author, translator: p.translator || "" };
    const par = parList("poems", p.id);
    const long = lineCount(p.text) > LONG_POEM;   // a long poem keeps its place, like a book
    setTitle(p.title + " — " + p.author);
    app.innerHTML = `
      <article class="detail">
        ${long ? progressHTML() : ""}
        <button class="back" id="back">← The Archive</button>
        ${readingToolsHTML()}
        ${findButtonHTML()}
        ${learnable(p.text, p.translator) ? learnButtonHTML() : ""}
        ${surpriseBarHTML()}
        <div class="detail-subject">${esc(p.primarySubject)}${form ? " · " + esc(form) : ""}</div>
        <h1 class="detail-title"${lang}>${esc(p.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(p.authorSlug)}">${esc(p.author)}</a>${datesHTML(p.authorSlug)}</p>
        ${sourceLine(p.translator, p.collection, long ? readTime(p.text, isProse(p.text, p.translator)) : "")}
        ${themes}
        <hr class="rule">
        ${enginePanel(p.text, { compare: true, gloss: true })}
        ${poemBlock(p.text, { label: "The Poem", translator: p.translator, lang, parallel: parCtlHTML("poems", p.id, par) })}
        <p class="book-source-slot" hidden></p>
        ${p.note ? `<div class="rule-ornament">✦ ✦ ✦</div>
        <p class="section-label">Codex Note</p>
        <p class="note-block">${esc(p.note)}</p>` : ""}
        ${citeHTML(cite, entry)}
        <div class="detail-nav">
          <button ${n === 0 ? "disabled" : ""} data-go="${n - 1}"><span class="dir">← Previous</span>${n > 0 ? esc(poems[n - 1].title) : ""}</button>
          <button class="next" ${n === poems.length - 1 ? "disabled" : ""} data-go="${n + 1}"><span class="dir">Next →</span>${n < poems.length - 1 ? esc(poems[n + 1].title) : ""}</button>
        </div>
        ${DATA ? relatedHTML(p) : poetNextHTML(poems, n, p)}
      </article>`;
    document.getElementById("back").addEventListener("click", () => { if (history.length > 1) history.back(); else location.hash = "#/poems"; });
    app.querySelectorAll(".theme-tag").forEach((t) => t.addEventListener("click", () => {
      const isSub = !DATA || DATA.subjects.some((s) => s.name === t.dataset.sub);
      filterSubject = isSub ? t.dataset.sub : "All";
      filterForm = "All";
      query = isSub ? "" : t.dataset.sub;
      syncSearchInput(); location.hash = "#/poems";
    }));
    app.querySelectorAll(".detail-nav button").forEach((b) => b.addEventListener("click", () => { if (!b.disabled) location.hash = "#/poem/" + slug + "/" + b.dataset.go; }));
    bindEngine({ title: p.title, author: p.author, text: p.text, id: p.id });
    bindReadingTools();
    bindFind();
    bindLineNumbers();
    bindFacing({ kind: "poem", key: p.id, list: par, build: (e, other) => poemFacing(p, other, e),
                 onShow: (el) => { if (READING_NOW && READING_NOW.poem === entry.id) { READING_NOW.el = el; drawProgress(); } } });
    bindCite(cite);
    { const here = location.hash; fetchSources(p.authorSlug).then((d) => applySource(cite, poemSource(d, p), here)); }
    bindShelfButton(entry);
    bindListNext();
    bindNote(entry);
    bindMarks(entry);
    bindQuoteTools(cite, p.authorSlug, p.translator, p.text);
    bindListen(listenLang(p.authorSlug, p.translator, p.text));
    restoreScroll();
    bindLearn({ entry, text: p.text, translator: p.translator, lang, par });
    // Every poem goes on the recently read list; a long one also keeps the reader's place,
    // and opened from "Continue reading" it scrolls back there.
    noteRecent({ id: entry.id, kind: "poem", title: p.title, author: p.author });
    if (long) {
      const text = app.querySelector(".fx-slot:not([hidden])") || app.querySelector(".poem-text");
      const resume = pendingResume && pendingResume.poem === entry.id ? pendingResume.frac : 0;
      pendingResume = null;
      if (resume > 0) {
        const r = text.getBoundingClientRect();
        jumpTo(Math.max(0, window.scrollY + r.top + resume * r.height - window.innerHeight * 0.3));
      }
      READING_NOW = { poem: entry.id, title: p.title, author: p.author, el: text };
      setPoemPlace(entry.id, resume > 0 ? resume : readingFrac(text), p.title, p.author);
      drawProgress();
    }
    showLinkedLines();
    bindReadingBar();
  }

  // ---------- Listen: the text read aloud by the device's own voice ----------
  // "Listen" in the text's label row (beside Line numbers) on a poem or a book, offered only
  // when the browser can speak and has a voice in the text's language: English for English
  // poems and every translation, Turkish for Turkish poems where the device has a Turkish
  // voice. Old and Middle English, Greek and other originals never get it: a modern voice
  // would mispronounce them. It speaks one line at a time (a paragraph, in sentences, in a
  // prose translation; the translation column on the facing pages), with a short pause at a
  // stanza break, starting from the selected words or else the first line in view. The line
  // being read gets a soft background (CSS only: a screen reader has its own speech) and is
  // kept in view. The player is a small labelled toolbar at the foot of the screen: Play /
  // Pause, Stop, three speeds (remembered in pc-prefs, this browser only) and a plain note
  // that this is a machine voice. Space plays or pauses while the player has focus. A new
  // page stops it. Nothing is sent anywhere: the speech is made on the device.
  const LISTEN_RATES = [0.8, 1, 1.2];
  const LISTEN_OK = typeof window.speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance === "function";
  const ENGLISH_WORDS = new Set("the and of to a in i my is that it with his he her for not but as be all thou thy thee me you your we our on by from this when what so no or are was which they them their shall will".split(" "));
  let LISTEN = null;       // {lang, units, at, playing, gen, timer, voice} for the page on screen
  let listenBar = null;
  // The language a machine voice may read the text in: "en", "tr" or "" (none).
  function listenLang(authorSlug, translator, text) {
    if (String(translator || "").trim()) return "en";   // every translation here is in English
    const cat = (POETS[authorSlug] || {}).category || "", sample = String(text || "").slice(0, 4000);
    if (langAttr(authorSlug, translator) || (!cat && /[ğışĞİŞ]/.test(sample))) return "tr";
    if (cat === "Anglo-Saxon" || cat === "Medieval" || /[æðþÆÐÞͰ-Ͽἀ-῿]/.test(sample) || looksArchaic(sample)) return "";
    const words = sample.toLowerCase().match(/[\p{L}']+/gu) || [];
    return words.length && words.filter((w) => ENGLISH_WORDS.has(w)).length / words.length >= 0.15 ? "en" : "";
  }
  // The device's voice for that language: one in the reader's own variant (en-GB, en-US) if
  // there is one, else the browser's default for it, else the first.
  function listenVoice(lang) {
    const vs = LISTEN_OK ? speechSynthesis.getVoices().filter((v) => String(v.lang).toLowerCase().replace("_", "-").split("-")[0] === lang) : [];
    const own = String(navigator.language || "").toLowerCase();
    return vs.find((v) => String(v.lang).toLowerCase().replace("_", "-") === own) || vs.find((v) => v.default) || vs[0] || null;
  }
  // Called by a poem or book page once it is drawn. The voices can arrive a moment later.
  function bindListen(lang) {
    stopListen();
    LISTEN = null;
    if (!LISTEN_OK || !lang) return;
    LISTEN = { lang, units: [], at: 0, playing: false, gen: 0, timer: 0, voice: null };
    const ctx = LISTEN, root = app.querySelector(".detail .poem-text");
    if (!root) return;
    const add = () => {
      if (LISTEN !== ctx || !root.isConnected || app.querySelector(".listen-open")) return true;
      ctx.voice = listenVoice(lang);
      if (!ctx.voice) return false;
      listenButton(root);
      return true;
    };
    if (!add()) speechSynthesis.addEventListener("voiceschanged", function once() { if (add()) speechSynthesis.removeEventListener("voiceschanged", once); });
  }
  // The button goes in the row above the text (made for it when the text has none).
  function listenButton(root) {
    const host = root.closest(".text-solo") || root;
    let row = host.previousElementSibling;
    if (!row || !row.classList.contains("ln-bar")) {
      row = document.createElement("div");
      row.className = "ln-bar";
      host.before(row);
      if (row.previousElementSibling && row.previousElementSibling.classList.contains("section-label")) row.prepend(row.previousElementSibling);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "listen-open";
    btn.setAttribute("aria-controls", "listen-bar");
    btn.setAttribute("aria-expanded", "false");
    btn.title = "Read aloud with this device's machine voice";
    btn.textContent = "Listen";   // the ▶ is drawn by CSS, so a flashed message restores cleanly
    btn.addEventListener("mousedown", (e) => e.preventDefault());   // keeps a selection to start from
    btn.addEventListener("click", () => {
      if (LISTEN && LISTEN.units.length && listenBar && !listenBar.hidden) { toggleListen(); return; }
      startListen(btn);
    });
    const ctl = row.querySelector(".ln-ctl");
    if (ctl) ctl.before(btn); else row.appendChild(btn);
  }
  // What is read: the lines (or a prose paragraph's sentences) of the text on screen, each
  // {el, text, pause}; on the facing pages, the translation's column.
  function listenUnits() {
    const out = [];
    const push = (el, text, pause) => { const t = String(text || "").replace(/\s+/g, " ").trim(); if (/\p{L}/u.test(t)) out.push({ el, text: t, pause }); };
    const sentences = (p) => (p.textContent.match(/[^.!?;:]+(?:[.!?;:]+["'’”)\]]*|$)\s*/g) || [p.textContent]).reduce((acc, s) => {
      // Joined back to about 220 characters: a very long utterance is cut short by some voices.
      if (acc.length && (acc[acc.length - 1] + s).length < 220) acc[acc.length - 1] += s; else acc.push(s);
      return acc;
    }, []);
    const fx = app.querySelector(".fx-slot:not([hidden]) .fx");
    if (fx) {
      if (fx.dataset.view === "orig") return out;
      fx.querySelectorAll(".fx-row:not(.fx-head):not(.fx-bookrow)").forEach((row) => {
        let first = true;
        row.querySelectorAll(".fx-t > .ln, .fx-t > p:not(.fx-cap)").forEach((el) => {
          if (el.tagName === "P") sentences(el).forEach((s, k) => push(el, s, first && k === 0 && row.classList.contains("gap")));
          else push(el, el.textContent, (first && row.classList.contains("gap")) || el.classList.contains("fx-gap"));
          first = false;
        });
      });
      return out;
    }
    const root = app.querySelector(".text-solo .poem-text") || app.querySelector(".detail .poem-text");
    if (!root) return out;
    if (root.classList.contains("is-prose")) {
      root.querySelectorAll(":scope > p").forEach((p, k) => sentences(p).forEach((s, j) => push(p, s, k > 0 && j === 0)));
    } else {
      root.querySelectorAll(".stanza").forEach((st, k) => st.querySelectorAll(".ln").forEach((l, j) => push(l, l.textContent, k > 0 && j === 0)));
    }
    return out;
  }
  // Where to begin: the first line the selection touches, else the first line in view.
  function listenStart(units) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const k = units.findIndex((u) => r.intersectsNode(u.el));
      if (k >= 0) return k;
    }
    const head = document.querySelector(".site-head");
    const top = head && getComputedStyle(head).position === "sticky" ? head.getBoundingClientRect().bottom : 0;
    const k = units.findIndex((u) => u.el.getBoundingClientRect().bottom > top + 4);
    return k >= 0 ? k : 0;
  }
  function listenBarEl() {
    if (listenBar) return listenBar;
    const rate = listenRate();
    listenBar = document.createElement("div");
    listenBar.className = "listen-bar";
    listenBar.id = "listen-bar";
    listenBar.hidden = true;
    listenBar.setAttribute("role", "toolbar");
    listenBar.setAttribute("aria-label", "Listen");
    listenBar.innerHTML = `
      <div class="listen-row">
        <button type="button" class="listen-play" aria-label="Pause"><span aria-hidden="true">❚❚</span></button>
        <button type="button" class="listen-stop" aria-label="Stop"><span aria-hidden="true">■</span></button>
        <span class="listen-speed" role="group" aria-label="Speed">${LISTEN_RATES.map((r) =>
          `<button type="button" data-rate="${r}" aria-pressed="${r === rate}">${r}×</button>`).join("")}</span>
      </div>
      <p class="listen-note">Machine voice: rhythm and old pronunciations may be wrong</p>`;
    listenBar.querySelector(".listen-play").addEventListener("click", toggleListen);
    listenBar.querySelector(".listen-stop").addEventListener("click", () => {
      const back = app.querySelector(".listen-open");
      stopListen();
      if (back) back.focus();
    });
    listenBar.querySelectorAll("[data-rate]").forEach((b) => b.addEventListener("click", () => {
      setPrefs({ listenRate: +b.dataset.rate });
      listenBar.querySelectorAll("[data-rate]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      if (LISTEN && LISTEN.playing) speakUnit();   // the line again, at the new speed
    }));
    listenBar.addEventListener("keydown", (e) => {
      // Space on Stop or a speed keeps its own meaning (presses that button).
      if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest(".listen-stop, [data-rate]")) { e.preventDefault(); toggleListen(); }
      else if (e.key === "Escape") { e.preventDefault(); listenBar.querySelector(".listen-stop").click(); }
    });
    document.body.appendChild(listenBar);
    return listenBar;
  }
  const listenRate = () => (LISTEN_RATES.includes(prefs().listenRate) ? prefs().listenRate : 1);
  function startListen(btn) {
    const ctx = LISTEN;
    if (!ctx) return;
    ctx.units = listenUnits();
    if (!ctx.units.length) { flash(btn, "Show the translation to listen"); return; }
    ctx.at = listenStart(ctx.units);
    const bar = listenBarEl();
    bar.hidden = false;
    document.body.classList.add("is-listening");
    btn.setAttribute("aria-expanded", "true");
    ctx.playing = true;
    speakUnit();   // inside the click: iOS speaks only in answer to a tap
    showListenState();
    bar.querySelector(".listen-play").focus();
  }
  function toggleListen() {
    const ctx = LISTEN;
    if (!ctx || !ctx.units.length) return;
    ctx.playing = !ctx.playing;
    if (ctx.playing) speakUnit();
    else { ctx.gen++; clearTimeout(ctx.timer); speechSynthesis.cancel(); }   // Pause: the line starts again on Play
    showListenState();
  }
  function showListenState() {
    if (!listenBar || !LISTEN) return;
    const b = listenBar.querySelector(".listen-play");
    b.setAttribute("aria-label", LISTEN.playing ? "Pause" : "Play");
    b.firstElementChild.textContent = LISTEN.playing ? "❚❚" : "▶";
  }
  // Speaks the line at LISTEN.at; each utterance carries its generation, so the end of one
  // that was cut off (Pause, a new speed, Stop) does not move the reading on.
  function speakUnit() {
    const ctx = LISTEN;
    if (!ctx) return;
    const gen = ++ctx.gen;
    clearTimeout(ctx.timer);
    speechSynthesis.cancel();
    const u = ctx.units[ctx.at];
    if (!u || !u.el.isConnected) { stopListen(); return; }
    listenMark(u.el);
    const ut = new SpeechSynthesisUtterance(u.text);
    if (ctx.voice) ut.voice = ctx.voice;
    ut.lang = ctx.voice ? ctx.voice.lang : ctx.lang;
    ut.rate = listenRate();
    const next = () => {
      if (gen !== ctx.gen || LISTEN !== ctx || !ctx.playing) return;
      ctx.at++;
      if (ctx.at >= ctx.units.length) { stopListen(); return; }
      ctx.timer = setTimeout(speakUnit, ctx.units[ctx.at].pause ? 450 : 0);
    };
    ut.onend = next;
    ut.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") next(); };
    speechSynthesis.speak(ut);
  }
  // The soft background on the line being read, scrolled into view when it leaves it.
  function listenMark(el) {
    app.querySelectorAll(".is-spoken").forEach((x) => { if (x !== el) x.classList.remove("is-spoken"); });
    el.classList.add("is-spoken");
    const r = el.getBoundingClientRect(), head = document.querySelector(".site-head");
    const top = head && getComputedStyle(head).position === "sticky" ? head.getBoundingClientRect().bottom : 0;
    const bottom = window.innerHeight - (listenBar && !listenBar.hidden ? listenBar.offsetHeight + 16 : 0);
    if (r.top < top + 8 || r.bottom > bottom - 8) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: Math.max(0, window.scrollY + r.top - window.innerHeight * 0.35), behavior: smooth ? "smooth" : "auto" });
    }
  }
  function stopListen() {
    if (LISTEN) { LISTEN.gen++; LISTEN.playing = false; LISTEN.units = []; clearTimeout(LISTEN.timer); }
    if (LISTEN_OK && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    document.querySelectorAll(".is-spoken").forEach((x) => x.classList.remove("is-spoken"));
    document.body.classList.remove("is-listening");
    if (listenBar) listenBar.hidden = true;
    const btn = app.querySelector(".listen-open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  window.addEventListener("hashchange", stopListen);
  window.addEventListener("pagehide", stopListen);

  // ---------- keep offline: an explicit download for a work or a poet's poems ----------
  // "Keep offline" on a work's contents page and on a poet's page fetches everything that
  // text needs to open with no connection (the work or poet file, its book source, line map,
  // study notes, the texts its facing pages show, the poet's portrait) into the cache the
  // service worker reads from (sw.js names it VERSION, "pc-1"), so sw.js needs no change.
  // The reader first sees about how much it takes ("About 2.1 MB on this device"), then
  // "Downloading… 3 of 5", then "Available offline" with a check, which the shelf shows too.
  // Pressing it again removes those files (never one another kept text still uses, nor the
  // small files every page shares). The kept texts are listed in pc-prefs.offline ({ref:
  // {title, files, bytes, at}}, ref "work:<slug>" or "poet:<slug>"): this browser only, like
  // the files themselves, since pc-prefs is not one of the synced kinds. While the device is
  // offline a quiet line under the top bar says so, and links to poems and books not saved on
  // this device are greyed, with a tooltip. The 32 MB index is never part of this.
  const OFF_OK = typeof caches !== "undefined" && location.protocol !== "file:";
  const OFF_SHARED = ["data/parallel.json", "work/works.json", "data/glosses/poems/index.json"];
  const offAbs = (path) => new URL(path, location.href).href;
  const offCache = () => caches.keys().then((keys) => caches.open(keys.find((k) => /^pc-\d+$/.test(k)) || "pc-1"));
  const offKept = () => { const o = prefs().offline; return o && typeof o === "object" ? o : {}; };
  function setOffKept(ref, rec) {
    const o = offKept();
    if (rec) o[ref] = rec; else delete o[ref];
    setPrefs({ offline: o });
  }
  // The kept download that covers a shelf id: the work for the work or any book of it, the
  // poet for one of their poems.
  function offRefFor(id) {
    const m = /^work:([^/]+)/.exec(id);
    const ref = m ? "work:" + m[1] : "poet:" + id.split("/")[0];
    return offKept()[ref] ? ref : "";
  }
  const offSize = (b) => b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
  const offMainFile = (ref) => ref.startsWith("work:")
    ? `data/works/${encodeURIComponent(ref.slice(5))}.json` : `data/poets/${encodeURIComponent(ref.slice(5))}.json`;
  // What one kept text needs, the shared files first.
  async function offFiles(ref) {
    const slug = ref.slice(5), files = OFF_SHARED.slice();
    const add = (f) => { if (f && !files.includes(f)) files.push(f); };
    await fetchParallel();
    add(offMainFile(ref));
    if (ref.startsWith("work:")) {
      const w = WORKS[slug];
      if (w) add(`data/sources/${encodeURIComponent(w.authorSlug)}.json`);
      if (LINEMAPPED.has(slug)) add(`data/linemaps/${slug}.json`);
      if (GLOSSED.has(slug) && w) w.sections.forEach((s, i) => add(`data/glosses/${slug}/${i}.json`));
      parList("works", slug).forEach((e) => add(`data/works/${encodeURIComponent(e.with)}.json`));
    } else {
      const poet = POETS[slug], glossed = await glossedPoems();
      add(`data/sources/${encodeURIComponent(slug)}.json`);
      if (poet && poet.portrait) add(poet.portrait);
      (DATA ? DATA.poems : []).filter((p) => p.authorSlug === slug).forEach((p) => {
        if (glossed.has(p.id)) add(`data/glosses/poems/${p.id}.json`);
        parList("poems", p.id).forEach((e) => add(`data/poets/${encodeURIComponent(e.with.split("/")[0])}.json`));
      });
    }
    return files;
  }
  // Which of them exist and about how big they are (a HEAD request each). The live site sends
  // its files compressed with no size, so the main file, unsized, is guessed from the index
  // (a work's line and paragraph counts, a poet's number of poems at about 1.9 KB each); any
  // other unsized file is left out of the sum ("or a little more").
  async function offMeasure(ref) {
    const files = await offFiles(ref), found = new Set(), main = offMainFile(ref);
    let bytes = 0, unsized = 0, mainUnsized = false;
    await Promise.all(files.map(async (f) => {
      const r = await fetch(f, { method: "HEAD", cache: "no-store" });
      if (!r.ok) return;
      found.add(f);
      if (OFF_SHARED.includes(f) && await caches.match(offAbs(f))) return;   // already on this device
      const n = +r.headers.get("content-length");
      if (n > 0) bytes += n; else if (f === main) mainUnsized = true; else unsized++;
    }));
    if (!found.has(main)) throw new Error("not found");
    if (mainUnsized) {
      const slug = ref.slice(5), w = ref.startsWith("work:") && WORKS[slug], poet = !w && POETS[slug];
      const guess = w ? w.sections.reduce((t, s) => t + (s.lines || 0) * 50 + (s.paras || 0) * 900, 0)
        : poet ? (poet.poemCount || 0) * 1900 : 0;
      if (guess) bytes += guess; else unsized++;
    }
    return { files: files.filter((f) => found.has(f)), bytes, unsized };
  }
  // Of these files, the ones no other kept text uses and no page shares: safe to remove.
  function offOwnFiles(files, ref) {
    const others = Object.entries(offKept()).filter(([r]) => r !== ref).flatMap(([, rec]) => rec.files || []);
    return files.filter((f) => !OFF_SHARED.includes(f) && !others.includes(f));
  }
  // One file after another, so the count moves; a failure takes back what this run added.
  async function offDownload(ref, title, plan, progress) {
    const cache = await offCache(), added = [];
    if (!Object.keys(offKept()).length && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    try {
      for (let k = 0; k < plan.files.length; k++) {
        progress(k + 1, plan.files.length);
        const f = plan.files[k], res = await fetch(f);
        if (!res.ok) continue;
        await cache.put(offAbs(f), res);
        added.push(f);
      }
    } catch (e) {
      await Promise.all(offOwnFiles(added, ref).map((f) => cache.delete(offAbs(f)))).catch(() => {});
      throw e;
    }
    setOffKept(ref, { title, files: added, bytes: plan.bytes, at: new Date().toISOString() });
  }
  async function offRemove(ref) {
    const rec = offKept()[ref];
    if (rec) {
      const cache = await offCache();
      await Promise.all(offOwnFiles(rec.files || [], ref).map((f) => cache.delete(offAbs(f))));
    }
    setOffKept(ref, null);
  }
  // The control: a toggle button, its check badge, the size question and a status line that
  // screen readers hear.
  function offlineHTML(ref) {
    if (!OFF_OK) return "";
    const on = !!offKept()[ref];
    return `<span class="offline-ctl" data-ref="${esc(ref)}">
        <button class="offline-toggle" type="button" aria-pressed="${on}">Keep offline</button>
        <span class="offline-badge"${on ? "" : " hidden"}>Available offline</span>
        <span class="offline-ask" hidden><span class="offline-size"></span>
          <button class="offline-go" type="button">Download</button>
          <button class="offline-no" type="button">Not now</button></span>
        <span class="offline-status" role="status" aria-live="polite"></span>
      </span>`;
  }
  function bindOffline(title) {
    const box = app.querySelector(".offline-ctl");
    if (!box) return;
    const ref = box.dataset.ref, btn = box.querySelector(".offline-toggle"), badge = box.querySelector(".offline-badge");
    const ask = box.querySelector(".offline-ask"), status = box.querySelector(".offline-status");
    let plan = null, busy = false;
    // While it measures or downloads the button stays focusable but does nothing
    // (aria-disabled), so the focus is never lost.
    const wait = (on) => { busy = on; btn.setAttribute("aria-disabled", String(on)); };
    const show = (on, msg) => {
      btn.setAttribute("aria-pressed", String(on));
      wait(false);
      badge.hidden = !on;
      ask.hidden = true;
      status.textContent = msg || "";
    };
    // A text kept earlier whose files the browser has since cleared shows as not kept.
    if (offKept()[ref]) offCache().then((c) => c.match(offAbs(offMainFile(ref)))).then((hit) => {
      if (!hit && box.isConnected) { setOffKept(ref, null); show(false, "No longer saved on this device: the browser cleared it."); }
    }).catch(() => {});
    btn.addEventListener("click", async () => {
      if (busy || !ask.hidden) return;
      if (offKept()[ref]) {
        wait(true);
        await offRemove(ref).catch(() => setOffKept(ref, null));
        show(false, "Removed from this device.");
        return;
      }
      if (!navigator.onLine) { show(false, "You are offline: connect to the internet to download this."); return; }
      wait(true);
      status.textContent = "Checking the size…";
      try { plan = await offMeasure(ref); }
      catch (e) { show(false, "The size could not be checked (no connection?). Try again in a moment."); return; }
      wait(false);
      status.textContent = "";
      box.querySelector(".offline-size").textContent = plan.bytes
        ? `About ${offSize(plan.bytes)}${plan.unsized ? " or a little more" : ""} on this device.`
        : "Size not known in advance.";
      ask.hidden = false;
      box.querySelector(".offline-go").focus();
    });
    box.querySelector(".offline-no").addEventListener("click", () => { show(false); btn.focus(); });
    box.querySelector(".offline-go").addEventListener("click", async () => {
      ask.hidden = true;
      wait(true);
      btn.focus();
      try {
        await offDownload(ref, title, plan, (k, n) => { status.textContent = `Downloading… ${k} of ${n}`; });
        show(true, "Saved on this device: it opens with no connection.");
      } catch (e) {
        const full = e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""));
        show(false, full
          ? "This device has no room left for it. Remove another text kept offline, or free some space, and try again."
          : "The download stopped, perhaps because the connection dropped. Nothing was kept: try again.");
      }
    });
  }
  // Offline: the line under the top bar, and greyed links to poems and books not on this
  // device (neither the whole poet or work file nor the piece the page opens from is kept).
  const offLine = document.createElement("p");
  offLine.className = "offline-line";
  offLine.setAttribute("role", "status");
  offLine.hidden = true;
  offLine.textContent = "Offline: showing texts saved on this device";
  app.before(offLine);
  const OFF_HAVE = new Map();   // file -> Promise<bool>, for this spell offline
  const offHave = (f) => OFF_HAVE.get(f) || OFF_HAVE.set(f, caches.match(offAbs(f)).then((r) => !!r).catch(() => true)).get(f);
  let offTimer = 0;
  function markOffLinks() {
    if (navigator.onLine || !OFF_OK) return;
    app.querySelectorAll('a[href^="#/poem/"], a[href^="#/work/"]').forEach((a) => {
      if (a.dataset.offChecked) return;
      a.dataset.offChecked = "1";
      const href = a.getAttribute("href");
      let m, whole, piece;
      if ((m = /^#\/poem\/([\w-]+)\/(\d+)/.exec(href))) {
        whole = `data/poets/${encodeURIComponent(m[1])}.json`;
        piece = `data/c/${encodeURIComponent(m[1])}/${Math.floor(m[2] / POEM_SHARD)}.json`;
      } else if ((m = /^#\/work\/([\w-]+)\/(\d+)(?:$|\?)/.exec(href))) {
        whole = `data/works/${encodeURIComponent(m[1])}.json`;
        piece = `data/ws/${encodeURIComponent(m[1])}/${m[2]}.json`;
      } else return;
      Promise.all([offHave(whole), offHave(piece)]).then(([x, y]) => {
        if (x || y || navigator.onLine) return;
        a.classList.add("off-missing");
        a.title = "Not saved on this device: it needs a connection";
      });
    });
  }
  function offlineState() {
    const off = OFF_OK && !navigator.onLine;
    offLine.hidden = !off;
    if (off) { OFF_HAVE.clear(); markOffLinks(); return; }
    app.querySelectorAll(".off-missing").forEach((a) => { a.classList.remove("off-missing"); a.removeAttribute("title"); });
    app.querySelectorAll("[data-off-checked]").forEach((a) => { delete a.dataset.offChecked; });
  }
  if (OFF_OK) {
    new MutationObserver(() => { if (!navigator.onLine) { clearTimeout(offTimer); offTimer = setTimeout(markOffLinks, 120); } })
      .observe(app, { childList: true, subtree: true });
    window.addEventListener("online", offlineState);
    window.addEventListener("offline", offlineState);
    offlineState();
  }

  // ---------- start ----------
  // Search works before the index is in (it opens the archive, which draws when the index
  // arrives); the page shows the masthead, or "Opening the archive…", until then.
  wireSearch();
  route();

  // The service worker (sw.js): on a later visit the page, the app and the index come from
  // the reader's own browser at once and are refreshed in the background. Registered after
  // the page has loaded, so it never competes with the first screen.
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }
})();
