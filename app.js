(() => {
  "use strict";
  const VERSION = "5";
  const games = window.FRUTI_GAMES || [];
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const $ = (s) => document.querySelector(s);
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- Storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("fruti:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fruti:" + k, JSON.stringify(v)); } catch {} },
  };
  let history = store.get("history", []);   // [{ id, at }] newest first
  let times = store.get("times", {});       // { id: ms }
  const settings = Object.assign(
    { theme: "green", particles: "stars", fullscreen: false, rotate: true, name: "", sbOpen: false },
    store.get("settings", {})
  );
  const save = () => { store.set("settings", settings); };
  const totalMs = () => Object.values(times).reduce((a, b) => a + b, 0);

  // ---------- Formatting ----------
  const fmt = (ms) => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return m + "m ago";
    if (m < 1440) return Math.round(m / 60) + "h ago";
    return Math.round(m / 1440) + "d ago";
  };
  const initials = (t) => t.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w) => /^\d+$/.test(w) ? w : w[0]).join("").slice(0, 4).toUpperCase();
  const bg = (g) => g.image ? `url("${g.image}")` : `linear-gradient(135deg, ${g.color?.[0] || "#333"}, ${g.color?.[1] || "#111"})`;
  const art = (g) => {
    const a = h("div", "art");
    if (g.image) {
      // Screenshot shown whole, on top of a blurred copy that fills the space
      a.classList.add("img");
      const blur = h("div", "art-blur"), fg = h("div", "art-fg");
      blur.style.backgroundImage = fg.style.backgroundImage = bg(g);
      a.append(blur, fg);
    } else {
      a.style.backgroundImage = bg(g);
      a.appendChild(h("div", "art-mark", esc(initials(g.title))));
    }
    return a;
  };

  // ---------- Icons ----------
  const I = {
    home: `<span class="logo"></span>`,
    library: `<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
    gifts: `<svg viewBox="0 0 24 24"><path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    account: `<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  };

  // ---------- Navigation ----------
  const TABS = [["home", "Fruti"], ["library", "Library"], ["gifts", "Gifts"], ["settings", "Settings"], ["account", "Profile"]];
  let tab = "home";
  TABS.forEach(([id, label]) => {
    const a = h("button", "sb-item", `${I[id]}<span class="sb-label">${label}</span>`);
    a.dataset.tab = id; a.title = label; a.onclick = () => show(id);
    $("#nav").appendChild(a);
    const b = h("button", "mnav-btn", `${I[id]}<span>${label}</span>`);
    b.dataset.tab = id; b.onclick = () => show(id);
    $("#mnav").appendChild(b);
  });
  function show(id) {
    tab = id;
    hideGame();
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === id));
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
    $("#wrap").scrollTop = 0;
    if (id === "account") renderAccount();
  }

  document.body.classList.toggle("sb-open", settings.sbOpen);
  $("#sb-toggle").onclick = () => { settings.sbOpen = document.body.classList.toggle("sb-open"); save(); };

  // ---------- Cards ----------
  function card(g, kind) {
    const c = h("button", "card " + kind);
    c.appendChild(art(g));
    const ic = h("div", "c-icon"); const i = h("i"); i.style.backgroundImage = bg(g);
    if (!g.image) i.textContent = initials(g.title).slice(0, 2);
    ic.appendChild(i); c.appendChild(ic);
    const t = times[g.id];
    c.appendChild(h("div", "c-inf",
      `<h3>${esc(g.title)}</h3><span>${esc(g.tags.join(" • "))}</span>` +
      (t >= 60000 ? `<div class="c-time">${I.clock}${fmt(t)} played</div>` : "")));
    c.onclick = () => openModal(g);
    return c;
  }

  // ---------- Hero ----------
  let heroIdx = 0, heroTimer;
  const heroList = () => {
    const recent = history.map((x) => byId[x.id]).filter(Boolean);
    return [...new Set([...recent, ...games])].slice(0, 5);
  };
  function renderHero() {
    const list = heroList();
    if (!list.length) { $("#hero").hidden = true; return; }
    const g = list[heroIdx % list.length];
    const img = $("#hero-img"); img.innerHTML = ""; img.appendChild(art(g));
    const played = history.some((x) => x.id === g.id);
    $("#hero-tag").textContent = played ? "Resume" : "Featured";
    $("#hero-title").textContent = g.title;
    $("#hero-tags").textContent = g.tags.join(" • ");
    $("#hero-time").textContent = times[g.id] >= 60000 ? fmt(times[g.id]) + " played" : "";
    $("#hero").onclick = () => play(g);
    $("#amb").style.backgroundImage = bg(g);
  }
  function startRotate() {
    clearInterval(heroTimer);
    if (settings.rotate) heroTimer = setInterval(() => { if (current) return; heroIdx++; renderHero(); }, 7000);
  }

  // ---------- Home lists ----------
  const SECTIONS = [
    ["Strategy & Tower Defense", (g) => g.tags.some((t) => /strategy|tower/i.test(t))],
    ["Action & Shooter", (g) => g.tags.some((t) => /action|shooter|zombie/i.test(t))],
    ["Puzzle & Board", (g) => g.tags.some((t) => /puzzle|stealth|board|physics/i.test(t))],
    ["Quick Play Arcade", (g) => g.tags.some((t) => /arcade|runner|platform/i.test(t))],
    ["All Games", () => true],
  ];
  function renderHome() {
    renderHero();
    // Marquee: least-recently-played first, duplicated for a seamless loop
    const played = new Set(history.map((x) => x.id));
    const rec = [...games].sort((a, b) => played.has(a.id) - played.has(b.id));
    const track = $("#recommend"); track.innerHTML = "";
    [...rec, ...rec].forEach((g) => track.appendChild(card(g, "h")));
    const box = $("#sections"); box.innerHTML = "";
    SECTIONS.forEach(([title, test]) => {
      const list = games.filter(test);
      if (!list.length) return;
      box.appendChild(h("h2", "sec-head", esc(title)));
      const grid = h("div", "grid-h");
      list.forEach((g) => grid.appendChild(card(g, "h")));
      box.appendChild(grid);
    });
  }
  function renderLibrary() {
    const q = $("#search").value.trim().toLowerCase();
    const grid = $("#library"); grid.innerHTML = "";
    const list = games.filter((g) => !q || g.title.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q)));
    if (!list.length) grid.appendChild(h("p", "empty", "No games found."));
    list.forEach((g) => grid.appendChild(card(g, "v")));
  }
  $("#search").oninput = renderLibrary;

  // ---------- Sidebar ----------
  function renderSidebar() {
    const items = history.filter((x) => byId[x.id]);
    const box = $("#history"); box.innerHTML = "";
    if (!items.length) box.appendChild(h("div", "sb-empty", "No History"));
    items.slice(0, 15).forEach((x) => {
      const g = byId[x.id];
      const it = h("button", "sb-hist-item");
      it.title = g.title;
      const im = h("div", "sb-hist-img"); im.style.backgroundImage = bg(g);
      it.appendChild(im);
      it.appendChild(h("div", "sb-hist-info", `<span class="sb-hist-name">${esc(g.title)}</span><span class="sb-hist-time">${ago(x.at)}</span>`));
      it.onclick = () => play(g);
      box.appendChild(it);
    });
    const last = items[0] && byId[items[0].id];
    $("#last").hidden = !last;
    if (last) {
      $("#last-img").style.backgroundImage = bg(last);
      $("#last-name").textContent = last.title;
      $("#last").onclick = () => play(last);
    }
    $("#total").textContent = fmt(totalMs());
  }
  const clock = () => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };

  // ---------- Modal ----------
  let modalGame = null;
  function openModal(g) {
    modalGame = g;
    $("#m-bg").style.backgroundImage = bg(g);
    const cov = $("#m-cover"); cov.innerHTML = ""; cov.appendChild(art(g));
    $("#m-title").textContent = g.title;
    $("#m-genre").textContent = g.tags[0] || "";
    $("#m-tags").innerHTML = g.tags.map((t) => `<span class="m-tg">${esc(t)}</span>`).join("");
    $("#m-desc").textContent = g.desc || "No description yet.";
    $("#m-platform").textContent = g.swf ? "Flash (Ruffle)" : "Web";
    $("#m-time").textContent = fmt(times[g.id] || 0);
    const hx = history.find((x) => x.id === g.id);
    $("#m-last").textContent = hx ? ago(hx.at) : "Never";
    $("#modal").hidden = false;
    $("#modal").scrollTop = 0;
  }
  const closeModal = () => { $("#modal").hidden = true; modalGame = null; };
  $("#m-close").onclick = closeModal;
  $("#m-play").onclick = () => { const g = modalGame; closeModal(); if (g) play(g); };

  // ---------- Game ----------
  let current = null, playStart = 0;
  function play(g) {
    if (current && current.id !== g.id) stopGame();
    closeModal();
    if (!current) {
      current = g;
      playStart = Date.now();
      history = [{ id: g.id, at: Date.now() }, ...history.filter((x) => x.id !== g.id)].slice(0, 40);
      store.set("history", history);
      const src = g.swf ? `play.html?v=${VERSION}&game=${encodeURIComponent(g.swf)}` : g.url;
      $("#game-empty").hidden = !!src;
      $("#game-load-title").textContent = g.title;
      $("#game-load").classList.remove("out");
      const f = $("#frame");
      f.onload = () => setTimeout(() => $("#game-load").classList.add("out"), 400);
      f.src = src || "about:blank";
      $("#notch-game-title").textContent = g.title;
      heroIdx = 0; renderHero(); renderSidebar();
    }
    showGame();
    if (settings.fullscreen) fullscreen();
  }
  function showGame() {
    if (!current) return;
    $("#game").hidden = false;
    document.body.classList.add("playing");
    $("#notch-game").hidden = false;
    $("#notch-game").classList.add("active");
    $("#notch-home").classList.remove("active");
    setTimeout(() => $("#frame").focus(), 50);
  }
  function hideGame() {
    $("#game").hidden = true;
    document.body.classList.remove("playing");
    $("#notch-game").classList.remove("active");
    $("#notch-home").classList.add("active");
  }
  function stopGame() {
    if (!current) return;
    times[current.id] = (times[current.id] || 0) + (Date.now() - playStart);
    store.set("times", times);
    current = null;
    $("#frame").src = "about:blank";
    $("#notch-game").hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    hideGame();
    heroIdx = 0;
    renderHome(); renderLibrary(); renderSidebar();
  }
  function fullscreen() { $("#game").requestFullscreen?.().catch(() => {}); }
  // Save play time periodically so closing the tab doesn't lose it
  setInterval(() => {
    if (!current) return;
    const now = Date.now();
    times[current.id] = (times[current.id] || 0) + (now - playStart);
    playStart = now;
    store.set("times", times);
    $("#total").textContent = fmt(totalMs());
  }, 15000);

  $("#notch-home").onclick = () => show(tab);
  $("#notch-game").onclick = (e) => { if (e.target.id !== "notch-exit" && e.target.id !== "notch-full") showGame(); };
  $("#notch-full").onclick = (e) => { e.stopPropagation(); showGame(); fullscreen(); };
  $("#notch-exit").onclick = (e) => { e.stopPropagation(); stopGame(); };
  $("#game-exit").onclick = stopGame;
  $("#game-full").onclick = fullscreen;
  document.addEventListener("fullscreenchange", () => document.body.classList.toggle("in-fullscreen", !!document.fullscreenElement));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#modal").hidden) closeModal();
    else if (current && !$("#game").hidden && !document.fullscreenElement) hideGame();
  });

  // ---------- Settings ----------
  const THEMES = {
    green: "#22c55e", red: "#ff4d4d", neon: "#00d2ff", sunset: "#f53b57", amethyst: "#a55eea",
    gold: "#f1c40f", hacker: "#00ff00", ocean: "#0abde3", cyber: "#d980fa", ice: "#c8d6e5",
    rose: "#f368e0", mint: "#1dd1a1", orange: "#ff9f43", white: "#ffffff",
  };
  function applyTheme() {
    document.documentElement.style.setProperty("--accent", THEMES[settings.theme] || THEMES.green);
    document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.theme === settings.theme));
  }
  Object.entries(THEMES).forEach(([name, color]) => {
    const s = h("button", "swatch"); s.style.background = color; s.dataset.theme = name; s.title = name;
    s.onclick = () => { settings.theme = name; save(); applyTheme(); };
    $("#themes").appendChild(s);
  });

  const P_ICONS = {
    none: `<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>`,
    snow: `<path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/>`,
    rain: `<path d="M16 13v8M8 13v8M12 15v8M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/>`,
    stars: `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>`,
    bubbles: `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>`,
    fireflies: `<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>`,
    nexus: `<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M8 8l8 8M8 16l8-8"/>`,
  };
  Object.entries(P_ICONS).forEach(([name, path]) => {
    const c = h("button", "p-card", `<svg viewBox="0 0 24 24">${path}</svg><span>${name[0].toUpperCase() + name.slice(1)}</span>`);
    c.dataset.p = name;
    c.onclick = () => { settings.particles = name; save(); particles.set(name); markParticles(); };
    $("#particle-opts").appendChild(c);
  });
  const markParticles = () => document.querySelectorAll(".p-card").forEach((c) => c.classList.toggle("active", c.dataset.p === settings.particles));

  $("#opt-fullscreen").checked = settings.fullscreen;
  $("#opt-rotate").checked = settings.rotate;
  $("#opt-fullscreen").onchange = (e) => { settings.fullscreen = e.target.checked; save(); };
  $("#opt-rotate").onchange = (e) => { settings.rotate = e.target.checked; save(); startRotate(); };
  $("#clear-history").onclick = () => {
    if (!confirm("Clear your play history and play time?")) return;
    history = []; times = {};
    store.set("history", history); store.set("times", times);
    renderHome(); renderLibrary(); renderSidebar(); renderAccount();
  };

  // ---------- Profile ----------
  function renderAccount() {
    const name = settings.name.trim() || "Player";
    $("#acc-name-title").textContent = name;
    $("#acc-time").textContent = fmt(totalMs());
    $("#acc-played").textContent = Object.keys(times).filter((k) => byId[k]).length || new Set(history.map((x) => x.id)).size;
    const fav = Object.entries(times).filter(([k]) => byId[k]).sort((a, b) => b[1] - a[1])[0];
    $("#acc-fav").textContent = fav ? byId[fav[0]].title : "-";
    $("#acc-lib").textContent = games.length + " games";
  }
  $("#acc-name").value = settings.name;
  $("#acc-name").oninput = (e) => { settings.name = e.target.value; save(); renderAccount(); };

  // ---------- Particles ----------
  const particles = (() => {
    const cv = $("#particles"), ctx = cv.getContext("2d");
    let W = 0, H = 0, ps = [], type = "none", raf = 0;
    const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
    addEventListener("resize", resize); resize();
    const R = (a, b) => a + Math.random() * (b - a);
    const make = () => {
      const n = { snow: 90, rain: 120, stars: 110, bubbles: 35, fireflies: 45, nexus: 60 }[type] || 0;
      ps = Array.from({ length: n }, () => ({ x: R(0, W), y: R(0, H), r: R(.5, 2.5), vx: R(-.3, .3), vy: R(.2, 1), a: R(.2, 1), t: R(0, 6.28) }));
    };
    const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#22c55e";
    function frame() {
      raf = requestAnimationFrame(frame);
      if (document.hidden || document.body.classList.contains("playing")) return;
      ctx.clearRect(0, 0, W, H);
      const col = accent();
      for (const p of ps) {
        p.t += .02;
        if (type === "snow") { p.y += p.vy; p.x += Math.sin(p.t) * .4; ctx.fillStyle = `rgba(255,255,255,${p.a * .7})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); }
        else if (type === "rain") { p.y += p.vy * 12; ctx.strokeStyle = `rgba(160,190,255,${p.a * .35})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 1, p.y + 12); ctx.stroke(); }
        else if (type === "stars") { ctx.globalAlpha = .25 + Math.abs(Math.sin(p.t * .6)) * .6 * p.a; ctx.fillStyle = "#fff"; ctx.fillRect(p.x, p.y, p.r * .8, p.r * .8); ctx.globalAlpha = 1; }
        else if (type === "bubbles") { p.y -= p.vy * .8; p.x += Math.sin(p.t) * .3; ctx.strokeStyle = `rgba(255,255,255,${p.a * .25})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 6, 0, 7); ctx.stroke(); }
        else if (type === "fireflies") { p.x += p.vx + Math.cos(p.t) * .3; p.y += Math.sin(p.t * .7) * .4; ctx.globalAlpha = Math.abs(Math.sin(p.t)) * .8; ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); ctx.shadowBlur = 0; ctx.globalAlpha = 1; }
        else if (type === "nexus") { p.x += p.vx; p.y += p.vx * (p.vy - .6); ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.fillRect(p.x, p.y, 2, 2); }
        if (p.y > H + 20) { p.y = -20; p.x = R(0, W); }
        if (p.y < -60) { p.y = H + 20; p.x = R(0, W); }
        if (p.x > W + 20) p.x = -20; if (p.x < -20) p.x = W + 20;
      }
      if (type === "nexus") {
        ctx.lineWidth = 1;
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
          const dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y, d = dx * dx + dy * dy;
          if (d < 14000) { ctx.strokeStyle = `rgba(255,255,255,${.12 * (1 - d / 14000)})`; ctx.beginPath(); ctx.moveTo(ps[i].x, ps[i].y); ctx.lineTo(ps[j].x, ps[j].y); ctx.stroke(); }
        }
      }
    }
    return {
      set(t) {
        type = t; make(); cancelAnimationFrame(raf); ctx.clearRect(0, 0, W, H);
        if (t !== "none" && !matchMedia("(prefers-reduced-motion: reduce)").matches) frame();
      },
    };
  })();

  // ---------- Init ----------
  applyTheme();
  markParticles();
  particles.set(settings.particles);
  show("home");
  renderHome(); renderLibrary(); renderSidebar(); renderAccount();
  startRotate();
  clock(); setInterval(clock, 10000);
  setInterval(renderSidebar, 60000);
  setTimeout(() => { $("#boot").classList.add("out"); setTimeout(() => $("#boot").remove(), 600); }, 1400);
})();
