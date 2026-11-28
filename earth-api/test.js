// node --test test.js  — upstream APIs are mocked, so this runs offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./src/earth.js";

const mocks = {
  "geocoding-api.open-meteo.com": { results: [{ name: "Paris", admin1: "Île-de-France", country: "France", country_code: "FR", latitude: 48.85, longitude: 2.35, elevation: 42, population: 2138551, timezone: "Europe/Paris" }] },
  "api.open-meteo.com": (u) => u.pathname.includes("elevation") ? { elevation: [8794] } : {
    timezone: "Europe/Paris",
    current: { time: "2026-11-28T10:00", temperature_2m: 7.1, apparent_temperature: 4.2, relative_humidity_2m: 80, precipitation: 0, weather_code: 3, wind_speed_10m: 12, wind_direction_10m: 225, is_day: 1 },
    daily: { time: ["2026-11-28"], weather_code: [61], temperature_2m_max: [9], temperature_2m_min: [3], precipitation_sum: [2.1], uv_index_max: [1.2] },
  },
  "air-quality-api.open-meteo.com": { current: { time: "2026-11-28T10:00", us_aqi: 42, european_aqi: 30, pm2_5: 8, pm10: 14, ozone: 40, nitrogen_dioxide: 20, carbon_monoxide: 200, uv_index: 1 } },
  // Shapes copied from real World Bank responses.
  "api.worldbank.org": (u) => {
    const france = { id: "FRA", iso2Code: "FR", name: "France", region: { value: "Europe & Central Asia" }, incomeLevel: { value: "High income" }, capitalCity: "Paris", longitude: "2.35097", latitude: "48.8566" };
    const world = { id: "WLD", iso2Code: "1W", name: "World", region: { value: "Aggregates" }, capitalCity: "", longitude: "", latitude: "" };
    if (u.pathname.includes("/indicator/")) return [{ page: 1 }, [
      { indicator: { id: "SP.POP.TOTL" }, date: "2025", value: 68400000 },
      { indicator: { id: "AG.SRF.TOTL.K2" }, date: "2024", value: 549087 }]];
    if (u.pathname.endsWith("/country")) return [{ page: 1 }, [world, france]];
    if (u.pathname.endsWith("/country/fr") || u.pathname.endsWith("/country/FR")) return [{ page: 1 }, [france]];
    return [{ message: [{ id: "120", key: "Invalid value" }] }];
  },
  "earthquake.usgs.gov": { features: [
    { id: "a", properties: { mag: 5.1, place: "Somewhere", time: 1764300000000, tsunami: 0, url: "u" }, geometry: { coordinates: [140, 35, 10] } },
    { id: "b", properties: { mag: 6.3, place: "Elsewhere", time: 1764300000000, tsunami: 1, url: "u" }, geometry: { coordinates: [-70, -30, 30] } }] },
  "eonet.gsfc.nasa.gov": { events: [{ id: "E1", title: "Fire", categories: [{ title: "Wildfires" }], sources: [{ url: "s" }], geometry: [{ date: "2026-11-27", type: "Point", coordinates: [-120, 38], magnitudeValue: 900, magnitudeUnit: "acres" }] }] },
  "api.wheretheiss.at": { latitude: 10, longitude: 20, altitude: 420, velocity: 27600, visibility: "daylight", timestamp: 1764300000 },
};
const seen = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  seen.push(u);
  const m = mocks[u.host];
  if (!m) return new Response("{}", { status: 500 });
  return new Response(JSON.stringify(typeof m === "function" ? m(u) : m), { status: 200 });
};
const get = async (path) => {
  const res = await handle(new Request("https://x" + path));
  return { status: res.status, body: res.status === 204 ? null : await res.json(), res };
};

test("index lists endpoints", async () => {
  const { status, body } = await get("/api");
  assert.equal(status, 200);
  assert.ok(body.endpoints.length >= 12);
});

test("sun: Paris on the June solstice", async () => {
  const { body } = await get("/api/sun?lat=48.8566&lon=2.3522&date=2026-06-21");
  // Real values: sunrise 03:47 UTC, sunset 19:58 UTC, ~16h10m of day.
  const rise = new Date(body.sunrise), set = new Date(body.sunset);
  assert.ok(Math.abs(rise.getUTCHours() * 60 + rise.getUTCMinutes() - 227) <= 3, body.sunrise);
  assert.ok(Math.abs(set.getUTCHours() * 60 + set.getUTCMinutes() - 1198) <= 3, body.sunset);
  assert.ok(Math.abs(body.dayLengthHours - 16.17) < 0.1);
});

test("sun: polar night and midnight sun", async () => {
  assert.equal((await get("/api/sun?lat=78.2&lon=15.6&date=2026-12-21")).body.polar, "polar-night");
  assert.equal((await get("/api/sun?lat=78.2&lon=15.6&date=2026-06-21")).body.dayLengthHours, 24);
});

