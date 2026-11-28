// Map and API explorer for index.html.
const served = location.protocol.startsWith("http");
document.getElementById("mode").textContent = served ? "live server" : "running in your browser";

// Same router on a server or right here in the page when opened from disk.
function call(path) {
  return served ? fetch(path) : EarthAPI.handle(new Request("https://earth.local" + path));
}
async function api(path) {
  const res = await call(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.status);
  return body;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(n)) ? "–" : n.toLocaleString(undefined, { maximumFractionDigits: d });
const timeIn = (iso, tz) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: tz || undefined }) : "–";

// ================= MAP =================
const OFM = "https://tiles.openfreemap.org";
const STYLES = {
  // Colorful vector map: green parks and woods, blue water, tan buildings that rise in 3D.
  streets: `${OFM}/styles/liberty`,
  // Real aerial photos (actual tree, field and roof colors) with 3D buildings and labels on top.
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
  // Topographic: forest greens, contour lines, rivers and peaks.
  topo: {
    version: 8,
    sources: {
      topo: { type: "raster", tileSize: 256, maxzoom: 17,
        tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png", "https://b.tile.opentopomap.org/{z}/{x}/{y}.png", "https://c.tile.opentopomap.org/{z}/{x}/{y}.png"],
        attribution: "© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors" },
    },
    layers: [{ id: "topo", type: "raster", source: "topo" }],
  },
};

let map = null;
let current = "streets";
const $ = (id) => document.getElementById(id);

function addBuildings() {
  const style = map.getStyle();
  if (!style.sources.openmaptiles) return;
  const has3d = style.layers.some((l) => l.type === "fill-extrusion");
  if (has3d) return;
  const before = style.layers.find((l) => l.type === "symbol" && current === "streets")?.id;
  map.addLayer({
    id: "buildings-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 14,
    paint: {
      "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8], 0, "#e8d9c0", 40, "#d9b98f", 120, "#c98f6b"],
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": current === "satellite" ? 0.9 : 0.85,
    },
  }, current === "satellite" ? "labels" : before);
}

function applyExtras() {
  if (!map.isStyleLoaded()) return;
  try { map.setProjection({ type: $("globe").checked ? "globe" : "mercator" }); } catch (e) {}
  if (!map.getSource("dem")) {
    map.addSource("dem", { type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 15,
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      attribution: "Elevation: Mapzen Terrain Tiles (AWS Open Data)" });
  }
  map.setTerrain($("mountains").checked ? { source: "dem", exaggeration: 1.4 } : null);
  try {
    map.setSky({ "sky-color": "#5fa8ff", "horizon-color": "#d8ecff", "fog-color": "#eaf4ff",
      "sky-horizon-blend": 0.5, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.4, "atmosphere-blend": 0.8 });
  } catch (e) {}
  try { addBuildings(); } catch (e) { console.warn("3D buildings:", e); }
}

function setStyle(name) {
  current = name;
  document.querySelectorAll("[data-style]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.style === name)));
  map.setStyle(STYLES[name]);
}

function initMap() {
  if (!window.maplibregl) { $("maperr").style.display = "flex"; return; }
  map = new maplibregl.Map({
    container: "map", style: STYLES.streets, center: [10, 25], zoom: 1.7, maxPitch: 80,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl(), "bottom-right");
  map.on("style.load", applyExtras);
  map.on("click", (e) => showPoint(e.lngLat.lat, e.lngLat.lng));
  map.on("error", (e) => console.warn("map:", e.error?.message || e));
  // Slow spin on the globe until someone touches the map.
  let spinning = true;
  const stop = () => { spinning = false; };
  window.stopSpin = stop;
  ["mousedown", "touchstart", "wheel", "dragstart"].forEach((ev) => map.on(ev, stop));
  const spin = () => {
    if (!spinning || map.getZoom() > 3) return;
    const c = map.getCenter(); c.lng -= 6;
    map.easeTo({ center: c, duration: 1000, easing: (t) => t });
  };
  map.on("moveend", spin);
  map.once("load", spin);
}

document.querySelectorAll("[data-style]").forEach((b) => b.onclick = () => setStyle(b.dataset.style));
$("globe").onchange = applyExtras;
$("mountains").onchange = () => {
  applyExtras();
  if ($("mountains").checked && map.getPitch() < 30) map.easeTo({ pitch: 60, zoom: Math.max(map.getZoom(), 10) });
};

// ---------- search ----------
$("searchForm").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  const ul = $("results");
  ul.innerHTML = "";
  if (q.length < 2) return;
  try {
    const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}&count=6`);
    if (!results.length) { ul.innerHTML = "<li><small>No places found.</small></li>"; return; }
    if (results.length === 1) return goTo(results[0]);
    for (const r of results) {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button">${esc(r.name)} <small>${esc([r.region, r.country].filter(Boolean).join(", "))}</small></button>`;
      li.firstChild.onclick = () => { ul.innerHTML = ""; goTo(r); };
      ul.append(li);
    }
  } catch (err) {
    ul.innerHTML = `<li><small>Search failed: ${esc(err.message)}</small></li>`;
  }
};

