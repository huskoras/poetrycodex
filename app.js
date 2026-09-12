(() => {
  "use strict";
  const app = document.getElementById("app");
  let DATA = null;
  let query = "";
  let filterSubject = "All";
  let POETS = {};      // slug -> poet
  let WORKS = {};      // slug -> work
  let POEM_IDX = new Map(); // poem object -> index

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  fetch("poems.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      DATA = d;
      d.poets.forEach((p) => { POETS[p.slug] = p; });
      (d.works || []).forEach((w) => { WORKS[w.slug] = w; });
      d.poems.forEach((p, i) => POEM_IDX.set(p, i));
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
        if (/^#\/(poem|topics|about|poets|poet)/.test(location.hash)) location.hash = "#/";
        else renderList();
      });
    });
    document.querySelectorAll("form.search-form").forEach((form) =>
      form.addEventListener("submit", (e) => { e.preventDefault(); if (location.hash !== "#/") location.hash = "#/"; else renderList(); }));
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
    if ((m = h.match(/^#\/poem\/(\d+)$/))) { setRoute("poems", "sub"); renderDetail(parseInt(m[1], 10)); }
    else if ((m = h.match(/^#\/work\/([\w-]+)\/(\d+)$/))) { setRoute("poems", "sub"); renderWorkSection(m[1], parseInt(m[2], 10)); }
    else if ((m = h.match(/^#\/work\/([\w-]+)$/))) { setRoute("poems", "sub"); renderWork(m[1]); }
    else if ((m = h.match(/^#\/poet\/([\w-]+)$/))) { setRoute("poets", "sub"); renderPoet(m[1]); }
    else if (h.startsWith("#/poets")) { setRoute("poets", "sub"); renderPoets(); }
    else if (h.startsWith("#/topics")) { setRoute("topics", "sub"); renderTopics(); }
    else if (h.startsWith("#/about")) { setRoute("about", "sub"); renderAbout(); }
    else { setRoute("poems", "home"); renderList(); }
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
      const hay = (p.title + " " + p.author + " " + p.text + " " + p.subjects.join(" ")).toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }
  const cardHTML = (p, i) => `
    <button class="card" data-i="${i}">
      <div class="card-subject">${esc(p.primarySubject)}</div>
      <h2 class="card-title">${esc(p.title)}</h2>
      <div class="card-author">${esc(p.author)}</div>
      <p class="card-excerpt">${esc(p.text)}</p>
    </button>`;
  function bindCards() {
    app.querySelectorAll(".card[data-i]").forEach((c) =>
      c.addEventListener("click", () => { location.hash = "#/poem/" + c.dataset.i; }));
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

  const sortKey = (s) => s.toLowerCase().replace(/^["'“‘]*(a|an|the)\s+/, "").replace(/^[^a-z0-9]+/, "").trim();
  function renderList() {
    const results = DATA.poems.map((p, i) => ({ p, i })).filter(({ p }) => matches(p));
    results.sort((a, b) => sortKey(a.p.title).localeCompare(sortKey(b.p.title)));
    const works = (DATA.works || []).filter((w) => filterSubject === "All" && (!query || (w.title + " " + w.author).toLowerCase().includes(query)));
    let banner = "";
    if (query) banner = `<div class="filter-banner"><span class="lbl">Search</span> <span class="val">“${esc(query)}”</span><button data-clear="1">Clear ✕</button></div>`;
    const chips = [`<button class="chip ${filterSubject === "All" ? "active" : ""}" data-sub="All">All<span class="n">${DATA.count}</span></button>`]
      .concat(DATA.subjects.map((s) => `<button class="chip ${filterSubject === s.name ? "active" : ""}" data-sub="${esc(s.name)}">${esc(s.name)}<span class="n">${s.count}</span></button>`)).join("");

    app.innerHTML = `
      ${banner}
      ${query ? "" : `<div class="chips">${chips}</div>`}
      <p class="result-meta">${results.length} poem${results.length === 1 ? "" : "s"}${works.length ? " · " + works.length + " work" + (works.length === 1 ? "" : "s") : ""}${filterSubject !== "All" ? " · " + esc(filterSubject) : ""}</p>
      <div class="grid">${works.map(workCardHTML).join("")}${results.length || works.length ? results.map(({ p, i }) => cardHTML(p, i)).join("") : `<p class="empty">No poems match.</p>`}</div>`;

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
    const poems = DATA.poems.map((p, i) => ({ p, i })).filter(({ p }) => p.authorSlug === slug);
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
            ${poems.map(({ p, i }) => `
              <li><a href="#/poem/${i}"><span class="pl-title">${esc(p.title)}</span><span class="pl-sub">${esc(p.primarySubject)}</span></a></li>`).join("")}
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
            <li><a href="#/work/${esc(w.slug)}/${i}"><span class="pl-title">${esc(s.title)}</span><span class="pl-sub">${s.text.split("\n\n").length} stanzas</span></a></li>`).join("")}
        </ul>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/poet/" + w.authorSlug; });
  }

  // ---------- WORK: one section (canto) reader ----------
  function renderWorkSection(slug, i) {
    const w = WORKS[slug];
    if (!w || !w.sections[i]) { location.hash = "#/work/" + slug; return; }
    const s = w.sections[i];
    app.innerHTML = `
      <article class="detail">
        <button class="back" id="back">← ${esc(w.title)} · Contents</button>
        <div class="detail-subject">${esc(w.title)} · ${esc(w.year)}</div>
        <h1 class="detail-title">${esc(s.title)}</h1>
        <p class="detail-author">by <a href="#/poet/${esc(w.authorSlug)}">${esc(w.author)}</a></p>
        <hr class="rule">
        <blockquote class="poem-text">${esc(s.text)}</blockquote>
        <div class="detail-nav">
          <button ${i === 0 ? "disabled" : ""} data-go="${i - 1}"><span class="dir">← Previous</span>${i > 0 ? esc(w.sections[i - 1].title) : ""}</button>
          <button class="next" ${i === w.sections.length - 1 ? "disabled" : ""} data-go="${i + 1}"><span class="dir">Next →</span>${i < w.sections.length - 1 ? esc(w.sections[i + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { location.hash = "#/work/" + slug; });
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
      filterSubject = c.dataset.sub; query = ""; syncSearchInput(); location.hash = "#/";
    }));
  }

  // ---------- ABOUT ----------
  function renderAbout() {
    app.innerHTML = `
      <article class="about">
        <img class="about-coin" src="coin.png" alt="Gold medallion of Alexander the Great" />
        <h1>About Poetry Codex</h1>
        <p>Poetry Codex is a curated archive of poetry and criticism — a quiet place to find a poem,
        its poet, and a brief reading of it. It gathers <strong>${DATA.count} poems</strong> by
        <strong>${DATA.poets.length} poets</strong>, from Milton to the English Romantics.</p>
        <h2>The Codex Note</h2>
        <p>Each poem carries a short <em>Codex Note</em> — a considered critical reading meant to open a door,
        not close one.</p>
        <h2>The Emblem</h2>
        <p>The archive’s emblem is a Roman gold medallion depicting Alexander the Great — an image of
        inheritance and endurance, fitting for a collection that returns great poems to a single shelf.</p>
        <h2>Texts &amp; Images</h2>
        <p>Every poem here is in the public domain and is reproduced in full. Poet portraits are likewise
        public-domain works, courtesy of Wikimedia Commons; each carries its credit. Poetry Codex is a
        non-commercial reading archive.</p>
      </article>`;
  }

  // ---------- POEM DETAIL ----------
  function renderDetail(i) {
    const p = DATA.poems[i];
    if (!p) { location.hash = "#/"; return; }
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
        <div class="detail-nav">
          <button ${i === 0 ? "disabled" : ""} data-go="${i - 1}"><span class="dir">← Previous</span>${i > 0 ? esc(DATA.poems[i - 1].title) : ""}</button>
          <button class="next" ${i === DATA.poems.length - 1 ? "disabled" : ""} data-go="${i + 1}"><span class="dir">Next →</span>${i < DATA.poems.length - 1 ? esc(DATA.poems[i + 1].title) : ""}</button>
        </div>
      </article>`;
    document.getElementById("back").addEventListener("click", () => { if (history.length > 1) history.back(); else location.hash = "#/"; });
    app.querySelectorAll(".theme-tag").forEach((t) => t.addEventListener("click", () => {
      const isSub = DATA.subjects.some((s) => s.name === t.dataset.sub);
      filterSubject = isSub ? t.dataset.sub : "All";
      query = isSub ? "" : t.dataset.sub.toLowerCase();
      syncSearchInput(); location.hash = "#/";
    }));
    app.querySelectorAll(".detail-nav button").forEach((b) => b.addEventListener("click", () => { if (!b.disabled) location.hash = "#/poem/" + b.dataset.go; }));
  }
})();
