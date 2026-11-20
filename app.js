(() => {
  const games = window.FRUTI_GAMES || [];
  const $ = (s) => document.querySelector(s);
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));

  // ---------- Storage (safe) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("fruti:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("fruti:" + k, JSON.stringify(v)); } catch {} },
  };
  let history = store.get("history", []);       // [{id, at}]
  let totalMs = store.get("totalMs", 0);
  const settings = Object.assign({ fullscreen: false, rotate: true, name: "", collapsed: false }, store.get("settings", {}));
  const saveSettings = () => store.set("settings", settings);

  // ---------- Helpers ----------
  const cover = (g) => g.image
    ? `url("${g.image}")`
    : `linear-gradient(135deg, ${g.color?.[0] || "#333"}, ${g.color?.[1] || "#111"})`;
  const initials = (t) => t.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function card(g) {
    const el = document.createElement("button");
    el.className = "card";
    el.style.backgroundImage = cover(g);
    el.innerHTML = `
      <div class="card-icon" style="background-image:${esc(cover(g))}">${g.image ? "" : esc(initials(g.title))}</div>
      <div class="card-info"><div class="card-title">${esc(g.title)}</div><div class="card-tags">${esc(g.tags.join(" • "))}</div></div>`;
    el.onclick = () => play(g);
    return el;
  }

  // ---------- Navigation ----------
  function show(view) {
    document.querySelectorAll(".view").forEach((v) => (v.hidden = v.dataset.view !== view));
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $(".main").scrollTop = 0;
  }
  document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => show(b.dataset.view)));

  const app = $("#app");
  app.classList.toggle("collapsed", settings.collapsed);
  $("#toggle").onclick = () => {
    settings.collapsed = app.classList.toggle("collapsed");
    saveSettings();
  };

  // ---------- Hero ----------
  const featured = () => {
    const recent = history.map((h) => byId[h.id]).filter(Boolean);
    const list = [...new Set([...recent, ...games])];
    return list.slice(0, 5);
  };
  let heroIdx = 0, heroTimer;
  function renderHero() {
    const list = featured();
    if (!list.length) return;
    const g = list[heroIdx % list.length];
    $("#heroBg").style.backgroundImage = cover(g);
    $("#heroTitle").textContent = g.title;
    $("#heroTags").innerHTML = `<span>${esc(g.tags.join(" • "))}</span>`;
    $("#hero").onclick = (e) => { if (!e.target.closest(".hero-dots")) play(g); };
    $("#heroDots").innerHTML = "";
    list.forEach((_, i) => {
      const d = document.createElement("button");
      d.className = i === heroIdx % list.length ? "on" : "";
      d.setAttribute("aria-label", "Slide " + (i + 1));
      d.onclick = () => { heroIdx = i; renderHero(); restartRotate(); };
      $("#heroDots").appendChild(d);
    });
  }
  function restartRotate() {
    clearInterval(heroTimer);
    if (settings.rotate) heroTimer = setInterval(() => { heroIdx++; renderHero(); }, 6000);
  }

  // ---------- Lists ----------
  function renderRecommend() {
    const row = $("#recommend");
    row.innerHTML = "";
    const played = new Set(history.map((h) => h.id));
    [...games].sort((a, b) => played.has(a.id) - played.has(b.id)).forEach((g) => row.appendChild(card(g)));
  }
  function renderLibrary() {
    const q = $("#search").value.trim().toLowerCase();
    const grid = $("#library");
    grid.innerHTML = "";
    const list = games.filter((g) => !q || g.title.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q)));
    if (!list.length) grid.innerHTML = `<p class="muted">No games found.</p>`;
    list.forEach((g) => grid.appendChild(card(g)));
  }
  $("#search").oninput = renderLibrary;

  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    if (m < 1440) return Math.round(m / 60) + "h ago";
    return Math.round(m / 1440) + "d ago";
  }
  function renderHistory() {
    const box = $("#history");
    const items = history.filter((h) => byId[h.id]);
    if (!items.length) { box.innerHTML = `<div class="history-empty">No History</div>`; return; }
    box.innerHTML = "";
    items.slice(0, 12).forEach((h) => {
      const g = byId[h.id];
      const el = document.createElement("button");
      el.className = "history-item";
      el.title = g.title;
      el.innerHTML = `<div class="history-thumb" style="background-image:${esc(cover(g))}"></div>
        <div><div class="history-name">${esc(g.title)}</div><div class="history-time">${ago(h.at)}</div></div>`;
      el.onclick = () => play(g);
      box.appendChild(el);
    });
  }
  function renderTotal() {
    const m = Math.floor(totalMs / 60000);
    $("#total").textContent = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }
  function renderClock() {
    $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // ---------- Player ----------
  let playStart = 0;
  function play(g) {
    history = [{ id: g.id, at: Date.now() }, ...history.filter((h) => h.id !== g.id)].slice(0, 30);
    store.set("history", history);
    renderHistory();
    $("#playerTitle").textContent = g.title;
    const src = g.swf ? "play.html?swf=" + encodeURIComponent(g.swf) : g.url;
    $("#playerFrame").src = src || "about:blank";
    $("#playerEmpty").hidden = !!src;
    $("#player").hidden = false;
    playStart = Date.now();
    if (settings.fullscreen) $("#player").requestFullscreen?.().catch(() => {});
  }
  function closePlayer() {
    if ($("#player").hidden) return;
    totalMs += Date.now() - playStart;
    store.set("totalMs", totalMs);
    renderTotal();
    $("#player").hidden = true;
    $("#playerFrame").src = "about:blank";
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    heroIdx = 0; renderHero(); renderRecommend();
  }
  $("#playerClose").onclick = closePlayer;
  $("#playerFull").onclick = () => $("#player").requestFullscreen?.().catch(() => {});
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !document.fullscreenElement) closePlayer(); });

  // ---------- Settings ----------
  $("#optFullscreen").checked = settings.fullscreen;
  $("#optRotate").checked = settings.rotate;
  $("#optName").value = settings.name;
  $("#optFullscreen").onchange = (e) => { settings.fullscreen = e.target.checked; saveSettings(); };
  $("#optRotate").onchange = (e) => { settings.rotate = e.target.checked; saveSettings(); restartRotate(); };
  $("#optName").oninput = (e) => { settings.name = e.target.value; saveSettings(); };
  $("#clearHistory").onclick = () => {
    history = []; totalMs = 0;
    store.set("history", history); store.set("totalMs", 0);
    renderHistory(); renderTotal(); renderHero(); renderRecommend();
  };

  // ---------- Init ----------
  renderHero(); restartRotate();
  renderRecommend(); renderLibrary(); renderHistory(); renderTotal();
  renderClock(); setInterval(renderClock, 10000);
})();
