(() => {
  "use strict";
  const app = document.getElementById("app");
  let DATA = null;
  let query = "";            // the search as typed (folded only when matching)
  let filterSubject = "All";
  // Long card lists are drawn PAGE cards at a time: the whole archive at once is
  // 60,000 elements, slow on a cheap phone. "Show more" adds the next PAGE.
  const PAGE = 60;
  let shown = PAGE;
  let SORTED = [];           // every poem, by title (built once the index arrives)
  const COLLATE = new Intl.Collator("en");
  let POETS = {};      // slug -> poet (index-level: metadata + counts, no full poems)
  let WORKS = {};      // slug -> work (index-level: metadata + section titles/stanzas, no text)
  let CATEGORY_STATS = {}; // category name -> { poems, works }

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
  function fetchWorkFile(slug) {
    if (!WORK_CACHE.has(slug)) {
      WORK_CACHE.set(slug, fetch(`data/works/${encodeURIComponent(slug)}.json`)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .catch((e) => { WORK_CACHE.delete(slug); throw e; }));
    }
    return WORK_CACHE.get(slug);
  }
  function renderLoading() { app.innerHTML = `<p class="loading">Loading…</p>`; }
  function renderFetchError(e) {
    app.innerHTML = `<p class="empty">Could not load this text (${esc(e.message)}).<br>Check your connection and try again.</p>`;
  }

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

  // ---------- attribution ----------
  // The data stores translators as "trans. Name (year)". Pages spell that out;
  // cards drop the trailing date, which the card already shows as the year.
  const translatedBy = (t) => String(t).replace(/^trans\.\s*/i, "Translated by ");
  const translatorShort = (t) => String(t).replace(/\s*\([^)]*\)\s*$/, "");
  // "Translated by … · From <book>", under the author line; empty when neither is known.
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
    const lead = `${esc(end(citeName(o.author)))} ${what}${by}`;
    const mla = `${lead} <i>Poetry Codex</i>, ${esc(url.replace(/^https:\/\//, ""))}. Accessed ${d.getDate()} ${MLA_MONTHS[d.getMonth()]} ${d.getFullYear()}.`;
    const chicago = `${lead} Poetry Codex. Accessed ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}. ${esc(url)}.`;
    const plain = (h) => h.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return [{ style: "MLA", html: mla, text: plain(mla) }, { style: "Chicago", html: chicago, text: plain(chicago) }];
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
    const list = citations(o);
    toggle.addEventListener("click", () => {
      box.hidden = !box.hidden;
      toggle.setAttribute("aria-expanded", String(!box.hidden));
    });
    const link = app.querySelector(".cite-link");
    link.addEventListener("click", () => copyText(link.dataset.url)
      .then(() => flash(link, "Link copied"), () => flash(link, link.dataset.url)));
    app.querySelectorAll(".cite-copy").forEach((b) => b.addEventListener("click", () => {
      const c = list[+b.dataset.i];
      copyText(c.text, c.html, document.getElementById("cite-" + b.dataset.i))
        .then(() => flash(b, "Copied"), () => flash(b, "Press Ctrl+C"));
    }));
  }

  // ---------- the reader's shelf and private notes ----------
  // "Save to shelf" keeps a poem, a long work or one book of it, and "Add a note" a note
  // on a poem or a book, in this browser's localStorage and nowhere else: no account,
  // nothing sent to the site, nothing shared.
  // Where the browser keeps no site data (some private windows, storage switched off, or
  // full) the shelf lasts for this visit only, and the shelf page says so and offers the
  // download. Ids are the Codex's own: "keats/0" (a poem), "work:iliad-pope" (a work),
  // "work:iliad-pope/5" (one part of it); each entry keeps the title it was saved under.
  const SHELF_KEY = "pc-shelf";
  const NOTES_KEY = "pc-notes";
  const NOTE_MAX = 5000;
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
    if (text.trim()) notes[entry.id] = Object.assign({}, entry, { text, updated: new Date().toISOString() });
    else delete notes[entry.id];
    const kept = writeStore(NOTES_KEY, { v: 1, notes });
    updateShelfNav();
    return kept;
  }
  // The top bar's "Shelf" appears once there is something on it.
  function updateShelfNav() {
    const show = shelfItems().length > 0 || Object.keys(allNotes()).length > 0 || /^#\/shelf/.test(location.hash);
    document.querySelectorAll('[data-nav="shelf"]').forEach((a) => { a.hidden = !show; });
  }
  const shelfPath = (id) => id.startsWith("work:") ? "/work/" + id.slice(5) + "/" : "/poem/" + id + "/";
  const VISIT_ONLY = "This browser is not keeping data for this site, so your shelf lasts for this visit only. Download it from your shelf before you close the tab.";
  const NOTE_KEPT = "Private: kept in this browser only, never sent to Poetry Codex. It also appears on your shelf.";
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
        <p class="note-status">${visitOnly() ? NOTE_VISIT : NOTE_KEPT}</p>
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
      status.textContent = kept ? NOTE_KEPT : NOTE_VISIT;
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
  window.addEventListener("storage", (e) => {      // saved or removed in another tab
    if (e.key !== SHELF_KEY && e.key !== NOTES_KEY && e.key !== null) return;
    updateShelfNav();
    if (DATA && /^#\/shelf/.test(location.hash)) renderShelf();
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
    let n = 0, skipNext = false;
    return stanzas.map((st) => {
      const ls = st.split("\n").filter((l) => l.trim());
      const first = ls[0].trim();
      const argument = skipNext || ARGUMENT.test(first);
      skipNext = ARGUMENT.test(first) && ls.length === 1;
      return `<p class="stanza">${ls.map((l) => {
        const counted = !argument && /\p{Ll}/u.test(l) && ++n % 5 === 0;
        return `<span class="ln"${counted ? ` data-n="${n}"` : ""}>${esc(l.replace(/\s+$/, ""))}</span><br>`;
      }).join("")}</p>`;
    }).join("");
  }
  // Long poems (over 40 lines) and every verse work section get a line-number switch;
  // the reader's choice is remembered in this browser.
  const LN_KEY = "pc-line-numbers";
  function lineNumbersOn() {
    try { return localStorage.getItem(LN_KEY) === "1"; } catch (e) { return false; }
  }
  // The text block with its label row. o: {label, translator, lang, work}
  function poemBlock(text, o) {
    const prose = isProse(text, o.translator);
    const numberable = !prose && (o.work || lineCount(text) > 40);
    const on = numberable && lineNumbersOn();
    const label = o.label ? `<p class="section-label">${o.label}</p>` : "";
    const head = numberable ? `
      <div class="ln-bar">${label}
        <span class="ln-ctl"><span class="ln-note"${on ? "" : " hidden"}>Numbered as printed in this edition</span>
        <button class="ln-toggle" type="button" aria-pressed="${on}">Line numbers</button></span>
      </div>` : label;
    return `${head}
      <div class="poem-text${prose ? " is-prose" : ""}${on ? " numbered" : ""}"${o.lang || ""}>${poemHTML(text, prose)}</div>
      ${prose ? `<p class="prose-note">This translation is printed as prose in its source edition.</p>` : ""}`;
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

  // ---------- era/category taxonomy ----------
  // Umbrella categories applied to every poet's `category` field (see data/poets/<slug>.json).
  // Order here is the display/chronological order used on the home page.
  const CATEGORY_ORDER = [
    "Ancient Greek & Roman",
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
    "Italian",
    "French",
    "Nordic",
  ];
  const CATEGORY_SLUGS = {
    "Ancient Greek & Roman": "ancient-greek-roman",
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
    "Italian": "italian",
    "French": "french",
    "Nordic": "nordic",
  };
  const SLUG_TO_CATEGORY = Object.fromEntries(Object.entries(CATEGORY_SLUGS).map(([k, v]) => [v, k]));
  const EPICS_SLUG = "epics";
  // "Epics" is a cross-cutting tag derived from each work's existing `type` field
  // (e.g. "Epic poem", "Heroic poem", "Historical epic") rather than a duplicated
  // boolean flag in the data — one regex here keeps the work files untouched.
  const isEpicWork = (w) => /\b(epic|heroic poem)\b/i.test(w.type || "");

  fetch("data/index.json")
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
      // Sorted by title once; every list filters this and so keeps the order.
      d.poems.forEach((p) => { p._sk = sortKey(p.title); });
      SORTED = d.poems.slice().sort((a, b) => COLLATE.compare(a._sk, b._sk));
      const fc = document.getElementById("foot-count"); if (fc) fc.textContent = d.count;
      const fp = document.getElementById("foot-poets"); if (fp) fp.textContent = d.poets.length;
      wireSearch();
      route();
    })
    .catch((e) => {
      app.innerHTML = `<p class="empty">Could not load the archive (${esc(e.message)}).<br>Serve this through a local server, not a file:// path.</p>`;
    });

  // ---------- global search ----------
  // Typing redraws the list 150 ms after the last key, not on every key. Typing anywhere
  // but the archive goes to it; the top bar's box takes over at once, so the reader can
  // keep typing even though the box they started in (home page, Eras page) goes away.
  let searchTimer = 0;
  const onArchive = () => /^#\/poems(\?|$)/.test(location.hash);
  function freshList() { shown = PAGE; renderList(); jumpTo(0); saveView(); }
  function wireSearch() {
    document.querySelectorAll("input.search-input").forEach((input) => {
      input.value = query;
      if (input.dataset.wired) return;          // safe to call again after a render
      input.dataset.wired = "1";
      input.addEventListener("input", (e) => {
        query = e.target.value.trim();
        if (query) filterSubject = "All";
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
    if (!DATA) return;
    try {
      history.replaceState(Object.assign({}, history.state,
        { y: Math.round(window.scrollY), shown, query, filterSubject }), "");
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
  function route() {
    if (!DATA) return;
    const h = location.hash || "#/";
    // Back/Forward bring back the entry's saved view; anything else is a fresh visit.
    const st = history.state && typeof history.state.y === "number" ? history.state : null;
    shown = st && st.shown > PAGE ? st.shown : PAGE;
    if (st && /^#\/poems(\?|$)/.test(h)) {
      query = st.query || "";
      filterSubject = st.filterSubject || "All";
    }
    let m;
    if ((m = h.match(/^#\/poem\/(\d+)$/))) {
      // Legacy link: #/poem/<arrayIndex> from the old single-poems.json array.
      // Resolve via the frozen legacyIndex map and redirect to the new stable id.
      setRoute("poems", "sub");
      const oldI = parseInt(m[1], 10);
      const id = DATA.legacyIndex && DATA.legacyIndex[oldI];
      if (id) location.replace(location.href.split("#")[0] + "#/poem/" + id);
      else { app.innerHTML = `<p class="empty">That poem could not be found.</p>`; }
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
    else if (h.startsWith("#/oracle")) { setRoute("oracle", "sub"); renderOracle(); }
    else if (h.startsWith("#/eras")) { setRoute("eras", "sub"); renderEras(); }
    else if (h.startsWith("#/poems")) {
      // "#/poems?q=keats" (the 404 page's search box) opens the archive already searched.
      const q = h.match(/[?&]q=([^&]*)/);
      if (q) {
        try { query = decodeURIComponent(q[1].replace(/\+/g, " ")).trim(); } catch (e) { query = ""; }
        filterSubject = "All";
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
  }

  // ---------- helpers ----------
  // words: searchWords(query). Full poem text is not in the index (that's the whole
  // point of the split), so search covers title, poet, translator, the opening lines
  // and subjects; the folded text is built the first time a poem is searched.
  function matches(p, words) {
    if (filterSubject !== "All" && p.primarySubject !== filterSubject) return false;
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
    return left > 0 ? `<div class="more-row"><button class="more-btn" type="button">Show ${Math.min(PAGE, left)} more<span class="more-left"> · ${left} left</span></button></div>` : "";
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
      <span class="work-flag">Read in ${w.sections.length} parts →</span>
    </a>`;

  // ---------- HOME: browse by era ----------
  // The era grid, shared by the home page and #/eras.
  function eraGridHTML() {
    const epicCount = (DATA.works || []).filter(isEpicWork).length;
    const tiles = CATEGORY_ORDER.map((cat) => {
      const stats = CATEGORY_STATS[cat] || { poems: 0, works: 0 };
      return `
        <a class="topic-card" href="#/category/${esc(CATEGORY_SLUGS[cat])}">
          <p class="tc-name">${esc(cat)}</p>
          <p class="tc-count">${[
            stats.poems ? stats.poems + " poem" + (stats.poems === 1 ? "" : "s") : "",
            stats.works ? stats.works + " work" + (stats.works === 1 ? "" : "s") : "",
          ].filter(Boolean).join(" \u00b7 ")}</p>
        </a>`;
    }).join("");
    return `
      <div class="topic-grid">
        ${tiles}
        <a class="topic-card epics-tile" href="#/category/${EPICS_SLUG}">
          <p class="tc-name">Epics</p>
          <p class="tc-count">${epicCount} work${epicCount === 1 ? "" : "s"} \u00b7 every era</p>
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
      <div class="browse-all"><a href="#/poems" class="read-link">Or browse all ${DATA.count} poems \u2192</a></div>`;
    wireSearch();
  }

  function renderHome() {
    setTitle("");
    // Two doors under one roof: the collection, and the way of asking about it.
    // The Oracle keeps its place even while it sleeps, so the shape of the site
    // does not change when it wakes.
    app.innerHTML = `
      <div class="doors">
        <a class="door door-archive" href="#/eras">
          <img src="archive-248.webp" alt="" width="124" height="124" />
          <span class="d-name">The Archive</span>
          <span class="d-line">${DATA.count} poems by ${DATA.poets.length} poets,
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

      <p class="doors-or">Or go straight to an era</p>
      ${eraGridHTML()}
      <div class="browse-all"><a href="#/poems" class="read-link">Browse all ${DATA.count} poems \u2192</a></div>`;
  }

  // ---------- CATEGORY: filtered era (or cross-cutting "epics") view ----------
  function renderCategory(slug) {
    const isEpics = slug === EPICS_SLUG;
    const catName = isEpics ? "Epics" : SLUG_TO_CATEGORY[slug];
    if (!catName) { location.hash = "#/"; return; }

    const works = isEpics
      ? (DATA.works || []).filter(isEpicWork)
      : (DATA.works || []).filter((w) => POETS[w.authorSlug] && POETS[w.authorSlug].category === catName);
    const poems = isEpics
      ? []
      : SORTED.filter((p) => POETS[p.authorSlug] && POETS[p.authorSlug].category === catName);

    const sub = isEpics
      ? `${works.length} epic work${works.length === 1 ? "" : "s"}, spanning every era in the archive.`
      : `${poems.length} poem${poems.length === 1 ? "" : "s"}${works.length ? " · " + works.length + " work" + (works.length === 1 ? "" : "s") : ""}.`;

    setTitle(isEpics ? "Epics" : catName + " poetry");
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

  const sortKey = (s) => s.toLowerCase().replace(/^["'“‘]*(a|an|the)\s+/, "").replace(/^[^a-z0-9]+/, "").trim();
  function renderList() {
    const words = searchWords(query);
    const results = SORTED.filter((p) => matches(p, words));
    const works = filterSubject !== "All" ? [] : (DATA.works || []).filter((w) => {
      if (!words.length) return true;
      if (w._hay === undefined) w._hay = fold([w.title, w.author, w.translator].join(" "));
      return hasAll(w._hay, words);
    });
    let banner = "";
    if (query) banner = `<div class="filter-banner"><span class="lbl">Search</span> <span class="val">“${esc(query)}”</span><button data-clear="1">Clear ✕</button></div>`;
    const chips = [`<button class="chip ${filterSubject === "All" ? "active" : ""}" data-sub="All">All<span class="n">${DATA.count}</span></button>`]
      .concat(DATA.subjects.map((s) => `<button class="chip ${filterSubject === s.name ? "active" : ""}" data-sub="${esc(s.name)}">${esc(s.name)}<span class="n">${s.count}</span></button>`)).join("");

    setTitle(query ? `\u201c${query}\u201d \u2014 Search` : filterSubject !== "All" ? `Poems on ${filterSubject}` : "All poems");
    app.innerHTML = `
      ${banner}
      ${query ? "" : `<div class="chips">${chips}</div>`}
      <p class="result-meta">${results.length} poem${results.length === 1 ? "" : "s"}${works.length ? " · " + works.length + " work" + (works.length === 1 ? "" : "s") : ""}${filterSubject !== "All" ? " · " + esc(filterSubject) : ""}</p>
      <div class="grid">${works.map(workCardHTML).join("")}${results.length || works.length ? pagedCards(results) : `<p class="empty">No poems match.</p>`}</div>
      ${moreHTML(results.length)}`;

    app.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { filterSubject = c.dataset.sub; query = ""; syncSearchInput(); freshList(); }));
    const clr = app.querySelector("[data-clear]");
    if (clr) clr.addEventListener("click", () => { query = ""; filterSubject = "All"; syncSearchInput(); freshList(); });
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
      <div class="page-head"><h1 class="page-title">Poets</h1><p class="page-sub">${DATA.poets.length} poets, from Homer to the early twentieth century.</p></div>
      <div class="poet-grid">
        ${DATA.poets.map((p) => `
          <a class="poet-card" href="#/poet/${esc(p.slug)}">
            ${portraitImgHTML(p, "pc-img")}
            <div class="pc-body">
              <p class="pc-name">${esc(p.name)}</p>
              <p class="pc-dates">${esc(p.dates)}</p>
              <p class="pc-count">${p.poemCount} poem${p.poemCount === 1 ? "" : "s"}${p.workCount ? " · " + p.workCount + " work" + (p.workCount === 1 ? "" : "s") : ""}</p>
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
    const worksHTML = works.length ? `
        <section class="poet-poems">
          <h2>Major Works</h2>
          <ul class="poem-links">
            ${works.map((w) => `
              <li><a href="#/work/${esc(w.slug)}"><span class="pl-title">${esc(w.title)}</span><span class="pl-sub">${esc(w.type)} · ${esc(w.year)} · ${w.sections.length} parts</span></a></li>`).join("")}
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
            <p class="poet-era">${esc(poet.era)}</p>
            <h1 class="poet-name">${esc(poet.name)}</h1>
            <p class="poet-dates">${esc(poet.dates)}</p>
            <div class="poet-bio">
              ${poet.bio.map((para) => `<p>${para}</p>`).join("")}
            </div>
          </div>
        </div>
        ${worksHTML}
        <section class="poet-poems">
          <h2>Poems · ${poems.length}</h2>
          <ul class="poem-links">
            ${poems.map((p) => `
              <li><a href="#/poem/${esc(p.id)}"><span class="pl-title"${langAttr(p.authorSlug, p.translator)}>${esc(p.title)}</span><span class="pl-sub">${esc(p.primarySubject)}</span></a></li>`).join("")}
          </ul>
        </section>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/poets"; });
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
  function otherTranslations(w) {
    if (!w || !w.workGroup || !w.translator) return [];
    const mine = translatorShort(trName(w.translator));
    return DATA.works.filter((o) => o.slug !== w.slug && o.workGroup === w.workGroup &&
      o.translator && translatorShort(trName(o.translator)) !== mine);
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
            ? `<a href="#/work/${esc(o.slug)}/${j}">${esc(trLabel(o.translator))} · ${esc(o.sections[j].title)}</a>
               <a class="compare-btn" href="#/work/${esc(w.slug)}/${i}/with/${esc(o.slug)}">Compare side by side</a>`
            : `<a href="#/work/${esc(o.slug)}">${esc(trLabel(o.translator))} →</a>`}</p>`;
        }).join("")}
      </div>`;
  }
  function renderWork(slug) {
    const w = WORKS[slug];
    if (!w) { location.hash = "#/"; return; }
    const entry = { id: "work:" + slug, kind: "work", title: w.title, author: w.author, translator: w.translator || "" };
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
        <div class="cite-row toc-tools">${shelfButtonHTML(entry)}</div>
        <p class="shelf-msg" hidden>${VISIT_ONLY}</p>
        <hr class="rule">
        <p class="section-label">Contents · ${w.sections.length} parts</p>
        <ul class="poem-links">
          ${w.sections.map((s, i) => `
            <li><a href="#/work/${esc(w.slug)}/${i}"><span class="pl-title">${esc(s.title)}</span><span class="pl-sub">${s.stanzas} stanzas</span></a></li>`).join("")}
        </ul>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/poet/" + w.authorSlug; });
    bindShelfButton(entry);
  }

  // ---------- WORK: one section (canto) reader ----------
  function renderWorkSection(slug, i) {
    if (!WORKS[slug]) { location.hash = "#/"; return; }
    renderLoading();
    const requestedHash = location.hash;
    fetchWorkFile(slug).then((w) => {
      if (location.hash !== requestedHash) return; // route changed while fetching
      if (!w.sections[i]) { location.hash = "#/work/" + slug; return; }
      renderWorkSectionReady(w, slug, i);
    }).catch((e) => { if (location.hash === requestedHash) renderFetchError(e); });
  }
  function renderWorkSectionReady(w, slug, i) {
    const s = w.sections[i];
    const wt = workTitle(WORKS[slug]);
    const cite = { author: w.author, work: w.title, title: w.sections.length > 1 ? s.title : "",
                   translator: w.translator, path: `/work/${slug}/${i}/` };
    const entry = { id: "work:" + slug + "/" + i, kind: "part", author: w.author, translator: w.translator || "",
                    title: w.sections.length > 1 ? w.title + " · " + s.title : w.title };
    setTitle(w.sections.length > 1 ? wt.replace(w.title, w.title + ", " + s.title) : wt);
    app.innerHTML = `
      <article class="detail">
        <button class="back" id="back">← ${esc(w.title)} · Contents</button>
        <div class="detail-subject">${esc(w.title)} · ${esc(w.year)}</div>
        <h1 class="detail-title">${esc(s.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(w.authorSlug)}">${esc(w.author)}</a></p>
        ${sourceLine(w.translator)}
        ${otherTrHTML(WORKS[slug], i)}
        <hr class="rule">
        ${enginePanel(s.text, { gloss: true })}
        ${poemBlock(s.text, { translator: w.translator, lang: langAttr(w.authorSlug, w.translator), work: true })}
        ${citeHTML(cite, entry)}
        <div class="detail-nav">
          <button ${i === 0 ? "disabled" : ""} data-go="${i - 1}"><span class="dir">← Previous</span>${i > 0 ? esc(w.sections[i - 1].title) : ""}</button>
          <button class="next" ${i === w.sections.length - 1 ? "disabled" : ""} data-go="${i + 1}"><span class="dir">Next →</span>${i < w.sections.length - 1 ? esc(w.sections[i + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/work/" + slug; });
    bindEngine({ title: w.title + " \u00b7 " + s.title, author: w.author, text: s.text,
                 id: "work:" + slug + "/" + i });
    bindLineNumbers();
    bindCite(cite);
    bindShelfButton(entry);
    bindNote(entry);
    app.querySelectorAll(".detail-nav button").forEach((b) => b.addEventListener("click", () => { if (!b.disabled) location.hash = "#/work/" + slug + "/" + b.dataset.go; }));
    restoreScroll();
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
          <p class="compare-tr">${esc(trName(w.translator))}<span class="compare-part"> · ${esc(s.title)}</span></p>
          <a class="compare-open" href="#/work/${esc(w.slug)}/${k}">Read alone →</a>
        </header>
        <div class="compare-pane" tabindex="0" role="region" aria-label="${esc(trLabel(w.translator))}, ${esc(s.title)}">
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
    const sa = trSurname(a.translator), sb = trSurname(b.translator);
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
          ${more.map((o) => `<a class="compare-btn" href="#/work/${esc(slug)}/${i}/with/${esc(o.slug)}">Compare with ${esc(trSurname(o.translator))}</a>`).join("")}
          <button class="compare-jump" type="button" data-to="tr-b">Jump to ${esc(sb)} ↓</button>
        </div>
        </div>
        <div class="compare-grid">
          ${compareColHTML(wa, i, "tr-a")}
          ${j >= 0 ? compareColHTML(wb, j, "tr-b") : `
            <section class="compare-col" id="tr-b">
              <p class="empty">${esc(trLabel(b.translator))} has no part matching ${esc(s.title)}.<br>
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
            <p class="tc-count">${s.count} poem${s.count === 1 ? "" : "s"}</p>
          </button>`).join("")}
      </div>`;
    app.querySelectorAll(".topic-card").forEach((c) => c.addEventListener("click", () => {
      filterSubject = c.dataset.sub; query = ""; syncSearchInput(); location.hash = "#/poems";
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
        <p>The archive currently holds <strong>${DATA.count} poems</strong> by
        <strong>${DATA.poets.length} poets</strong>, from the Greek and Roman epics and Anglo-Saxon
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
        <p>The engine is grounded in the history of criticism itself: the methods, the debates and the
        critics who shaped them. Its purpose is to lead readers to scholarship, not to replace it. Every
        reading is generated and names its method, so that a reader can disagree with it intelligently;
        it never attributes a claim to a named critic. Real citation of scholarship will come when the
        archive is joined to open-access criticism.</p>
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
        <p>Every poem here is in the public domain and is reproduced in full. Translations are pre-1929
        and name their translator; where the book a poem comes from is recorded, its page names that
        too. Poet portraits are likewise public-domain works, courtesy of Wikimedia
        Commons, and each carries its credit.</p>

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
          <p class="page-sub">Poems and works you have saved, and your notes. They are kept in this
          browser only: nothing is sent to Poetry Codex, and no one else can see them.</p>
        </div>
        ${visitOnly() ? `<p class="shelf-warn">This browser is not keeping data for this site (a private
          window, or site storage switched off or full), so your shelf will be gone when you close
          this tab. Download it below to keep a copy.</p>` : ""}
        ${items.length || loose.length ? group("Poems", poems, savedNote) + group("Works", works, savedNote)
          + group("Your notes on other texts", loose, (n) => n) + `
        <section class="shelf-export">
          <h2>Take it with you</h2>
          <p>Your shelf is stored nowhere else. Download a copy to keep it, or to paste into your own notes.</p>
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
      + block("Notes on other texts", looseNotes());
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
          <p>Everything else is open: <a href="#/poems">${DATA.count} poems</a> by
          <a href="#/poets">${DATA.poets.length} poets</a>, arranged
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
    if (!POETS[slug]) { location.hash = "#/"; return; }
    renderLoading();
    const requestedHash = location.hash;
    fetchPoetFile(slug).then((poetFile) => {
      if (location.hash !== requestedHash) return; // route changed while fetching
      const p = poetFile.poems[n];
      if (!p) { location.hash = "#/poet/" + slug; return; }
      renderDetailReady(poetFile, slug, n, p);
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
    async function run(path, payload, credit) {
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
          : "Modern-English gloss, generated by the Poetry Codex critical engine.");
      } else {
        run("/api/analyze", { lens: btn.dataset.lens },
            btn.textContent + " reading, generated by the Poetry Codex critical engine.");
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
          "In answer to: \u201c" + question + "\u201d \u2014 generated by the Poetry Codex critical engine.");
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
          + ", generated by the Poetry Codex critical engine.");
    });
  }

  function renderDetailReady(poetFile, slug, n, p) {
    const poems = poetFile.poems;
    const themes = p.subjects.length
      ? `<div class="themes">${p.subjects.map((s) => `<span class="theme-tag" data-sub="${esc(s)}">${esc(s)}</span>`).join("")}</div>` : "";
    const lang = langAttr(p.authorSlug, p.translator);
    const cite = { author: p.author, title: p.title, translator: p.translator, path: `/poem/${slug}/${n}/` };
    const entry = { id: slug + "/" + n, kind: "poem", title: p.title, author: p.author, translator: p.translator || "" };
    setTitle(p.title + " — " + p.author);
    app.innerHTML = `
      <article class="detail">
        <button class="back" id="back">← The Archive</button>
        <div class="detail-subject">${esc(p.primarySubject)}</div>
        <h1 class="detail-title"${lang}>${esc(p.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(p.authorSlug)}">${esc(p.author)}</a></p>
        ${sourceLine(p.translator, p.collection)}
        ${themes}
        <hr class="rule">
        ${enginePanel(p.text, { compare: true, gloss: true })}
        ${poemBlock(p.text, { label: "The Poem", translator: p.translator, lang })}
        ${p.note ? `<div class="rule-ornament">✦ ✦ ✦</div>
        <p class="section-label">Codex Note</p>
        <p class="note-block">${esc(p.note)}</p>` : ""}
        ${citeHTML(cite, entry)}
        <div class="detail-nav">
          <button ${n === 0 ? "disabled" : ""} data-go="${n - 1}"><span class="dir">← Previous</span>${n > 0 ? esc(poems[n - 1].title) : ""}</button>
          <button class="next" ${n === poems.length - 1 ? "disabled" : ""} data-go="${n + 1}"><span class="dir">Next →</span>${n < poems.length - 1 ? esc(poems[n + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { if (history.length > 1) history.back(); else location.hash = "#/poems"; });
    app.querySelectorAll(".theme-tag").forEach((t) => t.addEventListener("click", () => {
      const isSub = DATA.subjects.some((s) => s.name === t.dataset.sub);
      filterSubject = isSub ? t.dataset.sub : "All";
      query = isSub ? "" : t.dataset.sub;
      syncSearchInput(); location.hash = "#/poems";
    }));
    app.querySelectorAll(".detail-nav button").forEach((b) => b.addEventListener("click", () => { if (!b.disabled) location.hash = "#/poem/" + slug + "/" + b.dataset.go; }));
    bindEngine({ title: p.title, author: p.author, text: p.text, id: p.id });
    bindLineNumbers();
    bindCite(cite);
    bindShelfButton(entry);
    bindNote(entry);
    restoreScroll();
  }
})();