function goTo(r) {
  $("results").innerHTML = "";
  window.stopSpin?.();
  const big = (r.population || 0) > 500000;
  if (map) map.flyTo({ center: [r.lon, r.lat], zoom: big ? 15 : 14, pitch: 60, bearing: -20, speed: 1.4 });
  showPoint(r.lat, r.lon, r);
}

// ---------- click info ----------
let pin = null;
async function showPoint(lat, lon, known) {
  window.stopSpin?.();
  lat = +lat.toFixed(5); lon = +(((lon + 540) % 360) - 180).toFixed(5);
  if (map) {
    if (!pin) pin = new maplibregl.Marker({ color: "#e5484d" });
    pin.setLngLat([lon, lat]).addTo(map);
  }
  const body = $("infoBody");
  $("info").classList.add("open");
  body.innerHTML = `<h3>${esc(known?.name || "Loading…")}</h3><div class="sub">${lat}, ${lon}</div>`;

  const q = `lat=${lat}&lon=${lon}`;
  const [place, weather, air, elev, sun] = await Promise.allSettled([
    known ? Promise.resolve(null) : api(`/api/reverse?${q}`),
    api(`/api/weather?${q}&days=1`),
    api(`/api/air?${q}`),
    api(`/api/elevation?${q}`),
    api(`/api/sun?${q}`),
  ]);
  const v = (s) => (s.status === "fulfilled" ? s.value : null);
  const p = v(place), w = v(weather), a = v(air), el = v(elev), s = v(sun);
  const title = known?.name || p?.name || p?.town || (p ? p.nearest?.split(",")[0] : null) || "Somewhere on Earth";
  const where = known ? [known.region, known.country].filter(Boolean).join(", ") : [p?.town !== title ? p?.town : null, p?.region, p?.country].filter(Boolean).join(", ");
  const tz = w?.timezone;
  const aqiColor = !a ? "inherit" : a.usAqi <= 50 ? "#1a9b5b" : a.usAqi <= 100 ? "#c9a100" : a.usAqi <= 150 ? "#e07b00" : "#d1242f";

  body.innerHTML = `
    <h3>${esc(title)}</h3>
    <div class="sub">${esc(where || "No named place nearby")} · ${lat}, ${lon}</div>
    <div class="stats">
      <div class="stat wide"><span>Weather now</span><b>${w ? `${fmt(w.current.temperatureC, 1)}°C · ${esc(w.current.description)}` : "–"}</b>
        ${w ? `<span>Feels ${fmt(w.current.feelsLikeC, 0)}° · wind ${fmt(w.current.windKmh)} km/h ${esc(w.current.windFrom || "")} · humidity ${fmt(w.current.humidityPercent)}%</span>` : ""}</div>
      <div class="stat"><span>Air quality</span><b style="color:${aqiColor}">${a ? fmt(a.usAqi) : "–"}</b><span>${esc(a?.level || "")}</span></div>
      <div class="stat"><span>Elevation</span><b>${el ? fmt(el.elevationM) + " m" : "–"}</b><span>${el ? fmt(el.elevationFt) + " ft" : ""}</span></div>
      <div class="stat"><span>☀️ Sunrise</span><b>${s?.polar === "polar-night" ? "None" : s?.polar ? "Always up" : timeIn(s?.sunrise, tz)}</b></div>
      <div class="stat"><span>🌇 Sunset</span><b>${s?.polar ? "–" : timeIn(s?.sunset, tz)}</b></div>
      <div class="stat"><span>Daylight</span><b>${s ? fmt(s.dayLengthHours, 1) + " h" : "–"}</b></div>
      <div class="stat"><span>Moon</span><b style="font-size:14px">${esc(s?.moon.phase || "–")}</b></div>
    </div>
    <div class="sub" style="margin:10px 0 0">${tz ? "Times in local time (" + esc(tz) + ")" : ""}</div>`;
}
$("infoClose").onclick = () => { $("info").classList.remove("open"); pin?.remove(); };

// ---------- live layers (HTML markers survive style changes) ----------
const layerMarkers = { quakes: [], events: [] };
function clear(name) { layerMarkers[name].forEach((m) => m.remove()); layerMarkers[name] = []; }
function popup(html) { return new maplibregl.Popup({ offset: 14, maxWidth: "260px" }).setHTML(html); }

