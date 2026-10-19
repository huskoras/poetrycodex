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
  let TRANSLATORS = null;    // data/translators.json once it is in: {list, bySlug, byString} (translator pages)
  let TRANSLATORS_P = null;  // ...and the fetch of it
  let GLOSSARY = null;       // data/glossary.json once it is in: {list, bySlug} (glossary of poetic terms)
  let GLOSSARY_P = null;     // ...and the fetch of it

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
  // The translator's name links to their page (trByHTML, under "translator pages").
  function sourceLine(translator, collection, extra) {
    const parts = [translator && trByHTML(translator), collection && esc("From " + collection), extra && esc(extra)].filter(Boolean);
    return parts.length ? `<p class="detail-source">${parts.join(" · ")}</p>` : "";
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
        ${entry ? `<button class="cite-print" type="button" aria-haspopup="dialog">Print</button>` : ""}
      </div>
      ${entry ? `<p class="shelf-msg" hidden>${VISIT_ONLY}</p>${noteBoxHTML(entry)}` : ""}
      <div class="cite-box" id="cite-box" hidden>
        ${citations(o).map((c, i) => `
          <div class="cite-entry">
            <p class="cite-style">${c.style}</p>
            <p class="cite-text" id="cite-${i}">${c.html}</p>
            <button class="cite-copy" type="button" data-i="${i}">Copy</button>
          </div>`).join("")}
        ${o.translator ? trCiteHTML(o.translator) : ""}
        <div class="cite-entry cite-recs">
          <p class="cite-style">Files</p>
          <p class="cite-text cite-recs-note">For Zotero, EndNote or Mendeley (RIS) and LaTeX (BibTeX)${o.translator ? ", with the translator" : ""}. Zotero's browser button also saves this page.</p>
          <div class="cite-recs-acts" role="group" aria-label="RIS and BibTeX">
            <button class="cite-copy cite-rec" type="button" data-rec="ris" data-act="copy">Copy RIS</button>
            <button class="cite-copy cite-rec" type="button" data-rec="ris" data-act="save" aria-label="Download .ris file">.ris</button>
            <button class="cite-copy cite-rec" type="button" data-rec="bib" data-act="copy">Copy BibTeX</button>
            <button class="cite-copy cite-rec" type="button" data-rec="bib" data-act="save" aria-label="Download .bib file">.bib</button>
          </div>
        </div>
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
    // RIS and BibTeX: copied as plain text, or saved as a file the reference manager opens.
    app.querySelectorAll(".cite-rec").forEach((b) => b.addEventListener("click", () => {
      const ris = b.dataset.rec === "ris", text = ris ? risRecord(o) : bibRecord(o);
      if (b.dataset.act === "save") {
        downloadFile(citeFileName(o, ris ? "ris" : "bib"), ris ? "application/x-research-info-systems" : "application/x-bibtex", text);
        flash(b, "Saved");
      } else copyText(text).then(() => flash(b, "Copied"), () => flash(b, "Not copied"));
    }));
    app.querySelectorAll(".cite-copy:not(.cite-rec)").forEach((b) => b.addEventListener("click", () => {
      const c = citations(o)[+b.dataset.i];   // o.src may arrive after binding
      copyText(c.text, c.html, document.getElementById("cite-" + b.dataset.i))
        .then(() => flash(b, "Copied"), () => flash(b, "Press Ctrl+C"));
    }));
  }

  // ---------- citation records: Zotero, RIS and BibTeX ----------
  // A reference manager reads a text's details without retyping. metaCitation(o) writes them
  // into the page head as Highwire (citation_*) and Dublin Core (DC.*) tags, which the Zotero
  // Connector's "Embedded Metadata" translator reads, and tells Zotero the page has changed;
  // metaCitation(null) clears them (every route does, before drawing). The static pages are to
  // print the same tags (citation_meta, a patch for build_pages.py not yet applied). The
  // cite box adds RIS and BibTeX, to copy or download. Zotero ignores DC.contributor when citation_author is there, so the
  // translator reaches Zotero only through the RIS file (A4, which it reads as translator).
  // o: the cite object, plus year (the edition year, or "") and lang ("en", "tr").
  // "trans. Andrew Lang, Walter Leaf and Ernest Myers (1911)" -> the three names. Dates,
  // degrees (", M.A."), "and others" and a book after the names ("Henry Sweet, King
  // Alfred's …", "Wentworth Dillon, Earl of Roscommon, in Nott, …") drop out; a title of
  // nobility stays with its name. A list after a comma counts only when it reads as names
  // and ends "and …" or starts "with …"; a phrasing that is not a name gives none at all.
  function citeTranslators(t) {
    const PARTICLE = /^(de|la|del|della|van|von|der|den|of|du|da|di|le|y|al|ibn|bin|and|&|with|others)$/;
    const isName = (x) => !/^(The|A|An)\s/.test(x) && x.trim().split(/\s+(?:&|and|with)\s+/).every((n) => {
      const w = n.split(/\s+/);
      return w.length <= 6 && w.every((v) => /^["“]?[A-ZÀ-ÞĀ-Ž]/.test(v) || PARTICLE.test(v));
    });
    const s = String(t || "").replace(/^trans\.\s*/i, "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ")
      .replace(/,\s*(?:M\.A\.|C\.S\.I\.|D\.D\.|LL\.D\.|Ph\.D\.)/g, "")
      .replace(/,\s*(?=(?:Earl|Lord|Lady|Baron|Viscount|Marquess|Duke|Count|Bishop)\b)/g, "\u0001 ");
    const [first, ...rest] = s.split(/\s*,\s*/).map((x) => x.trim());
    if (!first || !isName(first)) return [];
    const list = rest.length && rest.every(isName) && (/\s(?:and|&)\s/.test(rest[rest.length - 1]) || rest.some((x) => /^with\s/.test(x)))
      ? [first, ...rest] : [first];
    return list.join(" and ").replace(/^with\s+/, "").split(/\s+(?:&|and|with)\s+|^with\s+/)
      .map((x) => x.replace(/^with\s+/, "").replace(/["“”]/g, "").replace(/\u0001/g, ",").trim())
      .filter((x) => x && !/^others$/i.test(x));
  }
  // The edition year, only where the data gives exactly one: the translator's "(1697)" or
  // "(Macmillan school edition, 1910)", else a work's plain "1829". A range, two dates or
  // "c." give none: never a guess.
  function citeYear(translator, year) {
    if (translator) {
      const par = (String(translator).match(/\([^)]*\)/g) || []).join(" ");
      const ys = par.match(/\b1\d{3}\b|\b20\d\d\b/g) || [];
      return ys.length === 1 && !/\bc\.|circa|\?/i.test(par) ? ys[0] : "";
    }
    return /^\d{4}$/.test(String(year || "").trim()) ? String(year).trim() : "";
  }
  // The language of the text on the page: Turkish originals "tr", the Old English originals
  // ("The Wanderer (Old English)", untranslated) "ang", everything else English.
  const citeLang = (slug, translator, title) => langAttr(slug, translator) ? "tr"
    : !String(translator || "").trim() && (POETS[slug] || {}).category === "Anglo-Saxon"
      && /\(Old English\)\s*$/.test(title || "") ? "ang" : "en";
  function metaCitation(o) {
    const had = document.head.querySelector("meta[data-pc-cite]");
    document.head.querySelectorAll("meta[data-pc-cite]").forEach((m) => m.remove());
    if (o) {
      const url = SITE + o.path;
      const tags = [["citation_title", o.work ? (o.title ? o.work + ", " + o.title : o.work) : o.title],
        ["citation_author", citeName(o.author)], ["DC.creator", o.author]]
        .concat(citeTranslators(o.translator).map((n) => ["DC.contributor", n]))
        .concat([["citation_publication_date", o.year || ""], ["DC.publisher", "Poetry Codex"],
          ["citation_public_url", url], ["DC.identifier", url], ["DC.type", "Text"],
          ["DC.language", o.lang || "en"], ["DC.rights", "Public domain"]]);
      tags.forEach(([name, content]) => {
        if (!content) return;
        const m = document.createElement("meta");
        m.name = name; m.content = content; m.dataset.pcCite = "";
        document.head.appendChild(m);
      });
    }
    if (o || had) document.dispatchEvent(new Event("ZoteroItemUpdated", { bubbles: true, cancelable: true }));
  }
  const isoDay = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((x) => String(x).padStart(2, "0")).join("-");
  // A poem is a web page (RIS ELEC, BibTeX @misc); a part of a long work is a section of a
  // book (CHAP, @incollection), the work as its book; a work in one part is a page again.
  function risRecord(o) {
    const part = o.work && o.title;
    const rows = [["TY", part ? "CHAP" : "ELEC"], ["TI", part ? o.title : o.work || o.title], ["AU", citeName(o.author)]]
      .concat(citeTranslators(o.translator).map((n) => ["A4", citeName(n)]))
      .concat([["T2", part ? o.work : "Poetry Codex"], ["PB", "Poetry Codex"], ["PY", o.year || ""],
        ["LA", o.lang || "en"], ["UR", SITE + o.path], ["Y2", isoDay(new Date()).replace(/-/g, "/")],
        ["N1", "Public domain"], ["ER", ""]]);
    return rows.filter(([k, v]) => v || k === "ER").map(([k, v]) => `${k}  - ${String(v).replace(/\s+/g, " ")}`).join("\r\n") + "\r\n";
  }
  // BibTeX: braces, backslashes and TeX's special characters escaped, and a double quote
  // as {"}; a name with nothing to invert (Homer, Yunus Emre) braced, so it stays whole.
  function bibRecord(o) {
    const part = o.work && o.title;
    const TEX = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_",
                  "~": "\\textasciitilde{}", "^": "\\textasciicircum{}", '"': '{"}' };
    const tex = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\\{}&%$#_~^"]/g, (c) => TEX[c]);
    // "Keats, John" as it is; a name not inverted ("Edward, Earl of Derby") or with a second
    // comma ("Tennyson, Alfred, Lord", which BibTeX would read as a "Jr" part) braced whole.
    const person = (n) => { const c = citeName(n); return c !== String(n).trim() && c.split(",").length === 2 ? tex(c) : "{" + tex(c) + "}"; };
    const key = "codex-" + o.path.replace(/^\/(poem|work)\//, "").replace(/\/$/, "").replace(/[^\w-]+/g, "-");
    const trs = citeTranslators(o.translator);
    const f = [["author", person(o.author)], ["title", tex(part ? o.title : o.work || o.title)],
      ["booktitle", part ? tex(o.work) : ""], ["translator", trs.map(person).join(" and ")],
      ["year", o.year || ""], [part ? "publisher" : "howpublished", "Poetry Codex"],
      ["url", SITE + o.path], ["urldate", isoDay(new Date())],
      ["language", { tr: "turkish", ang: "Old English" }[o.lang] || "english"], ["note", "Public domain"]];
    return `@${part ? "incollection" : "misc"}{${key},\n`
      + f.filter(([, v]) => v).map(([k, v]) => `  ${k.padEnd(12)} = {${v}}`).join(",\n") + "\n}\n";
  }
  // The file's name: the poet and the title, in plain letters ("keats-ode-on-a-grecian-urn.ris").
  const citeFileName = (o, ext) => (o.path.replace(/^\/(poem|work)\//, "").split("/")[0] + "-"
    + fold(o.work && o.title ? o.work + " " + o.title : o.work || o.title).replace(/[^a-z0-9]+/g, "-"))
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) + "." + ext;

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
  // A collection made into an assignment also has q (the teacher's question) and, on its
  // items, note and due ("YYYY-MM-DD"); MERGE.shelf keeps a collection whole, so they sync.
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
  // extra: more fields for the collection (q, the question of an assignment saved from a link).
  function newCollection(name, items, extra) {
    const s = shelfStore();
    const c = Object.assign({ id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                name: String(name).trim().slice(0, COL_NAME_MAX) || "Untitled", at: new Date().toISOString(), items: items || [] }, extra || {});
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
    drawLineTargets();
    lpReattach();
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
      return { entry: t.entry, root: fx, col: true, lines: !prose, lay: textLayout(t.text, prose), noQuote: true, noMargin: true,
               text: t.text, translator: t.translator };
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
    omApply();
    lpRefresh();   // the "This line" panel lists them too
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
        <p class="mark-row-quote">${m.kind === "hl" ? `<span class="hl-chip hl-${esc(hlColor(m.color))}"></span>` : ""}\u201c${esc(m.quote)}\u201d</p>
        ${m.text ? `<p class="mark-row-note">${noteHTML(m.text)}</p>` : ""}
        <p class="mark-row-src"><a href="${esc(routeFor(id))}">${esc(g.title || "")}</a>${g.author ? ` \u00b7 ${esc(g.author)}` : ""} \u00b7 ${esc(writtenLine(m))}</p>
      </li>`;

  // ---------- highlights: coloured, with an optional note, on any text ----------
  // Select words in a poem or a book of a long work (verse or prose) and a small bar offers
  // four colours and a note. Kept with the line notes (pc-marks, synced to the account) as
  // items {id, kind: "hl", s, e (character offsets in the text), quote, color, text}; a: -1
  // keeps them out of the line-note drawing of older copies of this script.
  const HL_COLORS = ["yellow", "green", "blue", "pink"];
  // A fifth swatch, "?", marks words as a question: an outline, not a colour, kept as color
  // "q". Older copies of this script draw a colour they do not know as yellow (the gold one),
  // so a question synced to a browser that still has one shows there as a plain highlight.
  const HL_KINDS = HL_COLORS.concat(["q"]);
  const HL_NAMES = { yellow: "Yellow", green: "Green", blue: "Blue", pink: "Pink", q: "Question" };
  const hlColor = (c) => HL_KINDS.includes(c) ? c : "yellow";
  const hlSwatchHTML = (c, attrs) => `<button type="button" class="hl-swatch hl-${c}" data-c="${c}"${attrs}>${c === "q" ? '<span aria-hidden="true">?</span>' : ""}</button>`;

  // ---------- tags: #words in the reader's notes ----------
  // Any #word in a note (on a highlight, on lines, or on a whole text) is a tag: a letter or
  // digit, then letters, digits or hyphens, in any script ("#ölüm", "#ubi-sunt"). A # inside a
  // web address, or straight after a letter, a digit or "&", is not one. Tags are read from
  // the note's own text, so they need no store of their own and follow a signed-in reader with
  // the notes; they are matched folded (fold), so "#Elegy" and "#elegy" are one tag. They show
  // as small chips wherever a note is shown, and filter #/notes and "Only my marks".
  const TAG_RE = /(^|[^\p{L}\p{N}\p{M}&#_/])#([\p{L}\p{N}][\p{L}\p{N}\p{M}-]*)/gu;
  const URL_RE = /(?:\bhttps?:\/\/|\bwww\.)\S+/giu;
  // The note in pieces: [{t, tag (its folded form) when it is a tag}].
  function noteParts(text) {
    const s = String(text || ""), out = [];
    const plain = (part) => {
      let k = 0;
      for (const m of part.matchAll(TAG_RE)) {
        const word = m[2].replace(/-+$/, ""), st = m.index + m[1].length;
        if (st > k) out.push({ t: part.slice(k, st) });
        out.push({ t: "#" + word, tag: fold(word) });
        k = st + 1 + word.length;
      }
      if (k < part.length) out.push({ t: part.slice(k) });
    };
    let at = 0;
    for (const u of s.matchAll(URL_RE)) { plain(s.slice(at, u.index)); out.push({ t: u[0] }); at = u.index + u[0].length; }
    plain(s.slice(at));
    return out;
  }
  const noteTags = (text) => [...new Set(noteParts(text).map((p) => p.tag).filter(Boolean))];
  const noteHTML = (text) => noteParts(text).map((p) => p.tag ? `<span class="tag-chip">${esc(p.t)}</span>` : esc(p.t)).join("");
  // Every tag in these notes, most used first: [{tag (folded), label (as most often written), n}].
  function tagCounts(notes) {
    const by = new Map();
    notes.forEach((text) => {
      const seen = new Set();
      noteParts(text).forEach((p) => {
        if (!p.tag || seen.has(p.tag)) return;
        seen.add(p.tag);
        const o = by.get(p.tag) || { tag: p.tag, n: 0, spell: new Map() };
        o.n++; o.spell.set(p.t, (o.spell.get(p.t) || 0) + 1);
        by.set(p.tag, o);
      });
    });
    return [...by.values()].map((o) => ({ tag: o.tag, n: o.n, label: [...o.spell].sort((a, b) => b[1] - a[1])[0][0] }))
      .sort((a, b) => b.n - a.n || COLLATE.compare(a.tag, b.tag));
  }
  let HL_CTX = null, hlBar = null, hlPop = null;
  const hlOf = (id) => marksOf(id).filter((m) => m.kind === "hl");
  function putHighlight(entry, h, remove) {
    const marks = allMarks();
    const g = marks[entry.id] || { title: entry.title, author: entry.author, kind: entry.kind, translator: entry.translator || "", items: [] };
    g.items = (g.items || []).filter((x) => x.id !== h.id);
    const now = new Date().toISOString();
    if (!remove) g.items.push({ id: h.id, kind: "hl", a: -1, s: h.s, e: h.e, quote: String(h.quote || "").slice(0, 600),
      color: hlColor(h.color), text: String(h.text || "").slice(0, MARK_MAX),
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
        m.className = "hl hl-" + (hlColor(h.color)) + (h.text ? " has-note" : "");
        m.dataset.hl = h.id;
        if (h.text) m.title = "Your note: " + h.text.slice(0, 120);
        else if (hlColor(h.color) === "q") m.title = "Your question";
        return m;
      });
    }));
    omApply();
    drawMarginNotes();
    lpRefresh();
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
    return document.documentElement.clientWidth - lpDrawerWidth() - r.right >= MARGIN_W + 70;
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
      return m && m.getClientRects().length ? { h, top: m.getBoundingClientRect().top - base } : null;   // none for words "Only my marks" folds away
    }).filter(Boolean).sort((a, b) => a.top - b.top).forEach(({ h, top }) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "mn-card hl-edge-" + (hlColor(h.color));
      card.dataset.hl = h.id;
      card.innerHTML = `<span class="mn-text">${noteHTML(h.text)}</span>`;
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
      hlBar.innerHTML = `<span class="hl-bar-group">` + HL_KINDS.map((c) => hlSwatchHTML(c, c === "q" ? ` aria-label="Mark as a question" title="Question"`
        : ` aria-label="Highlight in ${HL_NAMES[c].toLowerCase()}" title="${HL_NAMES[c]}"`)).join("")
        + `<button type="button" class="hl-note-btn" data-c="note">Note</button>`
        + `<button type="button" class="hl-note-btn hl-more" data-more="1" aria-haspopup="dialog">More on this line</button></span>`
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
        // "More on this line": the lines the selection touches, in the "This line" panel.
        if (b.dataset.more) {
          const got = hlSelection() || hlBar.sel; hideHlBar();
          if (got) lpFromOffsets(got.ctx, got.s, got.e);
          return;
        }
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
    const more = hlBar.querySelector(".hl-more"), lines = lpRangeOf(sel.ctx, sel.s, sel.e);
    more.hidden = !lines;
    more.textContent = lines && lines.b > lines.a ? `More on these ${lpProse(sel.ctx) ? "paragraphs" : "lines"}`
      : `More on this ${lpProse(sel.ctx) ? "paragraph" : "line"}`;
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
      <div class="hl-colors">${HL_KINDS.map((c) => hlSwatchHTML(c, ` aria-pressed="${hlColor(h.color) === c}" aria-label="${HL_NAMES[c]}"`)).join("")}</div>
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

  // ---------- "Only my marks": the text folded down to what the reader marked ----------
  // On a poem or a book with marks (shown alone, not in the facing pages), "Only my marks"
  // (beside "Line numbers", and in the phone's reading bar) folds away every line (or
  // paragraph) that holds no mark, keeping one line of context before and after each mark;
  // each stretch folded away becomes a row "⋯ 46 lines ⋯", a button that opens it again (and
  // folds it back). A bar above the text narrows it to some colours, Questions, line notes or
  // tags (a mark shows when it is of a kind chosen, if any, and carries every tag chosen) and
  // says how many marks could not be found in the text as it is now (they are on #/notes).
  // Print prints the folded text while it is on. The rows are empty buttons drawn by the
  // stylesheet (data-label), so the text's offsets are untouched. The state is kept for this
  // visit only, per text (OM_STATE), and nowhere else.
  const OM_STATE = new Map();     // entry id -> {on, kinds: [], tags: [], open: Set of folded stretches opened}
  const omState = (id) => OM_STATE.get(id) || OM_STATE.set(id, { on: false, kinds: [], tags: [], open: new Set() }).get(id);
  // The text "Only my marks" works on now: the text alone, on a reading page, with marks.
  function omCtx() {
    const ctx = SOLO_CTX;
    if (!ctx || !ctx.root.isConnected || !ctx.root.closest("article.detail") || ctx.root.closest("[hidden]")) return null;
    if (app.querySelector(".fx-slot:not([hidden]) .fx")) return null;
    return marksOf(ctx.entry.id).length ? ctx : null;
  }
  const omOn = (id) => { const c = omCtx(); return !!(c && c.entry.id === id && omState(id).on); };
  // The text's units (lines, or paragraphs of prose) and its marks, each with the units it stands in.
  function omMarks(ctx) {
    const prose = ctx.root.classList.contains("is-prose");
    const units = [...ctx.root.querySelectorAll(prose ? ":scope > p" : ".ln[data-i]")];
    const pos = new Map(units.map((u, k) => [u, k]));
    const list = marksOf(ctx.entry.id).map((m) => {
      const ks = new Set();
      if (m.kind === "hl") ctx.root.querySelectorAll(`mark.hl[data-hl="${CSS.escape(m.id)}"]`).forEach((el) => {
        const u = el.closest(prose ? "p" : ".ln[data-i]");
        if (pos.has(u)) ks.add(pos.get(u));
      });
      else if (!prose) for (let i = m.a; i <= m.b; i++) { const l = ctxLine(ctx, i); if (pos.has(l)) ks.add(pos.get(l)); }
      return { m, kind: m.kind === "hl" ? hlColor(m.color) : "line", tags: noteTags(m.text), ks: [...ks] };
    });
    return { prose, units, list };
  }
  const omShows = (st, x) => (!st.kinds.length || st.kinds.includes(x.kind)) && st.tags.every((t) => x.tags.includes(t));
  // Folds the text (or unfolds it), and draws the switches and the bar. focus: a selector to
  // put the focus on afterwards (the row or chip just pressed, drawn again).
  function omApply(focus) {
    const ctx = omCtx();
    app.querySelectorAll(".om-gap").forEach((b) => b.remove());
    app.querySelectorAll(".om-hide").forEach((x) => x.classList.remove("om-hide"));
    const old = app.querySelector(".om-bar");
    if (old) old.remove();
    omControls(ctx);
    if (!ctx || !omState(ctx.entry.id).on) return;
    const st = omState(ctx.entry.id), { prose, units, list } = omMarks(ctx);
    // What to keep: each mark shown, a unit either side.
    const keep = new Set();
    list.filter((x) => omShows(st, x)).forEach((x) => x.ks.forEach((k) => { keep.add(k - 1); keep.add(k); keep.add(k + 1); }));
    const unit = prose ? "paragraph" : "line";
    for (let k = 0; k < units.length;) {
      if (keep.has(k)) { k++; continue; }
      let e = k;
      while (e + 1 < units.length && !keep.has(e + 1)) e++;
      const n = units.slice(k, e + 1).filter((u) => u.textContent.trim()).length;
      if (e > k && n > 1) {                  // one line alone is not worth a row
        const open = st.open.has(k);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "om-gap";
        b.dataset.k = k;
        b.setAttribute("aria-expanded", String(open));
        b.dataset.label = open ? `Fold these ${num(n)} ${unit}s away` : `⋯ ${num(n)} ${unit}s ⋯`;
        b.setAttribute("aria-label", open ? `Fold away the ${num(n)} ${unit}s below` : `${num(n)} ${unit}s without marks: show them`);
        const from = k;
        b.addEventListener("click", () => {
          if (st.open.has(from)) st.open.delete(from); else st.open.add(from);
          omApply(`.om-gap[data-k="${from}"]`);
        });
        units[k].before(b);
        if (!open) units.slice(k, e + 1).forEach((u) => u.classList.add("om-hide"));
      }
      k = e + 1;
    }
    if (!prose) ctx.root.querySelectorAll(".stanza").forEach((s) => {
      if (!s.querySelector(".om-gap") && s.querySelector(".ln") && !s.querySelector(".ln:not(.om-hide)")) s.classList.add("om-hide");
    });
    // The bar: the kinds and tags of the marks found in the text, each a toggle.
    const found = list.filter((x) => x.ks.length), shown = found.filter((x) => omShows(st, x)), lost = list.length - found.length;
    const kinds = HL_KINDS.concat(["line"]).filter((k) => found.some((x) => x.kind === k));
    const tags = tagCounts(found.map((x) => x.m.text));
    const kindLabel = (k) => k === "line" ? `<span class="nb-dot" aria-hidden="true"></span>Line notes`
      : k === "q" ? `<span class="hl-chip hl-q" aria-hidden="true"></span>Questions`
      : `<span class="hl-chip hl-${k}" aria-hidden="true"></span>${HL_NAMES[k]}`;
    const bar = document.createElement("div");
    bar.className = "om-bar";
    bar.innerHTML = `
      <p class="om-sum" role="status">Only your marks: ${num(shown.length)} of ${num(found.length)} shown, with a ${unit} either side.</p>
      ${kinds.length > 1 || tags.length ? `<div class="om-chips" role="group" aria-label="Show only these marks">
        <button type="button" class="chip om-chip" data-om="all" aria-pressed="${!st.kinds.length && !st.tags.length}">All marks</button>
        ${kinds.length > 1 ? kinds.map((k) => `<button type="button" class="chip om-chip" data-om="k:${k}" aria-pressed="${st.kinds.includes(k)}">${kindLabel(k)}</button>`).join("") : ""}
        ${tags.map((t) => `<button type="button" class="chip om-chip om-tag" data-om="t:${esc(t.tag)}" aria-pressed="${st.tags.includes(t.tag)}">${esc(t.label)} <span class="om-n">${num(t.n)}</span></button>`).join("")}
      </div>` : ""}
      ${lost ? `<p class="om-lost">${lost === 1 ? "One of your marks" : num(lost) + " of your marks"} could not be found in the text as it is now: <a href="#/notes">see ${lost === 1 ? "it" : "them"} in My notes</a>.</p>` : ""}
      <button type="button" class="om-off">Show every ${unit}</button>`;
    bar.querySelectorAll(".om-chip").forEach((c) => c.addEventListener("click", () => {
      const v = c.dataset.om;
      if (v === "all") { st.kinds = []; st.tags = []; }
      else if (v.startsWith("k:")) { const k = v.slice(2); st.kinds = st.kinds.includes(k) ? st.kinds.filter((x) => x !== k) : st.kinds.concat(k); }
      else { const t = v.slice(2); st.tags = st.tags.includes(t) ? st.tags.filter((x) => x !== t) : st.tags.concat(t); }
      st.open.clear();
      omApply(`.om-chip[data-om="${CSS.escape(v)}"]`);
    }));
    bar.querySelector(".om-off").addEventListener("click", () => { omSet(ctx, false); const t = app.querySelector(".om-toggle"); if (t) t.focus(); });
    const text = ctx.root.closest(".text-solo") || ctx.root;
    text.before(bar);
    if (focus) {
      drawMarginNotes();
      const f = app.querySelector(focus);
      if (f) f.focus({ preventScroll: true });
    }
  }
  // A line Find or "Go to line" goes to, folded away: its stretch is opened.
  function omReveal(el) {
    if (!el || !el.closest || !el.closest(".om-hide")) return;
    const gaps = [...app.querySelectorAll('.om-gap[aria-expanded="false"]')]
      .filter((g) => g.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const c = omCtx();
    if (!gaps.length || !c) return;
    omState(c.entry.id).open.add(+gaps[gaps.length - 1].dataset.k);
    omApply();
    drawMarginNotes();
  }
  function omSet(ctx, on) {
    const st = omState(ctx.entry.id);
    st.on = on;
    st.open.clear();
    if (on && ppOn()) { ppState(PP.slug).who = ""; ppApply(); }   // one fold at a time (who's who)
    omApply();
    drawMarginNotes();
    announce(on ? "Only your marks are shown." : "Every line is shown.");
  }
  // "Only my marks" beside "Line numbers" (a row made for it where the text has none) and in
  // the phone's reading bar, while the text has marks.
  function omControls(ctx) {
    const on = !!(ctx && omState(ctx.entry.id).on);
    let btn = app.querySelector(".om-toggle");
    if (ctx && !btn) {
      const text = ctx.root.closest(".text-solo") || ctx.root;
      let row = app.querySelector("article.detail .ln-bar");
      if (!row) { row = document.createElement("div"); row.className = "ln-bar"; text.before(row); }
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "om-toggle";
      btn.textContent = "Only my marks";
      btn.addEventListener("click", () => { const c = omCtx(); if (c) omSet(c, !omState(c.entry.id).on); });
      const ctl = row.querySelector(".ln-ctl");
      if (ctl) ctl.prepend(btn); else row.appendChild(btn);
    }
    if (btn) { btn.hidden = !ctx; btn.setAttribute("aria-pressed", String(on)); }
    if (!RB || !RB.nav.isConnected) return;
    let rb = RB.nav.querySelector(".rb-om");
    if (ctx && !rb) {
      RB.nav.querySelector(".rb-next").insertAdjacentHTML("beforebegin",
        `<button type="button" class="rb-btn rb-om" aria-pressed="false">${rbIcon("marks")}<span class="rb-l">My marks</span></button>`);
      rb = RB.nav.querySelector(".rb-om");
      rb.addEventListener("click", () => {
        const c = omCtx();
        if (!c) return;
        omSet(c, !omState(c.entry.id).on);
        if (omState(c.entry.id).on) { const bar = app.querySelector(".om-bar"); if (bar) jumpTo(Math.max(0, window.scrollY + bar.getBoundingClientRect().top - 80)); }
      });
    }
    if (rb) { rb.hidden = !ctx; rb.setAttribute("aria-pressed", String(on)); }
  }

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
    const units = [...root.querySelectorAll(prose ? ":scope > p" : ".ln[data-i]")].filter((u) => r.intersectsNode(u));
    if (units.length > 1 && r.endOffset === 0 && units[units.length - 1].contains(r.endContainer)) units.pop();
    const parts = units.map((u) => {
      const ur = document.createRange(); ur.selectNodeContents(u);
      if (u.contains(r.startContainer)) ur.setStart(r.startContainer, r.startOffset);
      if (u.contains(r.endContainer)) ur.setEnd(r.endContainer, r.endOffset);
      return { u, t: ur.toString() };
    }).filter((p) => p.t.trim());
    return quoteParts(root, parts);
  }
  // The quotation for those pieces of lines or paragraphs (parts: [{u (the line or
  // paragraph), t (its words taken)}]); also used by the "This line" panel for whole lines.
  function quoteParts(root, parts) {
    if (!parts.length) return null;
    const prose = root.classList.contains("is-prose");
    const all = [...root.querySelectorAll(prose ? ":scope > p" : ".ln[data-i]")];
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
    // Opened from an assignment link: the lines keep a pale wash while the page is open
    // (a class, never a mark).
    if (assignmentItem()) lit.forEach((el) => el.classList.add("ln-assigned"));
    if (LINES_SHOWN === location.hash) return;    // drawn again in place: the reader's scroll stands
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
    if (hlPop && !hlPop.contains(t) && !t.closest(".mn-card, .hl-bar, .lp-edit")) closeHlPop();   // the bar's Note just opened it
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

  // ---------- "This line": everything about one line in one place ----------
  // Tap the margin beside a line (where its number is printed, or would be: every line has an
  // invisible target there), choose "More on this line" in the selection bar, or Tab to a
  // line's target (Up and Down move between lines, Home and End to the first and last; "Go to
  // line" puts the focus there too) and press Enter: a panel gathers what the Codex holds on
  // that line or the lines selected. It only reads what is already kept, and nothing goes in
  // the address: (1) the lines with their place; (2) the editors' study notes on them (one
  // whose anchor stands in them, or whose range, "Il. 1.4-5", runs on from its anchor into
  // them); (3) the reader's own line notes and highlights there, with "Add a note" (a line
  // note in pc-marks, as the selection bar makes); (4) the same lines in the text this one
  // faces in data/parallel.json, never guessed: a book with no such map offers its other
  // translations instead, side by side; (5) whatever later features add through LP_PARTS;
  // (6) Copy quote, Copy link to line, Listen from here, Look up a word, Learn this stanza.
  // From 780px it is a drawer on the right that the page makes room for, and it stays open
  // (and follows) as other lines are tapped; on a phone it is a sheet from the foot of the
  // screen, 55% of its height, dragged up to 90%, down (or Esc, or Close) to shut, and modal
  // while it is up. It works in a text alone, in either column of the facing pages and either
  // side of two translations. A prose translation alone has a target by each paragraph; one
  // in a facing column is reached through the selection bar only.
  const LP_WIDE = window.matchMedia("(min-width: 780px)");
  const LP_PARTS = [];        // later sections: (info) => {title, html, bind(el)} or null
  const LP_SHOW = 3;          // other texts shown before "Show all"
  let LP = null;              // {el, scrim, ctx, a, b, from, gen} while the panel is open
  let LP_FACING = null;       // the page's facing-page setup (bindFacing): {hash, kind, key, list, build}
  const lpProse = (ctx) => !ctx.col && ctx.root.classList.contains("is-prose");
  const lpDrawerWidth = () => (LP && LP.el.isConnected && LP_WIDE.matches ? LP.el.offsetWidth : 0);
  // A text's units, each with its number in the text from 0: its lines (data-i, or data-u in a
  // facing column) or, for a prose translation alone, its paragraphs.
  function lpKeyed(ctx) {
    if (lpProse(ctx)) return [...ctx.root.querySelectorAll(":scope > p")].map((el, k) => ({ el, k }));
    return ctxLines(ctx).map((el) => ({ el, k: +(ctx.col ? el.dataset.u : el.dataset.i) }));
  }
  const lpEls = (ctx, a, b) => lpKeyed(ctx).filter((x) => x.k >= a && x.k <= b).map((x) => x.el);
  // Where each unit stands in the text's characters (the offsets highlights and study notes
  // use): Map key -> [start, end].
  function lpSpans(ctx) {
    const keyOf = new Map(lpKeyed(ctx).map((x) => [x.el, x.k]));
    const pick = lpProse(ctx) ? (el) => el.closest(".poem-text > p") : ctx.col ? (el) => el.closest("[data-u]") : (el) => el.closest(".ln[data-i]");
    const spans = new Map();
    ctxNodes(ctx).forEach(({ n, s }) => {
      const u = pick(n.parentElement), k = u ? keyOf.get(u) : undefined;
      if (k === undefined) return;
      const e = s + n.nodeValue.length, had = spans.get(k);
      spans.set(k, had ? [Math.min(had[0], s), Math.max(had[1], e)] : [s, e]);
    });
    return spans;
  }
  // The units a stretch of characters touches (a selection): {a, b}, or null.
  function lpRangeOf(ctx, s, e) {
    if (!ctx) return null;
    let a = Infinity, b = -1;
    lpSpans(ctx).forEach(([x, y], k) => { if (x < e && y > s) { a = Math.min(a, k); b = Math.max(b, k); } });
    return b < 0 ? null : { a, b };
  }
  function lpFromOffsets(ctx, s, e) {
    const r = lpRangeOf(ctx, s, e);
    if (r) openLinePanel(ctx, r.a, r.b, null);
  }
  // The mark text a line belongs to: the one whose root holds it (in a facing column, the
  // one its data-e names).
  function lpCtxOf(el) {
    const line = el.closest("[data-e]");
    return liveCtxs().find((c) => c.root.contains(el) && (!c.col || (line && line.dataset.e === c.entry.id))) || null;
  }
  // The counted number of each line (data-c, as quotations cite it), from the page itself or,
  // for a text shown in a column, as its own page counts them.
  function lpCounts(ctx) {
    if (ctx.lpC) return ctx.lpC;
    const c = [];
    let box = ctx.root;
    if (ctx.col) { box = document.createElement("div"); box.innerHTML = poemHTML(ctx.text || "", false); }
    box.querySelectorAll(".ln[data-i]").forEach((l) => { c[+l.dataset.i] = +(l.dataset.c || 0); });
    return (ctx.lpC = c);
  }
  // "Line 12", "Lines 12–14", "Paragraph 3 · Greek lines 120–144" (Murray's Homer).
  function lpPlace(ctx, a, b) {
    if (lpProse(ctx)) {
      const ps = ctx.root.querySelectorAll(":scope > p");
      const para = a === b ? `Paragraph ${a + 1}` : `Paragraphs ${a + 1}–${b + 1}`;
      if (!ctx.root.classList.contains("greek-lines") || !ps[a] || !ps[a].dataset.n) return para;
      const ga = +ps[a].dataset.n, next = ps[b + 1], gb = next && next.dataset.n ? +next.dataset.n - 1 : 0;
      return para + " · " + (gb > ga ? `Greek lines ${ga}–${gb}` : gb === ga ? `Greek line ${ga}` : `Greek lines ${ga} ff.`);
    }
    if (!ctx.lines) return a === b ? `Line ${a + 1} as printed` : `Lines ${a + 1}–${b + 1} as printed`;
    const cs = lpCounts(ctx).slice(a, b + 1).filter(Boolean);
    if (!cs.length) return a === b ? "A line not numbered" : "Lines not numbered";   // a heading, an argument
    return cs[0] === cs[cs.length - 1] ? `Line ${cs[0]}` : `Lines ${cs[0]}–${cs[cs.length - 1]}`;
  }
  // The page's own text (its quotations, link and dictionary), alone or in its column.
  const lpOwn = (ctx) => !!(SOLO_CTX && SOLO_CTX.root.isConnected && SEL_CTX && SOLO_CTX.entry.id === ctx.entry.id
    && (ctx === SOLO_CTX || (ctx.col && ctx.lines && !SOLO_CTX.root.classList.contains("is-prose"))));

  // ---- the targets in the margin ----
  // One button per line (or paragraph), empty, so the text, its highlights and its offsets
  // are untouched. Only one per text is in the Tab order (and heard by a screen reader in
  // browse mode): the last one focused, else the first.
  function drawLineTargets() {
    const ctxs = liveCtxs(), roots = new Set(ctxs.map((c) => c.root));
    roots.forEach((root) => {
      root.querySelectorAll(".ln-more").forEach((b) => b.remove());
      root.classList.remove("lp-on");
    });
    ctxs.forEach((ctx) => {
      if (!ctx.lines && !lpProse(ctx)) return;
      lpKeyed(ctx).forEach(({ el, k }) => {
        if ((!lpProse(ctx) && !el.classList.contains("ln")) || !el.textContent.trim()) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ln-more";
        b.tabIndex = -1;
        b.setAttribute("aria-hidden", "true");
        b.setAttribute("aria-label", "More on " + lpPlace(ctx, k, k).replace(/ · .*$/, "").replace(/^A /, "a ").replace(/^(Line|Paragraph)/, (x) => x.toLowerCase()));
        el.appendChild(b);
      });
      ctx.root.classList.add("lp-on");
    });
    roots.forEach((root) => lpRove(root.querySelector(".ln-more")));
  }
  // That target becomes its text's one tab stop.
  function lpRove(b) {
    if (!b) return;
    const root = b.closest(".poem-text, .fx");
    if (root) root.querySelectorAll('.ln-more[tabindex="0"]').forEach((x) => { if (x !== b) { x.tabIndex = -1; x.setAttribute("aria-hidden", "true"); } });
    b.tabIndex = 0;
    b.removeAttribute("aria-hidden");
  }
  // Go to line: the focus on that line's target (a facing row hidden on a phone has none).
  function lpFocusLine(el) {
    const b = el && !el.classList.contains("fx-row") && el.querySelector(".ln-more");
    if (!b || !b.getClientRects().length) return;
    lpRove(b);
    b.focus({ preventScroll: true });
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".ln-more");
    if (!b) return;
    e.preventDefault();
    const unit = b.parentElement, ctx = lpCtxOf(unit);
    const hit = ctx && lpKeyed(ctx).find((x) => x.el === unit);
    if (!hit) return;
    lpRove(b);
    openLinePanel(ctx, hit.k, hit.k, b);
  });
  document.addEventListener("focusin", (e) => { if (e.target.classList && e.target.classList.contains("ln-more")) lpRove(e.target); });
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains("ln-more") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const root = t.closest(".poem-text, .fx");
    const all = [...root.querySelectorAll(".ln-more")].filter((x) => x.getClientRects().length);
    const at = all.indexOf(t);
    const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
    e.preventDefault();
    if (!all[to]) return;
    lpRove(all[to]);
    all[to].focus();
  });

  // ---- what the panel shows ----
  // The editors' study notes on lines a..b, from the same files drawGlosses reads.
  async function lpGlosses(ctx, a, b) {
    const url = await glossUrl(ctx.entry);
    if (!url) return [];
    const notes = await (GLOSS_CACHE[url] || (GLOSS_CACHE[url] = fetch(url).then((r) => r.ok ? r.json() : []).catch(() => [])));
    if (!Array.isArray(notes) || !ctx.root.isConnected) return [];
    const spans = lpSpans(ctx), full = ctxFull(ctx, ctxNodes(ctx));
    const unitAt = (at) => { let hit = -1; spans.forEach(([x, y], k) => { if (hit < 0 && at >= x && at < y) hit = k; }); return hit; };
    // How many lines past its anchor a note runs: "Il. 1.4-5" one more, "l. 3" none (verse only).
    const runOn = (ref) => {
      const m = /(?:^|\s)(?:\d+\.)?(\d+)(?:\s*[-–]\s*(\d+))?/.exec(String(ref || ""));
      return m && m[2] && !lpProse(ctx) ? Math.max(0, Math.min(30, +m[2] - +m[1])) : 0;
    };
    return notes.filter((g) => {
      if (!g || !g.anchor) return false;
      let at = -1;
      for (let c = 0; c < (g.occurrence || 1); c++) { at = full.indexOf(g.anchor, at + 1); if (at < 0) break; }
      if (at < 0) return false;
      const k = unitAt(at);
      return k >= 0 && k <= b && k + runOn(g.ref) >= a;
    });
  }
  // The reader's line notes and highlights on lines a..b.
  function lpMarks(ctx, a, b) {
    const notes = ctx.lines ? marksOf(ctx.entry.id).filter((m) => m.kind !== "hl" && m.a <= b && m.b >= a) : [];
    const spans = lpSpans(ctx), from = spans.get(a), to = spans.get(b);
    let hls = [];
    if (from && to) {
      const full = ctxFull(ctx, ctxNodes(ctx));
      hls = hlOf(ctx.entry.id).filter((h) => { const at = markSpan(full, h); return at && at[0] < to[1] && at[1] > from[0]; });
    }
    return { notes, hls };
  }
  // The other text's lines facing these: [{label, orig (it is the original), lines}]. With the
  // facing pages on screen, the rows these lines stand in; with them off, the same rows made
  // from data/parallel.json for each text this one faces (fetched once, then kept).
  function lpFacingOnScreen(ctx, els) {
    const rows = [...new Set(els.map((el) => el.closest(".fx-row")).filter(Boolean))];
    if (!rows.length) return [];
    const inOrig = !!els[0].closest(".fx-o");
    const lbl = ctx.root.querySelectorAll(".fx-head .fx-lbl")[inOrig ? 1 : 0];
    const lines = rows.flatMap((r) => [...r.querySelectorAll(inOrig ? ".fx-t > .ln, .fx-t > p" : ".fx-o > .ln")])
      .map((x) => x.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
    return lines.length ? [{ label: lbl ? lbl.firstChild.textContent.trim() : (inOrig ? "Translation" : "Original"), orig: !inOrig, lines }] : [];
  }
  function lpFacingModels(ctx, a, b) {
    const F = LP_FACING;
    if (!F || F.hash !== location.hash || ctx !== SOLO_CTX || !lpOwn(ctx) || !F.list.length) return { items: [], waiting: [] };
    const items = [], waiting = [];
    F.list.forEach((e) => {
      const other = FX_READY.get(F.kind + ":" + e.with);
      if (!other) { waiting.push(e); return; }
      let m;
      try { m = F.build(e, other); } catch (err) { return; }
      const id = ctx.entry.id, mine = (u) => u.src === id && u.k >= a && u.k <= b;
      const rows = m.rows.filter((r) => r.o.some(mine) || r.t.some(mine));
      if (!rows.length) return;
      const ownOrig = rows.some((r) => r.o.some(mine));
      const lines = rows.flatMap((r) => (ownOrig ? r.t : r.o).filter((u) => u.src !== id).map((u) => String(u.t).replace(/\s+/g, " ").trim())).filter(Boolean);
      if (!lines.length) return;
      const label = ownOrig ? (m.translator ? trCredit(m.translator) : "Translation")
        : (LANG_NAMES[m.lang] || "The original") + (m.version ? " · " + m.version : "");
      items.push({ label, orig: !ownOrig, lines, lang: ownOrig ? "" : m.lang });
    });
    return { items, waiting };
  }
  // A book of a work with other translations and no line map: those translations' same book,
  // side by side with this one.
  function lpOtherBooks(ctx) {
    const m = /^work:([^/]+)\/(\d+)$/.exec(ctx.entry.id);
    const w = m && WORKS[m[1]];
    if (!w || !w.sections) return [];
    const i = +m[2];
    return otherTranslations(w).filter((o) => matchingPart(w, o, i) >= 0)
      .map((o) => ({ label: verShort(o), href: `#/work/${m[1]}/${i}/with/${o.slug}` }));
  }
  // Up to LP_SHOW items, the rest behind "Show all n".
  const lpMoreList = (items, html) => items.slice(0, LP_SHOW).map(html).join("")
    + (items.length > LP_SHOW ? `<div class="lp-rest" hidden>${items.slice(LP_SHOW).map(html).join("")}</div>
       <button type="button" class="lp-showall">Show all ${num(items.length)}</button>` : "");
  // The stanza line k stands in (units from 0, as poemHTML numbers them).
  function lpStanza(text, k) {
    const us = textUnits(text);
    if (!us[k]) return null;
    let a = k, b = k;
    while (a > 0 && !us[a].gap) a--;
    while (us[b + 1] && !us[b + 1].gap) b++;
    return { a, b };
  }
  const lpWords = (els) => [...new Set(els.map((el) => el.textContent).join(" ").split(/\s+/)
    .map((x) => x.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, "")).filter((x) => /\p{L}/u.test(x)))].slice(0, 60);
  // The dictionary: the page's own text's (bindQuoteTools), else by the column's language.
  const lpDictFor = (ctx, el) => {
    if (lpOwn(ctx)) return lookupDict();
    const l = (el.closest("[lang]") || {}).lang || "";
    return DICTS[l] ? l : "en";
  };

  // ---- the panel itself ----
  function lpShell() {
    const el = document.createElement("div");
    el.className = "lp";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-labelledby", "lp-title");
    el.innerHTML = `
      <div class="lp-grip" aria-hidden="true"><span></span></div>
      <div class="lp-head">
        <div class="lp-head-t">
          <p class="lp-kicker"></p>
          <h2 class="lp-title" id="lp-title" tabindex="-1"></h2>
        </div>
        <button type="button" class="lp-size" aria-expanded="false">Taller</button>
        <button type="button" class="lp-close">Close</button>
      </div>
      <div class="lp-body"></div>`;
    const scrim = document.createElement("div");
    scrim.className = "lp-scrim";
    scrim.addEventListener("click", () => closeLinePanel(true));
    el.querySelector(".lp-close").addEventListener("click", () => closeLinePanel(true));
    el.querySelector(".lp-size").addEventListener("click", () => lpHeight(el.classList.contains("is-tall") ? 55 : 90));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeLinePanel(true); return; }
      // On a phone the sheet is modal: Tab goes round inside it.
      if (e.key !== "Tab" || LP_WIDE.matches) return;
      const fs = [...el.querySelectorAll("button, a[href], textarea, summary, [tabindex='0']")].filter((x) => !x.disabled && x.getClientRects().length);
      if (!fs.length) return;
      const first = fs[0], last = fs[fs.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    lpDrag(el);
    document.body.append(scrim, el);
    return { el, scrim };
  }
  // The sheet's height on a phone, in % of the screen.
  function lpHeight(pc) {
    if (!LP) return;
    LP.el.style.height = pc + "vh";
    LP.el.classList.toggle("is-tall", pc > 70);
    const b = LP.el.querySelector(".lp-size");
    b.textContent = pc > 70 ? "Shorter" : "Taller";
    b.setAttribute("aria-expanded", String(pc > 70));
  }
  // Dragging the sheet by its top: up to 90%, down to close (or back to 55%).
  function lpDrag(el) {
    let start = null;
    const down = (e) => {
      if (LP_WIDE.matches || e.target.closest("button") || (e.pointerType === "mouse" && e.button !== 0)) return;
      start = { y: e.clientY, h: el.getBoundingClientRect().height, t: Date.now() };
      el.classList.add("is-dragging");
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    };
    const move = (e) => {
      if (!start) return;
      el.style.height = Math.max(80, Math.min(window.innerHeight * 0.9, start.h - (e.clientY - start.y))) + "px";
    };
    const up = (e) => {
      if (!start) return;
      const dy = e.clientY - start.y, fast = dy > 60 && Date.now() - start.t < 300;
      const pc = (el.getBoundingClientRect().height / window.innerHeight) * 100;
      start = null;
      el.classList.remove("is-dragging");
      if (fast || pc < 35) closeLinePanel(true);
      else lpHeight(pc > 72 ? 90 : 55);
    };
    [el.querySelector(".lp-grip"), el.querySelector(".lp-head")].forEach((h) => {
      h.addEventListener("pointerdown", down);
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
  }
  // A drawer or a sheet, as the screen is now.
  function lpMode() {
    if (!LP) return;
    const wide = LP_WIDE.matches, el = LP.el;
    el.classList.toggle("is-sheet", !wide);
    el.classList.toggle("is-drawer", wide);
    if (wide) { el.removeAttribute("aria-modal"); el.style.height = ""; el.classList.remove("is-tall"); }
    else { el.setAttribute("aria-modal", "true"); if (!el.style.height) lpHeight(55); }
    LP.scrim.hidden = wide;
    document.body.classList.toggle("lp-open", wide);
    const head = document.querySelector(".site-head");
    el.style.setProperty("--lp-top", wide && head && getComputedStyle(head).position === "sticky" ? Math.max(0, head.getBoundingClientRect().bottom) + "px" : "0px");
    drawMarginNotes();
    if (RB) rbSync();
  }
  { const changed = () => lpMode();
    if (LP_WIDE.addEventListener) LP_WIDE.addEventListener("change", changed); else LP_WIDE.addListener(changed); }   // Safari 13
  // Opens the panel on lines a..b of a text (or moves it there); from: the target the focus
  // goes back to.
  function openLinePanel(ctx, a, b, from) {
    if (!ctx) return;
    if (!LP) {
      LP = Object.assign(lpShell(), { gen: 0 });
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) LP.el.classList.add("no-motion");
    }
    const first = lpEls(ctx, a, a)[0];
    Object.assign(LP, { ctx, a, b, from: from || (first && first.querySelector(".ln-more")) || null });
    lpMode();
    lpDraw();
    requestAnimationFrame(() => { if (LP) LP.el.classList.add("is-in"); });
    LP.el.querySelector(".lp-title").focus({ preventScroll: true });
  }
  function closeLinePanel(refocus) {
    if (!LP) return;
    const { el, scrim, from } = LP;
    LP = null;
    el.remove(); scrim.remove();
    document.body.classList.remove("lp-open");
    document.querySelectorAll(".lp-sel").forEach((x) => x.classList.remove("lp-sel"));
    drawMarginNotes();
    if (refocus && from && from.isConnected) from.focus({ preventScroll: true });
    if (RB) rbSync();
  }
  window.addEventListener("hashchange", () => closeLinePanel(false));
  // The texts on screen were drawn again (the index came in, the facing pages turned on or
  // off): the panel follows its lines there, or closes.
  function lpReattach() {
    if (!LP) return;
    const was = LP.ctx, prose = lpProse(was);
    const ctx = liveCtxs().find((c) => c.entry.id === was.entry.id && lpProse(c) === prose && (!was.lines || c.lines));
    if (!ctx) { closeLinePanel(false); return; }
    const first = lpEls(ctx, LP.a, LP.a)[0];
    Object.assign(LP, { ctx, from: (first && first.querySelector(".ln-more")) || null });
    lpDraw();
  }
  // Drawn again after a note or a highlight changes, unless the reader is typing in it.
  function lpRefresh() {
    if (!LP || !LP.ctx.root.isConnected || (LP.el.contains(document.activeElement) && document.activeElement.matches("textarea"))) return;
    lpDraw();
  }
  function lpDraw() {
    const { ctx, a, b, el } = LP, gen = ++LP.gen, entry = ctx.entry;
    const els = lpEls(ctx, a, b);
    document.querySelectorAll(".lp-sel").forEach((x) => x.classList.remove("lp-sel"));
    els.forEach((x) => x.classList.add("lp-sel"));
    const prose = lpProse(ctx), place = lpPlace(ctx, a, b), own = lpOwn(ctx);
    el.querySelector(".lp-kicker").textContent = [entry.title, entry.author, entry.translator && translatorShort(trName(entry.translator))].filter(Boolean).join(" · ");
    el.querySelector(".lp-title").textContent = place;
    const langEl = els[0] && els[0].closest("[lang]"), lang = langEl ? ` lang="${esc(langEl.lang)}"` : "";
    const texts = els.map((x) => x.textContent.replace(/\s+$/, ""));
    const sec = (cls, title, body) => body ? `<section class="lp-sec ${cls}"><h3 class="lp-h">${title}</h3>${body}</section>` : "";
    // (1) The lines themselves.
    const whole = texts.join(" ").replace(/\s+/g, " ").trim();
    const lineHTML = prose || (ctx.col && !ctx.lines)
      ? `<p class="lp-quote is-prose"${lang}>${esc(whole.slice(0, 420))}${whole.length > 420 ? "…" : ""}</p>`
      : `<p class="lp-quote"${lang}>${texts.map((t) => `<span class="lp-ql">${esc(t)}</span>`).join("")}</p>`;
    // (3) The reader's own notes and highlights, and a new note.
    const mk = lpMarks(ctx, a, b);
    const mkRow = (m, hl) => `<li class="lp-mk">
        <p class="lp-mk-q">${hl ? `<span class="hl-chip hl-${esc(hlColor(m.color))}"></span>` : ""}“${esc(String(m.quote || "").slice(0, 160))}”</p>
        ${m.text ? `<p class="lp-mk-t">${noteHTML(m.text)}</p>` : ""}
        <p class="lp-mk-d">${esc(writtenLine(m))}<button type="button" class="lp-edit" data-${hl ? "hl" : "mk"}="${esc(m.id)}">${hl && !m.text ? "Add a note" : "Edit"}</button></p></li>`;
    const marksHTML = mk.notes.length || mk.hls.length
      ? `<ul class="lp-list">${mk.notes.map((m) => mkRow(m, false)).join("")}${mk.hls.map((h) => mkRow(h, true)).join("")}</ul>` : "";
    const addHTML = ctx.lines ? `
        <details class="lp-add">
          <summary>Add a note on ${a === b ? "this line" : "these lines"}</summary>
          <label class="visually-hidden" for="lp-note">Your note</label>
          <textarea id="lp-note" class="mark-input" rows="3" maxlength="${MARK_MAX}" placeholder="Your note…"></textarea>
          <div class="mark-actions"><button type="button" class="mark-save lp-save">Save note</button>
            <span class="mark-where">${signedIn() ? "Private: kept in your account" : "Private: kept in this browser"}</span></div>
        </details>` : "";
    // (4) The same lines in the text this one faces, else the book in other translations.
    const onScreen = ctx.col ? lpFacingOnScreen(ctx, els) : [];
    const fm = onScreen.length ? { items: onScreen, waiting: [] } : lpFacingModels(ctx, a, b);
    const books = fm.items.length || fm.waiting.length ? [] : lpOtherBooks(ctx);
    const parItem = (it) => `<div class="lp-par"><p class="lp-par-l">${esc(it.label)}</p>
        <p class="lp-quote lp-par-q"${it.lang ? ` lang="${esc(it.lang)}"` : ""}>${it.lines.map((t) => `<span class="lp-ql">${esc(t)}</span>`).join("")}</p></div>`;
    const parTitle = fm.items.length && fm.items.every((x) => x.orig) ? "In the original" : "In other translations";
    const parHTML = fm.items.length ? lpMoreList(fm.items, parItem)
      : fm.waiting.length ? `<p class="lp-wait">Finding the facing lines…</p>`
      : books.length ? `<p class="lp-books">Open this book in: ${books.map((x) => `<a href="${esc(x.href)}">${esc(x.label)}</a>`).join(" · ")}</p>` : "";
    // (6) What can be done with them.
    const listen = (own || ctx.col) && LISTEN && app.querySelector(".listen-open");
    const text = own ? SEL_CTX.text : ctx.text, translator = own ? SEL_CTX.translator : ctx.translator;
    const st = !prose && ctx.lines && text ? lpStanza(text, a) : null;
    const learn = st && st.b >= b && st.b - st.a < LEARN_PASSAGE_MAX;
    const words = lpWords(els), dict = els[0] ? lpDictFor(ctx, els[0]) : "en";
    const unit = prose ? "paragraph" : "line", units = a === b ? unit : unit + "s";
    const acts = [
      own ? `<button type="button" class="lp-act" data-act="quote">Copy quote</button>` : "",
      own ? `<button type="button" class="lp-act" data-act="link">Copy link to ${units}</button>` : "",
      listen ? `<button type="button" class="lp-act" data-act="listen">Listen from here</button>` : "",
      learn ? `<button type="button" class="lp-act" data-act="learn" aria-haspopup="dialog">Learn this stanza</button>` : "",
      own && PRINT_NOW && PRINT_NOW.hash === location.hash ? `<button type="button" class="lp-act" data-act="print" aria-haspopup="dialog">Print ${a === b ? "this " + unit : "these " + units}</button>` : "",
    ].join("");
    const lookHTML = words.length ? `<details class="lp-look"><summary>Look up a word in ${esc(DICTS[dict].name)}</summary>
        <p class="lp-words"${lang}>${words.map((w) => `<button type="button" class="lp-word" data-w="${esc(w)}" aria-label="Look up ${esc(w)} (opens a new tab)">${esc(w)}</button>`).join("")}</p></details>` : "";
    // (5) Sections added by later features.
    const info = { ctx, entry, a, b, place, lines: texts };
    const parts = LP_PARTS.map((f) => { try { return f(info); } catch (err) { return null; } }).filter((p) => p && p.html);
    const body = el.querySelector(".lp-body");
    body.innerHTML = `
      <section class="lp-sec lp-line" aria-label="The ${units}">${lineHTML}</section>
      <div class="lp-gl-slot"></div>
      ${sec("lp-marks", "Your notes on " + (a === b ? "this " + unit : "these " + units), marksHTML + addHTML)}
      ${sec("lp-pars", parTitle, parHTML)}
      ${parts.map((p, k) => `<section class="lp-sec lp-part" data-part="${k}"><h3 class="lp-h">${esc(p.title)}</h3>${p.html}</section>`).join("")}
      ${sec("lp-acts", "Do more", (acts ? `<div class="lp-act-row">${acts}</div>` : "") + lookHTML)}`;
    parts.forEach((p, k) => { if (p.bind) p.bind(body.querySelector(`[data-part="${k}"]`)); });
    body.querySelectorAll(".lp-showall").forEach((btn) => btn.addEventListener("click", () => {
      const rest = btn.previousElementSibling;
      rest.hidden = false; btn.remove();
      rest.tabIndex = -1; rest.focus();
    }));
    // Add a note: a line note, as the selection bar's Note makes one.
    const save = body.querySelector(".lp-save");
    if (save) save.addEventListener("click", () => {
      const input = body.querySelector("#lp-note");
      if (!input.value.trim()) { input.focus(); return; }
      putMark(entry, { id: "m" + Date.now().toString(36), a, b, quote: whole.slice(0, 300), text: input.value });
      input.blur();
      drawMarks();
      announce("Note saved.");
      const h = LP && LP.el.querySelector(".lp-marks .lp-h");
      if (h) { h.tabIndex = -1; h.focus(); }
    });
    // Edit: the note's own editor under its stanza, or the highlight's beside its words.
    body.querySelectorAll(".lp-edit").forEach((btn) => btn.addEventListener("click", () => {
      if (!LP_WIDE.matches) closeLinePanel(false);
      if (btn.dataset.mk) {
        const m = marksOf(ctx.entry.id).find((x) => x.id === btn.dataset.mk);
        if (m) { MARK_CTX = ctx; openMarkEditor(m, false); }
      } else {
        const h = hlOf(ctx.entry.id).find((x) => x.id === btn.dataset.hl);
        if (h) { HL_CTX = ctx; openHlPop(h, true); }
      }
    }));
    body.querySelectorAll(".lp-word").forEach((btn) => btn.addEventListener("click", () => window.open(DICTS[dict].url([btn.dataset.w]), "_blank", "noopener")));
    body.querySelectorAll(".lp-act").forEach((btn) => btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      if (act === "quote" || act === "link") { const q = lpQuote(a, b); if (q) quoteAction(act, q, false); return; }
      if (act === "print") { const from = LP.from; closeLinePanel(false); openPrint({ a, b }, from); return; }
      if (act === "listen") {
        if (!LP_WIDE.matches) closeLinePanel(false);
        startListen(app.querySelector(".listen-open"), els[0]);
        return;
      }
      if (act === "learn") {
        const from = LP.from;
        closeLinePanel(false);
        openLearn([{ label: "", entry, text, translator, lang, ok: true, own: true }], 0, { a: st.a + 1, b: st.b + 1 }, from);
      }
    }));
    // (2) The editors' study notes, and (4) the texts still to fetch, once they are in.
    lpGlosses(ctx, a, b).then((gs) => {
      if (!LP || LP.gen !== gen || !gs.length) return;
      const glRow = (g) => `<li class="lp-gl">
          <p class="lp-gl-k">${esc(g.kind || "note")}${g.ref ? ` · ${esc(g.ref)}` : ""}</p>
          <p class="lp-gl-t">${esc(g.title)}</p>
          ${g.greek ? `<p class="gl-greek">${esc(g.greek)}</p>` : ""}
          ${g.short ? `<p class="lp-gl-s">${esc(g.short)}</p>` : ""}
          ${g.body ? `<details class="lp-gl-more"><summary>The whole note</summary><div class="gl-body">${String(g.body).split(/\n\s*\n/).map((t) => `<p>${esc(t)}</p>`).join("")}</div>
            ${(g.sources || []).length ? `<p class="lp-gl-src">Sources: ${g.sources.map((x) => x.url ? `<a href="${esc(x.url)}" rel="noopener" target="_blank">${esc(x.cite)}</a>` : esc(x.cite)).join("; ")}</p>` : ""}</details>` : ""}
        </li>`;
      el.querySelector(".lp-gl-slot").innerHTML = sec("lp-gls", gs.length === 1 ? "Editors’ note" : "Editors’ notes", `<ul class="lp-list">${gs.map(glRow).join("")}</ul>`);
    });
    if (fm.waiting.length) Promise.all(fm.waiting.map((e) => loadPartner(LP_FACING.kind, e.with).catch(() => null)))
      .then(() => { if (LP && LP.gen === gen) lpDraw(); });
  }
  // The page's own lines a..b as "Copy quote" and "Copy link" take them (quoteParts).
  function lpQuote(a, b) {
    const root = SOLO_CTX && SOLO_CTX.root;
    if (!root || !root.isConnected || !SEL_CTX) return null;
    const prose = root.classList.contains("is-prose");
    const units = prose ? [...root.querySelectorAll(":scope > p")].slice(a, b + 1)
      : [...root.querySelectorAll(".ln[data-i]")].filter((l) => +l.dataset.i >= a && +l.dataset.i <= b);
    return quoteParts(root, units.map((u) => ({ u, t: u.textContent })).filter((p) => p.t.trim()));
  }

  // ---------- print for class ----------
  // "Print" under every poem and book (beside Cite and Copy link), and "Print these lines" in
  // the "This line" panel, open a small dialog: line numbers every fifth line, on every line or
  // off; "Leave room for notes" (the text in a column 58% wide beside a ruled blank margin);
  // "Include my marks and notes" (highlights print as underlines, the reader's line notes and
  // notes on highlights as numbered notes at the end); "Print only lines a to b" (filled in
  // from the lines chosen in the panel). A long print (over PRINT_PAGES_WARN pages) is said so;
  // a book of a long work prints that book only, never the whole work. The choices are kept in
  // this browser only (pc-print: {nums, room, marks}; not synced). Printing builds a clean copy
  // of the text on screen, alone or facing its original (.pr-sheet: a header with the title,
  // author, translator and edition; the text; the notes; a footer with the MLA entry, the
  // permanent address, the date and "Public domain text, Poetry Codex"), and while the body
  // has .pc-printing the stylesheet prints only that, black on white in a serif face, with the
  // work and book at the head of every later page. The browser's own print (Save as PDF, or
  // Share on a phone) does the rest. Ctrl+P without the dialog prints the page as before.
  const PRINT_KEY = "pc-print";
  const PRINT_PAGES_WARN = 40;
  let PRINT_NOW = null;    // the page's print setup (bindPrint): {hash, cite, entry, title, author, translator, work, part, ...}
  function printPrefs() {
    const p = readStore(PRINT_KEY);
    return { nums: ["five", "every", "off"].includes(p.nums) ? p.nums : "five", room: p.room === true, marks: p.marks === true };
  }
  function bindPrint(o) {
    PRINT_NOW = Object.assign({ hash: location.hash }, o);
    const btn = app.querySelector(".cite-print");
    if (btn) btn.addEventListener("click", () => openPrint(null, btn));
  }
  // The text on screen: the text alone (always there, hidden while the facing pages show) and
  // the facing pages when they are open.
  function printSource() {
    const solo = (SOLO_CTX && SOLO_CTX.root.isConnected && SOLO_CTX.root)
      || app.querySelector(".text-solo .poem-text") || app.querySelector(".poem-text");
    if (!solo) return null;
    return { solo, fx: app.querySelector(".fx-slot:not([hidden]) .fx"), prose: solo.classList.contains("is-prose") };
  }
  // The text's units as the dialog counts them: {k (the line's data-i, or the paragraph from
  // 0), n (its printed number: the counted line, 0 for a heading; the paragraph from 1), len,
  // gap (it opens a stanza or a paragraph)}.
  function printUnits(src) {
    if (src.prose) return [...src.solo.querySelectorAll(":scope > p")].map((p, k) => ({ k, n: k + 1, len: p.textContent.length, gap: true }));
    return [...src.solo.querySelectorAll(".ln[data-i]")].map((l) => ({ k: +l.dataset.i, n: +(l.dataset.c || 0),
      len: l.textContent.length, gap: l === l.parentElement.querySelector(".ln") }));
  }
  // Printed numbers from..to as units a..b (a heading inside the stretch goes with it), and back.
  function printRangeUnits(us, from, to) {
    const hit = us.filter((u) => u.n && u.n >= from && u.n <= to);
    return hit.length ? { a: hit[0].k, b: hit[hit.length - 1].k } : null;
  }
  function printRangeNums(us, r) {
    const hit = us.filter((u) => u.k >= r.a && u.k <= r.b && u.n);
    if (hit.length) return { from: hit[0].n, to: hit[hit.length - 1].n };
    const next = us.find((u) => u.k > r.b && u.n) || us.find((u) => u.n);
    return next ? { from: next.n, to: next.n } : null;
  }
  // About how many A4 or Letter pages: some 42 lines a page, a long line wrapping (sooner in
  // the narrower column), a little more for each stanza break, the header and the footer.
  function printPages(us, room, facing) {
    const cap = room ? 46 : 78;
    let rows = 14;
    us.forEach((u) => { rows += Math.max(1, Math.ceil(u.len / cap)) + (u.gap ? 0.8 : 0); });
    return Math.max(1, Math.ceil((rows * (facing ? 2 : 1)) / 42));
  }
  // range: units {a, b} from the line panel, or null; from: the button the focus goes back to.
  function openPrint(range, from) {
    const P = PRINT_NOW, src = printSource();
    if (!P || P.hash !== location.hash || !src) return;
    const us = printUnits(src), pref = printPrefs();
    const unit = src.prose ? "paragraph" : "line";
    const max = us.reduce((m, u) => Math.max(m, u.n), 0);
    const nums = (range && printRangeNums(us, range)) || { from: 1, to: max };
    const hasMarks = marksOf(P.entry.id).length > 0;
    const numsNow = src.prose && pref.nums === "every" ? "five" : pref.nums;
    const radio = (v, label) => `<label class="pr-opt"><input type="radio" name="pr-nums" value="${v}"${numsNow === v ? " checked" : ""}> ${label}</label>`;
    const dlg = document.createElement("dialog");
    dlg.className = "pr-dlg";
    dlg.setAttribute("aria-labelledby", "pr-t");
    dlg.innerHTML = `
      <form method="dialog">
        <h2 class="pr-t" id="pr-t">Print ${range ? (nums.from === nums.to ? `this ${unit}` : `these ${unit}s`) : P.part ? "this book" : P.work ? "this text" : "this poem"}</h2>
        <p class="pr-d">${esc(P.part ? P.work + " · " + P.part : P.title)}${P.part ? " (this book only)" : ""}</p>
        <fieldset class="pr-f"><legend>${!src.prose ? "Line numbers" : src.solo.classList.contains("greek-lines") ? "Greek line numbers" : "Paragraph numbers"}</legend>
          <div class="pr-opts">${src.prose ? radio("five", "On") + radio("off", "Off")
            : radio("five", "Every 5 lines") + radio("every", "Every line") + radio("off", "Off")}</div>
        </fieldset>
        <label class="pr-check"><input type="checkbox" name="pr-room"${pref.room ? " checked" : ""}>
          <span>Leave room for notes<small>The text in a narrower column beside a ruled blank margin</small></span></label>
        <label class="pr-check"><input type="checkbox" name="pr-marks"${pref.marks && hasMarks ? " checked" : ""}${hasMarks ? "" : " disabled"}>
          <span>Include my marks and notes<small>${hasMarks ? "Highlights print as underlines; your notes are numbered and printed at the end"
            : "You have no highlights or notes on this text"}</small></span></label>
        ${max ? `<div class="pr-range">
          <label class="pr-check"><input type="checkbox" name="pr-only"${range ? " checked" : ""}><span>Print only ${unit}s</span></label>
          <span class="pr-nums">
            <label>from <input type="number" name="pr-from" inputmode="numeric" min="1" max="${max}" value="${nums.from}" aria-label="First ${unit} to print"></label>
            <label>to <input type="number" name="pr-to" inputmode="numeric" min="1" max="${max}" value="${nums.to}" aria-label="Last ${unit} to print"></label>
          </span>
        </div>` : ""}
        ${src.fx ? `<p class="pr-hint">The facing pages print side by side on a landscape page and one above the other on a portrait page.</p>` : ""}
        ${!src.fx && omOn(P.entry.id) ? `<p class="pr-hint">“Only my marks” is on: the lines it folds away are left out of the print.</p>` : ""}
        <p class="pr-warn" role="status"></p>
        <div class="mark-actions">
          <button value="print" class="mark-save pr-go">Print</button>
          <button value="cancel" class="mark-cancel">Cancel</button>
        </div>
      </form>`;
    const f = dlg.querySelector("form"), el = (n) => f.elements[n];
    const opts = () => {
      const only = !!(el("pr-only") && el("pr-only").checked);
      const a = only ? +el("pr-from").value || 1 : 1, b = only ? +el("pr-to").value || max : max;
      return { nums: (f.querySelector('[name="pr-nums"]:checked') || {}).value || "five", room: el("pr-room").checked,
               marks: el("pr-marks").checked && !el("pr-marks").disabled, only,
               range: only ? printRangeUnits(us, Math.min(a, b), Math.max(a, b)) : null };
    };
    const warn = dlg.querySelector(".pr-warn"), go = dlg.querySelector(".pr-go");
    const update = () => {
      const o = opts();
      const part = o.range ? us.filter((u) => u.k >= o.range.a && u.k <= o.range.b) : us;
      const pages = printPages(part, o.room, !!src.fx && !(o.range && src.prose));
      go.disabled = o.only && !o.range;
      warn.classList.toggle("is-long", pages > PRINT_PAGES_WARN && !go.disabled);
      warn.textContent = go.disabled ? `No ${unit} here is numbered ${el("pr-from").value}–${el("pr-to").value}.`
        : pages > PRINT_PAGES_WARN ? `About ${num(pages)} pages: a long print. To print a part, tick “Print only ${unit}s”.`
        : `About ${pages} page${pages === 1 ? "" : "s"}.`;
    };
    f.addEventListener("input", (e) => {
      if (e.target.name === "pr-from" || e.target.name === "pr-to") el("pr-only").checked = true;
      update();
    });
    f.addEventListener("change", update);
    update();
    dlg.addEventListener("close", () => {
      const o = opts();
      dlg.remove();
      if (from && from.isConnected) from.focus({ preventScroll: true });
      if (dlg.returnValue !== "print" || (o.only && !o.range)) return;
      writeStore(PRINT_KEY, { nums: o.nums, room: o.room, marks: el("pr-marks").disabled ? pref.marks : o.marks });
      printNow(P, src, o);
    });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }
  // The clean copy of the text and what goes round it.
  function printSheet(P, src, o) {
    const id = P.entry.id, r = o.range;
    const facing = !!src.fx && !(r && src.prose);   // a prose stretch is paragraphs; the columns count lines
    const body = (facing ? src.fx : src.solo).cloneNode(true);
    // "Only my marks" on: what it folds away stays out, a row in its place saying how much.
    if (!facing && omOn(id)) {
      body.querySelectorAll(".om-gap").forEach((g) => {
        if (g.getAttribute("aria-expanded") === "true") { g.remove(); return; }
        const row = document.createElement("span");
        row.className = "pr-gap";
        row.textContent = g.dataset.label;
        g.replaceWith(row);
      });
      body.querySelectorAll(".om-hide").forEach((x) => {
        if (x.nextElementSibling && x.nextElementSibling.tagName === "BR") x.nextElementSibling.remove();
        x.remove();
      });
    }
    // The who's who fold is for reading on the screen: the sheet has every line.
    body.querySelectorAll(".pp-hide").forEach((x) => x.classList.remove("pp-hide"));
    // What only the screen needs goes: buttons, pop-ups, the study notes' underlines, the
    // passing classes of the panel, Listen and the margin notes, and ids (the page keeps its own).
    body.querySelectorAll("button, .mark-pop, .mn-col, .fx-switch, .fx-open").forEach((x) => x.remove());
    body.querySelectorAll("span.gl").forEach((g) => g.replaceWith(...g.childNodes));
    body.querySelectorAll("[id], [tabindex], [role]").forEach((x) => { x.removeAttribute("id"); x.removeAttribute("tabindex"); x.removeAttribute("role"); });
    body.querySelectorAll(".lp-sel, .is-hover, .is-now, .is-spoken, .has-note").forEach((x) => x.classList.remove("lp-sel", "is-hover", "is-now", "is-spoken", "has-note"));
    body.querySelectorAll("[title]").forEach((x) => x.removeAttribute("title"));
    body.classList.remove("numbered", "lp-on");
    body.removeAttribute("role");
    if (facing) body.dataset.view = "both";
    // Only lines a..b (with the facing pages, the rows they stand in).
    if (r && facing) {
      let keep = r.a === 0;
      body.querySelectorAll(".fx-row:not(.fx-head)").forEach((row) => {
        const own = [...row.querySelectorAll(`[data-u][data-e="${CSS.escape(id)}"]`)].map((x) => +x.dataset.u);
        if (own.length) keep = own.some((k) => k >= r.a && k <= r.b);
        if (!keep) row.remove();
      });
    } else if (r && src.prose) {
      [...body.querySelectorAll(":scope > p")].forEach((p, k) => { if (k < r.a || k > r.b) p.remove(); });
    } else if (r) {
      body.querySelectorAll(".ln[data-i]").forEach((l) => {
        const k = +l.dataset.i;
        if (k >= r.a && k <= r.b) return;
        if (l.nextElementSibling && l.nextElementSibling.tagName === "BR") l.nextElementSibling.remove();
        l.remove();
      });
      body.querySelectorAll(".stanza").forEach((s) => { if (!s.querySelector(".ln")) s.remove(); });
    }
    // A stanza (or a speech set as one) of up to twelve lines is kept on one page.
    body.querySelectorAll(".stanza").forEach((s) => { if (s.querySelectorAll(".ln").length <= 12) s.classList.add("pr-keep"); });
    // Line numbers: every fifth counted line (and the first of a stretch), every line, or none.
    if (facing) {
      if (o.nums === "off") body.querySelectorAll("[data-n]").forEach((x) => x.removeAttribute("data-n"));
    } else if (src.prose) {
      body.querySelectorAll(":scope > p").forEach((p) => { if (o.nums !== "off" && p.dataset.n) p.dataset.pn = p.dataset.n; });
    } else {
      const first = body.querySelector(".ln[data-c]");
      body.querySelectorAll(".ln").forEach((l) => {
        l.removeAttribute("data-n");
        const c = +(l.dataset.c || 0);
        if (c && (o.nums === "every" || (o.nums === "five" && (c % 5 === 0 || (r && l === first))))) l.dataset.pn = c;
      });
    }
    // The reader's marks: highlights stay (printed as underlines) and every note, on a line or
    // on a highlight, gets a number after its words and is printed at the end.
    body.querySelectorAll(".has-mark").forEach((x) => x.classList.remove("has-mark"));
    let notesHTML = "", keyHTML = "";
    if (!o.marks) body.querySelectorAll("mark.hl").forEach((m) => m.replaceWith(...m.childNodes));
    else {
      const lineAt = (k) => body.querySelector(facing ? `[data-u="${k}"][data-e="${CSS.escape(id)}"]` : `.ln[data-i="${k}"]`);
      const ctx = SOLO_CTX && SOLO_CTX.entry.id === id ? SOLO_CTX : null;
      const items = [];
      marksOf(id).forEach((m) => {
        if (!String(m.text || "").trim()) return;
        let at = null;
        if (m.kind === "hl") {
          const ms = body.querySelectorAll(`mark.hl[data-hl="${CSS.escape(m.id)}"]`);
          at = ms[ms.length - 1] || null;
        } else for (let k = m.b; k >= m.a && !at; k--) at = lineAt(k);
        if (!at) return;
        const sup = document.createElement("sup");
        sup.className = "pr-ref";
        if (m.kind === "hl") at.after(sup); else at.appendChild(sup);
        let place = "";
        try {
          const line = m.kind === "hl" && !src.prose ? at.closest(facing ? "[data-u]" : ".ln[data-i]") : null;
          if (ctx && m.kind !== "hl") place = lpPlace(ctx, m.a, m.b);
          else if (ctx && line) { const k = +(facing ? line.dataset.u : line.dataset.i); place = lpPlace(ctx, k, k); }
        } catch (err) { place = ""; }
        items.push({ m, sup, place: /^Lines? \d/.test(place) ? place : "" });
      });
      items.sort((x, y) => (x.sup.compareDocumentPosition(y.sup) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      items.forEach((it, k) => { it.sup.textContent = k + 1; });
      if (items.length) notesHTML = `
        <section class="pr-notes"><h2 class="pr-h">Your notes</h2><ol>${items.map((it) => `
          <li><span class="pr-nq">${it.place ? esc(it.place) + ": " : ""}“${esc(String(it.m.quote || "").replace(/\s+/g, " ").slice(0, 140))}${String(it.m.quote || "").length > 140 ? "…" : ""}”</span>
            <span class="pr-nt">${esc(it.m.text)}</span></li>`).join("")}</ol></section>`;
      // Underlines tell the colours apart on black-and-white paper.
      const LINE = { yellow: "solid", green: "double", blue: "dotted", pink: "wavy", q: "dashed" };
      const used = HL_KINDS.filter((c) => body.querySelector("mark.hl-" + c)), names = hlMeanings();
      if (used.length) keyHTML = `<p class="pr-key">Your highlights are underlined: ${used.map((c) =>
        `<span class="pr-u hl-${c}">${LINE[c]}</span> for ${c === "q" ? "questions" : HL_NAMES[c].toLowerCase()}${names[c] ? " (" + esc(names[c]) + ")" : ""}`).join(", ")}.</p>`;
    }
    // The header, the stretch printed and the citation for it.
    const rn = r ? printRangeNums(printUnits(src), r) : null;
    const where = !rn ? "" : src.prose ? (rn.from === rn.to ? `Paragraph ${rn.from}` : `Paragraphs ${rn.from}–${rn.to}`)
      : rn.from === rn.to ? `Line ${rn.from}` : `Lines ${rn.from}–${rn.to}`;
    const loc = !rn ? "" : src.prose ? (rn.from === rn.to ? `para. ${rn.from}` : `paras. ${rn.from}–${rn.to}`)
      : rn.from === rn.to ? `line ${rn.from}` : `lines ${rn.from}–${rn.to}`;
    const mla = citations(Object.assign({}, P.cite, loc ? { loc } : {}))[0];
    const dates = (POETS[P.authorSlug] || {}).dates;
    const source = [P.translator && translatedBy(P.translator), P.collection && "From " + P.collection].filter(Boolean).join(" · ");
    const d = new Date();
    const sheet = document.createElement("div");
    sheet.className = "pr-sheet" + (o.room ? " pr-room" : "") + (facing ? " pr-facing" : "");
    sheet.setAttribute("aria-hidden", "true");
    sheet.innerHTML = `
      <header class="pr-head">
        ${P.kicker ? `<p class="pr-kicker">${esc(P.kicker)}</p>` : ""}
        <h1 class="pr-title"${langAttr(P.authorSlug, P.translator)}>${esc(P.title)}</h1>
        <p class="pr-by">by ${esc(P.author)}${dates ? ` <span class="pr-dates">${esc(dates)}</span>` : ""}</p>
        ${source ? `<p class="pr-src">${esc(source)}</p>` : ""}
        ${where ? `<p class="pr-where">${esc(where)}</p>` : ""}
      </header>
      <div class="pr-body"></div>
      ${keyHTML}${notesHTML}
      <footer class="pr-foot">
        <p class="pr-cite"><span class="pr-lbl">MLA</span> ${mla.html}</p>
        <p>Permanent address: ${esc(SITE + P.cite.path)} · Printed ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}</p>
        <p class="pr-pd">Public domain text, Poetry Codex</p>
      </footer>`;
    sheet.querySelector(".pr-body").appendChild(body);
    return sheet;
  }
  let PRINT_DONE = null;   // takes away the last copy printed (and its listeners)
  function printNow(P, src, o) {
    if (PRINT_DONE) PRINT_DONE();
    document.querySelectorAll(".pr-sheet, #pr-page").forEach((x) => x.remove());
    const sheet = printSheet(P, src, o);
    // The work and the book (or the poem and its poet) at the head of every page after the
    // first, and the page number at the foot (page margin boxes: Chrome and Edge; elsewhere
    // the pages go without).
    const str = (s) => '"' + String(s).replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ") + '"';
    const run = P.part ? `${P.work} · ${P.part}` : P.work ? `${P.work} · ${P.author}` : `${P.title} · ${P.author}`;
    const page = document.createElement("style");
    page.id = "pr-page";
    page.textContent = `@media print {
      @page { @top-center { content: ${str(run)}; font: italic 9pt Georgia, "Times New Roman", serif; color: #333; }
              @bottom-center { content: counter(page); font: 9pt Georgia, "Times New Roman", serif; color: #333; } }
      @page :first { @top-center { content: none; } } }`;
    document.head.appendChild(page);
    document.body.appendChild(sheet);
    document.body.classList.add("pc-printing");
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      PRINT_DONE = null;
      document.body.classList.remove("pc-printing");
      sheet.remove(); page.remove();
      window.removeEventListener("afterprint", later);
      window.removeEventListener("hashchange", done);
    };
    // A phone's browser may lay the page out after print() returns: there the copy stays (it
    // is never shown on screen) until the reader leaves the page.
    const later = () => { if (!window.matchMedia("(pointer: coarse)").matches) timer = setTimeout(done, 500); };
    window.addEventListener("afterprint", later);
    window.addEventListener("hashchange", done);
    PRINT_DONE = done;
    window.print();
  }

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
    planReached(slug, i, frac);     // a reading plan's portion ends here: it is done (reading plans)
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
    // Works, long poems and reading plans by entry, the newer winning; the recent list as one
    // list, newest first, without what either side cleared.
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
      // Reading plans by work, the newer record winning (a dropped plan is a dated {gone}).
      const plans = newer("plans");
      if (Object.keys(plans).length) out.plans = plans;
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
      <li class="mark-row"><p class="mark-row-note">${noteHTML(n.text)}</p>
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
  // The language of a text itself (its titles stay with langAttr): screen readers then read
  // Old English, Chaucer or the Latin Dies irae in the right voice. Only an untranslated text
  // can be other than English: Turkish as above; Old English (an Anglo-Saxon or Medieval text
  // written with ash and its commonest words, þæt, ond, wæs); Middle English, or Middle Scots for
  // Barbour, Blind Hary, Henryson and Gavin Douglas (else a Medieval text looksArchaic finds old);
  // the few originals printed beside the translations (TEXT_LANG_IDS); and, for a poet of a
  // translated literature whose own words are given, that literature's language.
  const TEXT_LANG_IDS = { "arndt/1": "de", "luther/45": "de", "jacopone-da-todi/7": "la", "thomas-of-celano/8": "la" };
  const SCOTS = new Set(["barbour", "blind-hary", "henryson", "douglas_g", "lancelot-of-the-laik"]);
  const CAT_LANG = { German: "de", French: "fr", Italian: "it" };
  // id: a poem's id, or "work:<slug>" for a book of a long work.
  function textLang(authorSlug, translator, text, id) {
    if (langAttr(authorSlug, translator)) return "tr";
    if (String(translator || "").trim()) return "";
    if (TEXT_LANG_IDS[id]) return TEXT_LANG_IDS[id];
    // A page drawn before the index is in knows no category: the text alone then decides.
    const cat = POETS[authorSlug] ? POETS[authorSlug].category : "";
    const work = /^work:/.test(id || "") ? id.slice(5) : "";
    const sample = String(text || "").slice(0, 4000);
    const early = !cat || cat === "Anglo-Saxon" || cat === "Medieval";
    if (early && /æ/i.test(sample) && /(?:^|[^\p{L}])(?:þæt|ðæt|ond|wæs)(?![\p{L}])/iu.test(sample)) return "ang";
    if (early && (SCOTS.has(authorSlug) || SCOTS.has(work))) return "sco";
    if (early && looksArchaic(sample)) return "enm";
    if (cat === "Ancient Greek & Roman") return /[Ͱ-Ͽἀ-῿]/.test(sample) ? "grc" : "";
    return CAT_LANG[cat] || "";
  }
  const textLangAttr = (authorSlug, translator, text, id) => {
    const l = textLang(authorSlug, translator, text, id);
    return l ? ` lang="${l}"` : "";
  };

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
  function proseParas(text) {
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
    return paras;
  }
  function proseHTML(text) {
    return proseParas(text).map((p, k) => `<p data-n="${k + 1}">${esc(p)}</p>`).join("");
  }
  // Verse: stanzas become paragraphs and each line its own block (styles.css .ln: hanging
  // indent, leading spaces kept); every fifth line carries its number for the optional
  // gutter. Headings are shown but not counted: a line with no lower-case letter ("12",
  // "BOOK I.", "THE ARGUMENT.") and an Argument (a stanza opening "Argument", or the
  // stanza after a heading that is only "THE ARGUMENT."), as editions number them.
  // The <br> is hidden by the stylesheet; it keeps lines apart in reader modes.
  // A poem of more than one stanza names each one for a screen reader (a group labelled
  // "Stanza 3"), with no words added to the text, so copying and the line indexes are as before.
  // Mirrors para_html in tools/build_pages.py (which does not number).
  const ARGUMENT = /^(the\s+)?argument\b/i;
  function poemHTML(text, prose) {
    if (prose) return proseHTML(text);
    const stanzas = String(text || "").split(/\n\s*\n/).filter((s) => s.trim());
    let n = 0, i = 0, skipNext = false;
    return stanzas.map((st, k) => {
      const ls = st.split("\n").filter((l) => l.trim());
      const first = ls[0].trim();
      const argument = skipNext || ARGUMENT.test(first);
      skipNext = ARGUMENT.test(first) && ls.length === 1;
      return `<p class="stanza"${stanzas.length > 1 ? ` role="group" aria-label="Stanza ${k + 1}"` : ""}>${ls.map((l) => {
        // data-c: every counted line's number (quotations cite it); data-n: the printed fifth.
        const c = !argument && /\p{Ll}/u.test(l) ? ++n : 0;
        // An indent of eight spaces or more is a span of its own, which a phone caps at a
        // quarter of the line (styles.css .ind); the text and its offsets are unchanged.
        const t = l.replace(/\s+$/, ""), ind = /^[ \t]{8,}/.exec(t);
        return `<span class="ln" data-i="${i++}"${c ? ` data-c="${c}"` : ""}${c && c % 5 === 0 ? ` data-n="${c}"` : ""}>${ind ? `<span class="ind">${ind[0]}</span>${esc(t.slice(ind[0].length))}` : esc(t)}</span><br>`;
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
        let prev = root.previousElementSibling;
        if (prev && prev.classList.contains("om-bar")) prev = prev.previousElementSibling;   // "Only my marks" bar
        const made = prev && prev.classList.contains("ln-bar");
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
    LP_FACING = bar ? Object.assign({ hash: location.hash }, ctx) : null;   // the "This line" panel's own lines in the other text
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
  // it wins. Spacing's Wide is the WCAG text-spacing test made a setting (letters .12em apart,
  // words .16em, lines and stanzas further apart); "Dyslexia-friendly" is Wide with the Legible
  // font, and then the editors' notes are set upright. Focus (pc-prefs focus, a
  // switch here and on the phone's reading bar) dims all but one stanza, see "Focus" below.
  // Signed in, each choice also goes into pc-parallel as aa: {choice: value, at} (the
  // Worker keeps only the kinds it knows; MERGE.parallel keeps the newer aa) and is taken from
  // there after each sync. The theme is the exception: Auto ("follow this device") is never
  // sent, and a device on Auto stays on Auto, so a phone that follows the system keeps doing so.
  const READ_PREFS = {
    theme: ["", "light", "paper", "dark", "black"], font: ["", "plain", "legible"],
    text: ["", "l", "xl", "xxl"], lh: ["snug", "", "airy", "wide"], measure: ["narrow", "", "wide"] };
  const RT_ROWS = [
    ["theme", "Theme", [["", "Auto", "Follow this device's light or dark setting"], ["light", "Light"], ["paper", "Paper", "Warm off-white, like a book's page"],
      ["dark", "Dark"], ["black", "Black", "Pure black, for OLED screens"]]],
    ["font", "Font", [["", "Book", "Fraunces, the Codex's serif"], ["plain", "Plain", "A plain sans-serif"],
      ["legible", "Legible", "Atkinson Hyperlegible, made for low vision"]]],
    ["text", "Text size", [["", "Standard text"], ["l", "Larger text"], ["xl", "Larger still"], ["xxl", "Largest text"]]],
    ["lh", "Spacing", [["snug", "Snug"], ["", "Standard"], ["airy", "Airy"], ["wide", "Wide", "Wider gaps between letters, words, lines and stanzas"]]],
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
    if (Object.keys(change).some((k) => k !== "theme" && k !== "lines" && k !== "gloss" && k !== "focus")) window.dispatchEvent(new Event("resize"));
    if ("focus" in change) fmRefresh();
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
      if (k === "focus") { if (typeof aa[k] === "boolean" && aa[k] !== focusOn()) change[k] = aa[k]; return; }
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
    document.querySelectorAll(".rt-dys").forEach((b) => b.setAttribute("aria-pressed", String(dyslexiaOn())));
    document.querySelectorAll(".rt-focus, .rb-focus").forEach((b) => b.setAttribute("aria-pressed", String(focusOn())));
  }
  function dyslexiaOn() { return readPref("font") === "legible" && readPref("lh") === "wide"; }
  function readingToolsHTML() {
    const row = ([kind, legend, opts]) => `
          <fieldset class="rt-row rt-row-${kind}"><legend class="rt-label">${legend}</legend><span class="rt-opts">
            ${opts.map(([v, label, title], k) => kind === "text"
              ? `<label class="rt-opt"><input type="radio" name="rt-${kind}" value="${v}" aria-label="${label}"${readPref(kind) === v ? " checked" : ""}><span class="rt-a rt-a${k + 1}" aria-hidden="true">A</span></label>`
              : `<label class="rt-opt"${title ? ` title="${esc(title)}"` : ""}><input type="radio" name="rt-${kind}" value="${v}"${readPref(kind) === v ? " checked" : ""}><span>${label}</span></label>`).join("")}
          </span></fieldset>`;
    return `<div class="rt">
        <button class="rt-toggle" type="button" aria-expanded="false" aria-controls="rt-panel" aria-label="Reading settings: theme, font, size, spacing, width, focus" title="Reading settings">Aa</button>
        <div class="rt-panel" id="rt-panel" hidden>${RT_ROWS.map(row).join("")}
          <div class="rt-switches">
            <button type="button" class="rt-switch rt-dys" aria-pressed="${dyslexiaOn()}">Dyslexia-friendly<span class="rt-sw-sub">Legible font, wide spacing</span></button>
            <button type="button" class="rt-switch rt-focus" aria-pressed="${focusOn()}">Focus<span class="rt-sw-sub">Dim all but one stanza</span></button>
          </div>
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
    panel.querySelector(".rt-dys").addEventListener("click", () => {
      const on = !dyslexiaOn();
      setReadPref(on ? { font: "legible", lh: "wide" } : { font: "", lh: "" });
      announce(on ? "Dyslexia-friendly text: legible font, wide spacing." : "Standard font and spacing.");
    });
    panel.querySelector(".rt-focus").addEventListener("click", () => setFocusMode(!focusOn()));
    panel.querySelector(".rt-reset").addEventListener("click", () => {
      setReadPref({ theme: "", font: "", text: "", lh: "", measure: "", focus: false });
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
    omReveal(el);
    ppReveal(el);
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
    lpFocusLine(el);   // its margin target: Enter then opens "This line"
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
    [["n", "p"], "Next or previous speech, while following a speaker in a play (Speakers)"],
    [["t"], "Reading settings (Aa)"],
    [["Enter", "Shift+Enter"], "Next or previous match, in Find"],
    [["Esc"], "Close Find, a panel or this list"],
    [["Enter"], "More on the line in focus (Tab to the margin beside a line; Up and Down move)"],
    [["[", "]"], "Previous or next stanza (a speech in a play, a paragraph in prose)"],
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
    // [ and ] are typed with AltGr (Ctrl+Alt) on Turkish, German and other keyboards.
    const bracket = e.key === "[" || e.key === "]";
    if (e.defaultPrevented || e.metaKey || e.isComposing || ((e.ctrlKey || e.altKey) && !(bracket && e.ctrlKey && e.altKey))) return;
    const t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='listbox'], [role='menu'], [role='tablist'], [role='radiogroup'], .hl-bar, .find-bar, .listen-bar, .lp, dialog")) return;
    const key = e.key;
    if (key === "?") { e.preventDefault(); openKeySheet(); return; }
    if (!app.querySelector(".detail .poem-text, .compare .poem-text")) return;   // reading pages only
    if (key === "/") { e.preventDefault(); openFind(false); return; }   // Shift+7 on a Turkish keyboard
    if (bracket) { if (fmStep(key === "]" ? 1 : -1)) e.preventDefault(); return; }
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
    } else if ((key === "n" || key === "p") && spkFollowing() && !(key === "n" && hlSelection())) {
      e.preventDefault(); spkStep(key === "n" ? 1 : -1);
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
  // Contents (a book) or Save (a poem) · Focus · Next, each an icon with its name under it. The
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
    marks: '<path d="M4 5h16M7 12h10M10 19h4"/>',
    focus: '<path d="M4 6h16M4 18h16" stroke-opacity=".35"/><path d="M4 12h16" stroke-width="2.6"/>',
    speakers: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.3a3 3 0 0 1 0 5.4M17 14.2c2 .6 3.2 2.2 3.6 4.8"/>',
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
      app.querySelector(".rt") ? item("rb-focus", rbIcon("focus"), "Focus", ` aria-pressed="${focusOn()}"`) : "",
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
    const focus = nav.querySelector(".rb-focus");
    if (focus) focus.addEventListener("click", () => setFocusMode(!focusOn()));
    RB = { nav, kind: o.contents ? "work" : "poem", last: window.scrollY, turn: window.scrollY, kb: false };
    bindFocus();             // Focus and the [ ] keys, on this page's text
    omControls(omCtx());     // "My marks", while the text has marks
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
    const pop = document.querySelector(".hl-bar:not([hidden]), .gl-pop, .hl-pop, .shelf-menu, .lp.is-sheet");
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

  // ---------- Focus: one stanza at a time; [ and ] between stanzas ----------
  // Focus (off by default: Aa's switch, or the phone's reading bar) dims every stanza of the
  // text on screen but one to 35%, to help a reader keep their place. The one left bright is
  // the one last tapped, else, while scrolling, the one at the upper third of the screen.
  // [ and ] move to the previous or next stanza, with or without Focus: a speech in a play is
  // set as a stanza, a prose translation moves by paragraph, and the facing pages by their
  // rows from one stanza break to the next (each passage, where passages face paragraphs). The
  // stanza moved to is put at the upper third of the screen and takes the keyboard focus, so a
  // screen reader reads it. Each unit's elements carry data-fm (its number) and the bright one
  // fm-cur; styles.css dims the rest while the text has fm-on. Only the switch is kept
  // (pc-prefs focus, beside the Aa choices, so it follows a signed-in reader).
  function focusOn() { return prefs().focus === true; }
  let FM = null;             // {root, units: [[element, …], …], at} for the text on screen
  function setFocusMode(on) {
    setReadPref({ focus: on });
    announce(on ? "Focus on: one stanza at a time. Press [ or ] to move." : "Focus off.");
  }
  // The text on screen, cut into units (a line hidden by "My marks" is left out).
  function fmUnits() {
    const fx = app.querySelector(".detail .fx-slot:not([hidden]) .fx");
    const root = fx || app.querySelector(".detail .poem-text");
    if (!root) return null;
    let units = [];
    if (fx) {
      const blocks = fx.dataset.mode === "blocks";
      fx.querySelectorAll(".fx-row:not(.fx-head)").forEach((r) => {
        if (!units.length || blocks || r.classList.contains("gap") || r.classList.contains("fx-bookrow")) units.push([]);
        units[units.length - 1].push(r);
      });
    } else units = [...root.querySelectorAll(root.classList.contains("is-prose") ? ":scope > p" : ".stanza")].map((el) => [el]);
    units = units.map((u) => u.filter((el) => el.getClientRects().length)).filter((u) => u.length);
    units.forEach((u, k) => u.forEach((el) => { el.dataset.fm = k; }));
    return { root, units, at: null };
  }
  // The unit at the upper third of the screen, or the nearest one to it.
  function fmAtScroll() {
    const us = FM.units, y = window.innerHeight / 3;
    let lo = 0, hi = us.length - 1;
    while (lo < hi) {                   // the last unit whose top is above that line
      const mid = (lo + hi + 1) >> 1;
      if (us[mid][0].getBoundingClientRect().top <= y) lo = mid; else hi = mid - 1;
    }
    const last = us[lo][us[lo].length - 1].getBoundingClientRect();
    if (last.bottom >= y || lo === us.length - 1) return lo;
    return y - last.bottom < us[lo + 1][0].getBoundingClientRect().top - y ? lo : lo + 1;
  }
  function fmShow(k) {
    if (!FM) return;
    FM.at = k;
    const on = focusOn();
    FM.root.classList.toggle("fm-on", on);
    FM.root.querySelectorAll(".fm-cur").forEach((el) => el.classList.remove("fm-cur"));
    if (on) (FM.units[k] || []).forEach((el) => el.classList.add("fm-cur"));
  }
  // Cut the text again (a new page, the facing pages opened or closed, the switch pressed).
  function fmRefresh() {
    const old = FM;
    FM = fmUnits();
    if (old && old.root !== (FM && FM.root) && old.root.isConnected) old.root.classList.remove("fm-on");
    if (!FM || !FM.units.length) return;
    fmShow(old && old.root === FM.root && old.at !== null && old.at < FM.units.length ? old.at : fmAtScroll());
  }
  // Moves to the previous (-1) or next (1) unit; false when there is no text to move in.
  function fmStep(d) {
    fmRefresh();
    if (!FM || !FM.units.length) return false;
    const n = FM.units.length, from = FM.at, k = Math.max(0, Math.min(n - 1, from + d));
    const el = FM.units[k][0];
    FM.hold = Date.now() + 300;      // the scroll this causes must not pick another stanza
    jumpTo(Math.max(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3 + 6));
    fmShow(k);
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.focus({ preventScroll: true });
    const what = FM.root.classList.contains("is-prose") ? "Paragraph" : "Stanza";
    if (k === from) announce(d < 0 ? `The first ${what.toLowerCase()}.` : `The last ${what.toLowerCase()}.`);
    else if (!el.hasAttribute("aria-label")) announce(`${what} ${k + 1} of ${n}`);
    return true;
  }
  function bindFocus() {
    FM = null;
    fmRefresh();
  }
  window.addEventListener("scroll", () => {
    if (!FM || FM.raf || (FM.hold && Date.now() < FM.hold)) return;
    FM.raf = requestAnimationFrame(() => {
      if (!FM) return;
      FM.raf = 0;
      if (FM.root.isConnected && FM.units.length) fmShow(fmAtScroll());
    });
  }, { passive: true });
  // A tap in the text brightens that stanza (a selection or a highlight goes on as usual).
  document.addEventListener("click", (e) => {
    if (!FM || !focusOn() || !e.target.closest) return;
    const u = e.target.closest("[data-fm]");
    if (u && FM.root.contains(u)) { FM.hold = Date.now() + 300; fmShow(+u.dataset.fm); }
  });
  // The facing pages drawn or taken away, "My marks" folding the text: cut it again.
  new MutationObserver(() => {
    if (!FM || FM.mo) return;
    FM.mo = requestAnimationFrame(() => {
      if (!FM) return;
      FM.mo = 0;
      const root = app.querySelector(".detail .fx-slot:not([hidden]) .fx") || app.querySelector(".detail .poem-text");
      if (root !== FM.root || !FM.root.isConnected) fmRefresh();
    });
  }).observe(app, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => { FM = null; });

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
    if (form) { label.dataset.form = form; label.insertAdjacentHTML("beforeend", ` · <a class="form-term" href="${termHref(formTerm(form))}" title="What is ${esc(withArticle(form.toLowerCase()))}?">${esc(form)}</a>`); }
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
        ${GUIDES.has(group) ? `<a class="gd-box" href="#/guide/${esc(group)}"><span class="gd-box-k">Study guide</span><span class="gd-box-t">Summary, book-by-book analysis, characters, themes and critical debates</span><span aria-hidden="true">→</span></a>` : ""}
        <h2 class="section-label">${num(vs.filter((w) => w.translator).length)} translations in the archive</h2>
        ${versionsListHTML(vs)}
        <p class="vs-tip">Each book can be read beside another translation: open a book and choose “Compare side by side”.</p>
        <p class="vs-trs" data-trp="${esc(JSON.stringify(vs.map((w) => w.translator).filter(Boolean)))}" hidden></p>
      </article>`;
    linkTranslators();
    addWhoBox(group, ".vs-page .section-label", "beforebegin");
    restoreScroll();
  }
  // Under the study-guide line (or in its place), a line to the work's who's who.
  function addWhoBox(group, sel, where) {
    const here = location.hash;
    peopleOf(group).then((d) => {
      const at = app.querySelector(sel);
      if (!d || location.hash !== here || !at || app.querySelector(".gd-box.pp-box")) return;
      at.insertAdjacentHTML(where, `<a class="gd-box pp-box" href="#/people/${esc(d.group)}"><span class="gd-box-k">Who’s who</span><span class="gd-box-t">${num(d.people.length)} people, gods and places in ${esc(d.title)}, with where each appears</span><span aria-hidden="true">→</span></a>`);
    });
  }

  // ---------- study guides: #/guide/<workGroup>[/<part>[/<n>]] ----------
  // data/guides/<group>.json, written for the editors (first the Iliad, 19 Oct 2026): an
  // overview, book-by-book summary and analysis, characters, themes, the critical debates,
  // key passages (quoted from the recommended translation), questions and a bibliography.
  // Paragraphs cite with [[bibId]], drawn as (Author year) linked to the bibliography.
  const GUIDES = new Set(["iliad", "aeneid", "odyssey", "paradise-lost", "beowulf", "divine-comedy", "gilgamesh", "faerie-queene", "mahabharata", "ramayana"]);
  const GUIDE_FILES = {};
  const GUIDE_PARTS = [["overview", "Overview"], ["books", "Book by book"], ["characters", "Characters"],
    ["themes", "Themes & symbols"], ["debates", "Critical debates"], ["quotes", "Key passages"],
    ["questions", "Questions"], ["bibliography", "Further reading"]];
  function guideOf(group) {
    if (!GUIDES.has(group)) return Promise.resolve(null);
    return GUIDE_FILES[group] || (GUIDE_FILES[group] = fetch(`data/guides/${encodeURIComponent(group)}.json`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => { delete GUIDE_FILES[group]; return null; }));
  }
  const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  function bookNumber(title) {
    const m = String(title || "").match(/\b(?:Book|Canto|Tablet)\s+([IVXLC]+|\d+)\b/i);
    if (!m) return 0;
    if (/^\d+$/.test(m[1])) return +m[1];
    let n = 0; const r = m[1].toUpperCase();
    for (let k = 0; k < r.length; k++) { const v = ROMAN[r[k]], nx = ROMAN[r[k + 1]] || 0; n += v < nx ? -v : v; }
    return n;
  }
  function guideCite(d, group, text) {
    const bib = {};
    (d.bibliography || []).forEach((b) => { bib[b.id] = b; });
    return esc(text).replace(/\[\[([\w-]+)\]\]/g, (all, id) => {
      const b = bib[id];
      if (!b) return "";
      const who = b.text.split(/[,.]/)[0].trim(), yr = (b.text.match(/\b(1[5-9]\d\d|20\d\d)\b(?!.*\b(1[5-9]\d\d|20\d\d)\b)/) || [""])[0];
      return `<a class="gd-cite" href="#/guide/${esc(group)}/bibliography" title="${esc(b.text)}">(${esc(who)}${yr ? " " + yr : ""})</a>`;
    });
  }
  function guideRefLink(d, ref) {
    const m = String(ref || "").match(/(\d+)\.\d/);
    return m && d.quoteEdition ? `<a class="gd-ref" href="#/work/${esc(d.quoteEdition)}/${+m[1] - 1}">${esc(ref)}</a>` : `<span class="gd-ref">${esc(ref || "")}</span>`;
  }
  async function renderGuide(group, part, n) {
    setRoute("poems", "sub");
    const h = location.hash;
    if (!app.querySelector(".gd-page")) app.innerHTML = `<p class="loading">Loading…</p>`;
    const d = await guideOf(group);
    if (location.hash !== h) return;
    if (!d) { app.innerHTML = `<p class="empty">There is no study guide for this work yet.</p>`; return; }
    part = GUIDE_PARTS.some(([k]) => k === part) ? part : "overview";
    const P = (arr) => (arr || []).map((t) => `<p>${guideCite(d, group, t)}</p>`).join("");
    const nb = Math.min(Math.max(+n || 1, 1), d.books.length), U = d.unit || "Book";
    let body = "";
    if (part === "overview") {
      body = `<dl class="gd-glance">${(d.glance || []).map((g) => `<div><dt>${esc(g.label)}</dt><dd>${guideCite(d, group, g.value)}</dd></div>`).join("")}</dl>
        <h2 class="gd-h">Context</h2>${P(d.context)}<h2 class="gd-h">Plot overview</h2>${P(d.plot)}`;
    } else if (part === "books") {
      const b = d.books[nb - 1];
      body = `<nav class="gd-books" aria-label="Books">${d.books.map((x) => `<a href="#/guide/${esc(group)}/books/${x.n}"${x.n === nb ? ' aria-current="page"' : ""}>${x.n}</a>`).join("")}</nav>
        <h2 class="gd-h">${esc(U)} ${b.n}: ${esc(b.title)}</h2>${b.lines ? `<p class="gd-lines">Lines ${esc(b.lines)}</p>` : ""}
        <h3 class="gd-h3">Summary</h3>${P(b.summary)}
        <h3 class="gd-h3">Analysis</h3>${P(b.analysis)}
        ${(b.key || []).length ? `<h3 class="gd-h3">Key passages</h3>${b.key.map((k) => `<figure class="gd-quote"><blockquote>${esc(k.quote)}</blockquote><figcaption>${guideRefLink(d, k.ref)}</figcaption>${k.note ? `<p>${guideCite(d, group, k.note)}</p>` : ""}</figure>`).join("")}` : ""}
        <p class="gd-read">${d.quoteEdition ? `<a class="shelf-dl" href="#/work/${esc(d.quoteEdition)}/${b.section != null ? b.section : nb - 1}">Read ${d.unit ? "this part" : "Book " + nb}</a>` : ""}
          ${nb > 1 ? `<a href="#/guide/${esc(group)}/books/${nb - 1}">← ${esc(U)} ${nb - 1}</a>` : ""}${nb < d.books.length ? `<a href="#/guide/${esc(group)}/books/${nb + 1}">${esc(U)} ${nb + 1} →</a>` : ""}</p>`;
    } else if (part === "characters") {
      setTimeout(() => addWhoBox(group, ".gd-body", "afterbegin"), 0);
      const sides = [...new Set(d.characters.map((c) => c.side))];
      body = sides.map((s) => `<h2 class="gd-h">${esc(s)}</h2><dl class="gd-chars">${d.characters.filter((c) => c.side === s)
        .map((c) => `<div><dt>${esc(c.name)}</dt><dd>${guideCite(d, group, c.text)}</dd></div>`).join("")}</dl>`).join("");
    } else if (part === "themes") {
      body = `<h2 class="gd-h">Themes</h2>${d.themes.map((t) => `<h3 class="gd-h3">${esc(t.title)}</h3>${P(t.text)}`).join("")}
        <h2 class="gd-h">Motifs</h2>${(d.motifs || []).map((t) => `<h3 class="gd-h3">${esc(t.title)}</h3>${P([t.text])}`).join("")}
        <h2 class="gd-h">Symbols</h2>${(d.symbols || []).map((t) => `<h3 class="gd-h3">${esc(t.title)}</h3>${P([t.text])}`).join("")}`;
    } else if (part === "debates") {
      body = d.debates.map((t) => `<h2 class="gd-h">${esc(t.title)}</h2>${P(t.text)}`).join("");
    } else if (part === "quotes") {
      body = d.quotes.map((q) => `<figure class="gd-quote"><blockquote>${esc(q.quote)}</blockquote>
        <figcaption>${q.who ? esc(q.who) + " · " : ""}${guideRefLink(d, q.ref)}</figcaption><p>${guideCite(d, group, q.explanation)}</p></figure>`).join("");
    } else if (part === "questions") {
      body = `<ol class="gd-qs">${d.questions.map((q) => `<li><p class="gd-q">${esc(q.q)}</p><details><summary>How to approach it</summary><p>${guideCite(d, group, q.hint)}</p></details></li>`).join("")}</ol>`;
    } else {
      body = `<ul class="gd-bib">${d.bibliography.map((b) => `<li id="gd-${esc(b.id)}">${esc(b.text)}</li>`).join("")}</ul>`;
    }
    setTitle(`${d.title}: study guide — ${part === "books" && d.unit ? d.unit + " by " + d.unit.toLowerCase() : GUIDE_PARTS.find(([k]) => k === part)[1]}`);
    app.innerHTML = `
      <article class="detail gd-page">
        <div class="detail-subject">Study guide</div>
        <h1 class="detail-title">${esc(d.title)}</h1>
        <p class="detail-author">by ${esc(d.author)} · <a href="#/versions/${esc(group)}">Read the poem</a></p>
        <nav class="gd-tabs" aria-label="Study guide">${GUIDE_PARTS.map(([k, label]) => `<a href="#/guide/${esc(group)}/${k}"${k === part ? ' aria-current="page"' : ""}>${k === "books" && d.unit ? d.unit + " by " + d.unit.toLowerCase() : label}</a>`).join("")}</nav>
        <div class="gd-body">${body}</div>
        <p class="gd-foot">Written by the Poetry Codex editors. Quotations from ${d.quoteEdition && WORKS[d.quoteEdition] ? esc(trName(WORKS[d.quoteEdition].translator || "")) : "the recommended translation"}; line references are to the Greek. Updated ${esc(d.updated || "")}.</p>
      </article>`;
    const cur = app.querySelector(".gd-books [aria-current]");
    if (cur) cur.scrollIntoView({ block: "nearest", inline: "center" });
    restoreScroll();
  }
  // A book of a guided work opens with a line to its summary and analysis.
  function bindGuideBox(w, i) {
    const group = w.workGroup || w.slug;
    if (!GUIDES.has(group)) return;
    const s = w.sections && w.sections[i];
    const here = location.hash;
    guideOf(group).then((d) => {
      if (!d || location.hash !== here) return;
      let n = bookNumber(s && s.title), U = "Book";
      // a guide in parts (Beowulf): the part that holds this section, by the parts' first sections
      if (d.unit && (w.slug === d.quoteEdition || d.sameSections)) {
        U = d.unit; n = 0;
        d.books.forEach((b) => { if (b.section != null && b.section <= i) n = b.n; });
      } else if (d.unit) n = 0;
      const head = app.querySelector(".detail > .detail-author");
      if (!head || app.querySelector(".gd-box")) return;
      head.insertAdjacentHTML("afterend", `<a class="gd-box" href="#/guide/${esc(group)}/${n ? "books/" + n : "overview"}">
        <span class="gd-box-k">Study guide</span><span class="gd-box-t">${n ? (d.unit && d.books[n - 1] ? `${esc(d.books[n - 1].title)}: summary and analysis` : `${esc(U)} ${n}: summary and analysis`) : "Summary, themes and critical debates"}</span><span aria-hidden="true">→</span></a>`);
      addWhoBox(group, ".detail > .gd-box", "afterend");
    });
  }

  // ---------- translator pages: #/translator/<slug>, #/translators ----------
  // data/translators.json (curated by the editor): [{slug, name, match: [the translator
  // strings exactly as the data has them], forms: [the name as those strings spell it],
  // born, died, note, source?, sort?}]. Dates and the note come from a catalogue record or
  // the edition, else stay empty. A joint string ("S. H. Butcher and A. Lang") lists both
  // people; anonymous and initials-only translators have no entry, so no page and no link.
  // Wherever a translator is named (the line under a title, the cite box, a work's page of
  // translations) the name links to the page; before the file is in, the name is drawn plain
  // and linked in place when it comes (linkTranslators).
  function loadTranslators() {
    if (!TRANSLATORS_P) {
      TRANSLATORS_P = fetch("data/translators.json").then((r) => (r.ok ? r.json() : [])).catch(() => [])
        .then((list) => {
          const byString = new Map(), bySlug = new Map();
          (Array.isArray(list) ? list : []).forEach((t) => {
            bySlug.set(t.slug, t);
            (t.match || []).forEach((s) => { if (!byString.has(s)) byString.set(s, []); byString.get(s).push(t); });
          });
          TRANSLATORS = { list: Array.isArray(list) ? list : [], bySlug, byString };
          linkTranslators();
          return TRANSLATORS;
        });
    }
    return TRANSLATORS_P;
  }
  const trPeople = (s) => (TRANSLATORS && TRANSLATORS.byString.get(String(s || ""))) || [];
  const trHref = (t) => "#/translator/" + t.slug;
  // "Translated by Samuel Butler (1898)" with each person's name a link. text: what is shown;
  // s: the translator string it was made from.
  function trLinked(text, s) {
    const spans = [];
    trPeople(s).forEach((t) => {
      for (const f of (t.forms && t.forms.length ? t.forms : [t.name])) {
        const at = text.indexOf(f);
        if (at >= 0 && !spans.some((x) => at < x.end && at + f.length > x.at)) { spans.push({ at, end: at + f.length, t }); break; }
      }
    });
    spans.sort((a, b) => a.at - b.at);
    let html = "", i = 0;
    spans.forEach((x) => {
      html += esc(text.slice(i, x.at)) + `<a class="tr-link" href="${trHref(x.t)}">${esc(text.slice(x.at, x.end))}</a>`;
      i = x.end;
    });
    return html + esc(text.slice(i));
  }
  function trByHTML(s) {
    if (!TRANSLATORS) loadTranslators();
    return `<span class="tr-by" data-tr="${esc(s)}">${trLinked(translatedBy(s), s)}</span>`;
  }
  // The cite box's "Translator" row: the people behind the string, each a link; hidden until
  // there is someone to name.
  function trCiteHTML(s) {
    if (!TRANSLATORS) loadTranslators();
    return `<div class="cite-entry cite-trs"${trPeople(s).length ? "" : " hidden"}>
          <p class="cite-style">Translator</p>
          <p class="cite-text" data-trc="${esc(s)}">${trNamesHTML([s])}</p>
        </div>`;
  }
  // Each person behind these strings once, as links: "Alexander Pope · George Chapman".
  function trNamesHTML(strings) {
    const seen = new Set(), out = [];
    strings.forEach((s) => trPeople(s).forEach((t) => {
      if (!seen.has(t.slug)) { seen.add(t.slug); out.push(`<a class="tr-link" href="${trHref(t)}">${esc(t.name)}</a>`); }
    }));
    return out.join(" · ");
  }
  // Fills in the links on the page now on screen once data/translators.json is in.
  function linkTranslators() {
    if (!TRANSLATORS) { loadTranslators(); return; }
    app.querySelectorAll("[data-tr]").forEach((el) => {
      if (!el.querySelector("a")) el.innerHTML = trLinked(translatedBy(el.dataset.tr), el.dataset.tr);
    });
    app.querySelectorAll("[data-trc]").forEach((el) => {
      el.innerHTML = trNamesHTML([el.dataset.trc]);
      const row = el.closest(".cite-trs");
      if (row) row.hidden = !el.innerHTML;
    });
    app.querySelectorAll("[data-trp]").forEach((el) => {
      let strings = [];
      try { strings = JSON.parse(el.dataset.trp); } catch (e) { /* none */ }
      const names = trNamesHTML(strings);
      el.innerHTML = names ? `About the translators: ${names}` : "";
      el.hidden = !names;
    });
  }
  // Surname first, for the A–Z ("Pope, Alexander"; "Gregory, Lady"); an entry whose name
  // does not turn round that way ("Kiang Kang-hu") gives its own `sort`.
  const trSortName = (t) => t.sort || citeName(t.name);
  const trDates = (t) => t.born && t.died ? `${t.born}–${t.died}` : t.died ? "died " + t.died : t.born ? "born " + t.born : "";
  // What one person translated here: {works: [index entries], poems: [index entries]}.
  function trHoldings(t) {
    const mine = new Set(t.match || []);
    return {
      works: DATA.works.filter((w) => w.translator && mine.has(w.translator)),
      poems: DATA.poems.filter((p) => p.translator && mine.has(p.translator)),
    };
  }
  const TR_POEMS_SHOWN = 8;   // poems listed under each original author before "Show all"
  async function renderTranslator(slug) {
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    await loadTranslators();
    if (location.hash !== h) return;
    const t = TRANSLATORS.bySlug.get(slug);
    if (!t) { app.innerHTML = `<p class="empty">There is no page for this translator. <a href="#/translators">All translators</a></p>`; setTitle("Translator"); return; }
    setTitle(t.name + " · Translator");
    const { works, poems } = trHoldings(t);
    // Grouped by the original's author, the author with most here first.
    const groups = new Map();
    const group = (slug, name) => {
      if (!groups.has(slug)) groups.set(slug, { slug, name, works: [], poems: [] });
      return groups.get(slug);
    };
    works.forEach((w) => group(w.authorSlug, w.author).works.push(w));
    poems.forEach((p) => group(p.authorSlug, p.author || (POETS[p.authorSlug] || {}).name || p.authorSlug).poems.push(p));
    const list = [...groups.values()].sort((a, b) => (b.works.length * 50 + b.poems.length) - (a.works.length * 50 + a.poems.length)
      || COLLATE.compare(a.name, b.name));
    // A translator who is also a poet in the archive: a link to their own poems.
    const own = Object.values(POETS).find((p) => (p.poemCount || p.workCount) && fold(p.name) === fold(t.name.replace(/^Sir\s+/, "")));
    const workRow = (w) => {
      const grouped = (w.workGroup && versionsOf(w.workGroup).length > 1);
      const n = w.sections ? w.sections.length : 0;
      return `<li><a href="#/work/${esc(w.slug)}"><span class="pl-title">${esc(w.title)}</span>
          <span class="pl-sub">${esc([verYear(w) || w.year, n > 1 ? `${num(n)} parts` : ""].filter(Boolean).join(" · "))}</span></a>
          ${grouped ? `<a class="tr-alltr" href="#/versions/${esc(w.workGroup)}">All translations of this work</a>` : ""}</li>`;
    };
    const poemRow = (p) => `<li><a href="#/poem/${esc(p.id)}"><span class="pl-title">${esc(p.title)}</span></a></li>`;
    const count = [works.length && `${num(works.length)} work${works.length === 1 ? "" : "s"}`,
                   poems.length && `${num(poems.length)} poem${poems.length === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
    app.innerHTML = `
      <article class="detail tr-page">
        <p class="detail-subject"><a href="#/translators">Translators</a></p>
        <h1 class="detail-title">${esc(t.name)}</h1>
        ${trDates(t) ? `<p class="detail-author tr-dates">${esc(trDates(t))}</p>` : ""}
        ${t.note ? `<p class="note-block">${esc(t.note)}</p>` : ""}
        ${t.source ? `<p class="tr-source">Dates and note from <a href="${esc(t.source)}" rel="noopener">${esc(/wikipedia\.org/.test(t.source) ? "Wikipedia" : t.source.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}</a></p>` : ""}
        ${own ? `<p class="tr-own">Their own poems: <a href="#/poet/${esc(own.slug)}">${esc(own.name)}</a></p>` : ""}
        <section class="tr-holdings" aria-labelledby="tr-h">
          <h2 class="section-label" id="tr-h">Translations on Poetry Codex${count ? ` · ${count}` : ""}</h2>
          ${list.length ? list.map((g, gi) => `
            <section class="tr-group">
              <h3 class="tr-author"><a href="#/poet/${esc(g.slug)}">${esc(g.name)}</a></h3>
              ${g.works.length ? `<ul class="poem-links">${g.works.map(workRow).join("")}</ul>` : ""}
              ${g.poems.length ? `
                <p class="tr-pcount">${num(g.poems.length)} poem${g.poems.length === 1 ? "" : "s"}</p>
                <ul class="poem-links tr-poems" id="tr-poems-${gi}">${g.poems.slice(0, TR_POEMS_SHOWN).map(poemRow).join("")}</ul>
                ${g.poems.length > TR_POEMS_SHOWN ? `<div class="more-row"><button class="more-btn tr-more" type="button" data-g="${gi}" aria-controls="tr-poems-${gi}">Show all ${num(g.poems.length)}</button></div>` : ""}` : ""}
            </section>`).join("") : `<p class="empty">Nothing by this translator is in the archive at present.</p>`}
        </section>
        <p class="tr-back"><a href="#/translators">All translators, A–Z</a></p>
      </article>`;
    app.querySelectorAll(".tr-more").forEach((b) => b.addEventListener("click", () => {
      const g = list[+b.dataset.g], ul = document.getElementById("tr-poems-" + b.dataset.g);
      ul.insertAdjacentHTML("beforeend", g.poems.slice(TR_POEMS_SHOWN).map(poemRow).join(""));
      const next = ul.children[TR_POEMS_SHOWN];
      b.parentNode.remove();
      if (next) next.querySelector("a").focus();
    }));
    restoreScroll();
  }
  async function renderTranslators() {
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    await loadTranslators();
    if (location.hash !== h) return;
    setTitle("Translators");
    const counted = TRANSLATORS.list.map((t) => ({ t, k: trSortName(t), ...trHoldings(t) }))
      .filter((x) => x.works.length || x.poems.length)
      .sort((a, b) => COLLATE.compare(fold(a.k), fold(b.k)));
    const letterOf = (x) => { const c = fold(x.k).charAt(0).toUpperCase(); return c >= "A" && c <= "Z" ? c : "#"; };
    const byLetter = new Map();
    counted.forEach((x) => { const l = letterOf(x); if (!byLetter.has(l)) byLetter.set(l, []); byLetter.get(l).push(x); });
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat(byLetter.has("#") ? ["#"] : []);
    const sub = (x) => [x.works.length && `${num(x.works.length)} work${x.works.length === 1 ? "" : "s"}`,
                        x.poems.length && `${num(x.poems.length)} poem${x.poems.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Translators</h1>
        <p class="page-sub">The ${num(counted.length)} translators whose work is in the archive, by surname.</p></div>
      <nav class="az-strip tr-az" aria-label="Translators by surname">${letters.map((l) => byLetter.has(l)
        ? `<a class="az" href="#tr-${l === "#" ? "other" : l}" data-l="${esc(l)}">${esc(l)}</a>`
        : `<span class="az az-none" aria-hidden="true">${esc(l)}</span>`).join("")}</nav>
      ${[...byLetter.entries()].map(([l, xs]) => `
        <section class="tr-letter" aria-labelledby="tr-${l === "#" ? "other" : l}">
          <h2 class="section-label era-az" id="tr-${l === "#" ? "other" : l}" tabindex="-1">${esc(l)}</h2>
          <ul class="poem-links tr-index">${xs.map((x) => `
            <li><a href="${trHref(x.t)}"><span class="pl-title">${esc(x.k)}${trDates(x.t) ? ` <span class="tr-idates">${esc(trDates(x.t))}</span>` : ""}</span><span class="pl-sub">${esc(sub(x))}</span></a></li>`).join("")}</ul>
        </section>`).join("")}`;
    // The letters move within the page without changing its address (hash routing).
    app.querySelectorAll(".tr-az a").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(a.getAttribute("href").slice(1));
      if (target) { target.scrollIntoView(); target.focus({ preventScroll: true }); }
    }));
    restoreScroll();
  }

  // ---------- glossary of poetic terms: #/terms, #/term/<slug> ----------
  // data/glossary.json (written by the editors): {terms: [{slug, term, also, kind, short, long,
  // examples: [{ref, l, lines, title, author, translator?, lang?, why}], see_also, sources}]}.
  // Each example quotes two lines (sometimes four) from a text in the archive, with `l` the
  // lines as ?l= counts them, so "Read these lines" opens the text there and lights them.
  // #/terms is an A–Z list with a filter box; #/term/<slug> is one term: the definition (a
  // <dl>), its examples (each a <blockquote> with cite), see also, further reading and Print,
  // which prints the page on its own. Neither needs the index. Links in: the Form chips on
  // #/poems (an (i) beside each), the form named in a poem's header, and the "This line"
  // panel ("This poem is a sonnet: what is a sonnet?"). Nothing in a poem's text is underlined.
  function loadGlossary() {
    if (!GLOSSARY_P) {
      GLOSSARY_P = fetch("data/glossary.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
        .then((d) => {
          const list = Array.isArray(d && d.terms) ? d.terms : [];
          GLOSSARY = { list, bySlug: new Map(list.map((t) => [t.slug, t])) };
          return GLOSSARY;
        });
    }
    return GLOSSARY_P;
  }
  // The index's forms ("Sonnet", "Ode", "Ghazal"…) are all glossary terms under their own name;
  // a work is an epic when isEpicWork says so.
  const formTerm = (form) => String(form || "").toLowerCase().replace(/[^a-z]+/g, "-");
  const termHref = (slug) => "#/term/" + slug;
  const withArticle = (w) => (/^[aeiou]/i.test(w) ? "an " : "a ") + w;
  const KIND_LABEL = { form: "Form", genre: "Kind of poem", stanza: "Stanza", metre: "Metre", device: "Device", theme: "Theme" };
  async function renderTerms() {
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    await loadGlossary();
    if (location.hash !== h) return;
    setTitle("Glossary of poetic terms");
    const list = GLOSSARY.list.slice().sort((a, b) => COLLATE.compare(fold(a.term), fold(b.term)));
    if (!list.length) { app.innerHTML = `<p class="empty">The glossary could not be loaded. Please try again later.</p>`; return; }
    const letterOf = (t) => fold(t.term).charAt(0).toUpperCase();
    const byLetter = new Map();
    list.forEach((t) => { const l = letterOf(t); if (!byLetter.has(l)) byLetter.set(l, []); byLetter.get(l).push(t); });
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const q0 = (h.match(/[?&]q=([^&]*)/) || [])[1];
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Glossary of poetic terms</h1>
        <p class="page-sub">${num(list.length)} terms for forms, metres and devices, each shown at work in poems from the archive.</p></div>
      <div class="poet-tools term-tools">
        <nav class="az-strip" aria-label="Terms by first letter">${letters.map((l) => byLetter.has(l)
          ? `<a class="az" href="#gl-${l}" data-l="${l}">${l}</a>`
          : `<span class="az az-none" aria-hidden="true">${l}</span>`).join("")}</nav>
        <div class="poet-filter term-filter">
          <label class="visually-hidden" for="term-q">Find a term</label>
          <input id="term-q" type="search" placeholder="Find a term…" autocomplete="off" spellcheck="false" aria-describedby="term-count">
        </div>
        <p class="term-count" id="term-count" aria-live="polite"></p>
      </div>
      ${[...byLetter.entries()].map(([l, ts]) => `
        <section class="term-letter" aria-labelledby="gl-${l}">
          <h2 class="section-label era-az" id="gl-${l}" tabindex="-1">${l}</h2>
          <ul class="term-list">${ts.map((t) => `
            <li data-hay="${esc(fold([t.term].concat(t.also || [], t.short).join(" ")))}"><a href="${termHref(t.slug)}">
              <span class="term-name">${esc(t.term)}</span>
              <span class="term-short">${esc(t.short)}</span></a></li>`).join("")}</ul>
        </section>`).join("")}
      <p class="empty term-none" hidden>No term matches. <button type="button" class="term-clear">Show all terms</button></p>`;
    // The letters move within the page without changing its address (hash routing); a letter
    // the filter has hidden clears the filter first.
    app.querySelectorAll(".term-tools .az-strip a").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(a.getAttribute("href").slice(1));
      if (target && target.closest(".term-letter").hidden) { input.value = ""; filter(); }
      if (target) { target.scrollIntoView(); target.focus({ preventScroll: true }); }
    }));
    // The filter matches a term, its other names and its one-line definition, in any order of
    // words; the query is kept in the address (replaceState) so Back returns to it.
    const input = app.querySelector("#term-q"), count = app.querySelector("#term-count");
    const filter = () => {
      const words = fold(input.value).split(/\s+/).filter(Boolean);
      let shown = 0;
      app.querySelectorAll(".term-letter").forEach((sec) => {
        let n = 0;
        sec.querySelectorAll("li[data-hay]").forEach((li) => {
          const ok = words.every((w) => li.dataset.hay.includes(w));
          li.hidden = !ok; if (ok) n++;
        });
        sec.hidden = !n; shown += n;
      });
      app.querySelector(".term-none").hidden = shown > 0;
      count.textContent = words.length ? `${num(shown)} term${shown === 1 ? "" : "s"}` : "";
      const addr = "#/terms" + (input.value.trim() ? "?q=" + encodeURIComponent(input.value.trim()) : "");
      if (location.hash !== addr) {
        if (EARLY_DRAWN === location.hash) EARLY_DRAWN = addr;
        history.replaceState(history.state, "", addr);
      }
    };
    input.addEventListener("input", filter);
    app.querySelector(".term-clear").addEventListener("click", () => { input.value = ""; filter(); input.focus(); });
    if (q0) { try { input.value = decodeURIComponent(q0.replace(/\+/g, " ")); } catch (e) { /* as typed */ } filter(); }
    restoreScroll();
  }
  async function renderTerm(slug) {
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    await loadGlossary();
    if (location.hash !== h) return;
    const t = GLOSSARY.bySlug.get(slug);
    if (!t) { setTitle("Glossary"); app.innerHTML = `<p class="empty">There is no such term in the glossary. <a href="#/terms">All terms</a></p>`; return; }
    setTitle(t.term + " · Glossary");
    const lines = (x) => (x.l || "").replace("-", "–");
    const exHTML = (x) => {
      const href = routeFor(x.ref) + (x.l ? "?l=" + x.l : "");
      const where = x.ref.startsWith("work:") ? "/work/" + x.ref.slice(5) + "/" : "/poem/" + x.ref + "/";
      return `<figure class="term-ex">
          <blockquote cite="${esc(where)}"${x.lang ? ` lang="${esc(x.lang)}"` : ""}><p>${(x.lines || []).map((l) => `<span class="term-ql">${esc(l)}</span>`).join("")}</p></blockquote>
          <figcaption>
            <p class="term-src"><cite>${esc(x.title)}</cite>${x.author ? ` · ${esc(x.author)}` : ""}${x.translator ? ` · ${esc(translatedBy(x.translator))}` : ""}</p>
            ${x.why ? `<p class="term-why">${esc(x.why)}</p>` : ""}
            <p class="term-go"><a href="${esc(href)}">Read ${String(x.l || "").includes("-") ? "these lines" : "this line"} in the text<span class="visually-hidden">: ${esc(x.title)}, lines ${esc(lines(x))}</span></a> <span class="term-ln">(line${String(x.l || "").includes("-") ? "s" : ""} ${esc(lines(x))})</span></p>
          </figcaption>
        </figure>`;
    };
    const see = (t.see_also || []).map((s) => GLOSSARY.bySlug.get(s)).filter(Boolean);
    const srcName = (u) => /wikipedia\.org/.test(u) ? "Wikipedia: " + decodeURIComponent(u.split("/wiki/")[1] || "").replace(/_/g, " ").replace(/#.*/, "")
      : /archive\.org/.test(u) ? "Internet Archive" : u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
    app.innerHTML = `
      <article class="detail term-page">
        <p class="detail-subject"><a href="#/terms">Glossary</a> · ${esc(KIND_LABEL[t.kind] || "Term")}</p>
        <h1 class="detail-title">${esc(t.term)}</h1>
        <dl class="term-def">
          <dt class="visually-hidden"><dfn>${esc(t.term)}</dfn></dt>
          ${(t.also || []).length ? `<dd class="term-also">Also called ${t.also.map((a) => `<i>${esc(a)}</i>`).join(", ")}</dd>` : ""}
          <dd class="term-short-def">${esc(t.short)}</dd>
          <dd class="term-long">${String(t.long || "").split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("")}</dd>
        </dl>
        <p class="term-tools-row no-print"><button type="button" class="term-print">Print this term</button>
          <a class="term-all" href="#/terms">All terms, A–Z</a></p>
        ${(t.examples || []).length ? `
        <section class="term-exs" aria-labelledby="term-ex-h">
          <h2 class="section-label" id="term-ex-h">In the archive</h2>
          ${t.examples.map(exHTML).join("")}
        </section>` : ""}
        ${see.length ? `
        <section class="term-see" aria-labelledby="term-see-h">
          <h2 class="section-label" id="term-see-h">See also</h2>
          <ul class="term-see-list">${see.map((s) => `<li><a href="${termHref(s.slug)}">${esc(s.term)}</a></li>`).join("")}</ul>
        </section>` : ""}
        ${(t.sources || []).length ? `
        <section class="term-sources" aria-labelledby="term-src-h">
          <h2 class="section-label" id="term-src-h">Further reading</h2>
          <ul>${t.sources.map((u) => `<li><a href="${esc(u)}" rel="noopener" target="_blank">${esc(srcName(u))}<span class="visually-hidden"> (opens a new tab)</span></a></li>`).join("")}</ul>
        </section>` : ""}
        <p class="term-foot print-only">poetrycodex.com/#/term/${esc(t.slug)} · Definitions written by the editors; examples from public-domain texts in the archive.</p>
      </article>`;
    // Print: the browser prints the page alone (the top bar, footer and buttons are hidden on paper).
    app.querySelector(".term-print").addEventListener("click", () => window.print());
    restoreScroll();
  }
  // "This poem is a sonnet: what is a sonnet?" in the "This line" panel, for a poem with a form
  // and for a book of an epic.
  LP_PARTS.push((info) => {
    const id = info.entry.id || "";
    let word = "", slug = "", what = "poem";
    const m = /^work:([^/]+)\//.exec(id);
    if (m) { const w = WORKS[m[1]] || (DATA && DATA.works.find((x) => x.slug === m[1])); if (w && isEpicWork(w)) { word = "epic"; slug = "epic"; what = "work"; } }
    else { const f = indexPoem(id).form; if (f) { word = f.toLowerCase(); slug = formTerm(f); } }
    if (!slug) return null;
    return { title: "The form", html: `<p class="lp-form">This ${what} is ${esc(withArticle(word))}: <a href="${termHref(slug)}">what is ${esc(withArticle(word))}?</a></p>` };
  });

  // ---------- "Read with": curated echoes and paired passages ----------
  // data/echoes.json is the editors' list of passages that answer each other (Homer's leaves
  // and Virgil's, Hector's farewell and Aeneas' words to his son, Juno's grudge and Satan's):
  // {pairs: [{id, kind: echo | imitation | answer | source | contrast, a, b, note, q,
  // checked_by, checked_on}]}. A side names one text in one translation, `ref` ("work:<slug>/<i>"
  // or a poem id), and its lines: `l` "from-to" as the page counts them (in a book with a Greek
  // line map, Murray's Homer, the Greek lines), or `p` "from-to", paragraphs of a prose
  // translation; `label` names it ("Aeneid 6.450–476 (Dryden)") and `first` is its opening, two
  // lines as printed. `og` {group, part, l} gives the book and lines in the original, so the pair
  // also shows in every other translation of that book ("in this book"). Shown three ways:
  // (a) "Echoes" in the "This line" panel, for lines inside a side's range; (b) a "Read with"
  // card after the text of a book or poem that has pairs (three, then "Show all"), each with
  // the other passage's opening, the note and "Open beside"; (c) #/pair/<id>, the two passages
  // side by side from 900px (A at left), below that a switch A · B · Both, with the note and
  // the question above and Cite and Copy link under each; Print prints the page alone, as a
  // handout. #/pairs lists them all. The editors write every pair and readers add none, so
  // nothing is stored or synced.
  let ECHOES = null, ECHOES_P = null;   // {list, byId} once data/echoes.json is in
  let EC_PAGE = null;                   // the book or poem on screen: {id, slug, group, part}
  const EC_KINDS = { echo: "Echo", imitation: "Imitation", answer: "Answer", source: "Source", contrast: "Contrast" };
  const EC_SHOW = 3;
  function loadEchoes() {
    if (!ECHOES_P) {
      ECHOES_P = fetch("data/echoes.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
        .then((d) => {
          const list = (Array.isArray(d && d.pairs) ? d.pairs : []).filter((p) => p && p.id && p.a && p.b && p.a.ref && p.b.ref);
          ECHOES = { list, byId: new Map(list.map((p) => [p.id, p])) };
          return ECHOES;
        });
    }
    return ECHOES_P;
  }
  // "450-476" -> [450, 476]; "12" -> [12, 12].
  const ecRange = (s) => { const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(String(s || "").trim()); return m ? [+m[1], +(m[2] || m[1])] : null; };
  const ecSpan = (r) => (r[0] === r[1] ? String(r[0]) : r[0] + "–" + r[1]);
  // A part's title as a key: "Book VI", "Book Six" and "Book 6" are one book.
  const EC_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two", "twenty-three", "twenty-four"];
  function ecRoman(s) {
    const v = { i: 1, v: 5, x: 10, l: 50, c: 100 };
    let n = 0;
    for (let k = 0; k < s.length; k++) { const a = v[s[k]], b = v[s[k + 1]] || 0; n += a < b ? -a : a; }
    return n;
  }
  const ecPartKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9:-]+/g, " ").trim()
    .replace(/(\s|^)([ivxlc]+|\d+|[a-z]+(?:-[a-z]+)?)$/, (x, sp, w) => {
      const n = /^\d+$/.test(w) ? +w : /^[ivxlc]+$/.test(w) ? ecRoman(w) : EC_WORDS.indexOf(w);
      return sp + (n > 0 ? n : w);
    });
  // The page a text id stands for: its work's group and the part's title, from the index or
  // from what the page itself knew (EC_PAGE).
  function ecHere(id) {
    if (EC_PAGE && EC_PAGE.id === id) return EC_PAGE;
    const m = /^work:([^/]+)\/(\d+)$/.exec(id || "");
    if (!m) return { id };
    const w = WORKS[m[1]], s = w && w.sections && w.sections[+m[2]];
    return { id, slug: m[1], group: w && w.workGroup, part: s && s.title };
  }
  // How one side of a pair stands to a text: "exact" (this very text) or "book" (another
  // translation of the same book, through og); else null.
  function ecHow(side, here) {
    if (side.ref === here.id) return "exact";
    const og = side.og;
    return og && og.group && here.group && og.group === here.group && ecPartKey(og.part) === ecPartKey(here.part) ? "book" : null;
  }
  // [{pair, mine, other, how}] for a text, in the order of their lines in it.
  function ecPairsFor(here) {
    if (!ECHOES || !here || !here.id) return [];
    const out = [];
    ECHOES.list.forEach((pair) => {
      for (const [mine, other] of [[pair.a, pair.b], [pair.b, pair.a]]) {
        const how = ecHow(mine, here);
        if (how) { out.push({ pair, mine, other, how }); break; }
      }
    });
    const at = (x) => { const r = ecSideRange(x.mine, x.how); return r ? r[0] : Infinity; };
    return out.map((x, k) => ({ x, k, at: at(x) })).sort((p, q) => p.at - q.at || p.k - q.k).map((y) => y.x);
  }
  // The lines a..b chosen in the "This line" panel, in a side's own measure: counted lines,
  // Greek lines (a book with a line map) or paragraphs; null where it cannot be said.
  function ecChosen(ctx, a, b, side, how) {
    if (lpProse(ctx)) {
      if (how === "exact" && side.p) return [a + 1, b + 1];
      const want = how === "exact" ? side.l : side.og && side.og.l;
      if (!want || !ctx.root.classList.contains("greek-lines")) return null;
      const ps = ctx.root.querySelectorAll(":scope > p"), ga = ps[a] && +ps[a].dataset.n, next = ps[b + 1];
      return ga ? [ga, next && next.dataset.n ? Math.max(ga, +next.dataset.n - 1) : ga + 999] : null;
    }
    if (how !== "exact" || !side.l) return null;
    const cs = lpCounts(ctx).slice(a, b + 1).filter(Boolean);
    return cs.length ? [cs[0], cs[cs.length - 1]] : null;
  }
  const ecSideRange = (side, how) => ecRange(how === "exact" ? side.l || side.p : side.og && side.og.l);
  const ecFirstHTML = (side, cls) => (side.first || []).length
    ? `<p class="lp-quote ${cls}">${side.first.slice(0, 2).map((t) => `<span class="lp-ql">${esc(t)}</span>`).join("")}</p>` : "";
  // (a) "Echoes" in the "This line" panel.
  LP_PARTS.push((info) => {
    if (!ECHOES) return null;
    const here = ecHere(info.entry.id);
    const hits = ecPairsFor(here).filter((x) => {
      const r = ecSideRange(x.mine, x.how), got = r && ecChosen(info.ctx, info.a, info.b, x.mine, x.how);
      return got && got[0] <= r[1] && got[1] >= r[0];
    });
    if (!hits.length) return null;
    const row = (x) => `<div class="ec-pi">
        <p class="lp-par-l"><span class="ec-kind">${esc(EC_KINDS[x.pair.kind] || "Echo")}</span> · ${esc(x.other.label)}</p>
        ${ecFirstHTML(x.other, "lp-par-q")}
        <p class="ec-pnote">${esc(x.pair.note)}</p>
        <p class="ec-popen"><a href="#/pair/${esc(x.pair.id)}">Open beside<span class="visually-hidden">: ${esc(x.mine.label)} and ${esc(x.other.label)}</span></a></p>
      </div>`;
    return { title: hits.length === 1 ? "Echo" : "Echoes", html: lpMoreList(hits, row) };
  });
  // (b) The "Read with" card after the text. here: {id, slug, group, part}; drawn again with
  // the page (the index coming in redraws it), and the panel too if it is open.
  function bindEchoes(here) {
    EC_PAGE = here;
    const h = location.hash;
    // A book with a Greek line map waits for it too (applyLineMap numbers the paragraphs first).
    Promise.all([loadEchoes(), here.slug && LINEMAPPED.has(here.slug) ? lineMapOf(here.slug) : null]).then(() => {
      if (location.hash !== h || !app.querySelector(".cite-row") || app.querySelector(".ec-card")) return;
      if (LP) lpRefresh();
      const hits = ecPairsFor(here);
      if (!hits.length) return;
      const root = app.querySelector(".text-solo .poem-text") || app.querySelector(".poem-text");
      // Where a side's lines stand on this page, for "lines 146–149 here" (?l= counts units).
      const unitsHere = (x) => {
        const r = ecSideRange(x.mine, x.how);
        if (!root || !r) return null;
        let idx = [];
        if (root.classList.contains("is-prose")) {
          const ps = [...root.querySelectorAll(":scope > p")];
          if (x.how === "exact" && x.mine.p) idx = ps.map((p, k) => k + 1).filter((k) => k >= r[0] && k <= r[1]);
          else if (root.classList.contains("greek-lines")) idx = ps.map((p, k) => {
            const ga = +p.dataset.n, gb = ps[k + 1] ? Math.max(ga, +ps[k + 1].dataset.n - 1) : ga + 999;
            return ga <= r[1] && gb >= r[0] ? k + 1 : 0;
          }).filter(Boolean);
        } else if (x.how === "exact") {
          idx = [...root.querySelectorAll(".ln[data-c]")].filter((l) => +l.dataset.c >= r[0] && +l.dataset.c <= r[1]).map((l) => +l.dataset.i + 1);
        }
        return idx.length ? [idx[0], idx[idx.length - 1]] : null;
      };
      const base = h.replace(/\?.*$/, "");
      const item = (x) => {
        const u = unitsHere(x), r = ecSideRange(x.mine, x.how);
        const where = u ? `<a class="ec-here" href="${esc(base)}?l=${u[0] === u[1] ? u[0] : u[0] + "-" + u[1]}">${esc(x.mine.label.replace(/\s*\([^)]*\)\s*$/, ""))} here</a>`
          : r && x.how === "book" ? `<span class="ec-here">${esc(x.mine.og.label || x.mine.label.replace(/\s*\([^)]*\)\s*$/, ""))} in this book</span>` : "";
        return `<li class="ec-li">
            <p class="ec-k"><span class="ec-kind">${esc(EC_KINDS[x.pair.kind] || "Echo")}</span>${where ? ` · ${where}` : ""}</p>
            <p class="ec-other">Read with <cite>${esc(x.other.label)}</cite></p>
            ${ecFirstHTML(x.other, "ec-first")}
            <p class="ec-note">${esc(x.pair.note)}</p>
            <p class="ec-act"><a class="ec-open" href="#/pair/${esc(x.pair.id)}">Open beside<span class="visually-hidden">: ${esc(x.mine.label)} and ${esc(x.other.label)}</span></a></p>
          </li>`;
      };
      const sec = document.createElement("section");
      sec.className = "ec-card";
      sec.setAttribute("aria-labelledby", "ec-h");
      sec.innerHTML = `
        <h2 class="section-label" id="ec-h">Read with</h2>
        <p class="ec-sub">Passages the editors pair with this ${here.id.startsWith("work:") ? "book" : "poem"}: echoes, imitations and answers, to open side by side.</p>
        <ul class="ec-list">${hits.slice(0, EC_SHOW).map(item).join("")}</ul>
        ${hits.length > EC_SHOW ? `<ul class="ec-list ec-rest" hidden tabindex="-1">${hits.slice(EC_SHOW).map(item).join("")}</ul>
          <button type="button" class="ec-all">Show all ${num(hits.length)}</button>` : ""}`;
      app.querySelector(".cite-row").before(sec);
      const all = sec.querySelector(".ec-all");
      if (all) all.addEventListener("click", () => { const rest = sec.querySelector(".ec-rest"); rest.hidden = false; all.remove(); rest.focus(); });
    });
  }
  // One side's text: the lines it names, cut from its book or poem as the page prints them
  // ({html, units: [a, b] for ?l=, loc for a citation, cite, href, title, by, part}).
  async function ecPassage(side) {
    const m = /^work:([^/]+)\/(\d+)$/.exec(side.ref), pm = /^([\w-]+)\/(\d+)$/.exec(side.ref);
    let text = "", o = {};
    if (m) {
      const w = await loadSectionPage(m[1], +m[2]), s = w && w.sections[+m[2]];
      if (!s || !s.text) throw new Error("missing");
      text = s.text;
      o = { author: w.author, authorSlug: w.authorSlug, translator: w.translator || "", title: w.title, part: w.sections.length > 1 ? s.title : "",
            path: `/work/${m[1]}/${m[2]}/`, href: `#/work/${m[1]}/${m[2]}`, slug: m[1], i: +m[2], year: w.year };
    } else if (pm) {
      const f = await loadPoemPage(pm[1], +pm[2]), p = f && f.poems[+pm[2]];
      if (!p || !p.text) throw new Error("missing");
      text = p.text;
      o = { author: p.author || (POETS[pm[1]] || {}).name || "", authorSlug: pm[1], translator: p.translator || "", title: p.title, part: "",
            path: `/poem/${pm[1]}/${pm[2]}/`, href: `#/poem/${pm[1]}/${pm[2]}` };
    } else throw new Error("bad ref");
    const prose = isProse(text, o.translator), box = document.createElement("div");
    box.innerHTML = poemHTML(text, prose);
    const r = ecRange(side.l || side.p);
    if (!r) throw new Error("no lines");
    let units = [], keep = [], greek = false;
    if (prose) {
      const ps = [...box.querySelectorAll(":scope > p")];
      if (side.p) keep = ps.map((p, k) => (k + 1 >= r[0] && k + 1 <= r[1] ? k : -1)).filter((k) => k >= 0);
      else if (m && LINEMAPPED.has(m[1])) {
        const nums = (await lineMapOf(m[1]))[m[2]];
        if (Array.isArray(nums) && nums.length === ps.length) {
          greek = true;
          ps.forEach((p, k) => { p.dataset.n = nums[k]; });
          keep = ps.map((p, k) => (nums[k] <= r[1] && (k + 1 < nums.length ? Math.max(nums[k], nums[k + 1] - 1) : nums[k] + 999) >= r[0] ? k : -1)).filter((k) => k >= 0);
        }
      }
      units = keep.length ? [keep[0] + 1, keep[keep.length - 1] + 1] : [];
      o.html = keep.map((k) => ps[k].outerHTML).join("");
      o.loc = greek ? `lines ${ecSpan(r)}` : `${r[0] === r[1] ? "para." : "paras."} ${ecSpan(r)}`;
    } else {
      const ls = [...box.querySelectorAll(".ln[data-i]")];
      const a = ls.findIndex((l) => +l.dataset.c >= r[0]);
      let b = -1;
      ls.forEach((l, k) => { if (+l.dataset.c && +l.dataset.c <= r[1]) b = k; });
      if (a < 0 || b < a) throw new Error("lines");
      keep = ls.slice(a, b + 1);
      if (!keep[0].dataset.n && keep[0].dataset.c) keep[0].dataset.n = keep[0].dataset.c;   // the first line carries its number
      // The lines kept in their stanzas.
      const st = [];
      keep.forEach((l) => { const p = l.closest(".stanza"); if (!st.length || st[st.length - 1].p !== p) st.push({ p, ls: [] }); st[st.length - 1].ls.push(l); });
      o.html = st.map((x) => `<p class="stanza">${x.ls.map((l) => l.outerHTML + "<br>").join("")}</p>`).join("");
      units = [+keep[0].dataset.i + 1, +keep[keep.length - 1].dataset.i + 1];
      o.loc = r[0] === r[1] ? `line ${r[0]}` : `lines ${ecSpan(r)}`;
    }
    if (!o.html) throw new Error("lines");
    o.prose = prose; o.greek = greek;
    o.lang = textLangAttr(o.authorSlug, o.translator, text, side.ref);
    o.lineHref = o.href + (units.length ? "?l=" + (units[0] === units[1] ? units[0] : units[0] + "-" + units[1]) : "");
    o.cite = { author: o.author, work: m ? o.title : "", title: m ? o.part : o.title, translator: o.translator, path: o.path, loc: o.loc };
    return o;
  }
  // (c) #/pair/<id>: the two passages side by side.
  async function renderPair(id) {
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    await loadEchoes();
    if (location.hash !== h) return;
    const pair = ECHOES.byId.get(id);
    if (!pair) { setTitle("Read with"); app.innerHTML = `<p class="empty">There is no such pair. <a href="#/pairs">All paired passages</a></p>`; return; }
    const got = await Promise.all([pair.a, pair.b].map((s) => ecPassage(s).catch(() => null)));
    if (location.hash !== h) return;
    const kind = EC_KINDS[pair.kind] || "Echo";
    const title = pair.title || `${pair.a.label.replace(/\s*\([^)]*\)\s*$/, "")} and ${pair.b.label.replace(/\s*\([^)]*\)\s*$/, "")}`;
    setTitle(title + " · Read with");
    const col = (side, o, ab) => {
      const name = `Passage ${ab}: ${side.label}`;
      if (!o) return `<section class="pair-col" data-ab="${ab}" aria-label="${esc(name)}">
          <p class="pair-lbl"><span class="pair-ab" aria-hidden="true">${ab}</span>${esc(side.label)}</p>
          <p class="empty">This passage could not be loaded. Check your connection and try again.</p></section>`;
      const c = citations(o.cite)[0];
      return `<section class="pair-col" data-ab="${ab}" aria-label="${esc(name)}">
          <p class="pair-lbl"><span class="pair-ab" aria-hidden="true">${ab}</span>${esc(side.label)}</p>
          <p class="pair-src">${esc([o.author, o.translator && translatorShort(o.translator), o.part ? o.title + ", " + o.part : o.title].filter(Boolean).join(" · "))}</p>
          <div class="poem-text pair-text numbered${o.prose ? " is-prose" : ""}"${o.lang || ""}>${o.html}</div>
          ${o.greek ? `<p class="pair-gnote">Greek line numbers: where each paragraph begins, to the nearest five lines.</p>` : ""}
          <div class="pair-acts no-print">
            <a class="pair-go" href="${esc(o.lineHref)}">Read in the whole ${o.part ? "book" : "poem"}<span class="visually-hidden">: ${esc(side.label)}</span></a>
            <button type="button" class="pair-cite" aria-expanded="false" aria-controls="pair-cite-${ab}">Cite<span class="visually-hidden"> passage ${ab}</span></button>
            <button type="button" class="pair-link" data-url="${esc(SITE + "/" + o.lineHref)}">Copy link<span class="visually-hidden"> to passage ${ab}</span></button>
          </div>
          <div class="pair-cite-box" id="pair-cite-${ab}" hidden>
            <p class="cite-style">MLA</p>
            <p class="cite-text">${c.html}</p>
            <button type="button" class="cite-copy pair-cite-copy">Copy</button>
          </div>
          <p class="print-only pair-cite-print">${c.html}</p>
        </section>`;
    };
    app.innerHTML = `
      <article class="detail pair-page">
        <p class="detail-subject"><a href="#/pairs">Read with</a> · ${esc(kind)}</p>
        <h1 class="detail-title">${esc(title)}</h1>
        <div class="pair-note">
          <p>${esc(pair.note)}</p>
          ${pair.q ? `<p class="pair-q"><span class="pair-q-l">A question</span> ${esc(pair.q)}</p>` : ""}
        </div>
        <div class="pair-switch no-print" role="group" aria-label="Which passage to show">
          <button type="button" data-v="a" aria-pressed="false">A</button>
          <button type="button" data-v="b" aria-pressed="false">B</button>
          <button type="button" data-v="both" aria-pressed="true">Both</button>
        </div>
        <div class="pair-cols" data-view="both">
          ${col(pair.a, got[0], "A")}
          ${col(pair.b, got[1], "B")}
        </div>
        <p class="pair-checked">${pair.checked_on ? `Checked against both texts by the editors, ${esc(pair.checked_on)}. ` : ""}Line numbers are the edition's own as this archive prints it; where a translation is named, the original's lines are in its label.</p>
        <p class="term-tools-row no-print"><button type="button" class="term-print pair-print">Print this pair</button>
          <button type="button" class="term-print pair-copy">Copy link to this pair</button>
          <a class="term-all" href="#/pairs">All paired passages</a></p>
        <p class="print-only pair-foot">poetrycodex.com/#/pair/${esc(pair.id)} · Paired and annotated by the editors of Poetry Codex; public-domain texts.</p>
      </article>`;
    // Below 900px one passage or both, stacked; the choice lasts for the visit.
    const cols = app.querySelector(".pair-cols");
    const view = (v) => {
      cols.dataset.view = v;
      app.querySelectorAll(".pair-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
    };
    app.querySelectorAll(".pair-switch button").forEach((b) => b.addEventListener("click", () => view(b.dataset.v)));
    app.querySelectorAll(".pair-col").forEach((sec) => {
      const t = sec.querySelector(".pair-cite"), box = sec.querySelector(".pair-cite-box");
      if (t) t.addEventListener("click", () => { box.hidden = !box.hidden; t.setAttribute("aria-expanded", String(!box.hidden)); });
      const cp = sec.querySelector(".pair-cite-copy");
      if (cp) cp.addEventListener("click", () => {
        const txt = sec.querySelector(".pair-cite-box .cite-text");
        copyText(txt.textContent, txt.innerHTML, txt).then(() => flash(cp, "Copied"), () => flash(cp, "Press Ctrl+C"));
      });
      const ln = sec.querySelector(".pair-link");
      if (ln) ln.addEventListener("click", () => copyText(ln.dataset.url).then(() => flash(ln, "Link copied"), () => flash(ln, ln.dataset.url)));
    });
    const pc = app.querySelector(".pair-copy");
    pc.addEventListener("click", () => copyText(SITE + "/#/pair/" + pair.id).then(() => flash(pc, "Link copied"), () => flash(pc, SITE + "/#/pair/" + pair.id)));
    // Print: the page alone (top bar, footer, switch and buttons hidden), both passages stacked.
    app.querySelector(".pair-print").addEventListener("click", () => window.print());
    restoreScroll();
  }
  // #/pairs: every pair, by the work its first passage is in.
  async function renderPairs() {
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    await loadEchoes();
    if (location.hash !== h) return;
    setTitle("Read with: paired passages");
    const groups = new Map();
    ECHOES.list.forEach((p) => {
      // "Iliad 6.146–149 (Murray)" -> Iliad; "Horace, Odes 3.30" -> Horace; "The Faerie Queene I.i.14" -> The Faerie Queene.
      const g = String(p.a.label).replace(/\s*\([^)]*\)\s*$/, "").split(/[,:]|\s\d|\s[IVXL]+\.|\s'/)[0].trim() || "Other";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    });
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Read with</h1>
        <p class="page-sub">${num(ECHOES.list.length)} passages paired by the editors: where one poet echoes, imitates or answers another. Each opens side by side, with a note and a question.</p></div>
      ${ECHOES.list.length ? [...groups.entries()].map(([g, ps], k) => `
        <section class="ec-group" aria-labelledby="ec-g-${k}">
          <h2 class="section-label" id="ec-g-${k}">${esc(g)}</h2>
          <ul class="ec-index">${ps.map((p) => `
            <li><a href="#/pair/${esc(p.id)}"><span class="ec-ix-t">${esc(p.a.label)} <span class="ec-ix-w">with</span> ${esc(p.b.label)}</span>
              <span class="ec-ix-k">${esc(EC_KINDS[p.kind] || "Echo")}</span></a></li>`).join("")}</ul>
        </section>`).join("") : `<p class="empty">The paired passages could not be loaded. Please try again later.</p>`}`;
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
    // A reading plan needs only the list of works (and, once drawn, the work's own file).
    if (/^#\/plan(?:$|\?)/.test(h)) {
      setRoute("", "sub");
      app.innerHTML = `<p class="loading">Loading…</p>`;
      loadWorks().then((ok) => {
        if (location.hash !== h || DATA) return;
        if (ok) { EARLY_DRAWN = h; EARLY_REDRAW = false; setRoute("", "sub"); jumpTo(st ? st.y : 0); renderPlan(); }
        else { loadIndex(); app.innerHTML = INDEX_ERROR ? indexErrorHTML() : `<p class="loading">Opening the archive…</p>`; }
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
    metaCitation(null);   // a poem or book page sets its own again once drawn
    if (READING_NOW) { clearTimeout(readingTimer); noteReading(); READING_NOW = null; }
    {
      const h0 = location.hash || "", st0 = history.state && typeof history.state.y === "number" ? history.state : null;
      let m0;
      if ((m0 = h0.match(/^#\/search(?:\?q=(.*))?$/))) { restoreY = st0 ? st0.y : 0; jumpTo(0); renderSearch(decodeURIComponent((m0[1] || "").replace(/\+/g, " "))); return; }
      if ((m0 = h0.match(/^#\/versions\/([\w-]+)$/))) { restoreY = st0 ? st0.y : 0; jumpTo(0); renderVersions(m0[1]); return; }
      if ((m0 = h0.match(/^#\/guide\/([\w-]+)(?:\/([\w-]+)(?:\/(\d+))?)?$/))) { restoreY = st0 ? st0.y : 0; jumpTo(0); renderGuide(m0[1], m0[2] || "overview", m0[3]); return; }
      // The glossary needs only data/glossary.json; drawn before the index, it stays as it is
      // when the index comes (EARLY_DRAWN), so a reader is not sent back to the top.
      if (/^#\/terms(?:\?q=[^&]*)?$/.test(h0) || (m0 = h0.match(/^#\/term\/([\w-]+)$/))) {
        setRoute("", "sub"); restoreY = st0 ? st0.y : 0; jumpTo(0);
        if (!DATA) { EARLY_DRAWN = h0; EARLY_REDRAW = false; }
        if (m0) renderTerm(m0[1]); else renderTerms();
        updateShelfNav();
        return;
      }
      // "Read with": a pair and the list of pairs need only data/echoes.json and the two texts.
      if ((m0 = h0.match(/^#\/pair\/([\w-]+)$/)) || h0 === "#/pairs") {
        setRoute("", "sub"); restoreY = st0 ? st0.y : 0; jumpTo(0);
        if (!DATA) { EARLY_DRAWN = h0; EARLY_REDRAW = false; }
        if (m0) renderPair(m0[1]); else renderPairs();
        updateShelfNav();
        return;
      }
      // The who's who needs only data/people/ (and, for a card's lines, the list of works).
      if ((m0 = h0.match(/^#\/person\/([\w-]+)\/([\w-]+)(?:\?w=([\w-]+))?$/)) || (m0 = h0.match(/^#\/people\/([\w-]+)$/))) {
        setRoute("", "sub"); restoreY = st0 ? st0.y : 0; jumpTo(0);
        if (!DATA) { EARLY_DRAWN = h0; EARLY_REDRAW = false; }
        if (h0.startsWith("#/person/")) renderPerson(m0[1], m0[2], m0[3] || ""); else renderPeople(m0[1]);
        updateShelfNav();
        return;
      }
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
    else if ((m = h.match(/^#\/translator\/([\w-]+)$/))) { setRoute("poets", "sub"); renderTranslator(m[1]); }
    else if (h === "#/translators") { setRoute("poets", "sub"); renderTranslators(); }
    else if (h.startsWith("#/poets")) { setRoute("poets", "sub"); renderPoets(); }
    else if (h.startsWith("#/topics")) { setRoute("topics", "sub"); renderTopics(); }
    else if (h.startsWith("#/about")) { setRoute("about", "sub"); renderAbout(); }
    else if (h.startsWith("#/shelf")) { setRoute("shelf", "sub"); renderShelf(); }
    else if (h.startsWith("#/list")) { setRoute("", "sub"); renderReadingList(); }
    else if (/^#\/plan(?:$|\?)/.test(h)) { setRoute("", "sub"); renderPlan(); }
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
      ${homePlanHTML()}
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
  // Each form chip has an (i) beside it, a link to the form in the glossary (#/term/<form>).
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
        .concat(forms.map((f) => `<span class="chip-pair"><button class="chip ${filterForm === f.name ? "active" : ""}" data-form="${esc(f.name)}">${esc(formLabel(f.name))}<span class="n">${num(f.count)}</span></button>`
          + `<a class="chip-info" href="${termHref(formTerm(f.name))}" title="What is ${esc(withArticle(f.name.toLowerCase()))}?"><span aria-hidden="true">i</span><span class="visually-hidden">What is ${esc(withArticle(f.name.toLowerCase()))}? (glossary)</span></a></span>`)).join("")
      + `<a class="chips-more" href="#/terms">Glossary of poetic terms</a></div>` : "";
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
      <div class="page-head"><h1 class="page-title">Poets</h1><p class="page-sub">${num(all.length)} poets from Homer to the early twentieth century, by surname.</p>
        <p class="tr-also"><a href="#/translators">The translators, A–Z</a></p></div>
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
          <p class="plan-make-row"><a class="shelf-dl" href="#/plan?w=${esc(works.reduce((a, b) => (b.sections.length > a.sections.length ? b : a)).slug)}">Make a reading plan</a></p>
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
        ${workPlanHTML(slug)}
        <div class="cite-row toc-tools">${shelfButtonHTML(entry)}${offlineHTML("work:" + slug)}
          <a class="shelf-dl plan-make-link" href="#/plan?${planOf(slug) ? esc(planOf(slug).link) : "w=" + esc(slug)}">${planOf(slug) ? "Your reading plan" : "Make a reading plan"}</a></div>
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
    metaCitation({ author: w.author, work: w.title, title: "", translator: w.translator, path: `/work/${slug}/`,
                   year: citeYear(w.translator, w.year), lang: citeLang(w.authorSlug, w.translator) });
    bindShelfButton(entry);
    bindOffline(workTitle(w));
    bindListNext();
    bindContinue();
    const forget = app.querySelector(".continue-forget");
    if (forget) forget.addEventListener("click", () => { forgetReading(slug); renderWork(slug); });
    // A work with a who's who links to it beside the reading plan.
    const here = location.hash;
    peopleOf(w.workGroup).then((d) => {
      const row = app.querySelector(".toc-tools");
      if (!d || location.hash !== here || !row || row.querySelector(".pp-toc")) return;
      row.insertAdjacentHTML("beforeend", `<a class="shelf-dl pp-toc" href="#/people/${esc(d.group)}">Who’s who</a>`);
    });
    if (GUIDES.has(w.workGroup || w.slug)) {
      const row = app.querySelector(".toc-tools");
      if (row) row.insertAdjacentHTML("afterbegin", `<a class="shelf-dl gd-toc" href="#/guide/${esc(w.workGroup || w.slug)}">Study guide</a>`);
    }
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
                   translator: w.translator, path: `/work/${slug}/${i}/`,
                   year: citeYear(w.translator, w.year), lang: citeLang(w.authorSlug, w.translator) };
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
        ${poemBlock(s.text, { translator: w.translator, lang: textLangAttr(w.authorSlug, w.translator, s.text, "work:" + slug), work: true,
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
    metaCitation(cite);
    bindPrint({ cite, entry, title: s.title, author: w.author, authorSlug: w.authorSlug, translator: w.translator,
                work: w.title, year: w.year, part: w.sections.length > 1 ? s.title : "",
                kicker: `${w.title}${w.year ? " · " + w.year : ""}` });
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
    bindLearn({ entry, text: s.text, translator: w.translator, lang: textLangAttr(w.authorSlug, w.translator, s.text, "work:" + slug), par: [] });
    bindReadingBar({ contents: "#/work/" + slug });
    bindSpeakers(slug, i);
    bindPeople(w, slug, i);
    bindGuideBox(w, i);
    bindEchoes({ id: entry.id, slug, group: w.workGroup || (WORKS[slug] || {}).workGroup, part: s.title });
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

  // ---------- Speakers: who speaks which lines of a verse play ----------
  // A book of a play listed in data/speakers/index.json (made by build_speakers.py from the
  // speaker labels printed in the text and an editor's cast list, data/speakers/_works.json)
  // gets "Speakers" beside "Line numbers" and in the phone's reading bar. It opens the cast:
  // the lines each speaks in this part and in the whole play, and the chorus's share as a
  // plain bar with its number. Choosing someone follows them: the other speeches fade to 40%
  // (not hidden), and a bar above the text offers "Previous" and "Next speech by …" (n and p
  // from the keyboard) and "Hide the others", which folds the other speeches into rows
  // ("Chorus, 24 lines") that open again when pressed. The labels are set in small capitals
  // (.spk) and read out as "… speaks:". Counts leave out the labels and stage directions in
  // brackets. The data names lines by poemHTML's data-i and carries each part's number of
  // lines, so a part whose text has changed since gets nothing. Where a translator gives one
  // label to two speakers, his label stands. The rows, like "My marks", are empty buttons drawn
  // by the stylesheet (data-label), so the text's offsets are untouched. The speaker followed
  // is kept for this visit only, per work (SPK_STATE), and nowhere else.
  let SPK_LIST = null;          // Promise of data/speakers/index.json
  const SPK_FILES = {};         // work slug -> Promise of data/speakers/<slug>.json
  const SPK_STATE = new Map();  // work slug -> {who, hide, open: Set of folded stretches opened}
  let SPK = null;               // {slug, i, d, root, lines, runs} for the part on screen
  function speakersOf(slug) {
    if (!SPK_LIST) SPK_LIST = fetch("data/speakers/index.json").then((r) => r.ok ? r.json() : {})
      .catch(() => { SPK_LIST = null; return {}; });
    return SPK_LIST.then((list) => {
      if (!list || !list[slug]) return null;
      return SPK_FILES[slug] || (SPK_FILES[slug] = fetch(`data/speakers/${slug}.json`).then((r) => r.ok ? r.json() : null)
        .catch(() => { delete SPK_FILES[slug]; return null; }));
    });
  }
  const spkState = (slug) => SPK_STATE.get(slug) || SPK_STATE.set(slug, { who: "", hide: false, open: new Set() }).get(slug);
  const spkName = (id) => ((SPK && SPK.d.cast.find((c) => c.id === id)) || { label: id }).label;
  const spkSum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  // Every part's counts added up: {castId: lines in the whole play}.
  function spkPlay(d) {
    const out = {};
    Object.values(d.lines || {}).forEach((o) => Object.keys(o).forEach((k) => { out[k] = (out[k] || 0) + o[k]; }));
    return out;
  }
  // A line that counts: not a label alone, not a stage direction in brackets.
  const spkCounts = (l) => { const t = l.textContent.trim(); return !!t && !/^[[(].*[\])]\.?$/.test(t) && !l.classList.contains("spk-only"); };
  function bindSpeakers(slug, i) {
    SPK = null;
    const here = location.hash;
    speakersOf(slug).then((d) => {
      if (!d || location.hash !== here || !d.sections || !d.sections[i]) return;
      const root = app.querySelector(".detail .text-solo .poem-text") || app.querySelector(".detail .poem-text");
      if (!root || root.classList.contains("is-prose") || root.dataset.spk) return;
      const lines = [...root.querySelectorAll(".ln[data-i]")];
      if (lines.length !== (d.count || {})[i]) return;     // the text has changed since the data was made
      root.dataset.spk = "1";
      // The labels: small capitals, and "speaks:" for a screen reader (styles.css .spk::after).
      (d.labels[i] || []).forEach(([k, n]) => {
        const l = lines[k];
        if (!l) return;
        wrapSpan(hlNodes(l), 0, n, () => { const s = document.createElement("span"); s.className = "spk"; return s; });
        if (l.textContent.trim().length <= n) l.classList.add("spk-only");
      });
      const runs = d.sections[i].map(([a, b, id], k) => ({ a, b, id, k }));
      runs.forEach((r) => { for (let x = r.a; x <= r.b && x < lines.length; x++) lines[x].dataset.spk = r.k; });
      SPK = { slug, i, d, root, lines, runs };
      spkControls();
      spkApply();
    });
  }
  // "Speakers" beside "Line numbers", and in the phone's reading bar.
  function spkControls() {
    const text = SPK.root.closest(".text-solo") || SPK.root;
    let row = app.querySelector("article.detail .ln-bar");
    if (!row) { row = document.createElement("div"); row.className = "ln-bar"; text.before(row); }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spk-open";
    btn.textContent = "Speakers";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "spk-panel");
    btn.addEventListener("click", () => spkPanel(!app.querySelector("#spk-panel"), btn));
    const ctl = row.querySelector(".ln-ctl");
    if (ctl) ctl.prepend(btn); else row.appendChild(btn);
    if (!RB || !RB.nav.isConnected || RB.nav.querySelector(".rb-spk")) return;
    RB.nav.querySelector(".rb-next").insertAdjacentHTML("beforebegin",
      `<button type="button" class="rb-btn rb-spk" aria-expanded="false" aria-controls="spk-panel">${rbIcon("speakers")}<span class="rb-l">Speakers</span></button>`);
    const rb = RB.nav.querySelector(".rb-spk");
    rb.addEventListener("click", () => spkPanel(!app.querySelector("#spk-panel"), rb));
  }
  // The cast list, opened under the row of switches (from the reading bar, scrolled to).
  function spkPanel(open, from) {
    const old = app.querySelector("#spk-panel");
    if (old) old.remove();
    app.querySelectorAll(".spk-open, .rb-spk").forEach((b) => b.setAttribute("aria-expanded", String(!!open)));
    if (!open || !SPK || !SPK.root.isConnected) { if (from) from.focus(); return; }
    const { d, i } = SPK, here = d.lines[i] || {}, play = spkPlay(d), st = spkState(SPK.slug);
    const whole = Object.keys(d.sections).length > 1;
    // In the order they first speak in this part; those silent here after them.
    const first = new Map();
    SPK.runs.forEach((r) => { if (!first.has(r.id)) first.set(r.id, first.size); });
    const cast = d.cast.slice().sort((a, b) => (first.has(a.id) ? first.get(a.id) : 1e6) - (first.has(b.id) ? first.get(b.id) : 1e6));
    const chorus = d.cast.filter((c) => c.group === "chorus").map((c) => c.id);
    const meter = (o, where) => {
      const t = spkSum(o), c = chorus.reduce((a, id) => a + (o[id] || 0), 0), p = t ? Math.round(100 * c / t) : 0;
      return `<p class="spk-share"><span class="spk-share-l">The chorus ${where}: ${num(c)} of ${num(t)} lines</span>
        <span class="spk-meter" aria-hidden="true"><span style="width:${p}%"></span></span><span class="spk-pct">${p}%</span></p>`;
    };
    const count = (c) => {
      const h = here[c.id] || 0, n = (x) => `${num(x)} line${x === 1 ? "" : "s"}`;
      if (!whole) return n(h);
      return `${h ? n(h) + " here" : "not in this part"} · ${num(play[c.id] || 0)} in the play`;
    };
    const panel = document.createElement("div");
    panel.className = "spk-panel";
    panel.id = "spk-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Speakers");
    panel.innerHTML = `
      <p class="spk-title">Who speaks${whole ? " in this part" : ""}</p>
      ${chorus.length ? meter(here, whole ? "here" : "speaks") + (whole ? meter(play, "in the whole play") : "") : ""}
      <ul class="spk-list">${cast.map((c) => `<li class="spk-row${here[c.id] ? "" : " is-silent"}">
        ${here[c.id] ? `<button type="button" class="spk-pick" data-who="${esc(c.id)}" aria-pressed="${st.who === c.id}">${esc(c.label)}</button>`
          : `<span class="spk-pick-off">${esc(c.label)}</span>`}
        <span class="spk-n">${count(c)}</span></li>`).join("")}</ul>
      <p class="spk-help">Choose someone to follow their speeches. The labels are as the translator printed them.</p>
      <button type="button" class="spk-close">Close</button>`;
    const row = app.querySelector("article.detail .ln-bar");
    row.after(panel);
    panel.querySelectorAll(".spk-pick").forEach((b) => b.addEventListener("click", () => {
      spkPanel(false);
      spkFollow(b.dataset.who);
    }));
    panel.querySelector(".spk-close").addEventListener("click", () => spkPanel(false, from || app.querySelector(".spk-open")));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); spkPanel(false, from); } });
    if (from && from.classList.contains("rb-spk")) {
      const head = document.querySelector(".site-head");
      jumpTo(Math.max(0, window.scrollY + panel.getBoundingClientRect().top - (head ? head.offsetHeight : 0) - 16));
    }
    (panel.querySelector('.spk-pick[aria-pressed="true"]') || panel.querySelector(".spk-pick") || panel.querySelector(".spk-close")).focus({ preventScroll: true });
  }
  function spkFollow(who) {
    const st = spkState(SPK.slug);
    st.who = who;
    st.open.clear();
    spkApply();
    if (!who) { announce("Every speech is shown as before."); return; }
    const n = SPK.runs.filter((r) => r.id === who).length;
    announce(`Following ${spkName(who)}: ${n} speech${n === 1 ? "" : "es"} in this part. Press n for the next, p for the previous.`);
    spkStep(1, true);
  }
  // Fades (or folds) the other speeches and draws the bar; again after every change.
  function spkApply(focus) {
    if (!SPK || !SPK.root.isConnected) return;
    const { root, lines, runs } = SPK, st = spkState(SPK.slug);
    // Folding moves the lines, so the margin notes are placed again whenever rows come or go.
    const folded = !!root.querySelector(".spk-gap");
    root.querySelectorAll(".spk-gap").forEach((b) => b.remove());
    root.querySelectorAll(".spk-dim, .spk-hide, .spk-cur").forEach((x) => x.classList.remove("spk-dim", "spk-hide", "spk-cur"));
    const oldBar = app.querySelector(".spk-bar");
    if (oldBar) oldBar.remove();
    const mine = runs.filter((r) => r.id === st.who);
    root.classList.toggle("spk-on", !!mine.length);
    if (!mine.length) { if (folded) drawMarginNotes(); return; }
    const isMine = (k) => runs[k].id === st.who;
    lines.forEach((l) => { if (l.dataset.spk !== undefined && !isMine(+l.dataset.spk)) l.classList.add("spk-dim"); });
    if (st.hide) {
      // Each stretch of other speeches between two of theirs becomes one row.
      for (let k = 0; k < runs.length;) {
        if (isMine(k)) { k++; continue; }
        let e = k;
        while (e + 1 < runs.length && !isMine(e + 1)) e++;
        const ls = lines.slice(runs[k].a, runs[e].b + 1);
        const who = [...new Set(runs.slice(k, e + 1).map((r) => spkName(r.id)))];
        const n = ls.filter(spkCounts).length;
        const names = who.length === 1 ? who[0] : who.length === 2 ? who.join(" and ")
          : `${who.slice(0, 2).join(", ")} and ${who.length - 2} other${who.length > 3 ? "s" : ""}`;
        const what = `${names}, ${num(n)} line${n === 1 ? "" : "s"}`;
        const open = st.open.has(k), from = k;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "spk-gap";
        b.dataset.k = k;
        b.setAttribute("aria-expanded", String(open));
        b.dataset.label = open ? `Fold away: ${what}` : what;
        b.setAttribute("aria-label", open ? `Fold away ${what}` : `${what}, folded away: show them`);
        b.addEventListener("click", () => {
          if (st.open.has(from)) st.open.delete(from); else st.open.add(from);
          spkApply(`.spk-gap[data-k="${from}"]`);
        });
        ls[0].before(b);
        if (!open) ls.forEach((l) => l.classList.add("spk-hide"));
        k = e + 1;
      }
      root.querySelectorAll(".stanza").forEach((s) => {
        if (!s.querySelector(".spk-gap") && s.querySelector(".ln") && !s.querySelector(".ln:not(.spk-hide)")) s.classList.add("spk-hide");
      });
    }
    const name = spkName(st.who), n = (SPK.d.lines[SPK.i] || {})[st.who] || 0;
    const bar = document.createElement("div");
    bar.className = "spk-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Following " + name);
    bar.innerHTML = `
      <p class="spk-sum">Following <strong>${esc(name)}</strong> · ${num(mine.length)} speech${mine.length === 1 ? "" : "es"}, ${num(n)} line${n === 1 ? "" : "s"}${Object.keys(SPK.d.sections).length > 1 ? " in this part" : ""}</p>
      <div class="spk-acts">
        <button type="button" class="spk-prev">Previous</button>
        <button type="button" class="spk-next">Next speech by ${esc(name)}</button>
        <label class="spk-hide-l"><input type="checkbox" class="spk-hide-cb"${st.hide ? " checked" : ""}> Hide the others</label>
        <button type="button" class="spk-stop">Stop following</button>
      </div>`;
    bar.querySelector(".spk-prev").addEventListener("click", () => spkStep(-1));
    bar.querySelector(".spk-next").addEventListener("click", () => spkStep(1));
    bar.querySelector(".spk-hide-cb").addEventListener("change", (e) => {
      st.hide = e.target.checked;
      st.open.clear();
      spkApply(".spk-hide-cb");
      announce(st.hide ? "The other speeches are folded into rows." : "The other speeches are shown, faded.");
    });
    bar.querySelector(".spk-stop").addEventListener("click", () => { spkFollow(""); const b = app.querySelector(".spk-open"); if (b) b.focus(); });
    // It stays in view under the sticky top bar while the reader moves from speech to speech.
    const head = document.querySelector(".site-head");
    bar.style.setProperty("--spk-top", head && !document.body.classList.contains("rb-on") &&
      getComputedStyle(head).position === "sticky" ? head.offsetHeight + "px" : "0px");
    (root.closest(".text-solo") || root).before(bar);
    if (folded || st.hide) drawMarginNotes();
    if (focus) {
      const f = app.querySelector(focus);
      if (f) f.focus({ preventScroll: true });
    }
  }
  // The next (1) or previous (-1) speech of the one followed, put at the upper third of the
  // screen with the keyboard focus on its first line. first: the first speech from here on.
  function spkStep(dir, first) {
    if (!SPK || !SPK.root.isConnected) return false;
    const st = spkState(SPK.slug);
    const mine = SPK.runs.filter((r) => r.id === st.who);
    if (!mine.length) return false;
    const mark = window.innerHeight / 3;
    const top = (r) => SPK.lines[r.a].getBoundingClientRect().top;
    let k = -1;
    if (dir > 0) k = mine.findIndex((r) => top(r) > mark + (first ? -40 : 4));
    else mine.forEach((r, j) => { if (top(r) < mark - 12) k = j; });
    if (k < 0) {
      if (first) k = 0;
      else {
        const more = SPK.i + dir >= 0 && SPK.d.sections[SPK.i + dir] ? ` The ${dir > 0 ? "next" : "previous"} part goes on.` : "";
        announce(`No ${dir > 0 ? "later" : "earlier"} speech by ${spkName(st.who)} in this part.${more}`);
        return true;
      }
    }
    const r = mine[k], el = SPK.lines[r.a];
    SPK.root.querySelectorAll(".spk-cur").forEach((x) => x.classList.remove("spk-cur"));
    SPK.lines.slice(r.a, r.b + 1).forEach((l) => l.classList.add("spk-cur"));
    jumpTo(Math.max(0, window.scrollY + el.getBoundingClientRect().top - mark + 6));
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.focus({ preventScroll: true });
    if (!first) announce(`Speech ${k + 1} of ${mine.length} by ${spkName(st.who)}.`);
    return true;
  }
  // n and p on the keyboard while following someone (n with words selected stays a note).
  // Only where the one followed speaks in this part; elsewhere n is the note key as before.
  const spkFollowing = () => { if (!SPK || !SPK.root.isConnected) return false;
    const who = spkState(SPK.slug).who; return !!who && SPK.runs.some((r) => r.id === who); };

  // ---------- Who's who: the people, gods and places of the great epics ----------
  // data/people/index.json lists the work groups that have one ({groups: {iliad: {title, count,
  // hidden?}}}); data/people/<group>.json is the editors' list: {key (how to read the
  // respellings), note, sources, people: [{id, name, kind: god | mortal | monster | people |
  // place, side, aliases: {default: [...], <translation slug>: [...]}, who (one sentence), more
  // (80 words at most), say, say_also, related}], ambiguous: [{alias, ids, both, name, note}],
  // exclude}. A name is found as each translation spells it: whole words, capitals as written,
  // the longest name first ("son of Telamon" before "Telamon"), accents and æ set aside. A name
  // two people share ("Ajax", "Atrides", "Xanthus") is given to neither: it shows as "which
  // one?" with both, unless the same line names one of them outright; "the Ajaxes" counts for
  // both. A name not in the list shows nothing, and nothing in the text is underlined. Shown
  // four ways: (a) "People" beside "Line numbers" on a book of such a work: who is named in it,
  // in the order they first appear, with their number of lines; choosing someone folds the book
  // to the lines that name them (a line either side, the rest in rows, as "Only my marks"
  // does), which ?who=<id> in the address does too; (b) "People in this line" in the "This
  // line" panel; (c) #/person/<group>/<id>[?w=<translation>]: the card (who, more, how to say
  // it, other names, related) and every line naming them in one translation, chosen from a
  // list, book by book, each a link to its line; (d) #/people/<group>: everyone, with a filter.
  // The lines are found in the browser from the text itself (a whole translation is fetched
  // only for (c)), so they cannot drift from it. Nothing is stored or sent; the person
  // followed lasts for this visit only, per work (PP_STATE).
  let PEOPLE_LIST = null;        // Promise of data/people/index.json's groups
  const PEOPLE_FILES = {};       // group -> Promise of its file, made ready by ppPrepare (null: none)
  const PEOPLE_READY = {};       // group -> the file, once it is in (the "This line" panel reads it)
  const PP_STATE = new Map();    // work slug -> {who, open: Set of folded stretches opened}
  let PP = null;                 // {slug, i, group, d, root, prose, units, found, amb} for the book on screen
  const PP_KINDS = { god: "God", monster: "Creature", people: "People", place: "Place" };
  const ppKind = (p) => PP_KINDS[p.kind] || p.side || "Mortal";
  const ppHref = (group, id, slug) => `#/person/${group}/${id}${slug ? "?w=" + slug : ""}`;
  function peopleGroups() {
    if (!PEOPLE_LIST) PEOPLE_LIST = fetch("data/people/index.json").then((r) => (r.ok ? r.json() : {}))
      .then((d) => (d && d.groups) || {}).catch(() => { PEOPLE_LIST = null; return {}; });
    return PEOPLE_LIST;
  }
  function peopleOf(group) {
    if (!group) return Promise.resolve(null);
    return peopleGroups().then((gs) => {
      if (!gs[group] || gs[group].hidden) return null;
      return PEOPLE_FILES[group] || (PEOPLE_FILES[group] = fetch(`data/people/${encodeURIComponent(group)}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d && Array.isArray(d.people) ? (PEOPLE_READY[group] = ppPrepare(d, group, gs[group])) : null))
        .catch(() => { delete PEOPLE_FILES[group]; return null; }));
    });
  }
  function ppPrepare(d, group, meta) {
    d.group = group;
    d.title = d.title || (meta && meta.title) || group;
    d.byId = new Map(d.people.map((p) => [p.id, p]));
    d.amb = Array.isArray(d.ambiguous) ? d.ambiguous : [];
    d.rx = {};                   // translation slug -> its matcher (ppMatcher)
    return d;
  }
  // Text as names are matched: accents and diaereses set aside (Oïleus, Hekabé), æ and œ spelt
  // out, a curly apostrophe made straight.
  const ppNorm = (s) => String(s || "").replace(/[’ʼ]/g, "'").replace(/æ/g, "ae").replace(/Æ/g, "Ae").replace(/œ/g, "oe").replace(/Œ/g, "Oe")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // The names to find in one translation: {re, to: Map name -> {id} or {amb: index}}.
  function ppMatcher(d, slug) {
    if (d.rx[slug]) return d.rx[slug];
    const to = new Map(), skip = new Set((d.exclude || []).map(ppNorm));
    // "son of Peleus" also stands as "Peleus' son" and "Peleus's son", so the line is the son's,
    // not his father's (the longer name is matched first).
    const add = (name, t) => {
      const k = ppNorm(name).replace(/\s+/g, " ").trim(), m = /^(sons?|daughters?) of (.+)$/i.exec(k);
      if (k && !skip.has(k) && !to.has(k)) to.set(k, t);
      if (m) [`${m[2]}' ${m[1].toLowerCase()}`, `${m[2]}'s ${m[1].toLowerCase()}`].forEach((x) => { if (!to.has(x)) to.set(x, t); });
    };
    d.people.forEach((p) => Object.keys(p.aliases || {}).forEach((key) => {
      if (key === "default" || key === slug) (p.aliases[key] || []).forEach((a) => add(a, { id: p.id }));
    }));
    d.amb.forEach((a, k) => (a.alias || []).forEach((x) => add(x, { amb: k })));
    const names = [...to.keys()].sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
    let re = null;
    try { re = names.length ? new RegExp(`(^|[^\\p{L}\\p{M}])(${names.join("|")})(?![\\p{L}\\p{M}])`, "gu") : null; } catch (e) { re = null; }
    return (d.rx[slug] = { re, to });
  }
  // Who a line (or paragraph) names: {ids, amb: the shared names left open, at: id -> where}.
  function ppFind(d, slug, text) {
    const m = ppMatcher(d, slug), ids = [], open = [], at = new Map();
    if (!m.re) return { ids, amb: open, at };
    const t = ppNorm(text), hits = [];
    m.re.lastIndex = 0;
    let x;
    while ((x = m.re.exec(t))) {
      const hit = m.to.get(x[2].replace(/\s+/g, " "));
      if (!hit) continue;
      const where = x.index + x[1].length;
      if (hit.id) { if (!ids.includes(hit.id)) { ids.push(hit.id); at.set(hit.id, where); } }
      else if (!hits.some((h) => h.k === hit.amb)) hits.push({ k: hit.amb, where });
    }
    // "The Ajaxes" names both; "Ajax" alone names neither, unless the line names one outright.
    hits.forEach((h) => { if (d.amb[h.k].both) d.amb[h.k].ids.forEach((id) => { if (!ids.includes(id)) { ids.push(id); at.set(id, h.where); } }); });
    hits.forEach((h) => { const a = d.amb[h.k]; if (!a.both && !a.ids.some((id) => ids.includes(id))) open.push(h.k); });
    return { ids, amb: open, at };
  }
  const ppState = (slug) => PP_STATE.get(slug) || PP_STATE.set(slug, { who: "", open: new Set(), i: -1 }).get(slug);

  // (a) A book of a work with a who's who: who is named where.
  function bindPeople(w, slug, i) {
    PP = null;
    const here = location.hash, group = w.workGroup || (WORKS[slug] || {}).workGroup;
    if (!group) return;
    // A book with a Greek line map waits for it (applyLineMap makes the row of switches first).
    Promise.all([peopleOf(group), LINEMAPPED.has(slug) ? lineMapOf(slug) : null]).then(([d]) => {
      if (!d || location.hash !== here) return;
      const root = app.querySelector(".detail .text-solo .poem-text") || app.querySelector(".detail .poem-text");
      if (!root || root.dataset.pp) return;
      root.dataset.pp = "1";
      const prose = root.classList.contains("is-prose");
      const units = [...root.querySelectorAll(prose ? ":scope > p" : ".ln[data-i]")];
      const found = new Map(), amb = new Map();    // id -> [unit k]; shared name -> [unit k]
      units.forEach((u, k) => {
        const f = ppFind(d, slug, u.textContent);
        f.ids.forEach((id) => { if (!found.has(id)) found.set(id, []); found.get(id).push(k); });
        f.amb.forEach((a) => { if (!amb.has(a)) amb.set(a, []); amb.get(a).push(k); });
      });
      PP = { slug, i, group, d, root, prose, units, found, amb, part: /^fitt/i.test(w.sections[i].title || "") ? "fitt" : "book" };
      if (LP) lpRefresh();
      if (!found.size) return;
      ppControls();
      // The stretches opened belong to one book; a link to lines shows the whole book.
      const want = (/[?&]who=([\w-]+)/.exec(location.hash) || [])[1], st = ppState(slug);
      if (st.i !== i) { st.open.clear(); st.i = i; }
      if (want && found.has(want)) { st.who = want; st.open.clear(); }
      else if (linkedRange()) st.who = "";
      // "Only my marks" folds the same text: one fold at a time.
      const oc = omCtx();
      if (ppOn() && oc && omState(oc.entry.id).on) { if (want) { omState(oc.entry.id).on = false; omApply(); } else st.who = ""; }
      ppApply();
    });
  }
  const ppOn = () => !!(PP && PP.root.isConnected && ppState(PP.slug).who && PP.found.has(ppState(PP.slug).who));
  // "People" beside "Line numbers".
  function ppControls() {
    const text = PP.root.closest(".text-solo") || PP.root;
    let row = app.querySelector("article.detail .ln-bar");
    if (!row) { row = document.createElement("div"); row.className = "ln-bar"; text.before(row); }
    if (row.querySelector(".pp-open")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pp-open";
    btn.textContent = "People";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "pp-panel");
    btn.addEventListener("click", () => ppPanel(!app.querySelector("#pp-panel"), btn));
    const ctl = row.querySelector(".ln-ctl");
    if (ctl) ctl.prepend(btn); else row.appendChild(btn);
  }
  // Who is named in this book, under the row of switches.
  function ppPanel(open, from) {
    const old = app.querySelector("#pp-panel");
    if (old) old.remove();
    app.querySelectorAll(".pp-open").forEach((b) => b.setAttribute("aria-expanded", String(!!open)));
    if (!open || !PP || !PP.root.isConnected) { if (from) from.focus(); return; }
    const { d, found, amb, slug, prose } = PP, st = ppState(slug), unit = prose ? "paragraph" : "line";
    const n = (x) => `${num(x)} ${unit}${x === 1 ? "" : "s"}`;
    const list = [...found.entries()].sort((a, b) => a[1][0] - b[1][0]);   // in the order they first appear
    const panel = document.createElement("div");
    panel.className = "spk-panel pp-panel";
    panel.id = "pp-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "People in this " + PP.part);
    panel.innerHTML = `
      <p class="spk-title">Named in this ${PP.part} · ${num(list.length)}</p>
      <ul class="spk-list pp-list">${list.map(([id, ks]) => { const p = d.byId.get(id); return `<li class="spk-row">
        <span class="pp-who"><button type="button" class="spk-pick pp-pick" data-who="${esc(id)}" aria-pressed="${st.who === id}">${esc(p.name)}</button>
          <span class="pp-kind">${esc(ppKind(p))}</span></span>
        <span class="spk-n">${n(ks.length)} · <a class="pp-about" href="${ppHref(d.group, id, slug)}">About<span class="visually-hidden"> ${esc(p.name)}</span></a></span></li>`; }).join("")}</ul>
      ${amb.size ? `<p class="spk-help">Not given to anyone: ${[...amb.entries()].map(([k, ks]) => `“${esc(d.amb[k].name)}” (${n(ks.length)})`).join(", ")}, a name two people share. The panel on a line says who it may be.</p>` : ""}
      <p class="spk-help">Choose a name to see only the ${unit}s that name them. Names are found as this translation spells them.</p>
      <p class="pp-links"><a href="#/people/${esc(d.group)}">Who’s who in ${esc(d.title)}</a></p>
      <button type="button" class="spk-close pp-close">Close</button>`;
    app.querySelector("article.detail .ln-bar").after(panel);
    panel.querySelectorAll(".pp-pick").forEach((b) => b.addEventListener("click", () => {
      const who = b.dataset.who;
      ppPanel(false);
      ppFollow(st.who === who ? "" : who);
    }));
    panel.querySelector(".pp-close").addEventListener("click", () => ppPanel(false, from || app.querySelector(".pp-open")));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); ppPanel(false, from); } });
    (panel.querySelector('.pp-pick[aria-pressed="true"]') || panel.querySelector(".pp-pick")).focus({ preventScroll: true });
  }
  function ppFollow(who) {
    if (!PP || !PP.root.isConnected) return;
    const st = ppState(PP.slug);
    st.who = who;
    st.open.clear();
    // "Only my marks" folds the same text: one fold at a time.
    const oc = omCtx();
    if (who && oc && omState(oc.entry.id).on) { omState(oc.entry.id).on = false; omApply(); }
    ppApply();
    if (!who) { announce("Every line is shown."); const b = app.querySelector(".pp-open"); if (b) b.focus(); return; }
    const p = PP.d.byId.get(who), n = PP.found.get(who).length;
    announce(`Only the ${PP.prose ? "paragraphs" : "lines"} naming ${p.name}: ${n}, with one either side.`);
    const bar = app.querySelector(".pp-bar");
    if (bar) {
      const head = document.querySelector(".site-head");
      jumpTo(Math.max(0, window.scrollY + bar.getBoundingClientRect().top - (head ? head.offsetHeight : 0) - 16));
      const off = bar.querySelector(".pp-off");
      if (off) off.focus({ preventScroll: true });
    }
  }
  // A line Find goes to, folded away: its stretch is opened.
  function ppReveal(el) {
    if (!el || !el.closest || !el.closest(".pp-hide") || !PP || !PP.root.isConnected) return;
    const gaps = [...PP.root.querySelectorAll('.pp-gap[aria-expanded="false"]')]
      .filter((g) => g.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!gaps.length) return;
    ppState(PP.slug).open.add(+gaps[gaps.length - 1].dataset.k);
    ppApply();
  }
  // Folds the book to the lines naming the one followed (or unfolds it), with its bar.
  function ppApply(focus) {
    if (!PP || !PP.root.isConnected) return;
    const { root, units, prose, d } = PP, st = ppState(PP.slug);
    const folded = !!root.querySelector(".pp-gap");
    root.querySelectorAll(".pp-gap").forEach((b) => b.remove());
    root.querySelectorAll(".pp-hide").forEach((x) => x.classList.remove("pp-hide"));
    const oldBar = app.querySelector(".pp-bar");
    if (oldBar) oldBar.remove();
    if (!ppOn()) { if (folded) drawMarginNotes(); return; }
    const ks = PP.found.get(st.who), p = d.byId.get(st.who), unit = prose ? "paragraph" : "line";
    const keep = new Set();
    ks.forEach((k) => { keep.add(k - 1); keep.add(k); keep.add(k + 1); });
    for (let k = 0; k < units.length;) {
      if (keep.has(k)) { k++; continue; }
      let e = k;
      while (e + 1 < units.length && !keep.has(e + 1)) e++;
      const n = units.slice(k, e + 1).filter((u) => u.textContent.trim()).length;
      if (e > k && n > 1) {                  // one line alone is not worth a row
        const open = st.open.has(k), from = k;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pp-gap";
        b.dataset.k = k;
        b.setAttribute("aria-expanded", String(open));
        b.dataset.label = open ? `Fold these ${num(n)} ${unit}s away` : `⋯ ${num(n)} ${unit}s ⋯`;
        b.setAttribute("aria-label", open ? `Fold away the ${num(n)} ${unit}s below` : `${num(n)} ${unit}s not naming ${p.name}: show them`);
        b.addEventListener("click", () => {
          if (st.open.has(from)) st.open.delete(from); else st.open.add(from);
          ppApply(`.pp-gap[data-k="${from}"]`);
        });
        units[k].before(b);
        if (!open) units.slice(k, e + 1).forEach((u) => u.classList.add("pp-hide"));
      }
      k = e + 1;
    }
    if (!prose) root.querySelectorAll(".stanza").forEach((s) => {
      if (!s.querySelector(".pp-gap") && s.querySelector(".ln") && !s.querySelector(".ln:not(.pp-hide)")) s.classList.add("pp-hide");
    });
    const bar = document.createElement("div");
    bar.className = "pp-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Only " + p.name);
    bar.innerHTML = `
      <p class="om-sum">Only the ${unit}s naming <strong>${esc(p.name)}</strong>: ${num(ks.length)} in this ${PP.part}, with a ${unit} either side.</p>
      <div class="pp-acts"><a class="pp-card" href="${ppHref(d.group, p.id, PP.slug)}">About ${esc(p.name)}</a>
        <button type="button" class="om-off pp-off">Show every ${unit}</button></div>`;
    bar.querySelector(".pp-off").addEventListener("click", () => ppFollow(""));
    (root.closest(".text-solo") || root).before(bar);
    drawMarginNotes();
    if (focus) { const f = app.querySelector(focus); if (f) f.focus({ preventScroll: true }); }
  }

  // (b) "People in this line" in the "This line" panel, for a book of a work with a who's who.
  LP_PARTS.push((info) => {
    const m = /^work:([^/]+)\/\d+$/.exec(info.entry.id || "");
    if (!m) return null;
    const slug = m[1], group = (PP && PP.slug === slug && PP.group) || (WORKS[slug] || {}).workGroup;
    if (!group) return null;
    const d = PEOPLE_READY[group];
    if (!d) { peopleOf(group).then((x) => { if (x && LP) lpRefresh(); }); return null; }
    const f = ppFind(d, slug, info.lines.join("\n"));
    if (!f.ids.length && !f.amb.length) return null;
    const row = (p) => `<li class="pp-li">
        <p class="pp-li-n"><a href="${ppHref(group, p.id, slug)}">${esc(p.name)}</a> <span class="pp-kind">${esc(ppKind(p))}</span></p>
        <p class="pp-li-w">${esc(p.who)}</p>
        ${p.say ? `<p class="pp-say">Say it: <span class="pp-resp">${esc(p.say)}</span></p>` : ""}</li>`;
    const ambRow = (k) => { const a = d.amb[k]; return `<li class="pp-li">
        <p class="pp-li-n">${esc(a.name)}: which one?</p>
        <p class="pp-li-w">${esc(a.note)}</p>
        <p class="pp-li-w">${a.ids.map((id) => d.byId.get(id)).filter(Boolean).map((p) => `<a href="${ppHref(group, p.id, slug)}">${esc(p.name)}</a>`).join(" · ")}</p></li>`; };
    const unit = lpProse(info.ctx) ? "paragraph" : "line";
    return { title: info.a === info.b ? `People in this ${unit}` : `People in these ${unit}s`,
             html: `<ul class="lp-list pp-lp">${f.ids.map((id) => d.byId.get(id)).filter(Boolean).map(row).join("")}${f.amb.map(ambRow).join("")}</ul>` };
  });

  // (c) #/person/<group>/<id>: one card, and every line that names them in a translation.
  async function renderPerson(group, id, want) {
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    const d = await peopleOf(group);
    if (location.hash !== h) return;
    const p = d && d.byId.get(id);
    if (!p) {
      setTitle("Who’s who");
      app.innerHTML = `<p class="empty">There is no such entry in the who’s who.${d ? ` <a href="#/people/${esc(group)}">Everyone in ${esc(d.title)}</a>` : ""}</p>`;
      return;
    }
    // The translations to choose from: work/works.json, else the index.
    if (!(await loadWorks()) && !DATA && !INDEX_ERROR) await new Promise((res) => { INDEX_WAITERS.push(res); loadIndex(); });
    if (location.hash !== h) return;
    setTitle(`${p.name} · Who’s who: ${d.title}`);
    const vers = worksList().filter((w) => w.workGroup === group && w.translator)
      .sort((a, b) => COLLATE.compare(verShort(a), verShort(b)));
    const first = vers.find((w) => w.slug === want) || vers.find(isRecommended) || vers[0];
    // The other names: those every translation may use, then each translation's own.
    const seen = new Set([fold(p.name)]);
    const names = (list) => (list || []).filter((a) => { const k = fold(a); if (seen.has(k)) return false; seen.add(k); return true; });
    const common = names((p.aliases || {}).default);
    const own = Object.keys(p.aliases || {}).filter((k) => k !== "default")
      .map((k) => ({ w: WORKS[k], list: names(p.aliases[k]) })).filter((x) => x.list.length);
    const also = Object.entries(p.say_also || {});
    const rel = (p.related || []).map((r) => d.byId.get(r)).filter(Boolean);
    app.innerHTML = `
      <article class="detail term-page pp-page">
        <p class="detail-subject"><a href="#/people/${esc(group)}">Who’s who · ${esc(d.title)}</a> · ${esc(ppKind(p))}</p>
        <h1 class="detail-title">${esc(p.name)}</h1>
        ${p.say ? `<div class="pp-sayit">
          <p class="pp-sayit-l">Say it</p>
          <p class="pp-sayit-r"><span class="pp-resp">${esc(p.say)}</span></p>
          ${also.length ? `<p class="pp-sayit-also">${also.map(([nm, s]) => `${esc(nm)}: <span class="pp-resp">${esc(s)}</span>`).join(" · ")}</p>` : ""}
          ${d.key ? `<details class="pp-key"><summary>How to read this</summary><p>${esc(d.key)}</p></details>` : ""}
        </div>` : ""}
        <dl class="term-def">
          <dt class="visually-hidden">Who ${esc(p.name)} is</dt>
          <dd class="term-short-def">${esc(p.who)}</dd>
          ${p.more ? `<dd class="term-long"><p>${esc(p.more)}</p></dd>` : ""}
        </dl>
        ${common.length || own.length ? `
        <section class="pp-names" aria-labelledby="pp-names-h">
          <h2 class="section-label" id="pp-names-h">Other names</h2>
          ${common.length ? `<p class="pp-names-l">${common.map((a) => `<i>${esc(a)}</i>`).join(", ")}</p>` : ""}
          ${own.map((x) => `<p class="pp-names-l"><span class="pp-names-w">${esc(x.w ? verShort(x.w) : "")}${x.w ? ": " : ""}</span>${x.list.map((a) => `<i>${esc(a)}</i>`).join(", ")}</p>`).join("")}
        </section>` : ""}
        ${rel.length ? `
        <section class="term-see" aria-labelledby="pp-rel-h">
          <h2 class="section-label" id="pp-rel-h">Related</h2>
          <ul class="term-see-list">${rel.map((r) => `<li><a href="${ppHref(group, r.id, first ? first.slug : "")}">${esc(r.name)}</a></li>`).join("")}</ul>
        </section>` : ""}
        <section class="pp-every" aria-labelledby="pp-every-h">
          <h2 class="section-label" id="pp-every-h">Every appearance</h2>
          ${vers.length ? `<p class="pp-ver-row"><label for="pp-ver">In</label>
            <select id="pp-ver">${vers.map((w) => `<option value="${esc(w.slug)}"${first && w.slug === first.slug ? " selected" : ""}>${esc(verLabel(w))}</option>`).join("")}</select></p>
          <div class="pp-res" aria-live="polite"></div>` : `<p class="empty">The translations could not be loaded. Please try again later.</p>`}
        </section>
        <section class="term-sources" aria-labelledby="pp-src-h">
          <h2 class="section-label" id="pp-src-h">About this list</h2>
          ${d.note ? `<p class="pp-note">${esc(d.note)}</p>` : ""}
          <ul>${(d.sources || []).map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.cite)}<span class="visually-hidden"> (opens a new tab)</span></a>` : esc(s.cite)}</li>`).join("")}</ul>
          <p><a href="#/people/${esc(group)}">Everyone in ${esc(d.title)}</a></p>
        </section>
      </article>`;
    const sel = app.querySelector("#pp-ver");
    if (sel) {
      let gen = 0;
      const draw = async (slug) => {
        const my = ++gen, box = app.querySelector(".pp-res");
        box.innerHTML = `<p class="loading">Finding every line…</p>`;
        let w = null;
        try { w = await fetchWorkFile(slug); } catch (e) { w = null; }
        if (my !== gen || !box.isConnected) return;
        if (!w || !Array.isArray(w.sections)) { box.innerHTML = `<p class="empty">This translation could not be loaded. Check your connection and try again.</p>`; return; }
        const books = [];
        w.sections.forEach((s, i) => {
          const prose = isProse(s.text, w.translator);
          const units = prose ? proseParas(s.text) : textUnits(s.text).map((u) => u.t);
          const hits = [];
          units.forEach((t, k) => { const f = ppFind(d, slug, t); if (f.ids.includes(p.id)) hits.push({ k, t, at: f.at.get(p.id) || 0 }); });
          if (hits.length) books.push({ i, title: s.title, text: s.text, prose, hits });
        });
        const total = books.reduce((a, b) => a + b.hits.length, 0);
        const prose = books.length && books.every((b) => b.prose), unit = prose ? "paragraph" : "line";
        if (!total) { box.innerHTML = `<p class="empty">${esc(verLabel(w))} does not name ${esc(p.name)} under the names listed here.</p>`; return; }
        box.innerHTML = `
          <p class="pp-total">Named in ${num(total)} ${unit}${total === 1 ? "" : "s"}, in ${num(books.length)} of ${num(w.sections.length)} parts. Open a part to see each ${unit}.</p>
          ${books.map((b, x) => `<details class="pp-book" data-x="${x}">
            <summary><span class="pp-book-t">${esc(b.title)}</span> <span class="pp-book-n">${num(b.hits.length)} ${unit}${b.hits.length === 1 ? "" : "s"}</span></summary>
            <p class="pp-only"><a href="#/work/${esc(slug)}/${b.i}?who=${esc(p.id)}">Read ${esc(b.title)} with only these ${unit}s</a></p>
            <ol class="pp-lines"></ol>
          </details>`).join("")}`;
        // Each part's lines are drawn when it is opened: the line's number as the page counts it.
        box.querySelectorAll(".pp-book").forEach((det) => det.addEventListener("toggle", () => {
          const ol = det.querySelector(".pp-lines");
          if (!det.open || ol.childElementCount) return;
          const b = books[+det.dataset.x], nums = [];
          if (!b.prose) {
            const tmp = document.createElement("div");
            tmp.innerHTML = poemHTML(b.text, false);
            tmp.querySelectorAll(".ln[data-i]").forEach((l) => { nums[+l.dataset.i] = +(l.dataset.c || 0); });
          }
          ol.innerHTML = b.hits.map((x) => {
            const where = b.prose ? `¶ ${x.k + 1}` : nums[x.k] ? `line ${nums[x.k]}` : "heading";
            let t = x.t.replace(/\s+/g, " ").trim();
            // A long paragraph: some 180 characters round the name, cut between words.
            if (t.length > 200) {
              const a = x.at > 80 ? t.lastIndexOf(" ", x.at - 80) + 1 : 0;
              let e = a + 180 < t.length ? t.lastIndexOf(" ", a + 180) : t.length;
              if (e <= x.at) e = Math.min(t.length, a + 180);
              t = (a ? "…" : "") + t.slice(a, e).trim() + (e < t.length ? "…" : "");
            }
            return `<li><a href="#/work/${esc(slug)}/${b.i}?l=${x.k + 1}"><span class="pp-ln-n">${esc(where)}</span><span class="pp-ln-t">${esc(t)}</span></a></li>`;
          }).join("");
        }));
      };
      sel.addEventListener("change", () => {
        const addr = `#/person/${group}/${p.id}?w=${sel.value}`;
        if (EARLY_DRAWN === location.hash) EARLY_DRAWN = addr;
        history.replaceState(history.state, "", addr);
        draw(sel.value);
      });
      draw(sel.value);
    }
    restoreScroll();
  }

  // (d) #/people/<group>: everyone, grouped, with a filter.
  async function renderPeople(group) {
    app.innerHTML = `<p class="loading">Loading…</p>`;
    const h = location.hash;
    const d = await peopleOf(group);
    if (location.hash !== h) return;
    if (!d) { setTitle("Who’s who"); app.innerHTML = `<p class="empty">There is no who’s who for this work yet.</p>`; return; }
    setTitle(`Who’s who: ${d.title}`);
    const SECTIONS = [["god", "Gods"], ["Achaean", "The Achaeans"], ["Trojan", "The Trojans and their allies"],
      ["mortal", "Others in the stories told"], ["monster", "Creatures"], ["people", "Peoples"], ["place", "Places"]];
    const secOf = (p) => (p.kind === "mortal" ? p.side || "mortal" : p.kind);
    const byName = (a, b) => COLLATE.compare(fold(a.name), fold(b.name));
    const hay = (p) => fold([p.name, p.who].concat(...Object.values(p.aliases || {})).join(" "));
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Who’s who: ${esc(d.title)}</h1>
        <p class="page-sub">${num(d.people.length)} people, gods, peoples and places, each with how to say the name and every line that names them.</p></div>
      ${d.key ? `<details class="pp-key pp-key-top"><summary>How to read the respellings</summary><p>${esc(d.key)}</p></details>` : ""}
      <div class="poet-tools term-tools">
        <div class="poet-filter term-filter">
          <label class="visually-hidden" for="pp-q">Find a name</label>
          <input id="pp-q" type="search" placeholder="Find a name…" autocomplete="off" spellcheck="false" aria-describedby="pp-count">
        </div>
        <p class="term-count" id="pp-count" aria-live="polite"></p>
      </div>
      ${SECTIONS.map(([k, label], x) => {
        const ps = d.people.filter((p) => secOf(p) === k).sort(byName);
        return ps.length ? `
        <section class="term-letter pp-sec" aria-labelledby="pp-s-${x}">
          <h2 class="section-label" id="pp-s-${x}">${esc(label)}</h2>
          <ul class="term-list">${ps.map((p) => `
            <li data-hay="${esc(hay(p))}"><a href="${ppHref(group, p.id)}">
              <span class="term-name">${esc(p.name)}${p.say ? ` <span class="pp-resp pp-resp-s">${esc(p.say)}</span>` : ""}</span>
              <span class="term-short">${esc(p.who)}</span></a></li>`).join("")}</ul>
        </section>` : "";
      }).join("")}
      <p class="empty term-none" hidden>No name matches. <button type="button" class="term-clear">Show everyone</button></p>
      ${d.note ? `<p class="pp-note">${esc(d.note)}</p>` : ""}`;
    const input = app.querySelector("#pp-q"), count = app.querySelector("#pp-count");
    const filter = () => {
      const words = fold(input.value).split(/\s+/).filter(Boolean);
      let shown = 0;
      app.querySelectorAll(".pp-sec").forEach((sec) => {
        let n = 0;
        sec.querySelectorAll("li[data-hay]").forEach((li) => { const ok = words.every((w) => li.dataset.hay.includes(w)); li.hidden = !ok; if (ok) n++; });
        sec.hidden = !n; shown += n;
      });
      app.querySelector(".term-none").hidden = shown > 0;
      count.textContent = words.length ? `${num(shown)} name${shown === 1 ? "" : "s"}` : "";
    };
    input.addEventListener("input", filter);
    app.querySelector(".term-clear").addEventListener("click", () => { input.value = ""; filter(); input.focus(); });
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
                       noQuote: true, noMargin: true, text: w.sections[k].text, translator: w.translator };
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
    } else body = items.length || loose.length || markCount() || cols.length || planCount() ? (cols.length ? `
        <section class="shelf-group">
          <h2>Collections · ${cols.length}</h2>
          <ul class="shelf-list">${cols.map((c) => `
            <li class="shelf-item"><a class="shelf-link" href="#/shelf?c=${esc(c.id)}">
              <span class="shelf-title">${esc(c.name)}</span>
              <span class="shelf-by">${plural(c.items.length, "text", "texts")}</span></a></li>`).join("")}</ul>
        </section>` : "") + shelfPlansHTML() + group("Poems", poems, savedNote) + group("Works", works, savedNote)
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
    // A plan: Stop (one followed) or Remove (one finished, from the history).
    app.querySelectorAll(".plan-drop").forEach((b) => b.addEventListener("click", () => {
      dropPlan(b.dataset.plan);
      announce("Removed from your reading plans.");
      SHELF_FOCUS = "#shelf-pick";
      renderShelf();
    }));
    app.querySelectorAll(".shelf-remove:not(.col-out):not(.plan-drop)").forEach((b) => b.addEventListener("click", () => {
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
        (markCount() ? shelfMarkLinks() : Promise.resolve({}))
          .then((links) => downloadFile(`poetry-codex-shelf-${day}.md`, "text/markdown", shelfMarkdown(links)));
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
  // (the texts stay on the shelf), share as a reading-list link, print as a handout, or make
  // it an assignment link (assignPanelHTML below).
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
            <button class="shelf-dl col-assign" type="button" aria-expanded="${ASSIGN_OPEN === col.id && n ? "true" : "false"}" aria-controls="col-assign"${n ? "" : " disabled"}>Make an assignment link</button>
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
          ${n ? assignPanelHTML(col) : ""}
          ${listQuestionHTML(col.q)}
          ${n ? `<ol class="shelf-list col-list">${col.items.map((x, k) => `
            <li class="shelf-item col-item" data-k="${k}">
              <span class="col-grip no-print" draggable="true" title="Drag to reorder" aria-hidden="true">⠇</span>
              <a class="shelf-link" href="${esc(colItemHref(x))}">
                <span class="shelf-title">${esc(x.title)}</span>
                <span class="shelf-by">${esc(byLine(x))}</span>
                ${x.l ? `<span class="col-loc">${esc(passageLabel(x))}${x.first ? ` · “${esc(x.first)}…”` : ""}</span>` : ""}
                ${dueDay(x.due) ? `<span class="rl-due">Due ${esc(dueLabel(x.due))}</span>` : ""}
                ${x.note ? `<span class="rl-note"><span class="rl-note-label">Note:</span> ${esc(x.note)}</span>` : ""}
              </a>
              <span class="shelf-side no-print">${shelfLearnHTML(x.ref, x.l)}
                <button class="col-move" type="button" data-k="${k}" data-d="-1" aria-label="Move ${esc(x.title)} up"${k === 0 ? " disabled" : ""}>Up</button>
                <button class="col-move" type="button" data-k="${k}" data-d="1" aria-label="Move ${esc(x.title)} down"${k === n - 1 ? " disabled" : ""}>Down</button>
                <button class="shelf-remove col-out" type="button" data-k="${k}" aria-label="Take ${esc(x.title)} out of this collection">Remove</button>
              </span>
            </li>`).join("")}</ol>
          <p class="print-only col-url">Online: ${esc(readingListURL(col.name, col.items, col.q).url)}</p>` : `
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
    if (share) share.addEventListener("click", () => shareReadingList(col.name, col.items, col.q));
    bindAssignPanel(col);
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

  // ---------- making an assignment link ----------
  // "Make an assignment link" on a collection opens a panel: a question for the whole list,
  // and a note and a due date under each text. They are saved on the collection as they are
  // typed (q, and note / due on its items), and the link below is rebuilt each time, with its
  // length: course pages cut very long addresses, so above 1,900 characters the panel says so.
  // Sharing: copy the link; "Post to Google Classroom" is Google's plain share address (no
  // Google script is loaded); "Copy for Moodle, Canvas or Blackboard" copies an HTML link with
  // the list's title; Email opens the reader's mail program with no address filled in.
  let ASSIGN_OPEN = "";                // the collection whose panel is open, kept across redraws
  function assignPanelHTML(col) {
    const items = col.items.slice(0, LIST_MAX);
    return `
          <section class="assign-panel no-print" id="col-assign" aria-labelledby="assign-head"${ASSIGN_OPEN === col.id ? "" : " hidden"}>
            <h3 class="assign-head" id="assign-head">Assignment link</h3>
            <p class="assign-how">Add a question for the whole list and, if you like, a note and a due date for each text.
              They travel in the link itself: students need no account, and nothing about them is stored or sent.</p>
            <label class="col-form-label" for="assign-q">Question for the whole list <span class="assign-max">(up to ${ASSIGN_Q_MAX} characters)</span></label>
            <textarea class="col-form-input assign-q" id="assign-q" maxlength="${ASSIGN_Q_MAX}" rows="3">${esc(col.q || "")}</textarea>
            <ol class="assign-items">${items.map((x, k) => `
              <li class="assign-item">
                <p class="assign-title">${esc(x.title)}${x.l ? ` <span class="assign-loc">${esc(passageLabel(x))}</span>` : ""}</p>
                <div class="assign-fields">
                  <span class="assign-field assign-field-note">
                    <label class="col-form-label" for="assign-n${k}">Note on this text <span class="assign-max">(up to ${ASSIGN_NOTE_MAX})</span></label>
                    <textarea class="col-form-input assign-n" id="assign-n${k}" data-k="${k}" maxlength="${ASSIGN_NOTE_MAX}" rows="2">${esc(x.note || "")}</textarea>
                  </span>
                  <span class="assign-field">
                    <label class="col-form-label" for="assign-d${k}">Due date</label>
                    <input class="col-form-input assign-d" id="assign-d${k}" data-k="${k}" type="date" value="${esc(dueDay(x.due))}">
                  </span>
                </div>
              </li>`).join("")}
            </ol>
            ${col.items.length > LIST_MAX ? `<p class="shelf-how">A link holds at most ${LIST_MAX} texts, so the link has the first ${LIST_MAX}.</p>` : ""}
            <p class="assign-len"><span class="assign-count"></span></p>
            <p class="assign-warn" role="status"></p>
            <div class="cite-row assign-share">
              <button class="shelf-dl assign-copy" type="button">Copy link</button>
              <a class="shelf-dl assign-gc" href="#" target="_blank" rel="noopener noreferrer">Post to Google Classroom</a>
              <button class="shelf-dl assign-lms" type="button">Copy for Moodle, Canvas or Blackboard</button>
              <a class="shelf-dl assign-mail" href="#">Email</a>
              <a class="shelf-view assign-preview" href="#">See it as a student <span aria-hidden="true">→</span></a>
            </div>
          </section>`;
  }
  function bindAssignPanel(col) {
    const btn = app.querySelector(".col-assign"), panel = document.getElementById("col-assign");
    if (!btn || !panel) return;
    btn.addEventListener("click", () => {
      // Closing draws the collection again, so its question and notes show what was typed.
      if (!panel.hidden) { ASSIGN_OPEN = ""; SHELF_FOCUS = ".col-assign"; renderShelf(); return; }
      panel.hidden = false;
      ASSIGN_OPEN = col.id;
      btn.setAttribute("aria-expanded", "true");
      panel.querySelector(".assign-q").focus();
    });
    const now = () => shelfCollections().find((c) => c.id === col.id) || col;
    let over = null;
    const draw = () => {
      const c = now(), { url, hash } = readingListURL(c.name, c.items, c.q);
      panel.querySelector(".assign-count").textContent = `The link is ${num(url.length)} characters long.`;
      const long = url.length > ASSIGN_URL_WARN;
      if (long !== over) {                 // read out only when it crosses the line
        over = long;
        panel.querySelector(".assign-warn").textContent = long ? "Too long for some course pages: shorten the notes." : "";
      }
      panel.querySelector(".assign-gc").href = "https://classroom.google.com/share?url=" + encodeURIComponent(url) + "&title=" + encodeURIComponent(c.name);
      panel.querySelector(".assign-mail").href = "mailto:?subject=" + encodeURIComponent(c.name)
        + "&body=" + encodeURIComponent((oneLine(c.q, ASSIGN_Q_MAX) ? oneLine(c.q, ASSIGN_Q_MAX) + "\n\n" : "") + url);
      panel.querySelector(".assign-preview").href = hash;
      return { url, c };
    };
    // Saved as it is typed, on the collection itself.
    panel.querySelector(".assign-q").addEventListener("input", (e) => {
      const q = e.target.value.slice(0, ASSIGN_Q_MAX);
      editCollection(col.id, (c) => { if (q.trim()) c.q = q; else delete c.q; });
      draw();
    });
    panel.querySelectorAll(".assign-n, .assign-d").forEach((el) => el.addEventListener("input", () => {
      const k = +el.dataset.k, isNote = el.classList.contains("assign-n");
      editCollection(col.id, (c) => {
        const x = c.items[k];
        if (!x) return;
        if (isNote) { if (el.value.trim()) x.note = el.value.slice(0, ASSIGN_NOTE_MAX); else delete x.note; }
        else if (dueDay(el.value)) x.due = el.value; else delete x.due;
      });
      draw();
    }));
    panel.querySelector(".assign-copy").addEventListener("click", (e) => {
      const b = e.currentTarget, { url } = draw();
      copyText(url).then(() => { flash(b, "Copied"); announce("Assignment link copied."); }, () => copyBox(url, true));
    });
    panel.querySelector(".assign-lms").addEventListener("click", (e) => {
      const b = e.currentTarget, { url, c } = draw();
      const html = `<a href="${esc(url)}">${esc(c.name)}</a>`;
      // As a link where the editor takes formatted text; as HTML source in its HTML view.
      copyText(html, html).then(() => { flash(b, "Copied"); announce("Link copied for your course page: paste it into the editor, or into its HTML view."); },
        () => copyBox(html, true));
    });
    draw();
  }

  // ---------- reading lists: a collection shared as a link ----------
  // "Share as reading list" copies an address that carries the whole list:
  // #/list?t=<title>&i=<ref>,<ref>@120-160,… (a title of up to 80 characters, at most 60
  // items; a passage is its text's id @ the lines, counted as "Link to lines" counts them).
  // Nothing is stored anywhere for it. Whoever opens it sees a read-only page: the texts with
  // their poet, translator and first line (or the lines), "Read in order", "Save this list to
  // my shelf" (a new collection) and "Print list". An id that is not in the archive shows as
  // "moved or withdrawn" and is skipped. "Read in order" opens the first text with ?list=1 in
  // its address; while ?list= is there, the foot of the text offers the next one. The list
  // being read is kept for this tab only (sessionStorage), so the addresses stay short.
  // An assignment is the same link with the teacher's words in it (all optional):
  // &q=<a question for the whole list, up to 300 characters>, &n<k>=<a note on item k, up to
  // 200> and &d<k>=<YYYY-MM-DD, item k's due date>, k counting from 1. Older links and unknown
  // parameters are simply read without them. The words are shown as text, never as HTML.
  const LIST_MAX = 60;
  const ASSIGN_Q_MAX = 300, ASSIGN_NOTE_MAX = 200, ASSIGN_URL_WARN = 1900;
  const REF_RE = /^(?:work:[\w-]+(?:\/\d+)?|[\w-]+\/\d+)$/;
  const oneLine = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
  // A due date as the link carries it, or "" when it is not a real day.
  function dueDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    if (!m) return "";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : "";
  }
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function dueLabel(s) {
    const day = dueDay(s);
    if (!day) return "";
    const [y, m, d] = day.split("-").map(Number), dt = new Date(Date.UTC(y, m - 1, d));
    return `${WEEKDAYS[dt.getUTCDay()]} ${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
  }
  function readingListURL(name, items, q) {
    const list = items.slice(0, LIST_MAX);
    const refs = list.map((x) => x.ref + (x.l ? "@" + x.l : ""));
    let extra = oneLine(q, ASSIGN_Q_MAX) ? "&q=" + encodeURIComponent(oneLine(q, ASSIGN_Q_MAX)) : "";
    list.forEach((x, k) => {
      const note = oneLine(x.note, ASSIGN_NOTE_MAX), due = dueDay(x.due);
      if (note) extra += "&n" + (k + 1) + "=" + encodeURIComponent(note);
      if (due) extra += "&d" + (k + 1) + "=" + due;
    });
    const hash = "#/list?t=" + encodeURIComponent(String(name).slice(0, COL_NAME_MAX)) + "&i=" + refs.join(",") + extra;
    return { hash, url: SITE + "/" + hash, over: items.length > LIST_MAX };
  }
  function shareReadingList(name, items, q) {
    const { hash, url, over } = readingListURL(name, items, q);
    const msg = (over ? `A link holds at most ${LIST_MAX} texts, so this one has the first ${LIST_MAX} of ${num(items.length)}. ` : "")
      + "Link to the reading list copied. Whoever opens it sees the list; nothing is stored on Poetry Codex.";
    copyText(url).then(() => selToast(msg, { label: "Open it", run: () => { closeToast(); location.hash = hash; } }, true),
      () => copyBox(url, true));
  }
  function parseReadingList(h) {
    let t = "", raw = "", q = "";
    const notes = {}, dues = {};
    const dec = (v) => { try { return decodeURIComponent(v.replace(/\+/g, " ")); } catch (e) { return v; } };
    (h.split("?")[1] || "").split("&").forEach((kv) => {
      const at = kv.indexOf("="), k = kv.slice(0, at), v = kv.slice(at + 1);
      let m;
      if (k === "t") t = dec(v);
      else if (k === "i") { try { raw = decodeURIComponent(v); } catch (e) { raw = v; } }
      else if (k === "q") q = dec(v);
      else if ((m = /^([nd])(\d{1,2})$/.exec(k))) (m[1] === "n" ? notes : dues)[+m[2]] = dec(v);
    });
    const all = raw.split(",").map((x) => x.trim()).filter(Boolean);
    const items = all.slice(0, LIST_MAX).map((x, k) => {
      const at = x.lastIndexOf("@"), ref = at >= 0 ? x.slice(0, at) : x, l = at >= 0 ? x.slice(at + 1) : "";
      return { ref, l: /^\d+(?:-\d+)?$/.test(l) ? l : "", note: oneLine(notes[k + 1], ASSIGN_NOTE_MAX), due: dueDay(dues[k + 1]) };
    });
    return { t: t.replace(/\s+/g, " ").trim().slice(0, COL_NAME_MAX) || "A reading list", items,
             q: oneLine(q, ASSIGN_Q_MAX), over: all.length > LIST_MAX ? all.length : 0 };
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
  // The teacher's question, in a quiet frame; and an item's due date and note, under it.
  const listQuestionHTML = (q) => q ? `
        <div class="rl-question">
          <p class="rl-q-label">Question for this list</p>
          <p class="rl-q-text">${esc(q)}</p>
        </div>` : "";
  const listExtraHTML = (x) => x.note || x.due ? `
            <div class="rl-extra">${x.due ? `<p class="rl-due">Due ${esc(dueLabel(x.due))}</p>` : ""}${x.note
              ? `<p class="rl-note"><span class="rl-note-label">Teacher’s note:</span> ${esc(x.note)}</p>` : ""}</div>` : "";
  const LIST_RUN_KEY = "pc-list-run";
  let LIST_RUN = null;                 // {t, from (the list page's address), assign, items: [{ref, l, title, loc, note, due}]}
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
    const found = rows.filter((r) => r.info).map((r) => Object.assign({ ref: r.x.ref, l: r.x.l, note: r.x.note, due: r.x.due }, r.info));
    const missing = rows.length - found.length;
    const assign = !!(list.q || list.items.some((x) => x.note || x.due));
    setListRun({ t: list.t, from: location.hash, assign,
                 items: found.map((x) => ({ ref: x.ref, l: x.l, title: x.title, loc: x.loc, note: x.note, due: x.due })) });
    let k = -1;
    app.innerHTML = `
      <article class="shelf rlist">
        <div class="page-head">
          <p class="detail-subject">${assign ? "An assignment" : "A reading list"}</p>
          <h1 class="page-title">${esc(list.t)}</h1>
          <p class="page-sub">${num(found.length)} ${found.length === 1 ? "text" : "texts"}. ${assign
            ? "Shared as a link: the list, the question and the notes travel in the address itself. Nothing about you is stored or sent, and no sign-in is needed."
            : "Shared as a link: the list travels in the address itself, and nothing about it is stored on Poetry Codex."}</p>
        </div>
        ${listQuestionHTML(list.q)}
        ${found.length ? `<div class="cite-row rl-tools no-print">
          <a class="rl-read" href="${esc(listItemHref(found[0], 0))}">Read in order <span aria-hidden="true">→</span></a>
          <button class="shelf-dl rl-save" type="button">Save this list to my shelf</button>
          <button class="shelf-dl rl-print" type="button">Print list</button>
        </div>
        <p class="rl-saved no-print" hidden></p>` : ""}
        ${rows.length ? `<ol class="shelf-list rl-list">${rows.map(({ x, info }) => {
          if (!info) return `
          <li class="shelf-item rl-missing"><span class="shelf-link"><span class="shelf-title">This text has moved or been withdrawn</span>
            <span class="shelf-by">${esc(x.ref)} · skipped</span></span>${listExtraHTML(x)}</li>`;
          k++;
          return `
          <li class="shelf-item"><a class="shelf-link" href="${esc(listItemHref(x, k))}">
            <span class="shelf-title">${esc(info.title)}</span>
            <span class="shelf-by">${esc(byLine(info))}</span>
            ${info.loc || info.first ? `<span class="col-loc">${esc(info.loc || info.first)}</span>` : ""}
          </a>${listExtraHTML(x)}</li>`;
        }).join("")}</ol>` : `<p class="empty">This reading list is empty.</p>`}
        ${missing ? `<p class="shelf-how no-print">${missing === 1 ? "One item has" : num(missing) + " items have"} moved or been withdrawn and ${missing === 1 ? "is" : "are"} skipped.</p>` : ""}
        ${list.over ? `<p class="shelf-how">The link named ${num(list.over)} texts; a reading list holds at most ${LIST_MAX}, so only the first ${LIST_MAX} are shown.</p>` : ""}
        <p class="print-only col-url">Online: ${esc(SITE + "/" + location.hash)}</p>
      </article>`;
    const save = app.querySelector(".rl-save");
    if (save) save.addEventListener("click", () => {
      // The teacher's question and notes come along: the reader's copy is an assignment too.
      const c = newCollection(list.t, found.map((x) => ({ ref: x.ref, l: x.l || undefined, title: x.title, author: x.author,
        translator: x.translator, kind: x.kind, loc: x.l ? x.loc : undefined, note: x.note || undefined, due: x.due || undefined })),
        list.q ? { q: list.q } : null);
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
  // The text being read now, when it was opened from an assignment link: {run, k, x} or null.
  function assignmentItem() {
    const m = /[?&]list=(\d+)/.exec(location.hash), run = m && listRun();
    if (!run || !run.assign) return null;
    const k = +m[1] - 1;
    return run.items[k] ? { run, k, x: run.items[k] } : null;
  }
  // The assignment bar is closed for one list at a time, for this visit only.
  const ASSIGN_HIDE_KEY = "pc-assign-hide";
  function assignHidden(from) { try { return sessionStorage.getItem(ASSIGN_HIDE_KEY) === from; } catch (e) { return false; } }
  // A slim bar above a text opened from an assignment: where it stands in the list, the
  // lines set, the due date and the teacher's note, with Previous / Back to list / Next.
  // × closes it for the rest of the visit. Nothing is stored about the reader.
  function assignBar({ run, k, x }) {
    const n = run.items.length, prev = run.items[k - 1], next = run.items[k + 1];
    const nav = document.createElement("nav");
    nav.className = "assign-bar no-print";
    nav.setAttribute("aria-label", "Assignment");
    nav.innerHTML = `
      <p class="ab-where"><strong>Reading ${k + 1} of ${n}</strong>${x.loc ? " · " + esc(x.loc.charAt(0).toUpperCase() + x.loc.slice(1)) : ""}${
        dueDay(x.due) ? " · Due " + esc(dueLabel(x.due)) : ""}${x.note ? ` · <span class="ab-note-label">Teacher’s note:</span> ${esc(x.note)}` : ""}</p>
      <div class="ab-links">
        ${prev ? `<a class="ab-go" href="${esc(listItemHref(prev, k - 1))}"><span aria-hidden="true">←</span> Previous</a>` : ""}
        <a class="ab-go" href="${esc(run.from)}">Back to list</a>
        ${next ? `<a class="ab-go" href="${esc(listItemHref(next, k + 1))}">Next <span aria-hidden="true">→</span></a>` : ""}
        <button class="ab-close" type="button" aria-label="Close the assignment bar">×</button>
      </div>`;
    nav.querySelector(".ab-close").addEventListener("click", () => {
      try { sessionStorage.setItem(ASSIGN_HIDE_KEY, run.from); } catch (e) { /* closed for this page */ }
      const head = app.querySelector("article.detail h1");
      nav.remove();
      if (head) { head.tabIndex = -1; head.focus(); }
      announce("Assignment bar closed for this visit.");
    });
    return nav;
  }
  // At the foot of a text opened from a reading list (?list=N): where it stands in the list
  // and the next text, or the end of the list. From an assignment, the bar above it as well.
  function bindListNext() {
    const m = /[?&]list=(\d+)/.exec(location.hash), run = m && listRun();
    const art = app.querySelector("article.detail");
    if (!run || !art || app.querySelector(".list-next")) return;
    const k = +m[1] - 1, n = run.items.length, next = run.items[k + 1];
    if (!run.items[k]) return;
    const a = assignmentItem();
    if (a && !assignHidden(run.from)) art.before(assignBar(a));     // above the page, clear of Find and Aa
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
      collections: shelfCollections().map((c) => ({ name: c.name, readingList: readingListURL(c.name, c.items, c.q).url,
        items: c.items.map((x) => ({ id: x.ref, title: x.title, author: x.author, lines: x.l || undefined, url: SITE + shelfPath(x.ref) })) })),
      lineNotes: markRows().map(({ id, g, m }) => ({ id, title: g.title, author: g.author, url: SITE + shelfPath(id),
        quote: m.quote, note: m.text, updated: m.updated })),
    };
  }
  // links: {"<text id>|<mark id>": the address of the mark's lines}, from shelfMarkLinks.
  function shelfMarkdown(links) {
    const md = (s) => String(s || "").replace(/([\\`*_[\]<>])/g, "\\$1");
    const items = shelfItems();
    const notes = allNotes();
    const all = items.concat(looseNotes(), markRows().map(({ g }) => g));
    const head = frontMatter({ title: "My Poetry Codex shelf", author: uniq(all.map((it) => it.author)),
      translator: uniq(all.flatMap((it) => citeTranslators(it.translator))),
      url: SITE + "/#/shelf", exported: isoDay(new Date()) });
    // A note is quoted under its text, line for line.
    const quote = (n) => n ? "\n" + n.text.split("\n").map((l) => "  > " + l).join("\n") + "\n" : "";
    const block = (name, list) => list.length ? `## ${name}\n\n` + list.map((it) =>
      `- **${md(it.title)}** — ${md(byLine(it))}  \n  ${SITE + shelfPath(it.id)}  \n  `
      + (it.saved ? `Saved ${shortDate(it.saved)}` : `Note written ${shortDate(it.updated)}`) + "\n"
      + quote(notes[it.id])).join("\n") + "\n" : "";
    return head + `# My Poetry Codex shelf\n\nExported ${shortDate(new Date().toISOString())} from ${SITE}\n\n`
      + block("Poems", items.filter((it) => it.kind === "poem"))
      + block("Works", items.filter((it) => it.kind !== "poem"))
      + block("Notes on other texts", looseNotes())
      + (markCount() ? "## Notes on lines\n\n" + markRows().map(({ id, g, m }) =>
        `- “${md(m.quote)}” — **${md(g.title)}**, ${md(g.author || "")}  \n  <${(links && links[id + "|" + m.id]) || SITE + shelfPath(id)}>\n  > ${m.text.split("\n").join("\n  > ")}\n`).join("\n") + "\n" : "");
  }
  // Each highlight and line note found in its text (as on #/notes), for its ?l= address;
  // one that cannot be found keeps the text's own address.
  function shelfMarkLinks() {
    const items = nbItems().filter((it) => it.type !== "note");
    return Promise.all([...new Set(items.map((it) => it.tid))].map((tid) => nbText(tid).then((tx) => {
      items.filter((it) => it.tid === tid).forEach((it) => nbPlace(it, tx));
    }))).then(() => Object.fromEntries(items.map((it) => [it.key, markURL(it)])), () => ({}));
  }
  function downloadFile(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- READING PLANS: #/plan?w=iliad-pope&s=2026-10-20&e=&p=3b&d=127&by=book ----------
  // A long work cut into portions with dates. The link holds the whole plan: the work (w),
  // the start (s), a finish date (e) or else a pace (p: "3b" three books a week, "150l" about
  // 150 lines a day), the reading days (d: Mon = 1, Tue = 2 … Sun = 64, added up) and the split
  // (by: whole books, or even portions cut at the stanza or paragraph break nearest the target
  // and never mid-sentence where a full stop is within five lines). The same link always gives
  // the same plan, so a teacher shares a semester's plan as a link, as with an assignment.
  // Following a plan keeps {link, started, done, snap (the portions as they were drawn), sig}
  // under pc-reading's "plans" (MERGE.reading merges it by work, the newer winning), so it
  // follows a signed-in reader with no change to the Worker. A portion is done when the place
  // kept in pc-reading passes its last line, or when the reader ticks it. No streaks, no red,
  // no count of missed days: only "Two portions to catch up" and a way to spread the rest.
  const PLAN_MAX = 400;                  // portions in one plan (more than a year of days)
  const PLAN_DAYS_MAX = 1500;            // reading days in one plan (about four years)
  const PLAN_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const NUM_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  const weekIndex = (day) => (new Date(day + "T12:00:00").getDay() + 6) % 7;   // Mon 0 … Sun 6
  const planMin = (m) => m < 1 ? "<1 min" : m < 90 ? `about ${Math.round(m)} min`
    : `about ${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")} min`;
  function planParams(hash) {
    const q = new URLSearchParams(String(hash || "").split("?")[1] || "");
    const pm = /^(\d+(?:\.\d+)?)([bl])$/.exec(q.get("p") || "");
    let p = pm ? { n: +pm[1], u: pm[2] } : null;
    if (p) p.n = p.u === "b" ? Math.min(50, Math.max(0.25, p.n)) : Math.min(100000, Math.max(5, Math.round(p.n)));
    const d = parseInt(q.get("d"), 10);
    return { w: q.get("w") || "", s: dueDay(q.get("s")), e: dueDay(q.get("e")), p,
             d: d >= 1 && d <= 127 ? d : 127, by: q.get("by") === "even" ? "even" : "book" };
  }
  const planQuery = (o) => `w=${o.w}&s=${o.s}&e=${o.e || ""}&p=${o.p ? o.p.n + o.p.u : ""}&d=${o.d}&by=${o.by}`;
  // Every text unit of the work as the page numbers it: a verse line (weight 1) or a prose
  // paragraph (weight: its words / 8, so that 25 "lines" are a minute either way), with how
  // good a place to stop it ends at (3 the end of a book, 2 a stanza or paragraph, 1 a
  // sentence; .5 a colon or semicolon and .25 a comma, for verse whose sentences run long).
  function planUnits(work) {
    return work.sections.map((s) => {
      const prose = isProse(s.text, work.translator);
      const units = [];
      if (prose) proseParas(s.text).forEach((p) => units.push({ w: p.split(/\s+/).filter(Boolean).length / 8, brk: 2 }));
      else String(s.text || "").split(/\n\s*\n/).filter((st) => st.trim()).forEach((st) => {
        const ls = st.split("\n").filter((l) => l.trim());
        ls.forEach((l, k) => units.push({ w: 1, brk: k === ls.length - 1 ? 2 : /[.!?][’”"')\]]*\s*$/.test(l) ? 1
          : /[;:—][’”"')\]]*\s*$/.test(l) ? 0.5 : /,[’”"')\]]*\s*$/.test(l) ? 0.25 : 0 }));
      });
      if (!units.length) units.push({ w: 1, brk: 2 });
      units[units.length - 1].brk = 3;
      return { title: s.title, prose, units };
    });
  }
  // The reading days from the start: n of them, or up to the finish date.
  function planDays(o, n, until) {
    const out = [];
    let day = o.s;
    for (let guard = 0; guard < PLAN_DAYS_MAX * 7 && (until ? day <= until : out.length < n); guard++) {
      if (o.d & (1 << weekIndex(day))) out.push(day);
      day = addDays(day, 1);
    }
    return out;
  }
  // The plan the link describes: {portions: [{d, i, a, j, b, n, q, m, lab, f0, f1, ef}], sig}.
  // i/a: the book and unit it starts at, j/b where it ends (units counted from 1, as ?l= counts
  // them); n lines and q paragraphs; m minutes; f0/f1 where it starts and ends in the whole
  // work (0 to 1); ef how far into book j it ends, for "done".
  function planPortions(work, o) {
    const secs = planUnits(work);
    const flat = [];
    secs.forEach((s, i) => s.units.forEach((u, k) => flat.push({ i, k, w: u.w, brk: u.brk, prose: s.prose })));
    const total = flat.reduce((a, u) => a + u.w, 0) || 1;
    const by = secs.length > 1 ? o.by : "even";
    const perWeek = [...Array(7).keys()].filter((k) => o.d & (1 << k)).length || 7;
    let D;
    if (o.e) D = planDays(o, 0, o.e).length;
    else if (o.p && o.p.u === "l") D = Math.ceil(total / o.p.n);
    else D = Math.round(secs.length / (o.p ? o.p.n : 3) * perWeek);
    // D reading days; at most PLAN_MAX portions over them, so a slow pace keeps its dates.
    D = Math.min(PLAN_DAYS_MAX, Math.max(1, D));
    // Where each portion ends: an index into flat (inclusive).
    const ends = [];
    if (by === "book") {
      const N = Math.min(D, PLAN_MAX, secs.length);
      const bookEnd = [];                         // cumulative weight at the end of each book
      let acc = 0, g = -1;
      secs.forEach((s) => { s.units.forEach((u) => { acc += u.w; g++; }); bookEnd.push({ acc, g }); });
      let prev = -1;
      for (let k = 1; k < N; k++) {
        const T = total * k / N;
        let best = -1;
        for (let c = prev + 1; c <= secs.length - 1 - (N - k); c++) {
          if (best < 0 || Math.abs(bookEnd[c].acc - T) < Math.abs(bookEnd[best].acc - T)) best = c;
        }
        ends.push(bookEnd[best].g);
        prev = best;
      }
    } else {
      const N = Math.min(D, PLAN_MAX, flat.length);
      const cum = [];
      flat.reduce((a, u, g) => (cum[g] = a + u.w), 0);
      const win = Math.max(5, total / N * 0.25);
      let prev = -1;
      for (let k = 1; k < N; k++) {
        const T = total * k / N, last = flat.length - 1 - (N - k);
        let near = prev + 1;
        while (near < last && cum[near] < T) near++;
        const pick = (ok, w) => {
          let best = -1, bd = Infinity;
          for (let g = prev + 1; g <= last; g++) {
            if (cum[g] - T > 2 * w) break;        // past the window, even for a book's end
            const dist = Math.abs(cum[g] - T) * (flat[g].brk === 3 ? 0.5 : 1);
            if (dist <= w && ok(flat[g]) && dist < bd) { best = g; bd = dist; }
          }
          return best;
        };
        let g = pick((u) => u.brk >= 2, win);
        for (const b of [1, 0.5, 0.25]) if (g < 0) g = pick((u) => u.brk >= b, 5);
        if (g < 0) g = Math.max(prev + 1, Math.min(last, near));
        ends.push(g);
        prev = g;
      }
    }
    ends.push(flat.length - 1);
    // The portions, and the day each falls on: as far into the reading days as it starts in the work.
    const days = planDays(o, D);
    let start = 0, acc = 0, lastX = -1;
    const portions = ends.map((g, k) => {
      const part = flat.slice(start, g + 1);
      const f0 = acc / total;
      acc += part.reduce((a, u) => a + u.w, 0);
      let x = Math.max(lastX + 1, Math.floor(f0 * D));
      x = Math.min(x, days.length - (ends.length - k));
      lastX = x;
      const first = flat[start], end = flat[g];
      const p = {
        d: days[Math.max(0, x)] || o.s, i: first.i, a: first.k + 1, j: end.i, b: end.k + 1,
        n: part.filter((u) => !u.prose).length, q: part.filter((u) => u.prose).length,
        m: Math.round(part.reduce((a, u) => a + u.w, 0) / 25 * 10) / 10,
        f0: Math.round(f0 * 10000) / 10000, f1: Math.round(acc / total * 10000) / 10000,
        ef: Math.round((end.k + 1) / secs[end.i].units.length * 1000) / 1000,
      };
      p.lab = planLabel(secs, p);
      start = g + 1;
      return p;
    });
    return { portions, sig: secs.length + ":" + flat.length };
  }
  // "Book IV", "Books IV to VI" (as the titles go), "Book IV, lines 1–380",
  // "Book IV, line 400, to Book V, line 120"; "Lines 1–380" in a work of one part.
  function planLabel(secs, p) {
    const one = secs.length === 1;
    const unit = (s, n) => (s.prose ? "paragraph" : "line") + (n ? "s" : "");
    const whole = (i) => secs[i].title;
    const startsBook = p.a === 1, endsBook = p.b === secs[p.j].units.length;
    if (startsBook && endsBook && !one) return p.i === p.j ? whole(p.i) : `${whole(p.i)} to ${whole(p.j)}`;
    if (p.i === p.j) {
      const what = `${unit(secs[p.i], true)} ${p.a}–${p.b}`;
      return one ? what.charAt(0).toUpperCase() + what.slice(1) : `${whole(p.i)}, ${what}`;
    }
    return `${whole(p.i)}, ${unit(secs[p.i])} ${p.a}, to ${whole(p.j)}, ${unit(secs[p.j])} ${p.b}`;
  }
  const planSize = (p) => [p.n ? `${num(p.n)} line${p.n === 1 ? "" : "s"}` : "", p.q ? `${num(p.q)} paragraph${p.q === 1 ? "" : "s"}` : ""]
    .filter(Boolean).join(", ");
  const planHref = (slug, p) => `#/work/${slug}/${p.i}${p.a > 1 ? "?l=" + p.a : ""}`;

  // The plans followed, from pc-reading: {slug: record}; a dropped one is {gone, at} so that
  // the drop reaches the reader's other devices.
  function readingPlans() { return objOr(readStore(READING_KEY).plans); }
  function planOf(slug) {
    const r = readingPlans()[slug];
    return r && !r.gone && typeof r.link === "string" && Array.isArray(r.snap) && r.snap.length ? r : null;
  }
  function savePlan(slug, rec) {
    const plans = readingPlans();
    plans[slug] = Object.assign({}, rec, { at: new Date().toISOString() });
    writeReading({ plans });
  }
  function dropPlan(slug) {
    const plans = readingPlans();
    plans[slug] = { gone: true, at: new Date().toISOString() };
    writeReading({ plans });
  }
  // Ticks portion k (or unticks it); the last tick finishes the plan.
  function setPlanDone(slug, k, on) {
    const rec = planOf(slug);
    if (!rec || !rec.snap[k]) return;
    const done = new Set(Array.isArray(rec.done) ? rec.done : []);
    if (on) done.add(k); else done.delete(k);
    rec.done = [...done].sort((a, b) => a - b);
    if (rec.done.length >= rec.snap.length) rec.finished = rec.finished || dayKey(new Date());
    else delete rec.finished;
    savePlan(slug, rec);
  }
  // Called whenever the place in a work is kept (setReading): every portion that ends in this
  // book at or before the place is done.
  function planReached(slug, i, frac) {
    const rec = planOf(slug);
    if (!rec || rec.finished) return;
    const done = new Set(Array.isArray(rec.done) ? rec.done : []);
    let more = false;
    rec.snap.forEach((p, k) => {
      if (!done.has(k) && p.j === i && (frac || 0) >= Math.min(0.95, p.ef)) { done.add(k); more = true; }
    });
    if (!more) return;
    rec.done = [...done].sort((a, b) => a - b);
    if (rec.done.length >= rec.snap.length) rec.finished = dayKey(new Date());
    savePlan(slug, rec);
  }
  // Where the reader stands: the next portion not done, and how many earlier days' portions are open.
  function planState(rec) {
    const today = dayKey(new Date()), done = new Set(rec.done || []);
    const open = rec.snap.map((p, k) => ({ p, k })).filter((x) => !done.has(x.k));
    return { today, open, cur: open[0] || null, behind: open.filter((x) => x.p.d < today).length };
  }
  // "Spread the rest over the remaining days": the open portions over the reading days from
  // today to the plan's last day, or, when there are fewer days than portions, one a reading
  // day from today (the end moves later).
  function spreadPlan(slug) {
    const rec = planOf(slug);
    if (!rec) return;
    const o = planParams("?" + rec.link), st = planState(rec);
    if (!st.open.length) return;
    const lastDay = rec.snap[rec.snap.length - 1].d;
    const from = Object.assign({}, o, { s: st.today });
    let days = lastDay >= st.today ? planDays(from, 0, lastDay) : [];
    const R = st.open.length;
    if (days.length < R) days = planDays(from, R);
    st.open.forEach((x, n) => { rec.snap[x.k] = Object.assign({}, x.p, { d: days[Math.floor(n * days.length / R)] }); });
    rec.spread = st.today;
    savePlan(slug, rec);
  }
  // The card on the home page and on the work's contents page: today's portion (or the next),
  // with Read and Done. withTitle: name the work (home page).
  function planCardHTML(slug, rec, withTitle) {
    const st = planState(rec);
    if (!st.cur) return "";
    const p = st.cur.p, when = p.d <= st.today ? "Today" : "Next · " + dueLabel(p.d).replace(/ \d{4}$/, "");
    return `
        <div class="plan-card" data-plan="${esc(slug)}">
          <p class="plan-card-head"><span class="continue-label">${esc(when)}</span>${withTitle ? ` <span class="plan-card-work">${esc(rec.title || "")}</span>` : ""}</p>
          <p class="plan-card-what">${esc(p.lab)} <span class="plan-card-time">· ${esc(planMin(p.m))}</span></p>
          ${st.behind ? `<p class="plan-card-behind">${esc((NUM_WORDS[st.behind] || num(st.behind)) + (st.behind === 1 ? " portion" : " portions"))} to catch up.
            <button class="continue-forget plan-spread" type="button" data-plan="${esc(slug)}">Spread the rest over the remaining days</button></p>` : ""}
          <div class="plan-card-acts">
            <a class="shelf-dl plan-read" href="${esc(planHref(slug, p))}">Read</a>
            <button class="shelf-dl plan-done" type="button" data-plan="${esc(slug)}" data-k="${st.cur.k}" aria-label="Done: ${esc(p.lab)}">Done</button>
            <a class="shelf-view" href="#/plan?${esc(rec.link)}">The whole plan <span aria-hidden="true">→</span></a>
          </div>
        </div>`;
  }
  // The home page: the plans being followed (at most two, the soonest first). Nothing otherwise.
  function homePlanHTML() {
    const list = Object.keys(readingPlans()).map((slug) => [slug, planOf(slug)])
      .filter(([, r]) => r && !r.finished && planState(r).cur)
      .sort((a, b) => planState(a[1]).cur.p.d.localeCompare(planState(b[1]).cur.p.d)).slice(0, 2);
    if (!list.length) return "";
    return `<section class="plan-today home-plans" data-where="home" aria-label="Your reading plans">${list.map(([slug, r]) => planCardHTML(slug, r, true)).join("")}</section>`;
  }
  // The work's contents page: today's card, or a quiet line for a finished plan.
  function workPlanHTML(slug) {
    const rec = planOf(slug);
    if (!rec) return "";
    if (rec.finished) return `<p class="plan-finished">Reading plan finished on ${esc(dueLabel(rec.finished))}. <a href="#/plan?${esc(rec.link)}">See the plan</a></p>`;
    return `<section class="plan-today" data-where="work:${esc(slug)}" aria-label="Your reading plan">${planCardHTML(slug, rec, false)}</section>`;
  }
  // Done and Spread on a card, wherever it is: the card is drawn again in place.
  app.addEventListener("click", (e) => {
    const b = e.target.closest(".plan-done, .plan-spread");
    const box = b && b.closest(".plan-today");
    if (!box) return;
    const slug = b.dataset.plan;
    if (b.classList.contains("plan-done")) { setPlanDone(slug, +b.dataset.k, true); announce("Marked as done."); }
    else { spreadPlan(slug); announce("The rest of the plan is spread over the remaining days."); }
    // On the plan page the table is drawn again too (its ticks and dates).
    if (box.closest(".plan-page") && PLAN_REDRAW) { PLAN_FOCUS = ".plan-today .plan-read, .plan-finished"; PLAN_REDRAW(); return; }
    const where = box.dataset.where;
    const html = where === "home" ? homePlanHTML() : workPlanHTML(where.slice(5));
    if (!html) { box.remove(); return; }
    box.outerHTML = html;
    const next = app.querySelector(`.plan-card[data-plan="${CSS.escape(slug)}"] .plan-read`) || app.querySelector(".plan-today .plan-read, .plan-finished a");
    if (next) next.focus();
  });
  // The shelf's list of plans, followed and finished ("history").
  function shelfPlansHTML() {
    const list = Object.keys(readingPlans()).map((slug) => [slug, planOf(slug)]).filter(([, r]) => r);
    if (!list.length) return "";
    list.sort((a, b) => (!!a[1].finished - !!b[1].finished) || String(b[1].at).localeCompare(String(a[1].at)));
    return `
        <section class="shelf-group">
          <h2>Reading plans · ${list.length}</h2>
          <ul class="shelf-list">${list.map(([slug, r]) => {
            const st = planState(r);
            const what = r.finished ? `Finished on ${dueLabel(r.finished)}`
              : st.cur ? `${st.cur.p.d <= st.today ? "Today" : "Next, " + dueLabel(st.cur.p.d)}: ${st.cur.p.lab}` : "";
            return `
            <li class="shelf-item"><a class="shelf-link" href="#/plan?${esc(r.link)}">
              <span class="shelf-title">${esc(r.title || slug)}</span>
              <span class="shelf-by">${esc([r.author, what].filter(Boolean).join(" · "))}</span></a>
              <button class="shelf-remove plan-drop" type="button" data-plan="${esc(slug)}" aria-label="${r.finished ? "Remove from the list" : "Stop following"}: ${esc(r.title || slug)}">${r.finished ? "Remove" : "Stop"}</button></li>`;
          }).join("")}</ul>
        </section>`;
  }
  const planCount = () => Object.keys(readingPlans()).filter((slug) => planOf(slug)).length;

  // A calendar file: one all-day event a portion, each with its link. Made in the browser.
  function planICS(slug, title, portions) {
    const escT = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const enc = new TextEncoder();
    const fold = (line) => {                       // lines of at most 75 bytes
      const out = [];
      let cur = "";
      for (const ch of line) {
        if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ""; }
        cur += ch;
      }
      out.push(cur);
      return out.join("\r\n ");
    };
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const ymd = (d) => d.replace(/-/g, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Poetry Codex//Reading plan//EN", "CALSCALE:GREGORIAN",
                   "X-WR-CALNAME:" + escT("Reading plan: " + title)];
    portions.forEach((p, k) => {
      const url = SITE + "/" + planHref(slug, p);
      lines.push("BEGIN:VEVENT", `UID:plan-${slug}-${ymd(portions[0].d)}-${k + 1}@poetrycodex.com`, "DTSTAMP:" + stamp,
        "DTSTART;VALUE=DATE:" + ymd(p.d), "DTEND;VALUE=DATE:" + ymd(addDays(p.d, 1)),
        "SUMMARY:" + escT(`${title}: ${p.lab}`),
        "DESCRIPTION:" + escT(`${planSize(p)}, ${planMin(p.m)}.\n${url}`), "URL:" + url,
        "TRANSP:TRANSPARENT", "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  // The page: the plan's settings (open when the link has no start yet), the table, Follow,
  // the calendar file and the ways to share it. Changing a setting redraws the table and puts
  // the new plan in the address without a new history entry.
  let PLAN_FOCUS = "", PLAN_REDRAW = null;
  function renderPlan() {
    const o = planParams(location.hash), w = WORKS[o.w];
    if (!w) {
      setTitle("Reading plan");
      app.innerHTML = `<p class="empty">This reading plan’s work could not be found. <a href="#/eras">Browse the archive →</a></p>`;
      return;
    }
    const making = !o.s;
    if (!o.s) o.s = dayKey(new Date());
    if (!o.p && !o.e) o.p = w.sections.length > 1 ? { n: 3, u: "b" } : { n: 150, u: "l" };
    if (w.sections.length === 1) { o.by = "even"; if (o.p && o.p.u === "b") o.p = { n: 150, u: "l" }; }
    setTitle("Reading plan: " + w.title);
    const here = location.hash;
    if (EARLY_DRAWN !== here) renderLoading();
    fetchWorkFile(o.w).then((work) => {
      if (location.hash !== here) return;
      drawPlan(w, work, o, making);
    }).catch((e) => { if (location.hash === here) renderFetchError(e); });
  }
  function drawPlan(w, work, o, making) {
    const slug = w.slug, one = work.sections.length === 1;
    const siblings = worksList().filter((x) => x.authorSlug === w.authorSlug);
    const name = w.title + (otherTranslations(w).length ? ` (${verShort(w)})` : "");
    const pace = o.p || { n: one ? 150 : 3, u: one ? "l" : "b" };
    app.innerHTML = `
      <article class="detail plan-page">
        <button class="back" id="back">← ${esc(w.title)} · Contents</button>
        <p class="detail-subject">A reading plan</p>
        <h1 class="detail-title">${esc(w.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(w.authorSlug)}">${esc(w.author)}</a></p>
        ${sourceLine(w.translator)}
        <div class="plan-status"></div>
        <details class="plan-make no-print"${making ? " open" : ""}>
          <summary>${making ? "Make a reading plan" : "Change this plan"}</summary>
          <form class="plan-form" novalidate>
            ${siblings.length > 1 ? `<p class="plan-field"><label class="col-form-label" for="plan-w">Work</label>
              <select class="shelf-pick" id="plan-w">${siblings.map((x) => `<option value="${esc(x.slug)}"${x.slug === slug ? " selected" : ""}>${esc(x.title + (x.translator ? " · " + translatorShort(trName(x.translator)) : ""))}</option>`).join("")}</select></p>` : ""}
            <p class="plan-field"><label class="col-form-label" for="plan-s">Start</label>
              <input class="col-form-input plan-date" id="plan-s" type="date" value="${esc(o.s)}" required></p>
            <fieldset class="plan-set">
              <legend class="col-form-label">How fast</legend>
              <p class="plan-opt"><input type="radio" name="plan-how" id="plan-how-e" value="e"${o.e ? " checked" : ""}>
                <label for="plan-how-e">Finish by</label>
                <input class="col-form-input plan-date" id="plan-e" type="date" aria-label="Finish date" value="${esc(o.e || addDays(o.s, 55))}"></p>
              <p class="plan-opt"><input type="radio" name="plan-how" id="plan-how-p" value="p"${o.e ? "" : " checked"}>
                <label for="plan-how-p">At a pace of</label>
                <input class="col-form-input plan-num" id="plan-n" type="number" min="${pace.u === "b" ? "0.25" : "5"}" step="${pace.u === "b" ? "0.5" : "10"}" value="${pace.n}" aria-label="How many">
                <select class="shelf-pick plan-unit" id="plan-u" aria-label="Books a week or lines a day">
                  ${one ? "" : `<option value="b"${pace.u === "b" ? " selected" : ""}>books a week</option>`}
                  <option value="l"${pace.u === "l" ? " selected" : ""}>lines a day (about)</option>
                </select></p>
            </fieldset>
            <fieldset class="plan-set">
              <legend class="col-form-label">Reading days</legend>
              <p class="plan-days">${PLAN_DAY_NAMES.map((n, k) => `<label class="plan-day"><input type="checkbox" value="${1 << k}"${o.d & (1 << k) ? " checked" : ""}> ${n}</label>`).join("")}</p>
            </fieldset>
            <fieldset class="plan-set"${one ? " hidden" : ""}>
              <legend class="col-form-label">Split by</legend>
              <p class="plan-opt"><input type="radio" name="plan-by" id="plan-by-b" value="book"${o.by === "book" ? " checked" : ""}> <label for="plan-by-b">Books (whole books in each portion)</label></p>
              <p class="plan-opt"><input type="radio" name="plan-by" id="plan-by-e" value="even"${o.by === "even" ? " checked" : ""}> <label for="plan-by-e">Even portions (cut at a stanza or paragraph break)</label></p>
            </fieldset>
          </form>
        </details>
        <div class="plan-out"></div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/work/" + slug; });
    const form = app.querySelector(".plan-form");
    const read = () => {
      const val = (id) => document.getElementById(id).value;
      const how = form.querySelector('input[name="plan-how"]:checked').value;
      let d = 0;
      form.querySelectorAll(".plan-day input:checked").forEach((c) => { d += +c.value; });
      const unit = val("plan-u"), n = parseFloat(val("plan-n"));
      return { w: slug, s: dueDay(val("plan-s")) || o.s, e: how === "e" ? dueDay(val("plan-e")) : "",
               p: how === "p" && n > 0 ? { n, u: unit } : (how === "p" ? pace : null), d: d || 127,
               by: one ? "even" : (form.querySelector('input[name="plan-by"]:checked') || {}).value || "book" };
    };
    const update = () => {
      const q = planParams("?" + planQuery(read()));
      if (!q.p && !q.e) q.p = pace;
      history.replaceState(history.state, "", "#/plan?" + planQuery(q));
      EARLY_DRAWN = DATA ? "" : location.hash;
      drawPlanOut(w, work, q, name);
    };
    form.addEventListener("input", (e) => {
      if (e.target.id === "plan-w") return;
      if (e.target.id === "plan-e") form.querySelector("#plan-how-e").checked = true;
      if (e.target.id === "plan-n" || e.target.id === "plan-u") form.querySelector("#plan-how-p").checked = true;
      if (e.target.id === "plan-u") {           // a sensible number for the other unit
        const box = document.getElementById("plan-n");
        box.value = e.target.value === "b" ? 3 : 150;
        box.min = e.target.value === "b" ? "0.25" : "5"; box.step = e.target.value === "b" ? "0.5" : "10";
      }
      update();
    });
    form.addEventListener("submit", (e) => e.preventDefault());
    const pick = document.getElementById("plan-w");
    if (pick) pick.addEventListener("change", () => {
      location.replace("#/plan?w=" + encodeURIComponent(pick.value));   // a new plan, made from the defaults
    });
    // The address always holds the whole plan, so the link to copy is the one shown.
    const q0 = Object.assign({}, o, { p: o.e ? null : (o.p || pace) });
    history.replaceState(history.state, "", "#/plan?" + planQuery(q0));
    EARLY_DRAWN = DATA ? "" : location.hash;   // drawn without the index, which it does not need
    drawPlanOut(w, work, q0, name);
  }
  function drawPlanOut(w, work, o, name) {
    const slug = w.slug, link = planQuery(o);
    const made = planPortions(work, o);
    let rec = planOf(slug);
    const mine = rec && rec.link === link;
    // The work's parts have changed since the plan was followed: the portions are drawn
    // again and what was done is carried over by where it stands in the work.
    if (mine && rec.sig !== made.sig) {
      const was = rec.snap.filter((p, k) => (rec.done || []).includes(k));
      rec.snap = made.portions;
      rec.sig = made.sig;
      rec.done = made.portions.map((p, k) => [p, k]).filter(([p]) => was.some((x) => (p.f0 + p.f1) / 2 >= x.f0 && (p.f0 + p.f1) / 2 <= x.f1)).map(([, k]) => k);
      savePlan(slug, rec);
      rec = planOf(slug);
    }
    const portions = mine ? rec.snap : made.portions;
    const done = new Set(mine ? rec.done || [] : []);
    const first = portions[0].d, last = portions[portions.length - 1].d;
    const total = portions.reduce((a, p) => a + p.m, 0);
    const url = SITE + "/#/plan?" + link;
    const status = app.querySelector(".plan-status");
    status.innerHTML = mine ? (rec.finished
      ? `<p class="plan-finished" tabindex="-1">Finished on ${esc(dueLabel(rec.finished))}.</p>`
      : `<p class="plan-following">You are following this plan, since ${esc(dueLabel(rec.started))}.${rec.spread ? ` The rest was spread out on ${esc(dueLabel(rec.spread))}.` : ""}</p>
         <section class="plan-today" data-where="work:${esc(slug)}" aria-label="Your reading plan">${planCardHTML(slug, rec, false)}</section>`)
      : rec ? `<p class="plan-following">You follow a different plan for this work. <a href="#/plan?${esc(rec.link)}">Open it</a></p>` : "";
    const out = app.querySelector(".plan-out");
    out.innerHTML = `
        ${o.e && o.e < o.s ? `<p class="plan-note">The finish date is before the start, so the plan has one day.</p>` : ""}
        <p class="plan-sum">${num(portions.length)} reading${portions.length === 1 ? "" : "s"}, ${esc(dueLabel(first))} to ${esc(dueLabel(last))} · ${esc(planMin(total))} in all.</p>
        <div class="plan-acts cite-row no-print">
          ${mine ? `<button class="shelf-dl plan-stop" type="button">Stop following</button>`
            : `<button class="shelf-dl plan-follow" type="button">${rec ? "Follow this plan instead" : "Follow this plan"}</button>`}
          <button class="shelf-dl plan-ics" type="button">Add to calendar (.ics)</button>
          <button class="shelf-dl plan-print" type="button">Print</button>
        </div>
        <div class="table-wrap plan-wrap">
        <table class="plan-table">
          <caption>Reading plan: ${esc(name)}, ${esc(dueLabel(first))} to ${esc(dueLabel(last))}</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Reading</th><th scope="col">Length</th><th scope="col">Time</th>${mine ? `<th scope="col">Done</th>` : ""}</tr></thead>
          <tbody>${portions.map((p, k) => `
            <tr${done.has(k) ? ' class="is-done"' : ""}>
              <td class="plan-d">${esc(dueLabel(p.d).replace(/ \d{4}$/, ""))}</td>
              <th scope="row" class="plan-p"><a href="${esc(planHref(slug, p))}">${esc(p.lab)}</a></th>
              <td class="plan-n">${esc(planSize(p))}</td>
              <td class="plan-m">${esc(planMin(p.m).replace(/^about /, ""))}</td>
              ${mine ? `<td class="plan-c"><input type="checkbox" class="plan-tick" data-k="${k}" aria-label="Done: ${esc(p.lab)}"${done.has(k) ? " checked" : ""}></td>` : ""}
            </tr>`).join("")}
          </tbody>
        </table>
        </div>
        <section class="assign-panel plan-share no-print" aria-labelledby="plan-share-head">
          <h2 class="assign-head" id="plan-share-head">Share this plan</h2>
          <p class="assign-how">The plan travels in the link itself: the same link gives everyone the same dates and portions.
            Nothing about the reader is stored or sent.</p>
          <div class="cite-row assign-share">
            <button class="shelf-dl plan-copy" type="button">Copy link</button>
            <a class="shelf-dl" href="https://classroom.google.com/share?url=${esc(encodeURIComponent(url))}&amp;title=${esc(encodeURIComponent("Reading plan: " + name))}" target="_blank" rel="noopener noreferrer">Post to Google Classroom</a>
            <button class="shelf-dl plan-lms" type="button">Copy for Moodle, Canvas or Blackboard</button>
            <a class="shelf-dl" href="mailto:?subject=${esc(encodeURIComponent("Reading plan: " + name))}&amp;body=${esc(encodeURIComponent(url))}">Email</a>
          </div>
        </section>
        <p class="print-only col-url">Online: ${esc(url)}</p>`;
    PLAN_REDRAW = () => drawPlanOut(w, work, o, name);
    const again = (focus) => { PLAN_FOCUS = focus; PLAN_REDRAW(); };
    const btn = (sel, fn) => { const b = out.querySelector(sel); if (b) b.addEventListener("click", fn); };
    btn(".plan-follow", () => {
      savePlan(slug, { link, started: dayKey(new Date()), done: [], snap: made.portions, sig: made.sig, title: name, author: w.author });
      announce("You are following this plan. Today’s reading is shown on the home page and on the work’s contents.");
      again(".plan-stop");
    });
    btn(".plan-stop", () => { dropPlan(slug); announce("You no longer follow this plan."); again(".plan-follow"); });
    btn(".plan-ics", () => downloadFile(`reading-plan-${slug}.ics`, "text/calendar", planICS(slug, name, portions)));
    btn(".plan-print", () => window.print());
    btn(".plan-copy", (e) => {
      const b = e.currentTarget;
      copyText(url).then(() => { flash(b, "Copied"); announce("Link copied."); }, () => copyBox(url, true));
    });
    btn(".plan-lms", (e) => {
      const b = e.currentTarget, html = `<a href="${esc(url)}">${esc("Reading plan: " + name)}</a>`;
      copyText(url, html).then(() => { flash(b, "Copied"); announce("Link copied for your course page."); }, () => copyBox(html, true));
    });
    out.querySelectorAll(".plan-tick").forEach((c) => c.addEventListener("change", () => {
      setPlanDone(slug, +c.dataset.k, c.checked);
      announce(c.checked ? "Marked as done." : "Marked as not done.");
      again(`.plan-tick[data-k="${c.dataset.k}"]`);
    }));
    if (PLAN_FOCUS) { const f = app.querySelector(PLAN_FOCUS); PLAN_FOCUS = ""; if (f) f.focus(); }
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
  // Tags (#words in the notes, noteParts) make a row of toggles under the colours, most used
  // first, and combine: every tag chosen must be on the item. Marks whose words can no longer
  // be found in their text are gathered at the end under "Notes whose lines have moved".
  // "Export my questions" downloads every question (the "?" mark) as a Word-ready file in one
  // click, each with its lines, the link to them, the reader's words and its citation.
  const HL_NAMES_KEY = "pc-hl-names";
  const HL_SUGGEST = { yellow: "Question", green: "Image", blue: "Sound", pink: "Theme" };
  function hlMeanings() {
    const n = readStore(HL_NAMES_KEY);
    return Object.fromEntries(HL_COLORS.map((c) => [c, typeof n[c] === "string" ? n[c].trim().slice(0, 40) : ""]));
  }
  const NB_KINDS = HL_KINDS.concat(["line", "note"]);
  const nbKindName = (k, names) => k === "line" ? "Line note" : k === "note" ? "Note on the whole text" : k === "q" ? "Question"
    : HL_NAMES[k] + (names[k] ? " · " + names[k] : "");
  const NB = { q: "", kinds: [], tags: [], notesOnly: false, sort: "text", text: "" };   // the filters, kept for the visit
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
        kind: hl ? (hlColor(m.color)) : "line",
        quote: String(m.quote || ""), note: String(m.text || ""), tags: noteTags(m.text), when: m.created || m.updated || "" });
    }));
    Object.values(allNotes()).forEach((n) => {
      if (!n || typeof n.id !== "string" || typeof n.text !== "string" || !n.text.trim()) return;
      items.push({ key: n.id + "|note", tid: n.id, g: n, m: n, type: "note", kind: "note",
        quote: "", note: n.text, tags: noteTags(n.text), when: n.created || n.updated || "" });
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
      && NB.tags.every((t) => it.tags.includes(t))
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
        ${it.note.trim() ? `<p class="nb-note">${noteHTML(it.note)}</p>` : ""}
        <p class="nb-cite">${nbCite(it).html}</p>
        <p class="nb-go"><a href="${esc(nbHref(it))}">${it.range ? "Go to " + esc(it.loc) : "Go to the text"}<span class="visually-hidden"> in ${esc(w.subTitle)}</span> <span aria-hidden="true">→</span></a></p>
      </li>`;
  }
  // The filters in words, for the count and the head of a download ("Yellow, Line notes · …").
  function nbFilterWords(names) {
    const parts = [];
    if (NB.kinds.length) parts.push(NB.kinds.map((k) => k === "line" ? "line notes" : k === "note" ? "notes on whole texts" : k === "q" ? "questions" : nbKindName(k, names)).join(", "));
    if (NB.tags.length) parts.push("tagged " + NB.tags.map((t) => "#" + t).join(" and "));
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
                <button type="button" data-dl="qmd" class="nb-dl-q">My questions only (Markdown)</button>
              </div>
            </details>
            <button type="button" class="nb-qx" hidden>Export my questions</button>
          </div>
          <div class="nb-filters" id="nb-filters">
            <div class="nb-chips" role="group" aria-label="Show only">
              ${NB_KINDS.map((k) => `<button type="button" class="chip nb-chip" data-k="${k}" aria-pressed="${NB.kinds.includes(k)}">${
                k === "line" ? `<span class="nb-dot" aria-hidden="true"></span>Line notes` : k === "note" ? "Notes on whole texts"
                : k === "q" ? `<span class="hl-chip hl-q" aria-hidden="true"></span>Questions`
                : `<span class="hl-chip hl-${k}" aria-hidden="true"></span><span class="nb-chip-t">${esc(nbKindName(k, names))}</span>`}</button>`).join("")}
              <button type="button" class="nb-name">Name colours</button>
            </div>
            <div class="nb-tags" role="group" aria-label="Tags" hidden></div>
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
        else if (how === "qmd") downloadFile(`poetry-codex-questions-${day}.md`, "text/markdown", nbMarkdown(nbQuestions(), NB_QS));
        else if (how === "md") downloadFile(`poetry-codex-notes-${day}.md`, "text/markdown", nbMarkdown(list));
        else downloadFile(`poetry-codex-notes-${day}.html`, "text/html", nbWordHTML(list));
      });
    }));
    // "Export my questions": every question, whatever the filters, as a Word-ready file.
    app.querySelector(".nb-qx").addEventListener("click", () => NB_READY.then(() => {
      downloadFile(`poetry-codex-questions-${isoDay(new Date())}.html`, "text/html", nbWordHTML(nbQuestions(), NB_QS));
      announce("Your questions are downloaded.");
    }));
    nbStickyTop();
    nbLoad();
  }
  const nbQuestions = () => NB_ITEMS.filter((it) => it.kind === "q");
  const NB_QS = { title: "My questions", intro: "Each question with its lines, the link to them, your words and the citation" };
  // The tags of every note, as toggles (drawn when the marks are read, so a click keeps its place).
  function nbTagsDraw() {
    const box = app.querySelector(".nb-tags");
    if (!box) return;
    const tags = tagCounts(NB_ITEMS.map((it) => it.note));
    NB.tags = NB.tags.filter((t) => tags.some((x) => x.tag === t));
    box.hidden = !tags.length;
    box.innerHTML = tags.length ? `<span class="nb-tags-l" aria-hidden="true">Tags</span>` + tags.map((t) =>
      `<button type="button" class="chip nb-chip nb-tag" data-t="${esc(t.tag)}" aria-pressed="${NB.tags.includes(t.tag)}">${esc(t.label)} <span class="om-n">${num(t.n)}</span></button>`).join("") : "";
    box.querySelectorAll(".nb-tag").forEach((b) => b.addEventListener("click", () => {
      const t = b.dataset.t, on = !NB.tags.includes(t);
      NB.tags = on ? NB.tags.concat(t) : NB.tags.filter((x) => x !== t);
      b.setAttribute("aria-pressed", String(on));
      nbDraw();
    }));
  }
  // The marks again (on opening the page, and when the account's copy comes in), then each
  // text, after which the list is drawn again with lines and citations.
  function nbLoad() {
    NB_ITEMS = nbItems();
    NB_ITEMS.forEach((it) => { nbPlace(it, null); it.where = nbWhere(it); });
    nbTagsDraw();
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
    const active = NB.kinds.length + NB.tags.length + (NB.notesOnly ? 1 : 0) + (NB.text ? 1 : 0);
    app.querySelector(".nb-qx").hidden = !nbQuestions().length;
    app.querySelector(".nb-dl-q").hidden = !nbQuestions().length;
    app.querySelector(".nb-more").textContent = active ? `Filters (${active})` : "Filters";
    if (!n) {
      out.innerHTML = `<p class="nb-none">Nothing matches these filters. <button type="button" class="nb-clear">Show everything</button></p>`;
      out.querySelector(".nb-clear").addEventListener("click", () => {
        Object.assign(NB, { q: "", kinds: [], tags: [], notesOnly: false, text: "" });
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
    // Marks whose words are no longer in their text: kept, together, at the end.
    const moved = list.filter((it) => it.changed);
    out.innerHTML = nbGroups(list.filter((it) => !it.changed)).map((t) => `
      <section class="nb-group">
        <h2 class="nb-top">${esc(t.title)}${t.by ? ` <span class="nb-top-by">${esc(t.by)}</span>` : ""}</h2>
        ${t.subs.map((s) => `
          ${s.title && s.title !== t.title ? `<h3 class="nb-sub"><a href="${esc(routeFor(s.tid))}">${esc(s.title)}</a></h3>` : ""}
          <ul class="nb-list">${s.items.map((it) => nbItemHTML(it, names, false)).join("")}</ul>`).join("")}
      </section>`).join("") + (moved.length ? `
      <section class="nb-group nb-moved">
        <h2 class="nb-top">Notes whose lines have moved</h2>
        <p class="nb-moved-d">These texts have been corrected or set again since you marked them, and the words you marked
        could not be found in them. Each is kept here with the words as you marked them.</p>
        <ul class="nb-list">${moved.map((it) => nbItemHTML(it, names, true)).join("")}</ul>
      </section>` : "");
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
  const nbKindLabel = (it, names) => it.kind === "q" ? "Question"
    : it.type === "hl" ? `Highlight, ${it.kind}${names[it.kind] ? ` (${names[it.kind]})` : ""}` : nbLabel(it, names);
  // ---------- exports that link back ----------
  // The Markdown downloads (My notes, the shelf) open cleanly in Obsidian or any notes app:
  // YAML front matter (title, author, translator, url, exported), headings in plain words
  // (no backslash escapes, and none of # | ^ [ ] that break an Obsidian [[note#heading]]
  // link), and under each quoted passage the address of its lines. In the Word file each
  // quotation is itself a link to its lines.
  // f: {title, author, translator, url, exported}; a list gives a YAML list, empty drops out.
  function frontMatter(f) {
    const y = (v) => JSON.stringify(String(v));   // a JSON string is a valid YAML scalar
    return "---\n" + Object.entries(f).map(([k, v]) => {
      const vs = (Array.isArray(v) ? v : [v]).filter(Boolean);
      return !vs.length ? "" : !Array.isArray(v) ? `${k}: ${y(vs[0])}\n`
        : `${k}:\n` + vs.map((x) => `  - ${y(x)}\n`).join("");
    }).join("") + "---\n\n";
  }
  const mdHead = (s) => String(s || "").replace(/[#^|[\]\\*_`<>]/g, "").replace(/\s+/g, " ").trim();
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  // A mark's lines (?l=), or the text's own address when they cannot be found in it now.
  const markURL = (it) => it.range ? SITE + "/" + nbHref(it) : SITE + shelfPath(it.tid);
  // A file Word and Google Docs open as a document: a heading for each text, the quotation
  // indented with its line breaks (a link to its lines), the note, then the citation.
  // o: {title, intro} for a preset ("Export my questions"); else the page's filters say what it holds.
  function nbWordHTML(list, o) {
    const names = hlMeanings(), filt = o ? "" : nbFilterWords(names), title = o ? o.title : "My notes and highlights";
    const lineHTML = (l) => esc(l).replace(/^ +/, (s) => " ".repeat(s.length));
    const body = nbGroups(list).map((t) => `<h2>${esc(t.title)}${t.by ? ` <span class="by">— ${esc(t.by)}</span>` : ""}</h2>\n`
      + t.subs.map((s) => (s.title && s.title !== t.title ? `<h3>${esc(s.title)}</h3>\n` : "") + s.items.map((it) => {
        const c = nbCite(it);
        return `<p class="meta">${esc(nbKindLabel(it, names))}${it.loc ? " · " + esc(it.loc) : ""}</p>\n`
          + (it.type === "note" ? "" : `<blockquote>${nbStanzas(it).map((st) => `<p><a href="${esc(markURL(it))}">${st.map(lineHTML).join("<br>")}</a></p>`).join("")}</blockquote>\n`)
          + (it.changed ? `<p class="meta">The text has changed since this was marked: these are the words as marked.</p>\n` : "")
          + (it.note.trim() ? `<p class="note">${esc(it.note.trim()).replace(/\n/g, "<br>")}</p>\n` : "")
          + `<p class="cite">${c.html}</p>\n`;
      }).join("")).join("")).join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Poetry Codex</title>
<style>
body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.5; color: #000; max-width: 42em; margin: 2em auto; }
h1 { font-size: 20pt; font-weight: normal; margin: 0 0 4pt; }
h2 { font-size: 15pt; margin: 22pt 0 4pt; } h2 .by { font-weight: normal; font-size: 12pt; color: #444; }
h3 { font-size: 12.5pt; font-style: italic; font-weight: normal; margin: 14pt 0 4pt; }
p { margin: 0 0 6pt; } .intro { color: #444; font-size: 10.5pt; }
.meta { font-family: Arial, sans-serif; font-size: 9pt; color: #555; margin: 12pt 0 3pt; }
blockquote { margin: 0 0 6pt 0.5in; } blockquote p { margin: 0 0 6pt; } blockquote a { color: #000; text-decoration: none; }
.note { margin: 0 0 6pt 0.5in; } .cite { margin: 0 0 6pt 0.5in; font-size: 10.5pt; color: #333; }
</style></head><body>
<h1>${esc(title)}</h1>
<p class="intro">From Poetry Codex (poetrycodex.com), ${esc(shortDate(new Date().toISOString()))}${filt ? ". Only " + esc(filt) : ""}${o && o.intro ? ". " + esc(o.intro) : ""}.</p>
${body}</body></html>`;
  }
  function nbMarkdown(list, o) {
    const names = hlMeanings(), filt = o ? "" : nbFilterWords(names), title = o ? o.title : "My notes and highlights";
    const md = (s) => String(s || "").replace(/([\\`*_[\]<>])/g, "\\$1");
    const mdCite = (h) => h.replace(/<\/?i>/g, "_").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    // The front matter names the text when the file holds one, else every poet and translator.
    const groups = nbGroups(list), one = groups.length === 1 && groups[0].subs.length === 1 ? groups[0].subs[0] : null;
    const src = (it) => it.tx || it.g || {};
    const whose = (k) => uniq(k === "tr" ? list.flatMap((it) => citeTranslators(src(it).translator)) : list.map((it) => src(it).author));
    const head = frontMatter(one
      ? { title: one.tid.startsWith("work:") && one.title && one.title !== groups[0].title ? groups[0].title + ", " + one.title : one.title || groups[0].title,
          author: whose("au")[0] || "", translator: whose("tr"), url: SITE + shelfPath(one.tid), exported: isoDay(new Date()) }
      : { title, author: whose("au"), translator: whose("tr"), url: SITE + "/#/notes", exported: isoDay(new Date()) });
    return head + `# ${title}\n\nFrom Poetry Codex (${SITE}), ${shortDate(new Date().toISOString())}${filt ? ". Only " + filt : ""}${o && o.intro ? ". " + o.intro : ""}.\n\n`
      + groups.map((t) => `## ${mdHead(t.title)}${t.by ? " — " + mdHead(t.by) : ""}\n\n`
        + t.subs.map((s) => (s.title && s.title !== t.title ? `### ${mdHead(s.title)}\n\n` : "") + s.items.map((it) =>
          `*${md(nbKindLabel(it, names))}${it.loc ? " · " + it.loc : ""}*\n\n`
          + (it.type === "note" ? "" : nbStanzas(it).map((st) => st.map((l) => "> " + md(l).replace(/^ +/, (x) => " ".repeat(x.length))).join("  \n")).join("\n>\n") + "\n\n")
          + (it.type === "note" ? "" : `<${markURL(it)}>\n\n`)
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
      ${it.note.trim() ? `<p class="rv-note">${noteHTML(it.note)}</p>` : ""}
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
    const lang = langAttr(p.authorSlug, p.translator), tlang = textLangAttr(p.authorSlug, p.translator, p.text, p.id);
    const form = DATA ? (DATA.poems.find((q) => q.id === p.id) || {}).form : "";   // index only (B3)
    EARLY_DRAWN = DATA ? "" : location.hash;   // drawn without the index, which it does not fetch
    EARLY_REDRAW = false;
    const cite = { author: p.author, title: p.title, translator: p.translator, path: `/poem/${slug}/${n}/`,
                   year: citeYear(p.translator, ""), lang: citeLang(p.authorSlug, p.translator, p.title) };
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
        <div class="detail-subject">${esc(p.primarySubject)}${form ? ` · <a class="form-term" href="${termHref(formTerm(form))}" title="What is ${esc(withArticle(form.toLowerCase()))}?">${esc(form)}</a>` : ""}</div>
        <h1 class="detail-title"${lang}>${esc(p.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(p.authorSlug)}">${esc(p.author)}</a>${datesHTML(p.authorSlug)}</p>
        ${sourceLine(p.translator, p.collection, long ? readTime(p.text, isProse(p.text, p.translator)) : "")}
        ${themes}
        <hr class="rule">
        ${enginePanel(p.text, { compare: true, gloss: true })}
        ${poemBlock(p.text, { label: "The Poem", translator: p.translator, lang: tlang, parallel: parCtlHTML("poems", p.id, par) })}
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
    metaCitation(cite);
    bindPrint({ cite, entry, title: p.title, author: p.author, authorSlug: p.authorSlug, translator: p.translator,
                collection: p.collection || "", kicker: p.primarySubject + (form ? " · " + form : "") });
    { const here = location.hash; fetchSources(p.authorSlug).then((d) => applySource(cite, poemSource(d, p), here)); }
    bindShelfButton(entry);
    bindListNext();
    bindNote(entry);
    bindMarks(entry);
    bindQuoteTools(cite, p.authorSlug, p.translator, p.text);
    bindListen(listenLang(p.authorSlug, p.translator, p.text));
    restoreScroll();
    bindLearn({ entry, text: p.text, translator: p.translator, lang: tlang, par });
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
    bindEchoes({ id: entry.id });
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
    if (row && row.classList.contains("om-bar")) row = row.previousElementSibling;   // "Only my marks" bar
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
  // from: a line or paragraph to start at ("Listen from here" in the "This line" panel); on
  // the facing pages, a line of the original starts at the translation in its row.
  function startListen(btn, from) {
    const ctx = LISTEN;
    if (!ctx) return;
    ctx.units = listenUnits();
    if (!ctx.units.length) { flash(btn, "Show the translation to listen"); return; }
    const row = from && from.closest(".fx-row");
    const k = !from ? -1 : ctx.units.findIndex((u) => u.el === from || from.contains(u.el) || u.el.contains(from)
      || (row && row === u.el.closest(".fx-row")));
    ctx.at = k >= 0 ? k : listenStart(ctx.units);
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
