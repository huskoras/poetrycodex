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
      input.addEventListener("input", (e) => {
        query = e.target.value.trim().toLowerCase();
        if (query) filterSubject = "All";
        syncSearchInput();
        if (/^#\/(?!poems)/.test(location.hash) && location.hash !== "#/poems") location.hash = "#/poems";
        else renderList();
      });
    });
    document.querySelectorAll("form.search-form").forEach((form) =>
      form.addEventListener("submit", (e) => { e.preventDefault(); if (location.hash !== "#/poems") location.hash = "#/poems"; else renderList(); }));
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
      <div class="card-author">${esc(w.author)}</div>
      <p class="card-excerpt">${esc(w.blurb || (w.sections.length + " cantos"))}</p>
      <span class="work-flag">Read in ${w.sections.length} parts →</span>
    </button>`;

  // ---------- HOME: browse by era ----------
  function renderHome() {
    const epicCount = (DATA.works || []).filter(isEpicWork).length;
    const tiles = CATEGORY_ORDER.map((cat) => {
      const stats = CATEGORY_STATS[cat] || { poems: 0, works: 0 };
      return `
        <button class="topic-card" data-category="${esc(CATEGORY_SLUGS[cat])}">
          <p class="tc-name">${esc(cat)}</p>
          <p class="tc-count">${stats.poems} poem${stats.poems === 1 ? "" : "s"}${stats.works ? " · " + stats.works + " work" + (stats.works === 1 ? "" : "s") : ""}</p>
        </button>`;
    }).join("");
    app.innerHTML = `
      <div class="page-head"><h1 class="page-title">Browse by Era</h1><p class="page-sub">${DATA.count} poems across ${DATA.poets.length} poets, sorted into the ages that shaped them.</p></div>
      <div class="topic-grid">
        ${tiles}
        <button class="topic-card epics-tile" data-category="${EPICS_SLUG}">
          <p class="tc-name">Epics</p>
          <p class="tc-count">${epicCount} work${epicCount === 1 ? "" : "s"} · every era</p>
        </button>
      </div>
      <div class="browse-all"><a href="#/poems" class="read-link">Or browse all ${DATA.count} poems →</a></div>`;
    app.querySelectorAll(".topic-card[data-category]").forEach((c) =>
      c.addEventListener("click", () => { location.hash = "#/category/" + c.dataset.category; }));
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
      <div class="page-head"><h1 class="page-title">Poets</h1><p class="page-sub">${DATA.poets.length} poets, from Milton to the Romantics.</p></div>
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
              <span class="draft">Draft note — your biography text will replace this.</span>
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
        <hr class="rule">
        <blockquote class="poem-text">${esc(s.text)}</blockquote>
        ${enginePanel(s.text, { gloss: true })}
        <div class="detail-nav">
          <button ${i === 0 ? "disabled" : ""} data-go="${i - 1}"><span class="dir">← Previous</span>${i > 0 ? esc(w.sections[i - 1].title) : ""}</button>
          <button class="next" ${i === w.sections.length - 1 ? "disabled" : ""} data-go="${i + 1}"><span class="dir">Next →</span>${i < w.sections.length - 1 ? esc(w.sections[i + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/work/" + slug; });
    bindEngine({ title: w.title + " - " + s.title, author: w.author, text: s.text });
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
        <strong>${DATA.poets.length} poets</strong>, from Anglo-Saxon verse and the Greek and Roman
        epics through the Middle Ages, the Renaissance, the Romantics and the Victorians. Every text
        is reproduced in full, from a named edition, and is free of copyright.</p>

        <h2>Why this exists</h2>
        <p>Great poems are easy to find online; informed readings of them are not. A reader is usually
        offered either a bare text or a single, unattributed interpretation presented as the meaning of
        the poem. Poetry Codex begins from a different premise: that a poem is best understood through
        more than one lens, and that a reader deserves to see the lens named.</p>

        <h2>The Critical Engine <span class="soon">In development</span></h2>
        <p>We are building a reading system specialised entirely in poetry — not a general assistant —
        that can analyse any text in the archive through a chosen critical tradition: formalist,
        historicist, psychoanalytic, feminist, postcolonial, ecocritical, and others. Ask how
        <em>Beowulf</em> reads through a feminist lens, or how a Donne lyric looks first to a New Critic
        and then to a historicist, and the answer should be an argument rather than a summary — and it
        should say which scholarship it is standing on.</p>
        <p>The engine is grounded in the history of criticism itself: the methods, the debates and the
        critics who shaped them, together with open scholarship drawn from the academic literature. Its
        purpose is to cite scholarship, not to replace it. Every reading names its method and its
        sources, so that a reader can disagree with it intelligently.</p>
        <ul class="about-list">
          <li><strong>Semantic search</strong> — find poems by what they are about, not by the words
          they happen to use: ask for poems on exile, or on grief that refuses consolation.</li>
          <li><strong>Codex Notes</strong> — a short critical reading for every poem in the archive,
          generated under scholarly constraints and reviewed before publication.</li>
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
        and name their translator. Poet portraits are likewise public-domain works, courtesy of Wikimedia
        Commons, and each carries its credit.</p>

        <h2>The emblem</h2>
        <p>The archive’s emblem is a Roman gold medallion depicting Alexander the Great — an image of
        inheritance and endurance, fitting for a collection that returns great poems to a single shelf.</p>

        <h2>Contact</h2>
        <p>Poetry Codex welcomes correspondence from scholars, teachers and readers:
        <a href="mailto:admin@poetrycodex.com">admin@poetrycodex.com</a>.</p>
      </article>`;
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
  // The gloss button has to find Chaucer, Gower, Langland and Wyatt without
  // firing on Shakespeare or Spenser, whose spelling is old but readable.
  // Measured over the archive, Middle English texts score 9-59 hits per
  // thousand words on this vocabulary and early modern verse scores 0-1.6,
  // so the threshold sits in the gap.
  const ARCHAIC_WORDS = /\b(whan|swich|eek|nat|wol|quod|yclept|y-\w+|by-\w+|sithen|thilke|hire|nys|seyde|clepe[dn]?|licour|swoot|yern|mountaigne|leere|lynnen|aprilis|holt|heeth|croppes|yonge|sonne|halwes|ferne|straunge|sondry|corages|smale|foweles|slepen|nyght|eyen|bifil|wende[n]?|thanne|everich|certes|natheles|wight(?:es)?|sooth|ywis|parde|nolde|moot|mote|hadde|wolde|sholde|coude|seith|goth|doun|agayn|oother|peple|erthe|wordes|dayes|bettre|werk(?:es)?)\b/gi;
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
      <div class="rule-ornament">\u2726 \u2726 \u2726</div>
      <p class="section-label">Read with the Codex</p>
      <p class="engine-intro">Choose a critical tradition, or ask a question of your own.
      Readings are generated, and are meant to open an argument rather than settle one.</p>
      <div class="lens-row">${LENSES.map((l) =>
        `<button class="lens" data-lens="${esc(l.id)}">${esc(l.label)}</button>`).join("")}${gloss}</div>
      <form class="ask-form" autocomplete="off">
        <input class="ask-input" type="text" maxlength="400"
               placeholder="Ask the Codex about this poem\u2026" aria-label="Ask the Codex about this poem" />
        <button class="ask-send" type="submit">Ask</button>
      </form>
      ${compare}
      <div class="engine-out" id="engine-out" hidden></div>`;
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
        run("/api/gloss", {}, "Modern-English gloss, generated by the Poetry Codex critical engine.");
      } else {
        run("/api/analyze", { lens: btn.dataset.lens },
            btn.textContent + " reading, generated by the Poetry Codex critical engine.");
      }
    }));

    askForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = askInput.value.trim();
      if (!question || running) return;
      buttons.forEach((b) => b.classList.remove("active"));
      run("/api/ask", { question },
          "In answer to: \u201c" + question + "\u201d \u2014 generated by the Poetry Codex critical engine.");
    });

    if (cmpForm) bindCompare(cmpForm, piece, run, () => running, buttons);
  }

  // Title/author picker over the index, then the chosen poem's full text.
  function bindCompare(form, piece, run, isRunning, buttons) {
    const input = form.querySelector(".compare-input");
    const hits = form.querySelector(".compare-hits");
    let chosen = null;

    function close() { hits.hidden = true; hits.innerHTML = ""; }

    input.addEventListener("input", () => {
      chosen = null;
      const q = input.value.trim().toLowerCase();
      if (q.length < 3) return close();
      const found = [];
      for (const p of DATA.poems) {
        if (p.id === piece.id) continue;
        if (p.title.toLowerCase().includes(q) || p.author.toLowerCase().includes(q)) {
          found.push(p);
          if (found.length === 8) break;
        }
      }
      if (!found.length) return close();
      hits.innerHTML = found.map((p) =>
        `<li data-id="${esc(p.id)}"><strong>${esc(p.title)}</strong> <span>${esc(p.author)}</span></li>`).join("");
      hits.hidden = false;
    });

    hits.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      chosen = DATA.poems.find((p) => p.id === li.dataset.id) || null;
      if (chosen) input.value = chosen.title + " \u2014 " + chosen.author;
      close();
    });

    input.addEventListener("blur", () => setTimeout(close, 120));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (isRunning() || !chosen) { input.focus(); return; }
      buttons.forEach((b) => b.classList.remove("active"));
      const parts = chosen.id.split("/");
      const file = await fetchPoetFile(parts[0]).catch(() => null);
      const other = file && file.poems[Number(parts[1])];
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
        ${themes}
        <hr class="rule">
        <p class="section-label">The Poem</p>
        <blockquote class="poem-text">${esc(p.text)}</blockquote>
        ${p.note ? `<div class="rule-ornament">✦ ✦ ✦</div>
        <p class="section-label">Codex Note</p>
        <p class="note-block">${esc(p.note)}</p>` : ""}
        ${enginePanel(p.text, { compare: true, gloss: true })}
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