$("quakes").onchange = async (e) => {
  clear("quakes");
  if (!e.target.checked || !map) return;
  try {
    const { earthquakes } = await api("/api/earthquakes?minmag=4&days=7&limit=200");
    for (const q of earthquakes) {
      const el = document.createElement("div");
      const size = Math.max(10, (q.magnitude - 3) * 9);
      const hue = Math.max(0, 50 - (q.magnitude - 4) * 18);
      el.className = "quake";
      el.style.cssText += `width:${size}px;height:${size}px;background:hsla(${hue},95%,52%,.85)`;
      el.addEventListener("click", (ev) => ev.stopPropagation());
      layerMarkers.quakes.push(new maplibregl.Marker({ element: el }).setLngLat([q.lon, q.lat])
        .setPopup(popup(`<b>M ${q.magnitude}</b> · ${esc(q.place)}<br>${new Date(q.time).toLocaleString()}<br>Depth ${fmt(q.depthKm)} km${q.tsunamiWarning ? "<br><b>Tsunami warning</b>" : ""}<br><a href="${esc(q.url)}" target="_blank" rel="noopener">USGS details</a>`))
        .addTo(map));
    }
  } catch (err) { alert("Could not load earthquakes: " + err.message); e.target.checked = false; }
};

const EVENT_ICONS = { Wildfires: "🔥", "Severe Storms": "🌀", Volcanoes: "🌋", Floods: "🌊", "Sea and Lake Ice": "🧊", Earthquakes: "💥", "Dust and Haze": "🌫️", Drought: "🏜️", Landslides: "⛰️", "Snow": "❄️", "Temperature Extremes": "🌡️" };
$("events").onchange = async (e) => {
  clear("events");
  if (!e.target.checked || !map) return;
  try {
    const { events } = await api("/api/events?limit=200&days=60");
    for (const ev of events) {
      if (ev.lat === null) continue;
      const el = document.createElement("div");
      el.className = "emoji";
      el.textContent = EVENT_ICONS[ev.category] || "📍";
      el.title = ev.title;
      el.addEventListener("click", (x) => x.stopPropagation());
      layerMarkers.events.push(new maplibregl.Marker({ element: el }).setLngLat([ev.lon, ev.lat])
        .setPopup(popup(`<b>${esc(ev.title)}</b><br>${esc(ev.category)}${ev.magnitude ? " · " + esc(ev.magnitude) : ""}<br>Last seen ${esc((ev.lastSeen || "").slice(0, 10))}${ev.link ? `<br><a href="${esc(ev.link)}" target="_blank" rel="noopener">Source</a>` : ""}`))
        .addTo(map));
    }
  } catch (err) { alert("Could not load natural events: " + err.message); e.target.checked = false; }
};

let issMarker = null, issTimer = null, issFollowed = false;
async function updateIss() {
  try {
    const s = await api("/api/iss");
    if (!issMarker) {
      const el = document.createElement("div");
      el.className = "emoji"; el.style.fontSize = "30px"; el.textContent = "🛰️";
      el.addEventListener("click", (x) => x.stopPropagation());
      issMarker = new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).setPopup(popup("")).addTo(map);
    }
    issMarker.setLngLat([s.lon, s.lat]);
    issMarker.getPopup().setHTML(`<b>International Space Station</b><br>${fmt(s.altitudeKm)} km up · ${fmt(s.speedKmh)} km/h<br>${s.inSunlight ? "In sunlight" : "In Earth's shadow"}`);
    if (!issFollowed) { issFollowed = true; map.flyTo({ center: [s.lon, s.lat], zoom: 2.5, pitch: 0 }); }
  } catch (err) { console.warn("ISS:", err.message); }
}
$("iss").onchange = (e) => {
  clearInterval(issTimer);
  issMarker?.remove(); issMarker = null; issFollowed = false;
  if (!e.target.checked || !map) return;
  updateIss();
  issTimer = setInterval(updateIss, 5000);
};

initMap();

// ================= API EXPLORER =================
const list = $("list"), input = $("path"), meta = $("meta"), out = $("out");
for (const ep of EarthAPI.docs) {
  const b = document.createElement("button");
  b.className = "ep"; b.type = "button";
  b.innerHTML = "<code></code><span></span>";
  b.querySelector("code").textContent = ep.path;
  b.querySelector("span").textContent = ep.description;
  b.onclick = () => {
    list.querySelectorAll(".ep").forEach((x) => x.removeAttribute("aria-current"));
    b.setAttribute("aria-current", "true");
    input.value = ep.example;
    run();
  };
  list.append(b);
}
async function run() {
  const path = input.value.trim();
  if (!path.startsWith("/api")) { meta.className = "meta err"; meta.textContent = "Paths start with /api"; return; }
  meta.className = "meta"; meta.textContent = "Loading…";
  const t = performance.now();
  try {
    const res = await call(path);
    const text = await res.text();
    meta.className = res.ok ? "meta" : "meta err";
    meta.textContent = `${res.status} · ${Math.round(performance.now() - t)} ms`;
    out.textContent = text;
  } catch (e) {
    meta.className = "meta err"; meta.textContent = "Request failed: " + e.message;
  }
}
$("form").onsubmit = (e) => { e.preventDefault(); run(); };
list.querySelector(".ep").click();
