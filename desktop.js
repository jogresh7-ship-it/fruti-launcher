// Fruti Launcher - desktop-style UI (library list + details, grid and list views).
(() => {
  "use strict";
  const VERSION = "12";
  // Without its files (e.g. served from a blob: URL), load games and covers from GitHub Pages.
  const SITE = "https://jogresh7-ship-it.github.io/fruti-launcher/";
  const BASE = /^(https?|file):$/.test(location.protocol) ? "" : SITE;
  const abs = (p) => (!p || /^[a-z]+:/i.test(p) ? p : BASE + p);

  const games = window.FRUTI_GAMES || [];
  const CONSOLES = window.FRUTI_CONSOLES || [];
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- Storage (same keys as the classic UI, so play time is shared) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("fruti:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fruti:" + k, JSON.stringify(v)); } catch {} },
  };
  let history = store.get("history", []);   // [{ id, at }] newest first
  let times = store.get("times", {});       // { id: ms }
  let favs = new Set(store.get("favs", []));
  const ui = Object.assign({
    mode: "details", group: "genre", sort: "name", platform: "all", favOnly: false,
    accent: "#29b6f6", card: 180, bgArt: true, titles: true, collapsed: {}, sel: null, page: "library",
  }, store.get("desktop", {}));
  const saveUi = () => store.set("desktop", ui);

  // ---------- Helpers ----------
  const fmt = (ms) => { const m = Math.floor((ms || 0) / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
  const ago = (t) => {
    if (!t) return "Never";
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return m + " min ago";
    if (m < 1440) return Math.round(m / 60) + " h ago";
    const d = Math.round(m / 1440);
    return d === 1 ? "Yesterday" : d + " days ago";
  };
  const initials = (t) => t.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w) => /^\d+$/.test(w) ? w : w[0]).join("").slice(0, 3).toUpperCase();
  const bg = (g) => g.image ? `url("${abs(g.image)}")` : `linear-gradient(135deg, ${g.color?.[0] || "#334"}, ${g.color?.[1] || "#112"})`;
  const lastAt = (id) => history.find((x) => x.id === id)?.at || 0;

  const ICON = {
    library: `<svg viewBox="0 0 24 24"><path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="m16 5 3.8-1 3 15.4-3.8 1z"/></svg>`,
    fav: `<svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>`,
    emulators: `<svg viewBox="0 0 24 24"><path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.3 5H6.7a4 4 0 0 0-4 3.6L2 15.5A3 3 0 0 0 7.2 18l1.3-2h7l1.3 2a3 3 0 0 0 5.2-2.5l-.7-6.9A4 4 0 0 0 17.3 5z"/></svg>`,
    stats: `<svg viewBox="0 0 24 24"><path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
    flash: `<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
    web: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
    pad: `<svg viewBox="0 0 24 24"><path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.3 5H6.7a4 4 0 0 0-4 3.6L2 15.5A3 3 0 0 0 7.2 18l1.3-2h7l1.3 2a3 3 0 0 0 5.2-2.5l-.7-6.9A4 4 0 0 0 17.3 5z"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/></svg>`,
    chev: `<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>`,
  };

  // ---------- Platforms ----------
  const PLAT = {
    flash: { name: "Flash", tag: "FLASH", engine: "Ruffle", icon: ICON.flash },
    web: { name: "Web", tag: "WEB", engine: "Browser", icon: ICON.web },
  };
  CONSOLES.forEach((c) => { PLAT[c.id] = { name: c.name, tag: c.tag, engine: "EmulatorJS", icon: ICON.pad }; });
  const platOf = (g) => g.rom ? (g.console || "n64") : g.swf ? "flash" : "web";
  const badge = (g) => { const p = PLAT[platOf(g)]; return `<span class="badge">${p.icon}${esc(p.tag)}</span>`; };

  // ---------- Page buttons (top right) ----------
  const PAGES = [
    ["library", "Library", ICON.library],
    ["emulators", "Emulators", ICON.emulators],
    ["stats", "Statistics", ICON.stats],
    ["settings", "Settings", ICON.settings],
  ];
  PAGES.forEach(([id, label, icon]) => {
    const b = h("button", "tb-btn pg-btn", icon);
    b.dataset.pg = id; b.title = label; b.setAttribute("aria-label", label);
    b.onclick = () => { showPage(id); if (id === "library") renderLibrary(); };
    $("#pages").appendChild(b);
  });

  function showPage(id) {
    ui.page = id; saveUi();
    $$(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === id));
    $$(".pg-btn").forEach((b) => b.classList.toggle("active", b.dataset.pg === id));
    document.body.dataset.page = id;
    if (id === "stats") renderStats();
  }

  // ---------- Filtering, sorting, grouping ----------
  function visible() {
    const q = $("#search").value.trim().toLowerCase();
    let list = games.filter((g) =>
      (!q || g.title.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q))) &&
      (ui.platform === "all" || platOf(g) === ui.platform) &&
      (!ui.favOnly || favs.has(g.id)));
    const by = {
      name: (a, b) => a.title.localeCompare(b.title),
      last: (a, b) => lastAt(b.id) - lastAt(a.id) || a.title.localeCompare(b.title),
      time: (a, b) => (times[b.id] || 0) - (times[a.id] || 0) || a.title.localeCompare(b.title),
      platform: (a, b) => PLAT[platOf(a)].name.localeCompare(PLAT[platOf(b)].name) || a.title.localeCompare(b.title),
    }[ui.sort] || ((a, b) => a.title.localeCompare(b.title));
    return list.sort(by);
  }
  function grouped(list) {
    if (ui.group === "none") return [[null, list]];
    const m = new Map();
    const add = (k, g) => { if (!m.has(k)) m.set(k, []); m.get(k).push(g); };
    list.forEach((g) => ui.group === "genre" ? (g.tags.length ? g.tags : ["Other"]).forEach((t) => add(t, g)) : add(PLAT[platOf(g)].name, g));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  const filterActive = () => !!$("#search").value.trim() || ui.platform !== "all" || ui.favOnly;

  // ---------- Library render ----------
  let order = []; // unique ids in display order, for keyboard navigation
  function renderLibrary() {
    const list = visible();
    // Grid and list views show each game once; the details list is grouped
    order = ui.mode === "details" ? [...new Set(grouped(list).flatMap(([, gs]) => gs.map((g) => g.id)))] : list.map((g) => g.id);
    if (!order.includes(ui.sel)) ui.sel = order[0] || null;

    $("#content").dataset.mode = ui.mode;
    $$(".tb-btn.mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === ui.mode));
    $("#tb-fav").classList.toggle("active", ui.favOnly);
    $("#tb-plat").classList.toggle("active", ui.platform !== "all");
    $("#filter-chip").hidden = !filterActive();
    $("#count").textContent = `${list.length} game${list.length === 1 ? "" : "s"}`;

    if (ui.mode === "details") renderList(list);
    else if (ui.mode === "grid") renderGrid(list);
    else renderTable(list);
    renderDetails();
  }

  const emptyMsg = () => h("div", "empty", games.length ? "No games match. <button class='link' data-clear>Clear filters</button>" : "No games yet. Add some in games.js.");

  function groupHead(name, count, wrap) {
    const key = ui.group + ":" + name;
    const head = h("button", "grp-head" + (ui.collapsed[key] ? " closed" : ""), `${ICON.chev}<span>${esc(name)}</span><b>${count}</b>`);
    head.onclick = () => { ui.collapsed[key] = !ui.collapsed[key]; saveUi(); renderLibrary(); };
    wrap.appendChild(head);
    return !ui.collapsed[key];
  }

  function renderList(list) {
    const box = $("#list"); box.innerHTML = "";
    if (!list.length) { box.appendChild(emptyMsg()); return; }
    grouped(list).forEach(([name, gs]) => {
      if (name != null && !groupHead(name, gs.length, box)) return;
      gs.forEach((g) => {
        const it = h("button", "li" + (g.id === ui.sel ? " sel" : ""), `<i class="thumb"></i><span>${esc(g.title)}</span>${favs.has(g.id) ? `<em class="star">${ICON.fav}</em>` : ""}`);
        $(".thumb", it).style.backgroundImage = bg(g);
        it.dataset.id = g.id;
        bindPick(it, g);
        box.appendChild(it);
      });
    });
  }

  function renderGrid(list) {
    const box = $("#grid"); box.innerHTML = "";
    box.style.setProperty("--card", ui.card + "px");
    box.classList.toggle("no-titles", !ui.titles);
    if (!list.length) { box.appendChild(emptyMsg()); return; }
    const wrap = h("div", "cards");
    list.forEach((g) => {
        const c = h("button", "gcard" + (g.id === ui.sel ? " sel" : ""),
          `<div class="gc-top">${badge(g)}${favs.has(g.id) ? `<em class="star">${ICON.fav}</em>` : ""}</div>
           <div class="gc-art">${g.image ? "" : `<b>${esc(initials(g.title))}</b>`}</div>
           <div class="gc-title">${esc(g.title)}</div>`);
        $(".gc-art", c).style.backgroundImage = bg(g);
        c.dataset.id = g.id;
        bindPick(c, g);
        wrap.appendChild(c);
    });
    box.appendChild(wrap);
  }

  function renderTable(list) {
    const box = $("#table"); box.innerHTML = "";
    const cols = [["name", "Name"], ["platform", "Platform"], [null, "Genres"], ["time", "Time played"], ["last", "Last played"]];
    const head = h("div", "tr th");
    cols.forEach(([k, label]) => {
      const c = h(k ? "button" : "span", "td" + (k && ui.sort === k ? " on" : ""), esc(label));
      if (k) c.onclick = () => { ui.sort = k; saveUi(); renderLibrary(); };
      head.appendChild(c);
    });
    box.appendChild(head);
    if (!list.length) { box.appendChild(emptyMsg()); return; }
    list.forEach((g) => {
      const r = h("button", "tr" + (g.id === ui.sel ? " sel" : ""),
        `<span class="td"><i class="thumb"></i>${esc(g.title)}${favs.has(g.id) ? `<em class="star">${ICON.fav}</em>` : ""}</span>
         <span class="td">${badge(g)}</span>
         <span class="td dim">${esc(g.tags.join(", "))}</span>
         <span class="td dim">${times[g.id] ? fmt(times[g.id]) : "—"}</span>
         <span class="td dim">${ago(lastAt(g.id))}</span>`);
      $(".thumb", r).style.backgroundImage = bg(g);
      r.dataset.id = g.id;
      bindPick(r, g);
      box.appendChild(r);
    });
  }

  function bindPick(el, g) {
    el.onclick = () => select(g.id);
    el.ondblclick = () => play(g);
  }
  function select(id, scroll) {
    if (!byId[id]) return;
    ui.sel = id; saveUi();
    $$("[data-id]").forEach((e) => e.classList.toggle("sel", e.dataset.id === id));
    renderDetails();
    if (scroll) $(`.${ui.mode === "details" ? "li" : ui.mode === "grid" ? "gcard" : "tr"}[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ---------- Details ----------
  function renderDetails() {
    const box = $("#details");
    const g = byId[ui.sel];
    box.classList.toggle("no-bg", !ui.bgArt);
    if (!g) { box.innerHTML = `<div class="empty big">Select a game</div>`; return; }
    const p = PLAT[platOf(g)];
    const t = times[g.id] || 0, last = lastAt(g.id);
    const fav = favs.has(g.id);
    box.innerHTML = `
      <div class="d-bg"></div>
      <div class="d-inner">
        <div class="d-head">
          <div class="d-icon"></div>
          <h1 class="d-title">${esc(g.title)}</h1>
        </div>
        <div class="d-actions">
          <button class="btn-play" id="d-play">${ICON.play}<span>Play</span></button>
          <div class="d-stat"><small>Time played</small><b>${t ? fmt(t) : "Not played"}</b></div>
          <div class="d-stat"><small>Last played</small><b>${ago(last)}</b></div>
          <button class="d-fav${fav ? " on" : ""}" id="d-fav" title="Favorite (F)">${ICON.fav}<span>${fav ? "Favorite" : "Add to favorites"}</span></button>
        </div>
        <div class="d-cols">
          <div class="d-main">
            <div class="d-shot">${g.image ? `<img src="${esc(abs(g.image))}" alt="${esc(g.title)} screenshot" loading="lazy">` : `<b>${esc(initials(g.title))}</b>`}</div>
            <h3>Description</h3>
            <p>${esc(g.desc || "No description yet.")}</p>
            <h3>How to play</h3>
            <p>${platOf(g) === "flash"
              ? "Opens in a new tab and runs through Ruffle. Click the game once if it does not react to keys. Press F11 for fullscreen."
              : platOf(g) === "web" ? "Opens the game page in a new tab."
              : "Opens in a new tab and runs through EmulatorJS. A gamepad works too."}</p>
          </div>
          <aside class="d-info">
            <dl>
              <dt>Recent activity</dt><dd>${last ? "Played " + ago(last).toLowerCase() : "No activity yet"}</dd>
              <dt>Platform</dt><dd>${badge(g)}</dd>
              <dt>Library</dt><dd>Fruti</dd>
              <dt>Engine</dt><dd>${esc(p.engine)}</dd>
              <dt>Genres</dt><dd class="chips">${g.tags.map((x) => `<button class="chip" data-tag="${esc(x)}">${esc(x)}</button>`).join("")}</dd>
              <dt>Completion</dt><dd>${t >= 3600000 ? "Playing a lot" : t ? "Played" : "Not played"}</dd>
            </dl>
          </aside>
        </div>
      </div>`;
    $(".d-bg", box).style.backgroundImage = bg(g);
    $(".d-icon", box).style.backgroundImage = bg(g);
    $("#d-play").onclick = () => play(g);
    $("#d-fav").onclick = () => toggleFav(g.id);
    $$(".chip", box).forEach((c) => c.onclick = () => { $("#search").value = c.dataset.tag; renderLibrary(); });
    box.scrollTop = 0;
  }

  function toggleFav(id) {
    favs.has(id) ? favs.delete(id) : favs.add(id);
    store.set("favs", [...favs]);
    renderLibrary();
  }

  // ---------- Play (opens in a new tab) ----------
  function play(g) {
    const sys = platOf(g);
    const src = abs(g.rom ? `emu.html?v=${VERSION}&system=${sys}&game=${encodeURIComponent(g.rom)}` : g.swf ? `play.html?v=${VERSION}&game=${encodeURIComponent(g.swf)}` : g.url);
    if (!src) { alert("No game file set for " + g.title + " yet."); return; }
    history = [{ id: g.id, at: Date.now() }, ...history.filter((x) => x.id !== g.id)].slice(0, 40);
    store.set("history", history);
    window.open(src, "_blank");
    renderLibrary();
  }

  // ---------- Toolbar ----------
  $("#search").oninput = renderLibrary;
  $$(".tb-btn.mode").forEach((b) => b.onclick = () => { ui.mode = b.dataset.mode; saveUi(); showPage("library"); renderLibrary(); });
  $("#tb-fav").onclick = () => { ui.favOnly = !ui.favOnly; saveUi(); renderLibrary(); };
  $("#tb-random").onclick = () => {
    const list = visible(); if (!list.length) return;
    showPage("library");
    const g = list[Math.floor(Math.random() * list.length)];
    (g.tags.length ? g.tags : ["Other"]).forEach((t) => delete ui.collapsed["genre:" + t]);
    delete ui.collapsed["platform:" + PLAT[platOf(g)].name];
    ui.sel = g.id; renderLibrary(); select(g.id, true);
  };
  $("#filter-chip").onclick = clearFilters;
  function clearFilters() { $("#search").value = ""; ui.platform = "all"; ui.favOnly = false; saveUi(); renderLibrary(); }
  document.addEventListener("click", (e) => { if (e.target.closest("[data-clear]")) { showPage("library"); clearFilters(); } });

  // Small dropdown menus
  const menu = $("#menu");
  function openMenu(btn, items, current, pick) {
    if (!menu.hidden && menu.dataset.for === btn.id) { menu.hidden = true; return; }
    menu.innerHTML = ""; menu.dataset.for = btn.id;
    items.forEach(([val, label]) => {
      const it = h("button", "menu-it" + (val === current ? " on" : ""), `${val === current ? ICON.check : "<i></i>"}<span>${esc(label)}</span>`);
      it.onclick = () => { menu.hidden = true; pick(val); saveUi(); showPage("library"); renderLibrary(); };
      menu.appendChild(it);
    });
    const r = btn.getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + "px";
  }
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest(".tb-btn")) menu.hidden = true; });
  $("#tb-group").onclick = (e) => openMenu(e.currentTarget, [["genre", "Group by genre"], ["platform", "Group by platform"], ["none", "Don't group"]], ui.group, (v) => ui.group = v);
  $("#tb-sort").onclick = (e) => openMenu(e.currentTarget, [["name", "Name"], ["last", "Last played"], ["time", "Time played"], ["platform", "Platform"]], ui.sort, (v) => ui.sort = v);
  $("#tb-plat").onclick = (e) => {
    const used = [...new Set(games.map(platOf))];
    openMenu(e.currentTarget, [["all", "All platforms"], ...used.map((id) => [id, PLAT[id].name])], ui.platform, (v) => ui.platform = v);
  };

  // ---------- Keyboard ----------
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { menu.hidden = true; if (document.activeElement === $("#search")) $("#search").blur(); return; }
    if (e.target.matches("input, textarea")) {
      if (e.key === "Enter" && byId[ui.sel]) play(byId[ui.sel]);
      return;
    }
    if (ui.page !== "library") return;
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); return; }
    const g = byId[ui.sel];
    if (e.key === "Enter" && g) { play(g); e.preventDefault(); return; }
    if ((e.key === "f" || e.key === "F") && g) { toggleFav(g.id); return; }
    let step = 0;
    const cols = ui.mode === "grid" ? Math.max(1, getComputedStyle($("#grid .cards") || $("#grid")).gridTemplateColumns.split(" ").length) : 1;
    if (e.key === "ArrowDown") step = cols;
    else if (e.key === "ArrowUp") step = -cols;
    else if (e.key === "ArrowRight" && ui.mode === "grid") step = 1;
    else if (e.key === "ArrowLeft" && ui.mode === "grid") step = -1;
    if (!step || !order.length) return;
    e.preventDefault();
    const i = Math.max(0, order.indexOf(ui.sel));
    select(order[Math.min(order.length - 1, Math.max(0, i + step))], true);
  });

  // ---------- Emulators ----------
  function renderEmulators() {
    const box = $("#emu-grid"); box.innerHTML = "";
    CONSOLES.forEach((c) => {
      const n = games.filter((g) => platOf(g) === c.id).length;
      const card = h("div", "emu-card", `
        <div class="emu-tag">${esc(c.tag)}</div>
        <div class="emu-txt"><b>${esc(c.name)}</b><small>${esc(c.ext.join(" "))} · .zip · .7z</small><small>${n} game${n === 1 ? "" : "s"} in library</small></div>
        <button class="btn-play sm">${ICON.play}<span>Play a ROM</span></button>`);
      $("button", card).onclick = () => window.open(abs(`emu.html?v=${VERSION}&system=${c.id}`), "_blank");
      box.appendChild(card);
    });
  }

  // ---------- Statistics ----------
  function renderStats() {
    const total = Object.values(times).reduce((a, b) => a + b, 0);
    const played = games.filter((g) => times[g.id] || lastAt(g.id));
    const top = [...games].filter((g) => times[g.id]).sort((a, b) => times[b.id] - times[a.id]).slice(0, 8);
    const max = top.length ? times[top[0].id] : 1;
    const per = {};
    games.forEach((g) => { const n = PLAT[platOf(g)].name; per[n] = (per[n] || 0) + 1; });
    $("#stats").innerHTML = `
      <h1 class="pg-title">Statistics</h1>
      <div class="kpis">
        <div class="kpi"><small>Games</small><b>${games.length}</b></div>
        <div class="kpi"><small>Played</small><b>${played.length}</b></div>
        <div class="kpi"><small>Favorites</small><b>${favs.size}</b></div>
        <div class="kpi"><small>Total play time</small><b>${fmt(total)}</b></div>
      </div>
      <div class="set-card"><h3>Most played</h3>${top.length ? top.map((g) => `
        <div class="bar-row"><span>${esc(g.title)}</span><div class="bar"><i style="width:${Math.max(3, times[g.id] / max * 100)}%"></i></div><b>${fmt(times[g.id])}</b></div>`).join("")
        : `<p class="pg-sub">Play something and it shows up here.</p>`}</div>
      <div class="set-card"><h3>Games per platform</h3>${Object.entries(per).sort((a, b) => b[1] - a[1]).map(([n, c]) => `
        <div class="bar-row"><span>${esc(n)}</span><div class="bar"><i style="width:${c / games.length * 100}%"></i></div><b>${c}</b></div>`).join("")}</div>`;
  }

  // ---------- Settings ----------
  const ACCENTS = ["#29b6f6", "#5b8cff", "#a66bff", "#ff5c8a", "#ff8a3d", "#f5c542", "#3ccf6e", "#2ee6c5", "#e8ecf2"];
  function applyAccent() {
    document.documentElement.style.setProperty("--accent", ui.accent);
    $$(".swatch").forEach((s) => s.classList.toggle("on", s.dataset.c === ui.accent));
  }
  ACCENTS.forEach((c) => {
    const s = h("button", "swatch"); s.style.background = c; s.dataset.c = c; s.title = c;
    s.onclick = () => { ui.accent = c; saveUi(); applyAccent(); };
    $("#swatches").appendChild(s);
  });
  $("#set-size").value = ui.card;
  $("#set-size").oninput = (e) => { ui.card = +e.target.value; saveUi(); renderLibrary(); };
  $("#set-bg").checked = ui.bgArt;
  $("#set-bg").onchange = (e) => { ui.bgArt = e.target.checked; saveUi(); renderDetails(); };
  $("#set-titles").checked = ui.titles;
  $("#set-titles").onchange = (e) => { ui.titles = e.target.checked; saveUi(); renderLibrary(); };
  $("#set-clear").onclick = () => {
    if (!confirm("Clear play history and play time?")) return;
    history = []; times = {}; store.set("history", history); store.set("times", times); renderLibrary();
  };

  // ---------- Live updates from game tabs ----------
  const reload = () => {
    times = store.get("times", {}); history = store.get("history", history);
    renderLibrary(); if (ui.page === "stats") renderStats();
  };
  addEventListener("storage", (e) => { if (e.key === "fruti:times" || e.key === "fruti:history") reload(); });
  addEventListener("focus", reload);

  const clock = () => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };

  // ---------- Init ----------
  applyAccent();
  renderEmulators();
  showPage(["library", "emulators", "stats", "settings"].includes(ui.page) ? ui.page : "library");
  renderLibrary();
  clock(); setInterval(clock, 10000);
})();
