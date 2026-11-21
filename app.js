(() => {
  "use strict";
  const VERSION = "20";
  // When the launcher runs somewhere without its files (e.g. pasted into LiveCodes, which serves it
  // from a blob: URL), load games and art from the GitHub Pages site instead.
  const SITE = "https://jogresh7-ship-it.github.io/fruti-launcher/";
  const BASE = /^(https?|file):$/.test(location.protocol) ? "" : SITE;
  const abs = (p) => (!p || /^[a-z]+:/i.test(p) ? p : BASE + p);

  const GAMES = window.FRUTI_GAMES || [];
  const CONSOLES = window.FRUTI_CONSOLES || [];
  const SOURCES = window.FRUTI_ROM_SOURCES || [];
  const byId = new Map(GAMES.map((g) => [g.id, g]));
  const consoleById = new Map(CONSOLES.map((c) => [c.id, c]));

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => r.querySelectorAll(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // ---------- Storage (same keys as before, so history and play time carry over) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("fruti:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fruti:" + k, JSON.stringify(v)); } catch {} },
  };
  let history = store.get("history", []); // [{ id, at }] newest first
  let times = store.get("times", {});     // { id: ms }
  const settings = Object.assign({ theme: "green", particles: "none", rotate: true, calm: false }, store.get("settings", {}));
  const saveSettings = () => store.set("settings", settings);

  // ---------- Game helpers ----------
  const consoleOf = (g) => (g.cdn != null || g.rom != null ? g.console || "n64" : null);
  const kindOf = (g) => (consoleOf(g) ? "console" : g.swf != null ? "flash" : "web");
  const ready = (g) => {
    if (!(g.cdn || g.rom || g.swf || g.url)) return false;
    const c = consoleById.get(consoleOf(g));
    return !c || c.emu !== false;
  };
  const platform = (g) => {
    const c = consoleById.get(consoleOf(g));
    return c ? c.name : kindOf(g) === "flash" ? "Flash" : "Web";
  };
  const tag = (g) => consoleById.get(consoleOf(g))?.tag || (kindOf(g) === "flash" ? "FLASH" : "WEB");
  const lastPlayed = (id) => history.find((x) => x.id === id)?.at || 0;

  const fmt = (ms) => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return m + "m ago";
    if (m < 1440) return Math.round(m / 60) + "h ago";
    return Math.round(m / 1440) + "d ago";
  };
  const initials = (t) => t.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w) => (/^\d+$/.test(w) ? w : w[0])).join("").slice(0, 4).toUpperCase();
  const gradient = (g) => `linear-gradient(135deg, ${g.color?.[0] || "#2a2f3a"}, ${g.color?.[1] || "#111"})`;
  // Pre-built art from tools/make-art.py; falls back to the raw cover, then to a gradient.
  const tileSrc = (g) => (g.image ? abs(`art/${g.id}.webp`) : "");
  const heroBg = (g) => (g.image ? `url("${abs(`art/${g.id}-hero.webp`)}"), url("${abs(g.image)}"), ${gradient(g)}` : gradient(g));

  // ---------- Icons ----------
  const ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    emulator: '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59L2 15.5A3 3 0 0 0 7.24 18l1.26-2h7l1.26 2A3 3 0 0 0 22 15.5l-.7-6.91A4 4 0 0 0 17.32 5z"/>',
    flash: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`;

  // ---------- Navigation ----------
  const TABS = [["home", "Home"], ["library", "Library"], ["emulator", "Emulator"], ["flash", "Flash"], ["settings", "Settings"]];
  TABS.forEach(([id, label]) => {
    const b = el("button", "nav-btn", `${svg(id)}<span>${label}</span>`);
    b.dataset.go = id;
    $("#rail-items").appendChild(b);
  });
  let view = "";
  function go(id, push = true) {
    if (!TABS.some((t) => t[0] === id)) id = "home";
    if (id === "emulator" && openConsole) showConsole(null);
    if (id === view) { $("#main").scrollTo({ top: 0, behavior: "smooth" }); return; }
    view = id;
    $$(".view").forEach((v) => (v.hidden = v.dataset.view !== id));
    $$("[data-go]").forEach((b) => b.classList.toggle("active", b.dataset.go === id));
    $("#main").scrollTop = 0;
    if (push && location.hash !== "#" + id) history_replace("#" + id);
    rotate(id === "home");
  }
  const history_replace = (h) => { try { window.history.replaceState(null, "", h); } catch {} };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (b) go(b.dataset.go);
  });

  // ---------- Cards ----------
  // One delegated listener for every card instead of one per card.
  document.addEventListener("click", (e) => {
    const c = e.target.closest(".card[data-id]");
    if (c) openSheet(byId.get(c.dataset.id));
  });
  function card(g, { sub, progress } = {}) {
    const c = el("button", "card");
    c.dataset.id = g.id;
    const src = tileSrc(g);
    const thumb = el("div", "thumb");
    thumb.style.background = gradient(g);
    if (src) {
      const img = new Image();
      img.loading = "lazy"; img.decoding = "async"; img.alt = ""; img.width = 240; img.height = 240;
      img.src = src;
      img.onerror = () => { if (!img.dataset.fb) { img.dataset.fb = 1; img.src = abs(g.image); } else img.remove(); };
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el("div", "mono", esc(initials(g.title))));
    }
    thumb.appendChild(el("span", "badge", esc(tag(g))));
    if (!ready(g)) thumb.appendChild(el("span", "badge warn", "SETUP"));
    c.appendChild(thumb);
    const meta = el("div", "meta", `<div class="name">${esc(g.title)}</div><div class="sub">${esc(sub ?? g.tags.join(" · "))}</div>`);
    if (progress != null) meta.insertAdjacentHTML("beforeend", `<div class="bar"><i style="width:${Math.round(progress * 100)}%"></i></div>`);
    c.appendChild(meta);
    c.title = g.title;
    return c;
  }
  function fillGrid(box, list, empty = "No games here yet.") {
    const frag = document.createDocumentFragment();
    if (!list.length) frag.appendChild(el("p", "empty", empty));
    list.forEach((g) => frag.appendChild(card(g)));
    box.replaceChildren(frag);
  }

  // ---------- Hero ----------
  let heroList = [], heroIdx = 0, heroTimer = 0, heroLayer = 0;
  function buildHeroList() {
    const recent = history.map((x) => byId.get(x.id)).filter((g) => g && ready(g));
    const rest = GAMES.filter((g) => ready(g) && g.image);
    heroList = [...new Set([...recent, ...rest])].slice(0, 6);
  }
  function showHero(i) {
    if (!heroList.length) { $("#hero").hidden = true; return; }
    heroIdx = (i + heroList.length) % heroList.length;
    const g = heroList[heroIdx];
    // Cross-fade between two background layers
    const layers = [$("#hero-bg-a"), $("#hero-bg-b")];
    heroLayer ^= 1;
    layers[heroLayer].style.backgroundImage = heroBg(g);
    layers[heroLayer].classList.add("on");
    layers[heroLayer ^ 1].classList.remove("on");
    const played = lastPlayed(g.id);
    $("#hero-kicker").textContent = (played ? "Continue · " : "Featured · ") + platform(g);
    $("#hero-title").textContent = g.title;
    $("#hero-desc").textContent = g.desc || g.tags.join(" · ");
    $("#hero-play").onclick = () => play(g);
    $("#hero-info").onclick = () => openSheet(g);
    // Re-run the text animation
    const body = $(".hero-body"); body.style.display = "none"; void body.offsetWidth; body.style.display = "";
    $$("#hero-dots button").forEach((d, n) => d.classList.toggle("on", n === heroIdx));
    // Warm up the next banner so the cross-fade never shows a blank frame
    const next = heroList[(heroIdx + 1) % heroList.length];
    if (next?.image) new Image().src = abs(`art/${next.id}-hero.webp`);
  }
  function renderHero() {
    buildHeroList();
    const dots = $("#hero-dots"); dots.replaceChildren();
    heroList.forEach((g, n) => {
      const d = el("button"); d.setAttribute("aria-label", g.title);
      d.onclick = () => { showHero(n); rotate(true); };
      dots.appendChild(d);
    });
    showHero(0);
  }
  function rotate(on) {
    clearInterval(heroTimer);
    if (on && settings.rotate && !settings.calm && heroList.length > 1) heroTimer = setInterval(() => { if (!document.hidden) showHero(heroIdx + 1); }, 8000);
  }
  $("#hero").addEventListener("pointerenter", () => clearInterval(heroTimer));
  $("#hero").addEventListener("pointerleave", () => rotate(view === "home"));

  // ---------- Home rows ----------
  function row(title, list, opts = {}) {
    if (!list.length) return null;
    const sec = el("section", "row");
    sec.appendChild(el("h2", "row-title", `${esc(title)}${opts.note ? ` <small>${esc(opts.note)}</small>` : ""}`));
    const sc = el("div", "scroller");
    list.forEach((g) => sc.appendChild(card(g, opts.card?.(g))));
    sec.appendChild(sc);
    return sec;
  }
  function renderHome() {
    renderHero();
    const recent = history.map((x) => byId.get(x.id)).filter(Boolean).slice(0, 12);
    const maxT = Math.max(1, ...recent.map((g) => times[g.id] || 0));
    const has = (re) => (g) => g.tags.some((t) => re.test(t));
    const rows = [
      row("Continue playing", recent, { card: (g) => ({ sub: `${ago(lastPlayed(g.id))}${times[g.id] >= 60000 ? " · " + fmt(times[g.id]) : ""}`, progress: (times[g.id] || 0) / maxT }) }),
      row("Console classics", GAMES.filter((g) => kindOf(g) === "console"), { card: (g) => ({ sub: platform(g) }) }),
      row("Flash favorites", GAMES.filter((g) => kindOf(g) === "flash")),
      row("Web games", GAMES.filter((g) => kindOf(g) === "web")),
      row("Strategy & tower defense", GAMES.filter(has(/strategy|tower/i))),
      row("Action & adventure", GAMES.filter(has(/action|shooter|zombie|adventure/i))),
      row("Racing & arcade", GAMES.filter(has(/racing|arcade|runner|platform/i))),
      row("Puzzle & board", GAMES.filter(has(/puzzle|stealth|board|physics/i))),
    ].filter(Boolean);
    $("#rows").replaceChildren(...rows);
  }

  // ---------- Library ----------
  let libFilter = "all";
  const FILTERS = [
    ["all", "All", () => true],
    ["console", "Consoles", (g) => kindOf(g) === "console"],
    ["flash", "Flash", (g) => kindOf(g) === "flash"],
    ["web", "Web", (g) => kindOf(g) === "web"],
    ...CONSOLES.filter((c) => GAMES.some((g) => consoleOf(g) === c.id)).map((c) => [c.id, c.tag, (g) => consoleOf(g) === c.id]),
  ];
  FILTERS.forEach(([id, label, test]) => {
    const b = el("button", "chip", `${esc(label)}<small>${GAMES.filter(test).length}</small>`);
    b.dataset.f = id;
    b.onclick = () => { libFilter = id; renderLibrary(); };
    $("#lib-chips").appendChild(b);
  });
  function renderLibrary() {
    const q = $("#search").value.trim().toLowerCase();
    const test = FILTERS.find((f) => f[0] === libFilter)[2];
    const sort = $("#sort").value;
    const list = GAMES.filter((g) => test(g) && (!q || g.title.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q)) || platform(g).toLowerCase().includes(q)));
    list.sort(sort === "recent" ? (a, b) => lastPlayed(b.id) - lastPlayed(a.id) || a.title.localeCompare(b.title)
      : sort === "most" ? (a, b) => (times[b.id] || 0) - (times[a.id] || 0) || a.title.localeCompare(b.title)
      : (a, b) => a.title.localeCompare(b.title));
    $$("#lib-chips .chip").forEach((c) => c.classList.toggle("on", c.dataset.f === libFilter));
    $("#lib-count").textContent = `${list.length} of ${GAMES.length}`;
    fillGrid($("#lib-grid"), list, "No games match your search.");
  }
  let searchT = 0;
  $("#search").addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(renderLibrary, 60); });
  $("#sort").onchange = renderLibrary;

  // ---------- Emulator ----------
  let openConsole = null;
  function renderEmulator() {
    const box = $("#consoles"); box.replaceChildren();
    CONSOLES.forEach((c) => {
      const n = GAMES.filter((g) => consoleOf(g) === c.id).length;
      const off = c.emu === false;
      const t = el("button", "console" + (off ? " off" : ""),
        `<span class="tag">${esc(c.tag)}</span><div><b>${esc(c.name)}</b><br><span>${off ? "No browser emulator" : n ? `${n} game${n > 1 ? "s" : ""}` : "Play a ROM file"}</span></div>`);
      t.style.setProperty("--c", c.color || "#888");
      t.onclick = () => showConsole(c.id);
      box.appendChild(t);
    });
    fillGrid($("#emu-all"), GAMES.filter((g) => kindOf(g) === "console"));
    if (openConsole) showConsole(openConsole);
  }
  function showConsole(id) {
    const c = consoleById.get(id);
    openConsole = c ? id : null;
    $("#emu-home").hidden = !!c;
    $("#emu-console").hidden = !c;
    if (!c) return;
    const list = GAMES.filter((g) => consoleOf(g) === id);
    $("#emu-name").textContent = c.name;
    $("#emu-count").textContent = `${list.length} game${list.length === 1 ? "" : "s"}`;
    const off = c.emu === false;
    $("#emu-file").hidden = off;
    $("#emu-file").onclick = () => window.open(abs(`emu.html?v=${VERSION}&system=${c.id}`), "_blank");
    $("#emu-note").hidden = !off;
    $("#emu-note").textContent = off ? `${c.name} games can be listed here, but EmulatorJS has no ${c.name} core that runs in a browser yet, so they can't be played.` : "";
    fillGrid($("#emu-grid"), list, off ? "Nothing to show." : "No games yet. Use “Play a ROM file” to load one from your computer.");
    $("#main").scrollTop = 0;
  }
  $("#emu-back").onclick = () => showConsole(null);

  // ---------- Flash ----------
  function renderFlash() {
    const list = GAMES.filter((g) => kindOf(g) === "flash");
    $("#flash-count").textContent = `${list.length} games`;
    fillGrid($("#flash-grid"), list);
  }

  // ---------- Detail sheet ----------
  let sheetGame = null, lastFocus = null;
  function setupHint(g) {
    const c = consoleById.get(consoleOf(g));
    if (c && c.emu === false) return `${esc(c.name)} can't be emulated in the browser yet.`;
    if (kindOf(g) === "console") return `Upload the ROM to <code>rom-games</code> and set <code>cdn:</code> for this game in <code>games.js</code>.`;
    if (kindOf(g) === "flash") return `Run <code>python3 tools/embed.py swf game.swf ${esc(g.id)}</code> and set <code>swf: "${esc(g.id)}"</code> in <code>games.js</code>.`;
    return `Set <code>url:</code> for this game in <code>games.js</code> to the page that runs it.`;
  }
  function openSheet(g) {
    if (!g) return;
    sheetGame = g;
    lastFocus = document.activeElement;
    $("#d-hero").style.backgroundImage = heroBg(g);
    $("#d-kicker").textContent = platform(g);
    $("#d-title").textContent = g.title;
    $("#d-tags").innerHTML = g.tags.map((t) => `<span>${esc(t)}</span>`).join("");
    $("#d-desc").textContent = g.desc || "";
    $("#d-platform").textContent = platform(g) + (kindOf(g) === "flash" ? " (Ruffle)" : kindOf(g) === "console" ? " (EmulatorJS)" : "");
    $("#d-time").textContent = fmt(times[g.id] || 0);
    const lp = lastPlayed(g.id);
    $("#d-last").textContent = lp ? ago(lp) : "Never";
    const ok = ready(g);
    $("#d-play").disabled = !ok;
    $("#d-setup").hidden = ok;
    $("#d-setup").innerHTML = ok ? "" : "<b>Setup needed.</b> " + setupHint(g);
    $("#sheet").hidden = false;
    $(".sheet-panel").scrollTop = 0;
    $("#d-play").focus({ preventScroll: true });
    clearInterval(heroTimer);
  }
  function closeSheet() {
    if ($("#sheet").hidden) return;
    $("#sheet").hidden = true;
    sheetGame = null;
    lastFocus?.focus?.({ preventScroll: true });
    rotate(view === "home");
  }
  $("#d-close").onclick = closeSheet;
  $("#sheet-scrim").onclick = closeSheet;
  $("#d-play").onclick = () => sheetGame && play(sheetGame);

  // ---------- Play: each game opens in its own browser tab ----------
  function play(g) {
    if (!ready(g)) { openSheet(g); return; }
    const c = consoleOf(g);
    const src = abs(
      g.cdn ? `emu.html?v=${VERSION}&system=${c}&id=${encodeURIComponent(g.id)}`
      : g.rom ? `emu.html?v=${VERSION}&system=${c}&game=${encodeURIComponent(g.rom)}`
      : g.swf ? `play.html?v=${VERSION}&game=${encodeURIComponent(g.swf)}`
      : g.url);
    window.open(src, "_blank");
    history = [{ id: g.id, at: Date.now() }, ...history.filter((x) => x.id !== g.id)].slice(0, 40);
    store.set("history", history);
    closeSheet();
    refreshStats();
  }

  // The player pages save play time to localStorage; refresh the parts that show it.
  let statsT = 0;
  function refreshStats() {
    clearTimeout(statsT);
    statsT = setTimeout(() => {
      times = store.get("times", {});
      history = store.get("history", history);
      renderHome();
      if (view === "library") renderLibrary();
      updateDataSummary();
      rotate(view === "home");
    }, 50);
  }
  let statsSig = "";
  const sig = () => (localStorage.getItem("fruti:times") || "") + (localStorage.getItem("fruti:history") || "");
  addEventListener("storage", (e) => { if (e.key === "fruti:times" || e.key === "fruti:history") refreshStats(); });
  addEventListener("focus", () => { const s = sig(); if (s !== statsSig) { statsSig = s; refreshStats(); } });

  // ---------- Keyboard ----------
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSheet(); return; }
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if (e.key === "/" && !typing && $("#sheet").hidden) { e.preventDefault(); go("library"); $("#search").focus(); return; }
    // Arrow keys move between cards like a console dashboard
    if (!typing && $("#sheet").hidden && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      const cards = [...$$(`.view[data-view="${view}"] .card`)].filter((c) => c.offsetParent);
      if (!cards.length) return;
      const cur = document.activeElement?.closest?.(".card");
      if (!cur || !cards.includes(cur)) { e.preventDefault(); cards[0].focus(); return; }
      const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dir = e.key.slice(5);
      let best = null, bestD = Infinity;
      for (const c of cards) {
        if (c === cur) continue;
        const b = c.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, dx = x - cx, dy = y - cy;
        const okDir = dir === "Left" ? dx < -4 && Math.abs(dy) < r.height / 2
          : dir === "Right" ? dx > 4 && Math.abs(dy) < r.height / 2
          : dir === "Up" ? dy < -r.height / 2 : dy > r.height / 2;
        if (!okDir) continue;
        const d = dir === "Up" || dir === "Down" ? Math.abs(dy) * 4 + Math.abs(dx) : Math.abs(dx);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) { e.preventDefault(); best.focus(); best.scrollIntoView({ block: "nearest", inline: "nearest", behavior: settings.calm ? "auto" : "smooth" }); }
    }
  });

  // ---------- Settings ----------
  const THEMES = {
    green: "#22c55e", mint: "#1dd1a1", neon: "#00d2ff", ocean: "#0abde3", blue: "#3b82f6", amethyst: "#a55eea",
    cyber: "#d980fa", rose: "#f368e0", red: "#ff4d4d", sunset: "#f53b57", orange: "#ff9f43", gold: "#f1c40f", white: "#ffffff",
  };
  function applyTheme() {
    const hex = THEMES[settings.theme] || THEMES.green;
    const root = document.documentElement.style;
    root.setProperty("--accent", hex);
    // Dark or light text on the accent, whichever reads better
    const n = parseInt(hex.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    root.setProperty("--on-accent", lum > 0.55 ? "#05070a" : "#ffffff");
    settings.accent = hex; // read by emu.html for the emulator's UI colour
    $$(".swatch").forEach((s) => s.classList.toggle("on", s.dataset.t === settings.theme));
  }
  Object.entries(THEMES).forEach(([name, hex]) => {
    const s = el("button", "swatch"); s.style.setProperty("--c", hex); s.dataset.t = name; s.title = name; s.setAttribute("aria-label", name);
    s.onclick = () => { settings.theme = name; applyTheme(); saveSettings(); };
    $("#swatches").appendChild(s);
  });
  ["none", "stars", "snow", "rain", "bubbles", "fireflies", "nexus"].forEach((name) => {
    const b = el("button", "chip", name[0].toUpperCase() + name.slice(1)); b.dataset.fx = name;
    b.onclick = () => { settings.particles = name; saveSettings(); fx.set(name); markFx(); };
    $("#fx-opts").appendChild(b);
  });
  const markFx = () => $$("[data-fx]").forEach((b) => b.classList.toggle("on", b.dataset.fx === settings.particles));
  $("#opt-rotate").checked = settings.rotate;
  $("#opt-rotate").onchange = (e) => { settings.rotate = e.target.checked; saveSettings(); rotate(view === "home"); };
  $("#opt-calm").checked = settings.calm;
  $("#opt-calm").onchange = (e) => { settings.calm = e.target.checked; saveSettings(); applyCalm(); };
  const applyCalm = () => { document.documentElement.classList.toggle("calm", settings.calm); fx.set(settings.particles); rotate(view === "home"); };
  SOURCES.forEach((s) => $("#sources").appendChild(el("li", "", esc(s))));
  function updateDataSummary() {
    const total = Object.values(times).reduce((a, b) => a + b, 0);
    $("#data-sum").textContent = `${history.length} game${history.length === 1 ? "" : "s"} in history, ${fmt(total)} played in total. Saves made inside the emulator are kept by the browser and are not affected.`;
  }
  $("#clear-data").onclick = () => {
    if (!confirm("Clear your play history and play time? This can't be undone.")) return;
    history = []; times = {};
    store.set("history", history); store.set("times", times);
    refreshStats();
  };

  // ---------- Background effect (off by default; only runs while visible) ----------
  const fx = (() => {
    const cv = $("#fx"), ctx = cv.getContext("2d");
    let W = 0, H = 0, ps = [], type = "none", raf = 0;
    const resize = () => { const d = Math.min(devicePixelRatio || 1, 1.5); W = innerWidth; H = innerHeight; cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
    addEventListener("resize", () => { if (type !== "none") resize(); });
    const R = (a, b) => a + Math.random() * (b - a);
    const accent = () => THEMES[settings.theme] || "#22c55e";
    function frame() {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      ctx.clearRect(0, 0, W, H);
      const col = accent();
      for (const p of ps) {
        p.t += .02;
        if (type === "snow") { p.y += p.vy; p.x += Math.sin(p.t) * .4; ctx.fillStyle = `rgba(255,255,255,${p.a * .6})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); }
        else if (type === "rain") { p.y += p.vy * 12; ctx.strokeStyle = `rgba(160,190,255,${p.a * .3})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 1, p.y + 12); ctx.stroke(); }
        else if (type === "stars") { ctx.globalAlpha = .2 + Math.abs(Math.sin(p.t * .6)) * .5 * p.a; ctx.fillStyle = "#fff"; ctx.fillRect(p.x, p.y, p.r * .8, p.r * .8); ctx.globalAlpha = 1; }
        else if (type === "bubbles") { p.y -= p.vy * .8; p.x += Math.sin(p.t) * .3; ctx.strokeStyle = `rgba(255,255,255,${p.a * .2})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 6, 0, 7); ctx.stroke(); }
        else if (type === "fireflies") { p.x += p.vx + Math.cos(p.t) * .3; p.y += Math.sin(p.t * .7) * .4; ctx.globalAlpha = Math.abs(Math.sin(p.t)) * .7; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.3, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
        else if (type === "nexus") { p.x += p.vx; p.y += p.vx * (p.vy - .6); ctx.fillStyle = "rgba(255,255,255,.45)"; ctx.fillRect(p.x, p.y, 2, 2); }
        if (p.y > H + 20) { p.y = -20; p.x = R(0, W); }
        if (p.y < -60) { p.y = H + 20; p.x = R(0, W); }
        if (p.x > W + 20) p.x = -20; if (p.x < -20) p.x = W + 20;
      }
      if (type === "nexus") {
        ctx.lineWidth = 1;
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
          const dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y, d = dx * dx + dy * dy;
          if (d < 14000) { ctx.strokeStyle = `rgba(255,255,255,${.1 * (1 - d / 14000)})`; ctx.beginPath(); ctx.moveTo(ps[i].x, ps[i].y); ctx.lineTo(ps[j].x, ps[j].y); ctx.stroke(); }
        }
      }
    }
    return {
      set(t) {
        cancelAnimationFrame(raf);
        type = settings.calm || matchMedia("(prefers-reduced-motion: reduce)").matches ? "none" : t;
        cv.hidden = type === "none";
        if (type === "none") { ps = []; return; }
        resize();
        const n = { snow: 80, rain: 100, stars: 90, bubbles: 30, fireflies: 40, nexus: 55 }[type] || 0;
        ps = Array.from({ length: n }, () => ({ x: R(0, W), y: R(0, H), r: R(.5, 2.5), vx: R(-.3, .3), vy: R(.2, 1), a: R(.2, 1), t: R(0, 6.28) }));
        frame();
      },
    };
  })();

  // ---------- Clock ----------
  const clock = () => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };

  // ---------- Init ----------
  applyTheme();
  saveSettings();
  document.documentElement.classList.toggle("calm", settings.calm);
  markFx();
  fx.set(settings.particles);
  renderHome();
  renderLibrary();
  renderEmulator();
  renderFlash();
  updateDataSummary();
  statsSig = sig();
  go(location.hash.slice(1) || "home", false);
  addEventListener("hashchange", () => go(location.hash.slice(1), false));
  clock(); setInterval(clock, 15000);
})();
