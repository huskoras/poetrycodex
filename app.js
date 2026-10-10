(() => {
  "use strict";
  const app = document.getElementById("app");
  let DATA = null;
  let query = "";
  let filterSubject = "All";
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
      const fc = document.getElementById("foot-count"); if (fc) fc.textContent = d.count;
      const fp = document.getElementById("foot-poets"); if (fp) fp.textContent = d.poets.length;
      wireSearch();
      route();
    })
    .catch((e) => {
      app.innerHTML = `<p class="empty">Could not load the archive (${esc(e.message)}).<br>Serve this through a local server, not a file:// path.</p>`;
    });

  // ---------- global search ----------
  function wireSearch() {
    document.querySelectorAll("input.search-input").forEach((input) => {
      input.value = query;
      if (input.dataset.wired) return;          // safe to call again after a render
      input.dataset.wired = "1";
      input.addEventListener("input", (e) => {
        query = e.target.value.trim().toLowerCase();
        if (query) filterSubject = "All";
        syncSearchInput();
        if (/^#\/(?!poems)/.test(location.hash) && location.hash !== "#/poems") location.hash = "#/poems";
        else renderList();
      });
    });
    document.querySelectorAll("form.search-form").forEach((form) => {
      if (form.dataset.wired) return;
      form.dataset.wired = "1";
      form.addEventListener("submit", (e) => { e.preventDefault(); if (location.hash !== "#/poems") location.hash = "#/poems"; else renderList(); });
    });
  }
  function syncSearchInput() {
    document.querySelectorAll("input.search-input").forEach((input) => {
      if (document.activeElement !== input) input.value = query;
    });
  }

  // ---------- routing ----------
  window.addEventListener("hashchange", route);
  function route() {
    if (!DATA) return;
    const h = location.hash || "#/";
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
    else if ((m = h.match(/^#\/work\/([\w-]+)$/))) { setRoute("poems", "sub"); renderWork(m[1]); }
    else if ((m = h.match(/^#\/poet\/([\w-]+)$/))) { setRoute("poets", "sub"); renderPoet(m[1]); }
    else if ((m = h.match(/^#\/category\/([\w-]+)$/))) { setRoute("poems", "sub"); renderCategory(m[1]); }
    else if (h.startsWith("#/poets")) { setRoute("poets", "sub"); renderPoets(); }
    else if (h.startsWith("#/topics")) { setRoute("topics", "sub"); renderTopics(); }
    else if (h.startsWith("#/about")) { setRoute("about", "sub"); renderAbout(); }
    else if (h.startsWith("#/oracle")) { setRoute("oracle", "sub"); renderOracle(); }
    else if (h.startsWith("#/eras")) { setRoute("eras", "sub"); renderEras(); }
    else if (h.startsWith("#/poems")) { setRoute("poems", "sub"); renderList(); }
    else { setRoute("poems", "home"); renderHome(); }
    syncSearchInput();
    window.scrollTo(0, 0);
  }
  function setRoute(navKey, mode) {
    document.body.dataset.route = mode;   // "home" shows hero; anything else hides it
    document.querySelectorAll(".tb-nav a, .hero-nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
  }

  // ---------- helpers ----------
  function matches(p) {
    if (filterSubject !== "All" && p.primarySubject !== filterSubject) return false;
    if (query) {
      // Full poem text is no longer in the index (that's the whole point of the
      // split), so search matches title + author + excerpt + subjects only.
      const hay = (p.title + " " + p.author + " " + p.excerpt + " " + p.subjects.join(" ")).toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }
  const cardHTML = (p) => `
    <button class="card" data-id="${esc(p.id)}">
      <div class="card-subject">${esc(p.primarySubject)}</div>
      <h2 class="card-title">${esc(p.title)}</h2>
      <div class="card-author">${esc(p.author)}</div>
      <p class="card-excerpt">${esc(p.excerpt)}</p>
    </button>`;
  function bindCards() {
    app.querySelectorAll(".card[data-id]").forEach((c) =>
      c.addEventListener("click", () => { location.hash = "#/poem/" + c.dataset.id; }));
  }

  // ---------- POEMS ----------
  const workCardHTML = (w) => `
    <button class="card work-card" data-work="${esc(w.slug)}">
      <div class="card-subject">${esc(w.type)} · ${esc(w.year)}</div>
      <h2 class="card-title">${esc(w.title)}</h2>
      <div class="card-author">${esc(w.author)}${w.translator ? " · " + esc(translatorShort(w.translator)) : ""}</div>
      <p class="card-excerpt">${esc(w.blurb || (w.sections.length + " cantos"))}</p>
      <span class="work-flag">Read in ${w.sections.length} parts →</span>
    </button>`;

  // ---------- HOME: browse by era ----------
  // The era grid, shared by the home page and #/eras.
  function eraGridHTML() {
    const epicCount = (DATA.works || []).filter(isEpicWork).length;
    const tiles = CATEGORY_ORDER.map((cat) => {
      const stats = CATEGORY_STATS[cat] || { poems: 0, works: 0 };
      return `
        <button class="topic-card" data-category="${esc(CATEGORY_SLUGS[cat])}">
          <p class="tc-name">${esc(cat)}</p>
          <p class="tc-count">${[
            stats.poems ? stats.poems + " poem" + (stats.poems === 1 ? "" : "s") : "",
            stats.works ? stats.works + " work" + (stats.works === 1 ? "" : "s") : "",
          ].filter(Boolean).join(" \u00b7 ")}</p>
        </button>`;
    }).join("");
    return `
      <div class="topic-grid">
        ${tiles}
        <button class="topic-card epics-tile" data-category="${EPICS_SLUG}">
          <p class="tc-name">Epics</p>
          <p class="tc-count">${epicCount} work${epicCount === 1 ? "" : "s"} \u00b7 every era</p>
        </button>
      </div>`;
  }

  function renderEras() {
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
    bindEraTiles();
    wireSearch();
  }

  function bindEraTiles() {
    app.querySelectorAll(".topic-card").forEach((c) =>
      c.addEventListener("click", () => { location.hash = "#/category/" + c.dataset.category; }));
  }

  function renderHome() {
    // Two doors under one roof: the collection, and the way of asking about it.
    // The Oracle keeps its place even while it sleeps, so the shape of the site
    // does not change when it wakes.
    app.innerHTML = `
      <div class="doors">
        <a class="door door-archive" href="#/eras">
          <img src="archive.png" alt="" width="124" height="124" />
          <span class="d-name">The Archive</span>
          <span class="d-line">${DATA.count} poems by ${DATA.poets.length} poets,
          from Homer and Anglo-Saxon verse to the early twentieth century \u2014 every one in the public domain.</span>
          <span class="d-go">Enter &rarr;</span>
        </a>
        <a class="door door-oracle${ORACLE_LIVE ? "" : " is-resting"}" href="#/oracle">
          <img src="oracle.png" alt="" width="124" height="124" />
          <span class="d-name">The Oracle</span>
          <span class="d-line">Ask for a poem, an argument, or a place to start.
          It searches the collection before it answers.</span>
          <span class="d-go">${ORACLE_LIVE ? "Consult &rarr;" : "Resting"}</span>
        </a>
      </div>

      <p class="doors-or">Or go straight to an era</p>
      ${eraGridHTML()}
      <div class="browse-all"><a href="#/poems" class="read-link">Browse all ${DATA.count} poems \u2192</a></div>`;
    bindEraTiles();
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
      : DATA.poems.filter((p) => POETS[p.authorSlug] && POETS[p.authorSlug].category === catName);
    poems.sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)));

    const sub = isEpics
      ? `${works.length} epic work${works.length === 1 ? "" : "s"}, spanning every era in the archive.`
      : `${poems.length} poem${poems.length === 1 ? "" : "s"}${works.length ? " · " + works.length + " work" + (works.length === 1 ? "" : "s") : ""}.`;

    app.innerHTML = `
      <button class="back" id="back">← Browse by Era</button>
      <div class="page-head"><h1 class="page-title">${esc(catName)}</h1><p class="page-sub">${sub}</p></div>
      <div class="grid">
        ${works.map(workCardHTML).join("")}
        ${poems.map(cardHTML).join("")}
        ${!works.length && !poems.length ? `<p class="empty">Nothing filed here yet.</p>` : ""}
      </div>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/"; });
    app.querySelectorAll(".work-card").forEach((c) => c.addEventListener("click", () => { location.hash = "#/work/" + c.dataset.work; }));
    bindCards();
  }

  const sortKey = (s) => s.toLowerCase().replace(/^["'“‘]*(a|an|the)\s+/, "").replace(/^[^a-z0-9]+/, "").trim();
  function renderList() {
    const results = DATA.poems.filter(matches);
    results.sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)));
    const works = (DATA.works || []).filter((w) => filterSubject === "All" && (!query || (w.title + " " + w.author).toLowerCase().includes(query)));
    let banner = "";
    if (query) banner = `<div class="filter-banner"><span class="lbl">Search</span> <span class="val">“${esc(query)}”</span><button data-clear="1">Clear ✕</button></div>`;
    const chips = [`<button class="chip ${filterSubject === "All" ? "active" : ""}" data-sub="All">All<span class="n">${DATA.count}</span></button>`]
      .concat(DATA.subjects.map((s) => `<button class="chip ${filterSubject === s.name ? "active" : ""}" data-sub="${esc(s.name)}">${esc(s.name)}<span class="n">${s.count}</span></button>`)).join("");

    app.innerHTML = `
      ${banner}
      ${query ? "" : `<div class="chips">${chips}</div>`}
      <p class="result-meta">${results.length} poem${results.length === 1 ? "" : "s"}${works.length ? " · " + works.length + " work" + (works.length === 1 ? "" : "s") : ""}${filterSubject !== "All" ? " · " + esc(filterSubject) : ""}</p>
      <div class="grid">${works.map(workCardHTML).join("")}${results.length || works.length ? results.map(cardHTML).join("") : `<p class="empty">No poems match.</p>`}</div>`;

    app.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { filterSubject = c.dataset.sub; query = ""; syncSearchInput(); renderList(); }));
    const clr = app.querySelector("[data-clear]");
    if (clr) clr.addEventListener("click", () => { query = ""; filterSubject = "All"; syncSearchInput(); renderList(); });
    app.querySelectorAll(".work-card").forEach((c) => c.addEventListener("click", () => { location.hash = "#/work/" + c.dataset.work; }));
    bindCards();
  }

  // ---------- portrait fallback (monogram) ----------
  function portraitImgHTML(p, cls) {
    if (p.portrait) return `<img class="${cls}" src="${esc(p.portrait)}" alt="Portrait of ${esc(p.name)}" loading="lazy" />`;
    const initial = esc(p.name.trim().charAt(0));
    return `<div class="${cls} pc-monogram" aria-label="No confirmed portrait of ${esc(p.name)}"><span>${initial}</span></div>`;
  }

  // ---------- POETS index ----------
  function renderPoets() {
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Poets</h1><p class="page-sub">${DATA.poets.length} poets, from Homer to the early twentieth century.</p></div>
      <div class="poet-grid">
        ${DATA.poets.map((p) => `
          <button class="poet-card" data-slug="${esc(p.slug)}">
            ${portraitImgHTML(p, "pc-img")}
            <div class="pc-body">
              <p class="pc-name">${esc(p.name)}</p>
              <p class="pc-dates">${esc(p.dates)}</p>
              <p class="pc-count">${p.poemCount} poem${p.poemCount === 1 ? "" : "s"}${p.workCount ? " · " + p.workCount + " work" + (p.workCount === 1 ? "" : "s") : ""}</p>
            </div>
          </button>`).join("")}
      </div>`;
    app.querySelectorAll(".poet-card").forEach((c) => c.addEventListener("click", () => { location.hash = "#/poet/" + c.dataset.slug; }));
  }

  // ---------- POET page ----------
  function renderPoet(slug) {
    const poet = POETS[slug];
    if (!poet) { location.hash = "#/poets"; return; }
    const poems = DATA.poems.filter((p) => p.authorSlug === slug);
    const works = (DATA.works || []).filter((w) => w.authorSlug === slug);
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
              <li><a href="#/poem/${esc(p.id)}"><span class="pl-title">${esc(p.title)}</span><span class="pl-sub">${esc(p.primarySubject)}</span></a></li>`).join("")}
          </ul>
        </section>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/poets"; });
  }

  // ---------- WORK: table of contents ----------
  function renderWork(slug) {
    const w = WORKS[slug];
    if (!w) { location.hash = "#/"; return; }
    app.innerHTML = `
      <article class="detail work-toc">
        <button class="back" id="back">← ${esc(w.author)}</button>
        <div class="detail-subject">${esc(w.type)} · ${esc(w.year)}</div>
        <h1 class="detail-title">${esc(w.title)}</h1>
        ${w.subtitle ? `<p class="work-subtitle">${esc(w.subtitle)}</p>` : ""}
        <p class="detail-author">by <a href="#/poet/${esc(w.authorSlug)}">${esc(w.author)}</a></p>
        ${sourceLine(w.translator)}
        ${w.blurb ? `<p class="note-block">${esc(w.blurb)}</p>` : ""}
        <hr class="rule">
        <p class="section-label">Contents · ${w.sections.length} parts</p>
        <ul class="poem-links">
          ${w.sections.map((s, i) => `
            <li><a href="#/work/${esc(w.slug)}/${i}"><span class="pl-title">${esc(s.title)}</span><span class="pl-sub">${s.stanzas} stanzas</span></a></li>`).join("")}
        </ul>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/poet/" + w.authorSlug; });
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
    app.innerHTML = `
      <article class="detail">
        <button class="back" id="back">← ${esc(w.title)} · Contents</button>
        <div class="detail-subject">${esc(w.title)} · ${esc(w.year)}</div>
        <h1 class="detail-title">${esc(s.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(w.authorSlug)}">${esc(w.author)}</a></p>
        ${sourceLine(w.translator)}
        <hr class="rule">
        ${enginePanel(s.text, { gloss: true })}
        <blockquote class="poem-text">${esc(s.text)}</blockquote>
        <div class="detail-nav">
          <button ${i === 0 ? "disabled" : ""} data-go="${i - 1}"><span class="dir">← Previous</span>${i > 0 ? esc(w.sections[i - 1].title) : ""}</button>
          <button class="next" ${i === w.sections.length - 1 ? "disabled" : ""} data-go="${i + 1}"><span class="dir">Next →</span>${i < w.sections.length - 1 ? esc(w.sections[i + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/work/" + slug; });
    bindEngine({ title: w.title + " \u00b7 " + s.title, author: w.author, text: s.text,
                 id: "work:" + slug + "/" + i });
    app.querySelectorAll(".detail-nav button").forEach((b) => b.addEventListener("click", () => { if (!b.disabled) location.hash = "#/work/" + slug + "/" + b.dataset.go; }));
  }

  // ---------- TOPICS ----------
  function renderTopics() {
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
    app.innerHTML = `
      <article class="about">
        <img class="about-coin" src="coin.png" alt="Gold medallion of Alexander the Great" />
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
      : `<div class="o-turn o-codex"><div class="o-mark"><img src="oracle.png" alt="" width="34" height="34" /></div>
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
    app.innerHTML = `
      <section class="oracle">
        <header class="oracle-head">
          <img class="oracle-coin is-resting" src="oracle.png" alt="Silver tetradrachm of Alexander the Great" />
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
    const empty = !ORACLE_MSGS.length;
    app.innerHTML = `
      <section class="oracle">
        <header class="oracle-head">
          <img class="oracle-coin" src="oracle.png" alt="Silver tetradrachm of Alexander the Great" />
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
        `<div class="o-turn o-codex" id="o-live"><div class="o-mark"><img src="oracle.png" alt="" width="34" height="34" /></div>
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
      hay: (p.title + " " + p.author).toLowerCase(),
    }));
    (DATA.works || []).forEach((w) => {
      (w.sections || []).forEach((sec, i) => {
        ASK_ITEMS.push({
          id: "work:" + w.slug + "/" + i,
          label: w.title + " \u00b7 " + sec.title,
          author: w.author,
          hay: (w.title + " " + sec.title + " " + w.author).toLowerCase(),
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
      const q = input.value.trim().toLowerCase();
      if (q.length < 3) return close();
      const scored = [];
      for (const it of askItems()) {
        if (it.id === excludeId) continue;
        const label = it.label.toLowerCase();
        let score;
        if (label.startsWith(q)) score = 0;
        else if (label.includes(q)) score = 1;
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
            prose += msg.t || "";
            out.className = "engine-out" + (path === "/api/gloss" ? " is-gloss" : "");
            out.innerHTML = prose.split(/\n{2,}/).filter(Boolean)
              .map((para) => `<p>${esc(para)}</p>`).join("")
              + `<p class="engine-credit">${esc(credit)}</p>`;
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
    app.innerHTML = `
      <article class="detail">
        <button class="back" id="back">← The Archive</button>
        <div class="detail-subject">${esc(p.primarySubject)}</div>
        <h1 class="detail-title">${esc(p.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(p.authorSlug)}">${esc(p.author)}</a></p>
        ${sourceLine(p.translator, p.collection)}
        ${themes}
        <hr class="rule">
        ${enginePanel(p.text, { compare: true, gloss: true })}
        <p class="section-label">The Poem</p>
        <blockquote class="poem-text">${esc(p.text)}</blockquote>
        ${p.note ? `<div class="rule-ornament">✦ ✦ ✦</div>
        <p class="section-label">Codex Note</p>
        <p class="note-block">${esc(p.note)}</p>` : ""}
        <div class="detail-nav">
          <button ${n === 0 ? "disabled" : ""} data-go="${n - 1}"><span class="dir">← Previous</span>${n > 0 ? esc(poems[n - 1].title) : ""}</button>
          <button class="next" ${n === poems.length - 1 ? "disabled" : ""} data-go="${n + 1}"><span class="dir">Next →</span>${n < poems.length - 1 ? esc(poems[n + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { if (history.length > 1) history.back(); else location.hash = "#/poems"; });
    app.querySelectorAll(".theme-tag").forEach((t) => t.addEventListener("click", () => {
      const isSub = DATA.subjects.some((s) => s.name === t.dataset.sub);
      filterSubject = isSub ? t.dataset.sub : "All";
      query = isSub ? "" : t.dataset.sub.toLowerCase();
      syncSearchInput(); location.hash = "#/poems";
    }));
    app.querySelectorAll(".detail-nav button").forEach((b) => b.addEventListener("click", () => { if (!b.disabled) location.hash = "#/poem/" + slug + "/" + b.dataset.go; }));
    bindEngine({ title: p.title, author: p.author, text: p.text, id: p.id });
  }
})();
