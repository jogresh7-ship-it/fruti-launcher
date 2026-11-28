// Earth Flight: fly a plane over the real world.
// Map: MapLibre GL + OpenFreeMap (streets, 3D buildings) or Esri World Imagery (satellite),
// with real mountains from Mapzen terrain tiles. Place names come from the Earth API.
(() => {
  const served = location.protocol.startsWith("http");
  const call = (path) => (served ? fetch(path) : EarthAPI.handle(new Request("https://earth.local" + path)));
  async function api(path) {
    const res = await call(path);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.status);
    return body;
  }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const RAD = Math.PI / 180;
  const M_PER_DEG = 111320;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ---------- places ----------
  const PLACES = [
    { name: "New York", sub: "Up Manhattan", lat: 40.6990, lon: -74.0205, heading: 25, alt: 230 },
    { name: "Paris", sub: "Eiffel Tower and the Seine", lat: 48.8500, lon: 2.2790, heading: 45, alt: 190 },
    { name: "Dubai", sub: "Burj Khalifa", lat: 25.1800, lon: 55.2550, heading: 40, alt: 420 },
    { name: "Tokyo", sub: "Shibuya to Shinjuku", lat: 35.6560, lon: 139.7000, heading: 345, alt: 260 },
    { name: "San Francisco", sub: "Golden Gate", lat: 37.8040, lon: -122.4300, heading: 285, alt: 200 },
    { name: "London", sub: "Along the Thames", lat: 51.4990, lon: -0.1210, heading: 70, alt: 180 },
    { name: "Rio de Janeiro", sub: "Sugarloaf and beaches", lat: -22.9720, lon: -43.1820, heading: 20, alt: 380 },
    { name: "Swiss Alps", sub: "Matterhorn, 4,478 m", lat: 45.9300, lon: 7.6600, heading: 0, alt: 3900 },
    { name: "Grand Canyon", sub: "South Rim", lat: 36.0570, lon: -112.1400, heading: 0, alt: 2400 },
  ];

  // ---------- map styles ----------
  const OFM = "https://tiles.openfreemap.org";
  const STYLES = {
    streets: `${OFM}/styles/liberty`,
    satellite: {
      version: 8,
      glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
      sources: {
        photo: { type: "raster", tileSize: 256, maxzoom: 19,
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
        labels: { type: "raster", tileSize: 256, maxzoom: 19,
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"] },
        openmaptiles: { type: "vector", url: `${OFM}/planet`, attribution: "© OpenStreetMap contributors, OpenFreeMap" },
      },
      layers: [
        { id: "photo", type: "raster", source: "photo" },
        { id: "labels", type: "raster", source: "labels" },
      ],
    },
  };

  // ---------- state ----------
  const params = new URLSearchParams(location.search);
  let start = PLACES[0];
  if (params.get("lat") && params.get("lon")) {
    const lat = Number(params.get("lat")), lon = Number(params.get("lon"));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      start = { name: params.get("name") || "Your spot", sub: "From the map", lat, lon, heading: 0, alt: null };
    }
  }
  let styleName = "satellite"; // real photos by default, like the main map's Satellite view
  let mode = "free";
  let camMode = 0; // 0 chase, 1 far chase, 2 cockpit
  const plane = { lat: 0, lon: 0, alt: 300, heading: 0, pitch: 0, roll: 0, speed: 90 };
  let state = "menu"; // menu | flying | paused | crashed | finished
  let ground = 0;
  let lastSafe = null;
  let lastFrame = 0;
  const race = { cps: [], idx: 0, startTime: 0, elapsed: 0, marker: null };

  // ---------- map ----------
  const map = new maplibregl.Map({
    container: "map", style: STYLES[styleName], center: [start.lon, start.lat], zoom: 15.5, pitch: 70, bearing: start.heading,
    maxPitch: 100, attributionControl: { compact: true }, interactive: false, fadeDuration: 0,
  });

  function addBuildings() {
    const style = map.getStyle();
    if (!style.sources.openmaptiles || style.layers.some((l) => l.type === "fill-extrusion")) return;
    map.addLayer({
      id: "buildings-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 13,
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8], 0, "#eadcc4", 40, "#d9b98f", 150, "#c98f6b"],
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.92,
      },
    }, styleName === "satellite" ? "labels" : undefined);
  }

  map.on("style.load", () => {
    buildings.clear();
    try { map.setProjection({ type: "mercator" }); } catch { /* older styles */ }
    if (!map.getSource("dem")) {
      map.addSource("dem", { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15,
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        attribution: "Elevation: Mapzen Terrain Tiles (AWS Open Data)" });
    }
    map.setTerrain({ source: "dem", exaggeration: 1 });
    // Shade the slopes so hills and mountains look 3D on the colorful street map too.
    if (!map.getSource("hills") && styleName === "streets") {
      map.addSource("hills", { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15,
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] });
    }
    if (!map.getLayer("hillshade") && styleName === "streets") { // photos already have real shadows
      const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol" || l.id === "labels")?.id;
      map.addLayer({ id: "hillshade", type: "hillshade", source: "hills",
        paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#2f4a3a", "hillshade-highlight-color": "#fffbe8", "hillshade-accent-color": "#5b6b4a" } }, firstSymbol);
    }
    try {
      map.setSky({ "sky-color": "#4f9cf5", "horizon-color": "#cfe6ff", "fog-color": "#e3f0ff",
        "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.5, "atmosphere-blend": 0.9 });
    } catch { /* sky not supported */ }
    try { addBuildings(); } catch (e) { console.warn("buildings:", e); }
    styleReady = true;
    add3D();
  });

  // ---------- 3D models (fly3d.js, a module that may load after this file) ----------
  let model3D = false; // true once the 3D plane replaces the flat picture
  const game3D = {
    plane: () => plane,
    ground: (lon, lat) => groundAt(lon, lat),
    flying: () => state === "flying",
    showPlane: () => camMode !== 2 && state !== "menu",
    onPlaneReady() { model3D = true; $("plane").style.display = "none"; },
  };
  let styleReady = false;
  function add3D() {
    if (!window.EarthFlight3D || !styleReady) return;
    try { window.EarthFlight3D.addTo(map, game3D); } catch (e) { console.warn("3D models:", e); }
  }
  addEventListener("earthflight3d-ready", add3D);
  map.on("error", (e) => console.warn("map:", e.error?.message || e));

  // ---------- menu ----------
  function renderPlaces() {
    const list = start.alt === null ? [start, ...PLACES] : PLACES;
    $("places").innerHTML = "";
    for (const p of list) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip";
      b.setAttribute("aria-pressed", String(p === start));
      b.innerHTML = `${esc(p.name)}<small>${esc(p.sub || "")}</small>`;
      b.onclick = () => { start = p; renderPlaces(); preview(); };
      $("places").append(b);
    }
  }
  function pressGroup(rowId, attr, value) {
    document.querySelectorAll(`#${rowId} [${attr}]`).forEach((b) => b.setAttribute("aria-pressed", String(b.getAttribute(attr) === value)));
  }
  document.querySelectorAll("#styleRow [data-style]").forEach((b) => b.onclick = () => {
    styleName = b.dataset.style; pressGroup("styleRow", "data-style", styleName);
    styleReady = false;
    map.setStyle(STYLES[styleName]);
  });
  document.querySelectorAll("#modeRow [data-mode]").forEach((b) => b.onclick = () => {
    mode = b.dataset.mode; pressGroup("modeRow", "data-mode", mode);
  });
  $("searchForm").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    const box = $("results");
    box.innerHTML = "";
    if (q.length < 2) return;
    box.textContent = "Searching…";
    try {
      const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}&count=5`);
      box.innerHTML = results.length ? "" : "No places found.";
      for (const r of results) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "chip";
        b.innerHTML = `${esc(r.name)}<small>${esc([r.region, r.country].filter(Boolean).join(", "))}</small>`;
        b.onclick = () => {
          start = { name: r.name, sub: r.country || "", lat: r.lat, lon: r.lon, heading: 0, alt: null };
          box.innerHTML = ""; renderPlaces(); preview();
        };
        box.append(b);
      }
    } catch (err) { box.textContent = "Search failed: " + err.message; }
  };
  function preview() {
    map.jumpTo({ center: [start.lon, start.lat], zoom: 15, pitch: 65, bearing: start.heading || 0 });
  }

  // ---------- input ----------
  const keys = new Set();
  const stick = { x: 0, y: 0 };
  const touchBtn = { boost: false, brake: false };
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) e.preventDefault();
    if (e.key === "Escape" || e.key === "p" || e.key === "P") { togglePause(); return; }
    if ((e.key === "c" || e.key === "C") && state === "flying") { camMode = (camMode + 1) % 3; $("plane").style.opacity = camMode === 2 ? 0 : 1; }
    keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  });
  addEventListener("keyup", (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  addEventListener("blur", () => keys.clear());

  const stickEl = $("stick"), knob = $("knob");
  let stickId = null;
  function moveStick(e) {
    const r = stickEl.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const max = r.width / 2;
    const len = Math.min(max, Math.hypot(dx, dy)) / (Math.hypot(dx, dy) || 1);
    stick.x = clamp((dx * len) / max, -1, 1); stick.y = clamp((dy * len) / max, -1, 1);
    knob.style.transform = `translate(${stick.x * max * 0.7}px, ${stick.y * max * 0.7}px)`;
  }
  stickEl.addEventListener("pointerdown", (e) => { stickId = e.pointerId; stickEl.setPointerCapture(e.pointerId); moveStick(e); });
  stickEl.addEventListener("pointermove", (e) => { if (e.pointerId === stickId) moveStick(e); });
  const endStick = () => { stickId = null; stick.x = stick.y = 0; knob.style.transform = ""; };
  stickEl.addEventListener("pointerup", endStick);
  stickEl.addEventListener("pointercancel", endStick);
  for (const [id, k] of [["boostBtn", "boost"], ["brakeBtn", "brake"]]) {
    const el = $(id);
    el.addEventListener("pointerdown", (e) => { e.preventDefault(); touchBtn[k] = true; el.classList.add("on"); });
    const off = () => { touchBtn[k] = false; el.classList.remove("on"); };
    el.addEventListener("pointerup", off); el.addEventListener("pointercancel", off); el.addEventListener("pointerleave", off);
  }

  function readInput() {
    let turn = 0, climb = 0, boost = false, brake = false;
    if (keys.has("ArrowLeft") || keys.has("a")) turn -= 1;
    if (keys.has("ArrowRight") || keys.has("d")) turn += 1;
    if (keys.has("ArrowUp") || keys.has("w")) climb += 1;
    if (keys.has("ArrowDown") || keys.has("s")) climb -= 1;
    if (keys.has("Shift")) boost = true;
    if (keys.has(" ")) brake = true;
    turn += stick.x; climb -= stick.y;
    boost ||= touchBtn.boost; brake ||= touchBtn.brake;
    const pad = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
      turn += dz(pad.axes[0] || 0); climb -= dz(pad.axes[1] || 0);
      boost ||= (pad.buttons[7]?.value || 0) > 0.3 || pad.buttons[0]?.pressed;
      brake ||= (pad.buttons[6]?.value || 0) > 0.3 || pad.buttons[1]?.pressed;
      if (pad.buttons[9]?.pressed && !readInput.startHeld) togglePause();
      readInput.startHeld = !!pad.buttons[9]?.pressed;
    }
    return { turn: clamp(turn, -1, 1), climb: clamp(climb, -1, 1), boost, brake };
  }

  // ---------- flight ----------
  function groundAt(lon, lat) {
    const h = map.queryTerrainElevation ? map.queryTerrainElevation([lon, lat]) : null;
    return Number.isFinite(h) ? h : 0;
  }

  function placePlane(p) {
    plane.lat = p.lat; plane.lon = p.lon; plane.heading = p.heading || 0;
    plane.pitch = 0; plane.roll = 0; plane.speed = 90;
    const g = groundAt(p.lon, p.lat);
    plane.alt = p.alt ?? g + 250;
    if (plane.alt < g + 120) plane.alt = g + 250;
  }

  function step(dt, input) {
    const targetSpeed = input.boost ? 260 : input.brake ? 45 : 100; // m/s
    plane.speed += (targetSpeed - plane.speed) * Math.min(1, dt * (input.boost ? 0.9 : 0.6));
    plane.roll += (input.turn * 55 - plane.roll) * Math.min(1, dt * 3);
    plane.pitch += (input.climb * 28 - plane.pitch) * Math.min(1, dt * 2.5);
    plane.heading = (plane.heading + (plane.roll / 55) * 50 * dt + 360) % 360;
    const d = plane.speed * dt;
    const horiz = d * Math.cos(plane.pitch * RAD);
    plane.alt = Math.min(plane.alt + d * Math.sin(plane.pitch * RAD), 9000);
    plane.lat = clamp(plane.lat + (horiz * Math.cos(plane.heading * RAD)) / M_PER_DEG, -84, 84);
    plane.lon += (horiz * Math.sin(plane.heading * RAD)) / (M_PER_DEG * Math.cos(plane.lat * RAD));
    if (plane.lon > 180) plane.lon -= 360;
    if (plane.lon < -180) plane.lon += 360;
    $("plane").classList.toggle("boost", input.boost);
  }

  function updateCamera() {
    const h = plane.heading * RAD;
    const big = model3D ? 1.7 : 1; // the 3D airliner is bigger than the flat picture
    const back = camMode === 0 ? (70 + plane.speed * 0.22) * big : camMode === 1 ? (260 + plane.speed * 0.4) * big : -2;
    const up = camMode === 0 ? (16 + plane.speed * 0.04) * big : camMode === 1 ? 90 * big : 0;
    const camLat = plane.lat - (back * Math.cos(h)) / M_PER_DEG;
    const camLon = plane.lon - (back * Math.sin(h)) / (M_PER_DEG * Math.cos(plane.lat * RAD));
    const camAlt = Math.max(plane.alt + up, groundAt(camLon, camLat) + 5);
    const down = camMode === 2 ? 4 : Math.atan2(up, back) / RAD;
    const pitch = clamp(90 - down + plane.pitch * 0.55, 0, 100);
    const roll = plane.roll * (camMode === 2 ? 0.9 : 0.35);
    try {
      map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation([camLon, camLat], camAlt, plane.heading, pitch, roll));
    } catch (e) { /* camera can fail for a frame while the style reloads */ }
    $("plane").style.transform = `rotate(${(plane.roll - roll).toFixed(1)}deg)`;
  }

  // ---------- collisions ----------
  function inRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // MapLibre only returns buildings from tiles that are in view, and the chase camera
  // looks ahead, so the ground right under the plane is usually off screen. We
  // remember buildings as they come into view and test the plane against that memory.
  const buildings = new Map();
  const LANDMARK_SPOTS = [{ lon: 2.294481, lat: 48.858258, r: 90 }]; // Eiffel Tower: fly3d.js handles its shape
  function scanBuildings() {
    if (!map.getSource("openmaptiles")) return;
    const agl = plane.alt - ground;
    if (agl > 900) return;
    let feats;
    try {
      feats = map.querySourceFeatures("openmaptiles", {
        sourceLayer: "building",
        filter: [">=", ["coalesce", ["get", "render_height"], 8], Math.max(0, agl - 150)],
      });
    } catch { return; }
    for (const f of feats) {
      const g = f.geometry;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const rings of polys) {
        if (!rings[0] || rings[0].length < 4) continue;
        let minX = 180, minY = 90, maxX = -180, maxY = -90;
        for (const [x, y] of rings[0]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        const key = `${minX.toFixed(6)},${minY.toFixed(6)},${maxX.toFixed(6)},${maxY.toFixed(6)}`;
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        if (LANDMARK_SPOTS.some((l) => Math.abs(cx - l.lon) < l.r / (M_PER_DEG * Math.cos(cy * RAD)) && Math.abs(cy - l.lat) < l.r / M_PER_DEG)) continue;
        if (!buildings.has(key)) {
          buildings.set(key, { rings, minX, minY, maxX, maxY,
            top: f.properties.render_height ?? 8, base: f.properties.render_min_height ?? 0 });
        }
      }
    }
    if (buildings.size > 20000) {
      for (const [k, b] of buildings) {
        if (Math.abs(b.minY - plane.lat) > 0.03 || Math.abs(b.minX - plane.lon) > 0.04) buildings.delete(k);
      }
    }
  }
  function hitBuilding() {
    const agl = plane.alt - ground;
    const x = plane.lon, y = plane.lat, pt = [x, y];
    for (const b of buildings.values()) {
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
      if (agl < b.top && agl > b.base - 2 && inRing(pt, b.rings[0]) && !b.rings.slice(1).some((hole) => inRing(pt, hole))) return b.top;
    }
    return null;
  }

  function crash(what, name) {
    state = "crashed";
    $("crashTitle").textContent = what === "landmark" ? `You hit the ${name}!` : what === "tree" ? "You flew into the trees!" : what === "building" ? "You hit a building!" : what === "water" ? "Splash! You hit the water." : "You hit the ground!";
    $("crashText").textContent = `${placeLabel || "Somewhere on Earth"} · ${Math.round(plane.speed * 3.6)} km/h`;
    $("crash").hidden = false;
  }

  // ---------- race ----------
  function distanceM(aLat, aLon, bLat, bLon) {
    const dy = (bLat - aLat) * M_PER_DEG;
    const dx = (bLon - aLon) * M_PER_DEG * Math.cos(((aLat + bLat) / 2) * RAD);
    return { d: Math.hypot(dx, dy), bearing: (Math.atan2(dx, dy) / RAD + 360) % 360 };
  }
  function newRace() {
    race.cps = [];
    let lat = plane.lat, lon = plane.lon, hdg = plane.heading;
    for (let i = 0; i < 8; i++) {
      hdg = (hdg + (Math.random() * 120 - 60) + 360) % 360;
      const dist = 700 + Math.random() * 900;
      lat += (dist * Math.cos(hdg * RAD)) / M_PER_DEG;
      lon += (dist * Math.sin(hdg * RAD)) / (M_PER_DEG * Math.cos(lat * RAD));
      race.cps.push({ lat, lon });
    }
    race.idx = 0;
    race.startTime = performance.now();
    race.elapsed = 0;
    showCheckpoint();
  }
  function showCheckpoint() {
    race.marker?.remove();
    const cp = race.cps[race.idx];
    if (!cp) return;
    const el = document.createElement("div");
    el.className = "beacon";
    el.innerHTML = '<div class="beam"></div><div class="ring"></div>';
    race.marker = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([cp.lon, cp.lat]).addTo(map);
    $("rIdx").textContent = race.idx + 1;
    $("rTotal").textContent = race.cps.length;
  }
  function fmtTime(ms) {
    const s = ms / 1000;
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  }
  function raceTick() {
    const cp = race.cps[race.idx];
    if (!cp) return;
    race.elapsed = performance.now() - race.startTime;
    $("rTime").textContent = fmtTime(race.elapsed);
    const { d, bearing } = distanceM(plane.lat, plane.lon, cp.lat, cp.lon);
    const rel = ((bearing - plane.heading + 540) % 360) - 180;
    $("tArrow").style.transform = `rotate(${rel.toFixed(0)}deg)`;
    $("tText").textContent = d > 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
    if (d < 120 && plane.alt - ground < 600) {
      race.idx++;
      toast(race.idx < race.cps.length ? `✓ Checkpoint ${race.idx}` : "");
      if (race.idx >= race.cps.length) finishRace(); else showCheckpoint();
    }
  }
  function finishRace() {
    race.marker?.remove(); race.marker = null;
    state = "finished";
    const key = `earthflight-best-${start.name}`;
    const best = store.get(key);
    const isBest = !best || race.elapsed < best;
    if (isBest) store.set(key, race.elapsed);
    $("finishTime").textContent = fmtTime(race.elapsed);
    $("finishText").textContent = isBest ? `New best time for ${start.name}!` : `Best for ${start.name}: ${fmtTime(best)}`;
    $("finish").hidden = false;
  }

  let toastTimer = null;
  function toast(text) {
    if (!text) return;
    const t = $("toast");
    t.textContent = text; t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.display = "none"), 1400);
  }

  // ---------- HUD ----------
  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  let placeLabel = "";
  let lastLookup = 0;
  async function lookupPlace() {
    lastLookup = performance.now();
    try {
      const r = await api(`/api/reverse?lat=${plane.lat.toFixed(4)}&lon=${plane.lon.toFixed(4)}&zoom=12`);
      const main = r.town || r.name || r.region || (r.country ? "" : "Over the ocean");
      placeLabel = [main, r.country].filter(Boolean).join(", ");
      $("placeName").textContent = main || r.country || "Over the ocean";
      $("placeSub").textContent = [r.region, r.country].filter((x) => x && x !== main).join(", ") || " ";
    } catch { /* keep the old name */ }
  }
  function hud() {
    $("hdg").textContent = `${DIRS[Math.round(plane.heading / 45) % 8]} ${String(Math.round(plane.heading) % 360).padStart(3, "0")}°`;
    $("gSpeed").textContent = `${Math.round(plane.speed * 3.6)} km/h`;
    $("gAlt").textContent = `${Math.round(plane.alt).toLocaleString()} m`;
    const agl = Math.round(plane.alt - ground);
    $("gAgl").textContent = `${agl.toLocaleString()} m`;
    $("gAgl").classList.toggle("warn", agl < 40);
    if (performance.now() - lastLookup > 7000) lookupPlace();
  }

  // ---------- loop ----------
  let collideTimer = 0, scanTimer = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (t - lastFrame) / 1000 || 0);
    lastFrame = t;
    if (state !== "flying") return;
    step(dt, readInput());
    ground = groundAt(plane.lon, plane.lat);
    if (plane.alt < ground + 2) return crash(ground <= 1 ? "water" : "ground");
    collideTimer += dt;
    scanTimer += dt;
    if (scanTimer > 0.4) { scanTimer = 0; scanBuildings(); }
    if (collideTimer > 0.1) {
      collideTimer = 0;
      if (hitBuilding() !== null) return crash("building");
      const landmark = window.EarthFlight3D?.hitLandmark(plane.lon, plane.lat, plane.alt);
      if (landmark) return crash("landmark", landmark);
      if (window.EarthFlight3D?.hitTree(plane.lon, plane.lat, plane.alt)) return crash("tree");
      if (plane.alt - ground > 60) lastSafe = { lat: plane.lat, lon: plane.lon, alt: plane.alt, heading: plane.heading };
    }
    updateCamera();
    hud();
    if (mode === "race") raceTick();
  }
  requestAnimationFrame(frame);

  // ---------- screens ----------
  function hideScreens() { for (const id of ["menu", "pause", "crash", "finish"]) $(id).hidden = true; document.body.classList.remove("inmenu"); }
  function takeOff() {
    hideScreens();
    placePlane(start);
    lastSafe = null;
    buildings.clear();
    window.EarthFlight3D?.resetTrees();
    camMode = 0; $("plane").style.opacity = 1;
    $("pauseBtn").style.display = "block";
    const racing = mode === "race";
    document.body.classList.toggle("racing", racing);
    $("race").style.display = racing ? "block" : "none";
    $("target").style.display = racing ? "block" : "none";
    const best = store.get(`earthflight-best-${start.name}`);
    $("rBest").textContent = best ? `Best ${fmtTime(best)}` : "";
    race.marker?.remove(); race.marker = null;
    if (racing) newRace();
    lookupPlace();
    state = "flying";
    toast(racing ? "Fly through the yellow beacons!" : `Welcome to ${start.name}`);
  }
  function togglePause() {
    if (state === "flying") { state = "paused"; $("pause").hidden = false; }
    else if (state === "paused") { state = "flying"; $("pause").hidden = true; lastFrame = performance.now(); if (mode === "race") race.startTime = performance.now() - race.elapsed; }
  }
  function toMenu() {
    hideScreens();
    state = "menu";
    race.marker?.remove(); race.marker = null;
    $("pauseBtn").style.display = "none";
    $("race").style.display = "none"; $("target").style.display = "none";
    $("menu").hidden = false;
    document.body.classList.add("inmenu");
    preview();
  }
  $("takeoff").onclick = takeOff;
  $("pauseBtn").onclick = togglePause;
  $("resume").onclick = togglePause;
  for (const id of ["toMenu1", "toMenu2", "toMenu3"]) $(id).onclick = toMenu;
  $("respawn").onclick = () => {
    hideScreens();
    const p = lastSafe || { lat: start.lat, lon: start.lon, heading: start.heading, alt: null };
    placePlane({ ...p, alt: Math.max(p.alt ?? 0, groundAt(p.lon, p.lat) + 200) });
    state = "flying";
    lastFrame = performance.now();
    if (mode === "race") race.startTime = performance.now() - race.elapsed;
  };
  $("again").onclick = () => { mode = "race"; pressGroup("modeRow", "data-mode", "race"); takeOff(); };
  $("freeFly").onclick = () => {
    mode = "free"; pressGroup("modeRow", "data-mode", "free");
    hideScreens();
    $("race").style.display = "none"; $("target").style.display = "none";
    document.body.classList.remove("racing");
    state = "flying"; lastFrame = performance.now();
  };

  renderPlaces();
  window.earthFlight = { map, plane, race, hitBuilding, buildings, state: () => state }; // handy for debugging in the browser console
})();
