(() => {
  "use strict";
  const app = document.getElementById("app");
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
  function sourceLine(translator, collection) {
    const parts = [translator && translatedBy(translator), collection && "From " + collection].filter(Boolean);
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
    const mla = (o.src ? `${lead} ${end(o.src.mla)} ` : `${lead} `) +
      `<i>Poetry Codex</i>, ${esc(url.replace(/^https:\/\//, ""))}. Accessed ${d.getDate()} ${MLA_MONTHS[d.getMonth()]} ${d.getFullYear()}.`;
    const chicago = (o.src ? `${lead} ${o.src.chi} ` : `${lead} `) +
      `Poetry Codex. Accessed ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}. ${esc(url)}.`;
    const plain = (h) => h.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return [{ style: "MLA", html: mla, text: plain(mla) }, { style: "Chicago", html: chicago, text: plain(chicago) }];
  }
  // "Source: <the printed book>. Digital text: <where>." under a poem or a part of a work.
  // src.line is HTML built from the bibliography (titles in <i>, the rest escaped).
  function bookSourceHTML(src) {
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
  function shelfItems() {
    const s = readStore(SHELF_KEY);
    return Array.isArray(s.items) ? s.items.filter((it) => it && typeof it.id === "string") : [];
  }
  const onShelf = (id) => shelfItems().some((it) => it.id === id);
  // entry: {id, kind: "poem" | "work" | "part", title, author, translator}
  function toggleShelf(entry) {
    const items = shelfItems();
    const at = items.findIndex((it) => it.id === entry.id);
    if (at >= 0) items.splice(at, 1);
    else items.unshift(Object.assign({}, entry, { saved: new Date().toISOString() }));
    const kept = writeStore(SHELF_KEY, { v: 1, items });
    updateShelfNav();
    return { on: at < 0, kept };
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
    const show = shelfItems().length > 0 || Object.keys(allNotes()).length > 0 || markCount() > 0 || /^#\/shelf/.test(location.hash);
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
    return `<button class="shelf-toggle" type="button" aria-pressed="${on}">${on ? "On your shelf" : "Save to shelf"}</button>
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
    btn.addEventListener("click", () => {
      const r = toggleShelf(entry);
      btn.setAttribute("aria-pressed", String(r.on));
      btn.textContent = r.on ? "On your shelf" : "Save to shelf";
      app.querySelector(".shelf-view").hidden = !r.on;
      const msg = app.querySelector(".shelf-msg");
      if (msg) msg.hidden = r.kept;
    });
  }
  // ---------- notes on lines ----------
  // Select a line, or a few words of one, in a poem or a book of a long work, and "Note on
  // this line" appears under the selection. The note keeps the lines it covers (data-i, each
  // line's place in the text as poemHTML numbers them) and the words selected; those lines
  // get a gold mark in the margin, which opens the note again. Prose texts and the facing
  // pages take no line notes. pc-marks: {v, marks: {entry id: {title, author, kind,
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
  function bindMarks(entry) {
    const root = app.querySelector(".text-solo .poem-text") || app.querySelector(".poem-text");
    MARK_CTX = root && !root.classList.contains("is-prose") && root.querySelector(".ln[data-i]") ? { entry, root } : null;
    hideMarkButton();
    if (MARK_CTX) drawMarks();
  }
  function drawMarks() {
    const { entry, root } = MARK_CTX;
    root.querySelectorAll(".mark-dot").forEach((d) => d.remove());
    root.querySelectorAll(".ln.has-mark").forEach((l) => l.classList.remove("has-mark"));
    marksOf(entry.id).forEach((m) => {
      for (let i = m.a; i <= m.b; i++) {
        const l = root.querySelector(`.ln[data-i="${i}"]`);
        if (l) l.classList.add("has-mark");
      }
      const first = root.querySelector(`.ln[data-i="${m.a}"]`);
      if (!first) return;
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "mark-dot";
      dot.title = "Your note";
      dot.setAttribute("aria-label", "Your note on this line");
      dot.addEventListener("click", (e) => { e.preventDefault(); openMarkEditor(m, false); });
      first.appendChild(dot);
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
  document.addEventListener("selectionchange", () => { clearTimeout(selTimer); selTimer = setTimeout(checkSelection, 220); });
  // The note under the last line it covers: a new one, or one opened from its mark.
  function openMarkEditor(m, isNew) {
    if (!MARK_CTX) return;
    const { entry, root } = MARK_CTX;
    root.querySelectorAll(".mark-pop").forEach((p) => p.remove());
    const last = root.querySelector(`.ln[data-i="${m.b}"]`);
    const stanza = last && last.closest(".stanza");
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
      <li class="mark-row">
        <p class="mark-row-quote">\u201c${esc(m.quote)}\u201d</p>
        <p class="mark-row-note">${esc(m.text)}</p>
        <p class="mark-row-src"><a href="${esc(routeFor(id))}">${esc(g.title || "")}</a>${g.author ? ` \u00b7 ${esc(g.author)}` : ""} \u00b7 ${esc(writtenLine(m))}</p>
      </li>`;

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
  const READING_KEY = "pc-reading";
  function readingWorks() {
    const w = readStore(READING_KEY).works;
    return w && typeof w === "object" && !Array.isArray(w) ? w : {};
  }
  // The record for a work, if its book still exists.
  function readingOf(slug) {
    const r = readingWorks()[slug];
    const w = WORKS[slug];
    return r && w && Number.isInteger(r.i) && w.sections[r.i] ? r : null;
  }
  function setReading(slug, i, frac) {
    const works = readingWorks();
    works[slug] = { i, frac: Math.round(Math.min(1, Math.max(0, frac || 0)) * 1000) / 1000, at: new Date().toISOString() };
    writeStore(READING_KEY, { v: 1, works });
  }
  function forgetReading(slug) {
    const works = readingWorks();
    delete works[slug];
    writeStore(READING_KEY, { v: 1, works });
  }

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
      items.sort((a, b) => String(b.saved || "").localeCompare(String(a.saved || "")));
      return { v: 1, items };
    },
    notes(local, server) {
      const notes = Object.assign({}, (server && server.notes) || {});
      Object.entries((local && local.notes) || {}).forEach(([id, n]) => {
        if (!notes[id] || String(n.updated || "") >= String(notes[id].updated || "")) notes[id] = n;
      });
      return { v: 1, notes };
    },
    reading(local, server) {
      const works = Object.assign({}, (server && server.works) || {});
      Object.entries((local && local.works) || {}).forEach(([slug, r]) => {
        if (!works[slug] || String(r.at || "") >= String(works[slug].at || "")) works[slug] = r;
      });
      return { v: 1, works };
    },
    parallel: (local, server) => Object.assign({}, server || {}, local || {}),
    marks(local, server) {
      const marks = JSON.parse(JSON.stringify((server && server.marks) || {}));
      Object.entries((local && local.marks) || {}).forEach(([id, g]) => {
        if (!g || !Array.isArray(g.items)) return;
        const into = marks[id] || Object.assign({}, g, { items: [] });
        const byId = new Map((into.items || []).map((m) => [m.id, m]));
        g.items.forEach((m) => { const o = byId.get(m.id); if (!o || String(m.updated || "") >= String(o.updated || "")) byId.set(m.id, m); });
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
    if (push) schedulePush(200);
    updateAccountNav();
    if (changed) {
      updateShelfNav();
      if (/^#\/(shelf|account)/.test(location.hash) && DATA) route();
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
        size: "large", text: "continue_with", shape: "pill", logo_alignment: "left", width: 280 });
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
            ${marks.length > 12 ? `<p class="acct-more"><a href="#/shelf">All ${num(marks.length)} on your shelf →</a></p>` : ""}`
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
  let READING_NOW = null;    // {slug, i, el} while a book of a work is on screen
  let pendingResume = null;  // {slug, i, frac} set by a "Continue reading" link
  let readingTimer = 0;
  function readingFrac(el) {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (window.innerHeight * 0.3 - r.top) / Math.max(1, r.height)));
  }
  function noteReading() {
    const n = READING_NOW;
    if (n && n.el.isConnected) setReading(n.slug, n.i, readingFrac(n.el));
  }
  window.addEventListener("scroll", () => {
    if (!READING_NOW) return;
    clearTimeout(readingTimer); readingTimer = setTimeout(noteReading, 400);
  }, { passive: true });
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
    return paras.map((p) => `<p>${esc(p)}</p>`).join("");
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
        const counted = !argument && /\p{Ll}/u.test(l) && ++n % 5 === 0;
        return `<span class="ln" data-i="${i++}"${counted ? ` data-n="${n}"` : ""}>${esc(l.replace(/\s+$/, ""))}</span><br>`;
      }).join("")}</p>`;
    }).join("");
  }
  // Long poems (over 40 lines) and every verse work section get a line-number switch;
  // the reader's choice is remembered in this browser.
  const LN_KEY = "pc-line-numbers";
  function lineNumbersOn() {
    try { return localStorage.getItem(LN_KEY) === "1"; } catch (e) { return false; }
  }
  // The text block with its label row. o: {label, translator, lang, work, parallel}
  // parallel: the "Read with the translation" control (parCtlHTML); the text then sits in
  // .text-solo, with an empty .fx-slot beside it for the facing pages.
  function poemBlock(text, o) {
    const prose = isProse(text, o.translator);
    const numberable = !prose && (o.work || lineCount(text) > 40);
    const on = numberable && lineNumbersOn();
    const label = o.label ? `<p class="section-label">${o.label}</p>` : "";
    const head = numberable || o.parallel ? `
      <div class="ln-bar">${label}${o.parallel || ""}
        ${numberable ? `<span class="ln-ctl"><span class="ln-note"${on ? "" : " hidden"}>Numbered as printed in this edition</span>
        <button class="ln-toggle" type="button" aria-pressed="${on}">Line numbers</button></span>` : ""}
      </div>` : label;
    const solo = `
      <div class="poem-text${prose ? " is-prose" : ""}${on ? " numbered" : ""}"${o.lang || ""}>${poemHTML(text, prose)}</div>
      ${prose ? `<p class="prose-note">This translation is printed as prose in its source edition.</p>` : ""}`;
    return `${head}${o.parallel ? `<div class="text-solo">${solo}</div><div class="fx-slot" hidden></div>` : solo}`;
  }
  function bindLineNumbers() {
    const btn = app.querySelector(".ln-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      app.querySelector(".poem-text").classList.toggle("numbered", on);
      app.querySelector(".ln-note").hidden = !on;
      try { localStorage.setItem(LN_KEY, on ? "1" : "0"); } catch (e) { /* private window: not remembered */ }
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
  const indexPoem = (id) => (DATA && DATA.poems.find((q) => q.id === id)) || {};
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
  // break) comes before it. The maps count these units from 1.
  function textUnits(text) {
    const out = [];
    let gap = false;
    String(text || "").split("\n").forEach((l) => {
      if (!l.trim()) { gap = out.length > 0; return; }
      out.push({ t: l.replace(/\s+$/, ""), gap });
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
    const blocks = e.mode === "blocks";
    return {
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
  function oeLines(w, s, merged) {
    const [a, b] = s.oe;
    const out = new Array(Math.max(0, b - a + 1));
    const put = (sec, from, to) => {
      let n = from - 1;
      textUnits(sec.text).forEach((u) => {
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
  function trUnits(sec, s) {
    const us = textUnits(sec.text);
    (s.skip || []).forEach((k) => { if (us[k - 1]) us[k - 1].skip = true; });
    (s.caps || []).forEach((k) => { if (us[k - 1]) us[k - 1].cap = true; });
    const chunks = (s.chunks || []).filter((c) => c.oe && c.paras);
    if (!chunks.length) return { units: us, map: null };
    const pieces = us.map((u) => [u]);
    chunks.forEach((c) => {
      const u = us[c.paras[0] - 1];
      const at = c.from && u && pieces[c.paras[0] - 1].length === 1 ? u.t.indexOf(c.from) : -1;
      if (at > 0) pieces[c.paras[0] - 1] = [Object.assign({}, u, { t: u.t.slice(0, at).trimEnd() }),
                                            Object.assign({}, u, { t: u.t.slice(at), gap: false })];
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
  function sectionRows(e, s, wo, wt) {
    const sec = wt.sections[s.tr];
    if (!sec || !s.oe) return [];
    const a = s.oe[0];
    const O = oeLines(wo, s, e.merged), T = trUnits(sec, s);
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
  function workFacing(cur, slug, i, other, e) {
    const isOrig = e.orig === slug;
    const wo = isOrig ? cur : other, wt = isOrig ? other : cur;
    const secs = e.sections.filter((s) => (isOrig ? oeApplies(s, cur, i) : s.tr === i));
    const r = isOrig && secRange(cur.sections[i].title);
    let rows = [];
    secs.forEach((s) => {
      let part = sectionRows(e, s, wo, wt);
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
    return {
      rows, blocks: !e.lfl, lang: e.lang, prose: isProse(trText, wt.translator), translator: wt.translator,
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
    // Every fifth line is numbered, and in "blocks" mode the first line of each passage too.
    const oLine = (u, k) => {
      const shown = u.n && !u.nonum && (u.n % 5 === 0 || (m.blocks && k === 0));
      return `<span class="ln${k && u.gap ? " fx-gap" : ""}${u.head ? " fx-hd" : ""}"${shown ? ` data-n="${u.n}"` : ""}>${esc(u.t)}</span><br>`;
    };
    // A caption that is a fitt numeral comes out of the scan as "Ill"; it is "III".
    const capText = (t) => (/^[IVXl1]+$/.test(t.trim()) ? t.replace(/[l1]/g, "I") : t);
    // Prose sets as paragraphs beside a passage; facing line by line (Charm 10's prose close
    // in a verse translation) every unit is a line.
    const paras = m.prose && m.blocks;
    const tUnit = (u, k) => u.cap ? `<p class="fx-cap">${esc(capText(u.t))}</p>`
      : paras ? `<p>${esc(u.t)}</p>`
      : `<span class="ln${k && u.gap ? " fx-gap" : ""}">${esc(u.t)}</span><br>`;
    // Prose: a piece that starts in lower case goes on with the paragraph before it (the
    // printed book's page breaks cut Kennedy's paragraphs: "swiftly van-" / "ished ; light").
    const tCell = (us) => {
      if (!paras) return us.map(tUnit).join("");
      const out = [];
      us.forEach((u) => {
        const last = out[out.length - 1];
        if (last && !u.cap && !last.cap && /^[a-z]/.test(u.t)) last.t = /[a-z]-$/.test(last.t) ? last.t.slice(0, -1) + u.t : last.t + " " + u.t;
        else out.push({ t: u.t, cap: u.cap });
      });
      return out.map(tUnit).join("");
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
      <div class="fx" data-view="${view}" data-mode="${m.blocks ? "blocks" : "lines"}">
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
      if (!e) slot.innerHTML = "";
      if (ctx.onShow) ctx.onShow(e ? slot : solo);
    };
    const open = (e) => {
      const other = FX_READY.get(ctx.kind + ":" + e.with);
      if (other) {
        slot.innerHTML = facingHTML(ctx.build(e, other));
        bindFacingView(slot);
        show(e);
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

  // ---------- "Aa": reading text size and theme ----------
  // Kept in this browser only (pc-text: "", "l", "xl"; pc-theme: "", "light", "dark") and put
  // on <html> as data-text / data-theme, which styles.css reads. The small script at the top
  // of index.html (and of the static pages) applies them before the page is drawn, so a
  // night reader never sees a white flash. "Auto" (no theme) follows the device's setting.
  const VIEW_KEYS = { text: "pc-text", theme: "pc-theme" };
  const viewPref = (kind) => document.documentElement.dataset[kind] || "";
  function setViewPref(kind, v) {
    const root = document.documentElement;
    if (v) root.dataset[kind] = v; else delete root.dataset[kind];
    try { if (v) localStorage.setItem(VIEW_KEYS[kind], v); else localStorage.removeItem(VIEW_KEYS[kind]); }
    catch (e) { /* private window: kept for this visit only */ }
  }
  function readingToolsHTML() {
    const opt = (kind, v, label, extra) =>
      `<button type="button" data-${kind}="${v}" aria-pressed="${viewPref(kind) === v}"${extra || ""}>${label}</button>`;
    return `<div class="rt">
        <button class="rt-toggle" type="button" aria-expanded="false" aria-controls="rt-panel" aria-label="Text size and theme" title="Text size and theme">Aa</button>
        <div class="rt-panel" id="rt-panel" hidden>
          <div class="rt-row"><span class="rt-label">Text size</span><span class="rt-opts">
            ${opt("text", "", "A", ` class="rt-a rt-a1" aria-label="Standard text"`)}
            ${opt("text", "l", "A", ` class="rt-a rt-a2" aria-label="Larger text"`)}
            ${opt("text", "xl", "A", ` class="rt-a rt-a3" aria-label="Largest text"`)}
          </span></div>
          <div class="rt-row"><span class="rt-label">Theme</span><span class="rt-opts">
            ${opt("theme", "", "Auto", ` title="Follow this device's light or dark setting"`)}
            ${opt("theme", "light", "Light")}
            ${opt("theme", "dark", "Dark")}
          </span></div>
        </div>
      </div>`;
  }
  function bindReadingTools() {
    const box = app.querySelector(".rt");
    if (!box) return;
    const btn = box.querySelector(".rt-toggle"), panel = box.querySelector(".rt-panel");
    btn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      btn.setAttribute("aria-expanded", String(!panel.hidden));
    });
    panel.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const kind = "text" in b.dataset ? "text" : "theme";
      setViewPref(kind, b.dataset[kind]);
      panel.querySelectorAll(`[data-${kind}]`).forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    }));
  }
  // A click outside the panel, or Escape, closes it (one listener for every page).
  function closeReadingTools(refocus) {
    const box = app.querySelector(".rt");
    if (!box || box.querySelector(".rt-panel").hidden) return;
    box.querySelector(".rt-panel").hidden = true;
    const btn = box.querySelector(".rt-toggle");
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }
  document.addEventListener("click", (e) => { const box = app.querySelector(".rt"); if (box && !box.contains(e.target)) closeReadingTools(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeReadingTools(true); });

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
  fetch("data/home.json", { priority: "high" })
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => {
      if (h && typeof h.count === "number" && h.eras) HOME = h; else HOME_FAILED = true;
    }, () => { HOME_FAILED = true; })
    .then(() => {
      if (DATA) return;                       // the index won the race: nothing to do
      const fc = document.getElementById("foot-count");
      if (HOME && fc && !fc.textContent) fc.textContent = num(HOME.count);
      if (isHomeHash(location.hash)) route(); // other pages already say "Opening the archive…"
      afterPaint(loadIndex);
    });
  setTimeout(() => {
    if (HOME || DATA || HOME_FAILED) return;
    HOME_FAILED = true;
    loadIndex();
    if (isHomeHash(location.hash)) route();
  }, 1500);

  // The index (32 MB; reading it holds the page up for half a second or more on a phone) is
  // fetched only once the first screen is drawn: the home page from home.json, a poem or a
  // book from its shard. Any other page asks for it at once (routeEarly).
  let INDEX_STARTED = false;
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
          // A poem or a book drawn from its shard: drawn again in place, where the reader is.
          const y = window.scrollY;
          route();
          restoreY = y;
          jumpTo(y);
        } else route();
      })
      .catch((e) => {
        INDEX_ERROR = String(e && e.message || e);
        EARLY_HOME = "";
        app.innerHTML = indexErrorHTML();
      });
  }
  const afterPaint = (fn) => requestAnimationFrame(() => setTimeout(fn, 60));
  // (isHomeHash is defined further down: the same test is written out here.)
  if (!location.hash || /^#\/?(\?.*)?$/.test(location.hash) || /^#\/(poem|work)\/[\w-]+\/\d+$/.test(location.hash)) setTimeout(loadIndex, 2500);
  else loadIndex();
  // A signed-in reader: the account's copy is pulled after the first paint (reader accounts).
  updateAccountNav();
  if (signedIn()) setTimeout(pullNow, 1200);   // a timer, not a frame: it runs in a background tab too
  const indexErrorHTML = () => `<p class="empty">Could not load the archive (${esc(INDEX_ERROR)}).<br>Serve this through a local server, not a file:// path.</p>`;

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
      input.addEventListener("input", (e) => {
        query = e.target.value.trim();
        if (query) { filterSubject = "All"; filterForm = "All"; }
        syncSearchInput();
        clearTimeout(searchTimer);
        if (onArchive()) { searchTimer = setTimeout(freshList, 150); return; }
        const bar = document.querySelector(".tb-search input");
        if (bar && bar !== input) {
          setRoute("poems", "sub");             // shows the top bar before the hash changes
          bar.value = e.target.value;
          bar.focus();
          bar.setSelectionRange(bar.value.length, bar.value.length);
        }
        location.hash = "#/poems";
      });
    });
    document.querySelectorAll("form.search-form").forEach((form) => {
      if (form.dataset.wired) return;
      form.dataset.wired = "1";
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        clearTimeout(searchTimer);
        if (!onArchive()) location.hash = "#/poems"; else freshList();
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
    if (!DATA && !EARLY_HOME) return;   // nothing drawn yet whose place is worth keeping
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
  const EARLY_NAV = [[/^#\/(poems|poem|work|category|today)\b/, "poems"], [/^#\/poets?\b/, "poets"],
    [/^#\/topics/, "topics"], [/^#\/about/, "about"], [/^#\/shelf/, "shelf"], [/^#\/account/, "account"], [/^#\/oracle/, "oracle"], [/^#\/eras/, "eras"]];
  // Before the index is in: the home page from home.json if it has come (while it is on its
  // way the home page shows only the masthead), anything else "Opening the archive…".
  // route() draws the page properly when the index arrives.
  function routeEarly() {
    const h = location.hash;
    updateShelfNav();
    if (isHomeHash(h)) {
      setRoute("poems", "home");
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
    // A poem or a book of a work is drawn from its shard at once; the index redraws it later.
    let m;
    if (!INDEX_ERROR && (m = h.match(/^#\/poem\/([\w-]+)\/(\d+)$/))) { setRoute("poems", "sub"); renderDetail(m[1], parseInt(m[2], 10)); return; }
    if (!INDEX_ERROR && (m = h.match(/^#\/work\/([\w-]+)\/(\d+)$/))) { setRoute("poems", "sub"); renderWorkSection(m[1], parseInt(m[2], 10)); return; }
    loadIndex();
    const nav = EARLY_NAV.find(([re]) => re.test(h));
    setRoute(nav ? nav[1] : "", "sub");
    app.innerHTML = INDEX_ERROR ? indexErrorHTML() : `<p class="loading">Opening the archive…</p>`;
  }
  function route() {
    if (!DATA) { routeEarly(); return; }
    if (READING_NOW) { clearTimeout(readingTimer); noteReading(); READING_NOW = null; }
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
    if (h === "#/today") {
      // The day's poem, from a link that never changes (the footer's, or a bookmark).
      const p = poemOfTheDay();
      location.replace(location.href.split("#")[0] + (p ? "#/poem/" + p.id : "#/"));
    }
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
    else if ((m = h.match(/^#\/poem\/([\w-]+)\/(\d+)$/))) { setRoute("poems", "sub"); renderDetail(m[1], parseInt(m[2], 10)); }
    else if ((m = h.match(/^#\/work\/([\w-]+)\/(\d+)$/))) { setRoute("poems", "sub"); renderWorkSection(m[1], parseInt(m[2], 10)); }
    else if ((m = h.match(/^#\/work\/([\w-]+)\/(\d+)\/with\/([\w-]+)$/))) { setRoute("poems", "sub"); renderCompare(m[1], parseInt(m[2], 10), m[3]); }
    else if ((m = h.match(/^#\/work\/([\w-]+)$/))) { setRoute("poems", "sub"); renderWork(m[1]); }
    else if ((m = h.match(/^#\/poet\/([\w-]+)$/))) { setRoute("poets", "sub"); renderPoet(m[1]); }
    else if ((m = h.match(/^#\/category\/([\w-]+)$/))) { setRoute("poems", "sub"); renderCategory(m[1]); }
    else if (h.startsWith("#/poets")) { setRoute("poets", "sub"); renderPoets(); }
    else if (h.startsWith("#/topics")) { setRoute("topics", "sub"); renderTopics(); }
    else if (h.startsWith("#/about")) { setRoute("about", "sub"); renderAbout(); }
    else if (h.startsWith("#/shelf")) { setRoute("shelf", "sub"); renderShelf(); }
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
    else { setRoute("poems", "home"); renderHome(); }
    syncSearchInput();
    updateShelfNav();
    jumpTo(st ? st.y : 0);
    restoreY = st ? st.y : 0;
  }
  function setRoute(navKey, mode) {
    document.body.dataset.route = mode;   // "home" shows hero; anything else hides it
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
  const cardHTML = (p) => `
    <a class="card" href="#/poem/${esc(p.id)}">
      <div class="card-subject">${esc(p.primarySubject)}</div>
      <h2 class="card-title"${langAttr(p.authorSlug, p.translator)}>${esc(p.title)}</h2>
      <div class="card-author">${esc(p.author)}</div>
      <p class="card-excerpt"${langAttr(p.authorSlug, p.translator)}>${esc(p.excerpt)}</p>
    </a>`;

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
    setTitle("The Archive");
    app.innerHTML = `
      <div class="page-head archive-head">
        <h1 class="page-title">The Archive</h1>
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
  function poemOfTheDay() {
    const fits = (p) => p.excerpt && p.excerpt.split("\n").every((l) => l.length <= 90);
    let pool = DATA.poems.filter((p) => p.hasNote && fits(p));
    if (!pool.length) pool = DATA.poems.filter(fits);
    if (!pool.length) return null;
    return pool[(utcDay() * 7919) % pool.length];
  }
  // Today's row of home.json, as an object like an index entry (plus `lang`), or null.
  function homePoemOfTheDay() {
    const row = HOME.potd && HOME.potd[utcDay() - HOME.potdStart];
    if (!row) return null;
    const p = {};
    (HOME.potdFields || []).forEach((k, i) => { p[k] = row[i]; });
    return p.id && p.title ? p : null;
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
      ${potd}

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

    setTitle(catName + " poetry");
    app.innerHTML = `
      <button class="back" id="back">← Browse by Era</button>
      <div class="page-head"><h1 class="page-title">${esc(catName)}</h1><p class="page-sub">${sub}</p></div>
      <div class="grid">
        ${works.map(workCardHTML).join("")}
        ${pagedCards(poems)}
        ${!works.length && !poems.length ? `<p class="empty">Nothing filed here yet.</p>` : ""}
      </div>
      ${moreHTML(poems.length)}`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/"; });
    bindMore(poems);
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
  function epicCardHTML(ws) {
    if (ws.length === 1) return workCardHTML(ws[0]);
    const vs = ws.slice().sort((a, b) => (!a.translator ? -1 : !b.translator ? 1 : (verYear(a) || "9").localeCompare(verYear(b) || "9")));
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
        <li><a href="#/work/${esc(w.slug)}"${w.translator ? "" : langAttr(w.authorSlug, "")}>${esc(verNames(w))}${verYear(w) ? ` <span class="ev-year">${esc(verYear(w))}</span>` : ""}</a></li>`).join("")}
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
    const results = SORTED.filter((p) => matches(p, words));
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
      ${banner}
      ${query ? "" : `<div class="chips">${chips}</div>${formChips}`}
      <p class="result-meta">${num(results.length)} poem${results.length === 1 ? "" : "s"}${filterSubject !== "All" ? " · " + esc(filterSubject) : ""}${filterForm !== "All" ? " · " + esc(formLabel(filterForm)) : ""}</p>
      <div class="grid">${works.map(workCardHTML).join("")}${results.length || works.length ? pagedCards(results) : `<p class="empty">No poems match.</p>`}</div>
      ${moreHTML(results.length)}`;

    app.querySelectorAll(".chip[data-sub]").forEach((c) => c.addEventListener("click", () => { filterSubject = c.dataset.sub; query = ""; syncSearchInput(); freshList(); }));
    app.querySelectorAll(".chip[data-form]").forEach((c) => c.addEventListener("click", () => { filterForm = c.dataset.form; query = ""; syncSearchInput(); freshList(); }));
    const clr = app.querySelector("[data-clear]");
    if (clr) clr.addEventListener("click", () => { query = ""; filterSubject = "All"; filterForm = "All"; syncSearchInput(); freshList(); });
    bindMore(results);
  }

  // ---------- portrait fallback (monogram) ----------
  function portraitImgHTML(p, cls) {
    if (p.portrait) return `<img class="${cls}" src="${esc(p.portrait)}" alt="Portrait of ${esc(p.name)}" loading="lazy" />`;
    const initial = esc(p.name.trim().charAt(0));
    return `<div class="${cls} pc-monogram" aria-label="No confirmed portrait of ${esc(p.name)}"><span>${initial}</span></div>`;
  }

  // ---------- POETS index ----------
  function renderPoets() {
    setTitle("Poets");
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Poets</h1><p class="page-sub">Poets from Homer to the early twentieth century.</p></div>
      <div class="poet-grid">
        ${DATA.poets.map((p) => `
          <a class="poet-card" href="#/poet/${esc(p.slug)}">
            ${portraitImgHTML(p, "pc-img")}
            <div class="pc-body">
              <p class="pc-name">${esc(p.name)}</p>
              <p class="pc-dates">${esc(p.dates)}</p>
              <p class="pc-count">${[
                p.poemCount ? num(p.poemCount) + " poem" + (p.poemCount === 1 ? "" : "s") : "",
              ].filter(Boolean).join(" · ")}</p>
            </div>
          </a>`).join("")}
      </div>`;
  }

  // ---------- POET page ----------
  function renderPoet(slug) {
    const poet = POETS[slug];
    if (!poet) { location.hash = "#/poets"; return; }
    const poems = DATA.poems.filter((p) => p.authorSlug === slug);
    const works = (DATA.works || []).filter((w) => w.authorSlug === slug);
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
              <li><a href="#/work/${esc(w.slug)}"><span class="pl-title">${esc(w.title)}</span><span class="pl-sub">${esc(w.type)} · ${esc(w.year)} · ${num(w.sections.length)} part${w.sections.length === 1 ? "" : "s"}</span></a></li>`).join("")}
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
        ${worksHTML}
        ${poems.length || !works.length ? `<section class="poet-poems">
          <h2>Poems · ${num(poems.length)}</h2>
          <ul class="poem-links">
            ${poems.map((p) => `
              <li><a href="#/poem/${esc(p.id)}"><span class="pl-title"${langAttr(p.authorSlug, p.translator)}>${esc(p.title)}</span><span class="pl-sub">${esc(p.primarySubject)}</span></a></li>`).join("")}
          </ul>
        </section>` : ""}
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/poets"; });
    bindContinue();
  }

  // ---------- WORK: table of contents ----------
  // "The Iliad — Homer, trans. Alexander Pope" when the archive holds more than one
  // translation of a work (as work_title in tools/build_pages.py).
  function workTitle(w) {
    const grouped = w.workGroup && DATA.works.some((o) => o.slug !== w.slug && o.workGroup === w.workGroup);
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
    if (!w || !w.workGroup || !DATA) return [];
    const mine = w.translator ? translatorShort(trName(w.translator)) : "";
    return DATA.works.filter((o) => o.slug !== w.slug && o.workGroup === w.workGroup &&
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
  function otherTrHTML(w, i) {
    const others = otherTranslations(w);
    if (!others.length) return "";
    return `
      <div class="also-tr">
        <p class="section-label">Also in this archive</p>
        ${others.map((o) => {
          const j = i == null ? -1 : matchingPart(w, o, i);
          return `<p class="also-row">${j >= 0
            ? `<a href="#/work/${esc(o.slug)}/${j}">${esc(verLabel(o))} · ${esc(o.sections[j].title)}</a>
               <a class="compare-btn" href="#/work/${esc(w.slug)}/${i}/with/${esc(o.slug)}">Compare side by side</a>`
            : `<a href="#/work/${esc(o.slug)}">${esc(verLabel(o))} →</a>`}</p>`;
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
        ${w.blurb ? `<p class="note-block">${esc(w.blurb)}</p>` : ""}
        ${otherTrHTML(w)}
        ${place ? `<div class="continue-wrap">${continueHTML(w)}
          <button class="continue-forget" type="button">Forget my place</button></div>` : ""}
        <div class="cite-row toc-tools">${shelfButtonHTML(entry)}</div>
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
      return (pick ? loadPartner("work", pick.with).catch(() => null) : Promise.resolve()).then(() => {
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
    EARLY_DRAWN = DATA ? "" : location.hash;
    if (!DATA) afterPaint(loadIndex);
    setTitle(w.sections.length > 1 ? wt.replace(w.title, w.title + ", " + s.title) : wt);
    app.innerHTML = `
      <article class="detail">
        <button class="back" id="back">← ${esc(w.title)} · Contents</button>
        ${readingToolsHTML()}
        <div class="detail-subject">${esc(w.title)} · ${esc(w.year)}</div>
        <h1 class="detail-title">${esc(s.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(w.authorSlug)}">${esc(w.author)}</a>${datesHTML(w.authorSlug)}</p>
        ${sourceLine(w.translator)}
        ${otherTrHTML(WORKS[slug], i)}
        <hr class="rule">
        ${enginePanel(s.text, { gloss: true })}
        ${poemBlock(s.text, { translator: w.translator, lang: langAttr(w.authorSlug, w.translator), work: true,
                              parallel: parCtlHTML("works", slug, par) })}
        <p class="book-source-slot" hidden></p>
        ${citeHTML(cite, entry)}
        <div class="detail-nav">
          <button ${i === 0 ? "disabled" : ""} data-go="${i - 1}"><span class="dir">← Previous</span>${i > 0 ? esc(w.sections[i - 1].title) : ""}</button>
          <button class="next" ${i === w.sections.length - 1 ? "disabled" : ""} data-go="${i + 1}"><span class="dir">Next →</span>${i < w.sections.length - 1 ? esc(w.sections[i + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/work/" + slug; });
    bindEngine({ title: w.title + " \u00b7 " + s.title, author: w.author, text: s.text,
                 id: "work:" + slug + "/" + i });
    bindReadingTools();
    bindLineNumbers();
    // The reading position follows whichever text is on screen, alone or facing its partner.
    bindFacing({ kind: "work", key: "w:" + slug, list: par, build: (e, other) => workFacing(w, slug, i, other, e),
                 onShow: (el) => { if (READING_NOW && READING_NOW.slug === slug) READING_NOW.el = el; } });
    bindCite(cite);
    { const here = location.hash; fetchSources(w.authorSlug).then((d) => applySource(cite, d && d.works && d.works[slug], here)); }
    bindShelfButton(entry);
    bindNote(entry);
    bindMarks(entry);
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
    setReading(slug, i, resume > 0 ? resume : readingFrac(text));
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
        <p>The archive currently holds <strong>${DATA.count.toLocaleString("en-US")} poems</strong>, from the Greek and Roman epics and Anglo-Saxon
        verse through the Middle Ages, the Renaissance, the Romantics and the Victorians to the early
        twentieth century, together with Turkish and Ottoman poetry. Every text is reproduced in full
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
          they happen to use: ask for poems on exile, or on grief that refuses consolation.</li>
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
  // `it` a shelf entry or, for a note on a text not on the shelf, the note itself.
  function shelfRowHTML(it, note) {
    return `
      <li class="shelf-item">
        <a class="shelf-link" href="${esc(routeFor(it.id))}">
          <span class="shelf-title">${esc(it.title)}</span>
          <span class="shelf-by">${esc(byLine(it))}</span>
        </a>
        <span class="shelf-side">${it.saved ? `
          <span class="shelf-date">Saved ${esc(shortDate(it.saved))}</span>
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
  function renderShelf() {
    setTitle("Your shelf");
    const items = shelfItems();
    const notes = allNotes();
    const loose = looseNotes();
    const poems = items.filter((it) => it.kind === "poem");
    const works = items.filter((it) => it.kind !== "poem");
    const group = (name, list, noteOf) => list.length ? `
      <section class="shelf-group">
        <h2>${name} · ${list.length}</h2>
        <ul class="shelf-list">${list.map((it) => shelfRowHTML(it, noteOf(it))).join("")}</ul>
      </section>` : "";
    const savedNote = (it) => notes[it.id];
    app.innerHTML = `
      <article class="shelf">
        <div class="page-head">
          <h1 class="page-title">Your shelf</h1>
          <p class="page-sub">Poems and works you have saved, and your notes. ${signedIn()
            ? `They are kept in your account and in this browser, and no one else can see them. <a href="#/account">Your account →</a>`
            : `They are kept in this browser only: nothing is sent to Poetry Codex, and no one else can see them.${GOOGLE_CLIENT
              ? ` <a href="#/account">Sign in to keep them on all your devices →</a>` : ""}`}</p>
        </div>
        ${visitOnly() ? `<p class="shelf-warn">This browser is not keeping data for this site (a private
          window, or site storage switched off or full), so your shelf will be gone when you close
          this tab. Download it below to keep a copy.</p>` : ""}
        ${items.length || loose.length || markCount() ? group("Poems", poems, savedNote) + group("Works", works, savedNote)
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
        <a href="#/poems">Browse the poems →</a></p>`}
      </article>`;
    app.querySelectorAll(".shelf-remove").forEach((b) => b.addEventListener("click", () => {
      const it = shelfItems().find((x) => x.id === b.dataset.id);
      if (it) toggleShelf(it);
      renderShelf();
    }));
    app.querySelectorAll(".shelf-dl").forEach((b) => b.addEventListener("click", () => {
      const day = new Date().toISOString().slice(0, 10);
      if (b.dataset.format === "json") {
        downloadFile(`poetry-codex-shelf-${day}.json`, "application/json", JSON.stringify(shelfExport(), null, 2));
      } else {
        downloadFile(`poetry-codex-shelf-${day}.md`, "text/markdown", shelfMarkdown());
      }
    }));
  }
  // What the downloads hold: every entry with its permanent address.
  function shelfExport() {
    const notes = allNotes();
    const row = (it) => {
      const n = notes[it.id];
      return { id: it.id, kind: it.kind, title: it.title, author: it.author,
        translator: it.translator || undefined, url: SITE + shelfPath(it.id), saved: it.saved || undefined,
        note: n ? n.text : undefined, noteUpdated: n ? n.updated : undefined };
    };
    return {
      format: "Poetry Codex shelf", version: 1, exported: new Date().toISOString(),
      shelf: shelfItems().map(row), notes: looseNotes().map(row),
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
      const pick = parPick(parList("poems", p.id), p.id);
      return (pick ? loadPartner("poem", pick.with).catch(() => null) : Promise.resolve()).then(() => {
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

    input.addEventListener("input", () => {
      onPick(null);
      const q = fold(input.value.trim());
      if (q.length < 3) return close();
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
      if (!li) return;
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

  function renderDetailReady(poetFile, slug, n, p) {
    const poems = poetFile.poems;
    const themes = p.subjects.length
      ? `<div class="themes">${p.subjects.map((s) => `<span class="theme-tag" data-sub="${esc(s)}">${esc(s)}</span>`).join("")}</div>` : "";
    const lang = langAttr(p.authorSlug, p.translator);
    const form = DATA ? (DATA.poems.find((q) => q.id === p.id) || {}).form : "";   // index only (B3)
    EARLY_DRAWN = DATA ? "" : location.hash;
    if (!DATA) afterPaint(loadIndex);
    const cite = { author: p.author, title: p.title, translator: p.translator, path: `/poem/${slug}/${n}/` };
    const entry = { id: slug + "/" + n, kind: "poem", title: p.title, author: p.author, translator: p.translator || "" };
    const par = parList("poems", p.id);
    setTitle(p.title + " — " + p.author);
    app.innerHTML = `
      <article class="detail">
        <button class="back" id="back">← The Archive</button>
        ${readingToolsHTML()}
        <div class="detail-subject">${esc(p.primarySubject)}${form ? " · " + esc(form) : ""}</div>
        <h1 class="detail-title"${lang}>${esc(p.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(p.authorSlug)}">${esc(p.author)}</a>${datesHTML(p.authorSlug)}</p>
        ${sourceLine(p.translator, p.collection)}
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
        ${DATA ? relatedHTML(p) : ""}
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
    bindLineNumbers();
    bindFacing({ kind: "poem", key: p.id, list: par, build: (e, other) => poemFacing(p, other, e) });
    bindCite(cite);
    { const here = location.hash; fetchSources(p.authorSlug).then((d) => applySource(cite, poemSource(d, p), here)); }
    bindShelfButton(entry);
    bindNote(entry);
    bindMarks(entry);
    restoreScroll();
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