test("moon: a known full moon", async () => {
  const { body } = await get("/api/moon?date=2026-12-24T01:28:00Z"); // full moon 24 Dec 2026
  assert.equal(body.phase, "Full Moon");
  assert.ok(body.illumination > 0.99);
});

test("distance Paris to New York", async () => {
  const { body } = await get("/api/distance?from=48.8566,2.3522&to=40.7128,-74.0060");
  assert.ok(Math.abs(body.km - 5837) < 10, String(body.km));
  assert.equal(body.direction, "WNW");
});

test("random point is valid", async () => {
  const { body } = await get("/api/random");
  assert.ok(Math.abs(body.lat) <= 90 && Math.abs(body.lon) <= 180);
  assert.equal(body.antipode.lat, -body.lat);
});

test("bad input gives 400", async () => {
  assert.equal((await get("/api/sun?lat=200&lon=0")).status, 400);
  assert.equal((await get("/api/distance?from=abc")).status, 400);
  assert.equal((await get("/api/country?code=../x")).status, 400);
  assert.equal((await get("/api/nope")).status, 404);
  assert.equal((await get("/api/weather?lat=1")).status, 400);
});

test("weather, air, elevation", async () => {
  const w = (await get("/api/weather?lat=48.85&lon=2.35")).body;
  assert.equal(w.current.description, "Overcast");
  assert.equal(w.current.windFrom, "SW");
  assert.equal(w.forecast[0].description, "Light rain");
  assert.equal((await get("/api/air?lat=1&lon=1")).body.level, "Good");
  assert.equal((await get("/api/elevation?lat=1&lon=1")).body.elevationM, 8794);
});

test("earthquakes and events", async () => {
  const q = (await get("/api/earthquakes?minmag=5&lat=35&lon=140&radius=300")).body;
  assert.equal(q.count, 2);
  assert.equal(q.strongest.id, "b");
  assert.ok(seen.at(-1).searchParams.get("maxradiuskm") === "300");
  const e = (await get("/api/events?category=wildfires")).body;
  assert.equal(e.events[0].magnitude, "900 acres");
  assert.equal(e.events[0].lat, 38);
});

test("country, iss, place mashup", async () => {
  const fr = (await get("/api/country?code=fr")).body.results[0];
  assert.equal(fr.capital, "Paris");
  assert.equal(fr.flag, "🇫🇷");
  assert.equal(fr.population, 68400000);
  assert.equal(fr.peoplePerKm2, 124.6);
  assert.equal(fr.lat, 48.8566);
  assert.equal((await get("/api/country?code=ZZ")).status, 404);
  const byName = (await get("/api/country?name=fran")).body.results;
  assert.deepEqual(byName.map((c) => c.name), ["France"]); // "World" grouping is filtered out
  assert.equal((await get("/api/iss")).body.inSunlight, true);
  const p = (await get("/api/place?q=Paris")).body;
  assert.equal(p.place.country, "France");
  assert.equal(p.country.capital, "Paris");
  assert.equal(p.weather.current.temperatureC, 7.1);
  assert.ok(p.sun.sunrise);
});

test("landmark search falls back to OpenStreetMap", async () => {
  const saved = mocks["geocoding-api.open-meteo.com"];
  mocks["geocoding-api.open-meteo.com"] = { generationtime_ms: 0.1 }; // Open-Meteo's real "no results" answer
  mocks["nominatim.openstreetmap.org"] = [{ name: "Eiffel Tower", display_name: "Eiffel Tower, Paris, France", lat: "48.8582599", lon: "2.2945006", type: "attraction", address: { state: "Île-de-France", country: "France", country_code: "fr" } }];
  try {
    const g = (await get("/api/geocode?q=Eiffel%20Tower")).body;
    assert.equal(g.results[0].name, "Eiffel Tower");
    assert.equal(g.results[0].lat, 48.8582599);
    assert.equal(g.results[0].countryCode, "FR");
    assert.match(g.source, /OpenStreetMap/);
    const p = (await get("/api/place?q=Eiffel%20Tower")).body;
    assert.equal(p.place.name, "Eiffel Tower");
    assert.equal(p.country.name, "France");
  } finally {
    mocks["geocoding-api.open-meteo.com"] = saved;
  }
});

test("CORS and OPTIONS", async () => {
  const { status, res } = await get("/api/facts");
  assert.equal(status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal((await handle(new Request("https://x/api/sun", { method: "OPTIONS" }))).status, 204);
});

test("reverse geocode", async () => {
  mocks["nominatim.openstreetmap.org"] = { name: "Statue of Liberty", display_name: "Statue of Liberty, Liberty Island, New York, United States", type: "attraction", address: { city: "New York", state: "New York", country: "United States", country_code: "us" } };
  const r = (await get("/api/reverse?lat=40.6892&lon=-74.0445")).body;
  assert.equal(r.name, "Statue of Liberty");
  assert.equal(r.countryCode, "US");
  mocks["nominatim.openstreetmap.org"] = { error: "Unable to geocode" };
  assert.equal((await get("/api/reverse?lat=0&lon=-30")).body.name, null);
});
