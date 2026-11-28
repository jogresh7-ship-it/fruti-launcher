// Earth API: one router that runs the same way on Cloudflare Pages Functions,
// in Node (server.js) and straight in the browser (public/earth-browser.js).
//
// Some endpoints are my own math (sun, moon, distance, random, facts). Others
// wrap free, keyless public APIs and tidy up what they return.

const VERSION = "1.0.0";
const R_EARTH_KM = 6371.0088; // mean radius (IUGG)
const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;

// ---------- helpers ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200, maxAge = 0) {
  return new Response(status === 204 ? null : JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

function num(params, name, { min = -Infinity, max = Infinity, required = true, fallback } = {}) {
  const raw = params.get(name);
  if (raw === null || raw === "") {
    if (required && fallback === undefined) throw new ApiError(400, `Missing "${name}".`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ApiError(400, `"${name}" must be a number from ${min} to ${max}.`);
  }
  return n;
}

function latLon(params) {
  return {
    lat: num(params, "lat", { min: -90, max: 90 }),
    lon: num(params, "lon", { min: -180, max: 180 }),
  };
}

function parsePoint(text, name) {
  const parts = String(text || "").split(",").map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite) ||
      Math.abs(parts[0]) > 90 || Math.abs(parts[1]) > 180) {
    throw new ApiError(400, `"${name}" must look like "lat,lon", for example 48.85,2.35.`);
  }
  return { lat: parts[0], lon: parts[1] };
}

function round(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function getJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "earth-api/" + VERSION },
    });
  } catch (err) {
    throw new ApiError(502, `Could not reach ${new URL(url).host}.`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw new ApiError(404, "Nothing found.");
  if (!res.ok) throw new ApiError(502, `${new URL(url).host} answered ${res.status}.`);
  return res.json();
}

// ---------- my own math: sun, moon, distance ----------

const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);
const OBLIQUITY = RAD * 23.4397;

function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
}

const declination = (L) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
const rightAscension = (L) => Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L));

function sunPosition(date, lat, lon) {
  const d = toDays(date.getTime());
  const L = eclipticLongitude(solarMeanAnomaly(d));
  const dec = declination(L);
  const H = RAD * (280.16 + 360.9856235 * d) + RAD * lon - rightAscension(L);
  const phi = RAD * lat;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return {
    altitude: altitude / RAD,
    azimuth: ((azimuth / RAD + 180) % 360 + 360) % 360, // degrees clockwise from north
  };
}

// Sunrise / sunset for the solar day nearest `date` (NOAA-style approximation).
function sunTimes(date, lat, lon) {
  const lw = -RAD * lon;
  const phi = RAD * lat;
  const d = toDays(date.getTime());
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const jNoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

  const at = (angleDeg) => {
    const c = (Math.sin(RAD * angleDeg) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (c > 1) return { state: "never-rises" };
    if (c < -1) return { state: "never-sets" };
    const w = Math.acos(c);
    const jSet = J2000 + 0.0009 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    return { rise: fromJulian(jNoon - (jSet - jNoon)), set: fromJulian(jSet) };
  };

  const sun = at(-0.833);
  const civil = at(-6);
  const iso = (x) => (x ? x.toISOString() : null);
  let dayLengthHours;
  if (sun.state === "never-sets") dayLengthHours = 24;
  else if (sun.state === "never-rises") dayLengthHours = 0;
  else dayLengthHours = (sun.set - sun.rise) / 3600000;

  return {
    sunrise: iso(sun.rise),
    sunset: iso(sun.set),
    solarNoon: fromJulian(jNoon).toISOString(),
    civilDawn: iso(civil.rise),
    civilDusk: iso(civil.set),
    dayLengthHours: round(dayLengthHours, 2),
    polar: sun.state === "never-sets" ? "midnight-sun" : sun.state === "never-rises" ? "polar-night" : null,
  };
}

function moonPhase(date) {
  const synodic = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const age = ((((date - knownNewMoon) / DAY_MS) % synodic) + synodic) % synodic;
  const fraction = age / synodic;
  const names = ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
    "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"];
  return {
    phase: names[Math.floor(fraction * 8 + 0.5) % 8],
    ageDays: round(age, 2),
    illumination: round((1 - Math.cos(2 * Math.PI * fraction)) / 2, 3),
  };
}

function haversine(a, b) {
  const p1 = a.lat * RAD, p2 = b.lat * RAD;
  const dp = (b.lat - a.lat) * RAD, dl = (b.lon - a.lon) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const km = 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const bearing = ((Math.atan2(y, x) / RAD) + 360) % 360;
  return { km, bearing };
}

function compass(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

function parseDate(params) {
  const raw = params.get("date");
  if (!raw) return new Date();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + "T12:00:00Z" : raw);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, `"date" must be like 2026-06-21.`);
  return d;
}

const WEATHER_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Violent showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail",
};

// ---------- endpoints ----------

const routes = {};
const docs = [];
function route(path, description, example, handler) {
  routes[path] = handler;
  docs.push({ path: "/api" + path, description, example: "/api" + example });
}

route("/facts", "Planet Earth by the numbers (my own data).", "/facts", () => ({
  body: {
    name: "Earth",
    meanRadiusKm: R_EARTH_KM,
    equatorialRadiusKm: 6378.137,
    polarRadiusKm: 6356.752,
    circumferenceKm: 40075.017,
    surfaceAreaKm2: 510072000,
    landPercent: 29.2,
    waterPercent: 70.8,
    massKg: 5.9722e24,
    densityGcm3: 5.514,
    gravityMs2: 9.80665,
    escapeVelocityKms: 11.186,
    axialTiltDeg: 23.44,
    siderealDayHours: 23.9345,
    orbitalPeriodDays: 365.256,
    orbitalSpeedKms: 29.78,
    meanDistanceFromSunKm: 149597870.7,
    ageBillionYears: 4.54,
    moons: 1,
    highestPoint: { name: "Mount Everest", metres: 8849 },
    lowestPoint: { name: "Challenger Deep", metres: -10935 },
    continents: ["Africa", "Antarctica", "Asia", "Australia", "Europe", "North America", "South America"],
    oceans: ["Pacific", "Atlantic", "Indian", "Southern", "Arctic"],
  },
  maxAge: 86400,
}));

route("/sun", "Sunrise, sunset, day length and where the sun is in the sky right now. My own math, no upstream.",
  "/sun?lat=48.85&lon=2.35&date=2026-06-21", (p) => {
    const { lat, lon } = latLon(p);
    const date = parseDate(p);
    const pos = sunPosition(date, lat, lon);
    return {
      body: {
        lat, lon, at: date.toISOString(),
        ...sunTimes(date, lat, lon),
        position: {
          altitudeDeg: round(pos.altitude, 2),
          azimuthDeg: round(pos.azimuth, 2),
          direction: compass(pos.azimuth),
          isDaytime: pos.altitude > -0.833,
        },
        moon: moonPhase(date),
      },
      maxAge: 60,
    };
  });

route("/moon", "Moon phase, age and how much of it is lit. My own math.", "/moon?date=2026-12-24", (p) => ({
  body: { at: parseDate(p).toISOString(), ...moonPhase(parseDate(p)) },
  maxAge: 3600,
}));

route("/distance", "Great-circle distance, bearing and midpoint between two points. My own math.",
  "/distance?from=48.85,2.35&to=40.71,-74.01", (p) => {
    const a = parsePoint(p.get("from"), "from");
    const b = parsePoint(p.get("to"), "to");
    const { km, bearing } = haversine(a, b);
    // midpoint on the sphere
    const p1 = a.lat * RAD, p2 = b.lat * RAD, l1 = a.lon * RAD, dl = (b.lon - a.lon) * RAD;
    const bx = Math.cos(p2) * Math.cos(dl), by = Math.cos(p2) * Math.sin(dl);
    const mLat = Math.atan2(Math.sin(p1) + Math.sin(p2), Math.sqrt((Math.cos(p1) + bx) ** 2 + by ** 2));
    const mLon = l1 + Math.atan2(by, Math.cos(p1) + bx);
    return {
      body: {
        from: a, to: b,
        km: round(km, 2),
        miles: round(km / 1.609344, 2),
        nauticalMiles: round(km / 1.852, 2),
        initialBearingDeg: round(bearing, 1),
        direction: compass(bearing),
        midpoint: { lat: round(mLat / RAD, 5), lon: round(((mLon / RAD + 540) % 360) - 180, 5) },
        flightHoursAt900kmh: round(km / 900, 1),
      },
      maxAge: 86400,
    };
  });

route("/random", "A random spot on Earth, spread evenly over the globe. My own math.", "/random", () => {
  const lat = Math.asin(2 * Math.random() - 1) / RAD;
  const lon = Math.random() * 360 - 180;
  const anti = { lat: -lat, lon: lon > 0 ? lon - 180 : lon + 180 };
  return {
    body: {
      lat: round(lat, 5), lon: round(lon, 5),
      antipode: { lat: round(anti.lat, 5), lon: round(anti.lon, 5) },
      hemisphere: `${lat >= 0 ? "Northern" : "Southern"}, ${lon >= 0 ? "Eastern" : "Western"}`,
      map: `https://www.openstreetmap.org/?mlat=${round(lat, 5)}&mlon=${round(lon, 5)}#map=5/${round(lat, 5)}/${round(lon, 5)}`,
    },
  };
});

// Towns and cities come from Open-Meteo. Landmarks, streets and anything else
// (Eiffel Tower, Central Park, Mount Fuji) fall back to OpenStreetMap.
async function searchPlaces(q, count) {
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=${count}&language=en&format=json`);
  if (data.results?.length) {
    return {
      results: data.results.map((r) => ({
        name: r.name, region: r.admin1 || null, country: r.country || null, countryCode: r.country_code || null,
        lat: r.latitude, lon: r.longitude, elevationM: r.elevation ?? null,
        population: r.population ?? null, timezone: r.timezone || null,
      })),
      source: "Open-Meteo (open-meteo.com), CC BY 4.0",
    };
  }
  const osm = await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&accept-language=en&limit=${count}&q=${encodeURIComponent(q)}`);
  return {
    results: (Array.isArray(osm) ? osm : []).map((r) => ({
      name: r.name || (r.display_name || "").split(",")[0], region: r.address?.state || null,
      country: r.address?.country || null, countryCode: r.address?.country_code ? r.address.country_code.toUpperCase() : null,
      lat: Number(r.lat), lon: Number(r.lon), elevationM: null, population: null, timezone: null, kind: r.type || null,
    })),
    source: "© OpenStreetMap contributors (ODbL), Nominatim",
  };
}

route("/geocode", "Find places, landmarks and addresses by name. Data: Open-Meteo Geocoding, then OpenStreetMap.", "/geocode?q=Eiffel Tower&count=3", async (p) => {
  const q = (p.get("q") || "").trim();
  if (q.length < 2) throw new ApiError(400, `"q" needs at least 2 letters.`);
  const count = num(p, "count", { min: 1, max: 20, fallback: 5 });
  return { body: { query: q, ...(await searchPlaces(q, count)) }, maxAge: 86400 };
});

route("/reverse", "What is at a point: address, town, country. Data: OpenStreetMap Nominatim.",
  "/reverse?lat=40.6892&lon=-74.0445", async (p) => {
    const { lat, lon } = latLon(p);
    const zoom = num(p, "zoom", { min: 3, max: 18, fallback: 14 });
    const d = await getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${zoom}&accept-language=en`);
    if (d.error) {
      return { body: { lat, lon, name: null, nearest: "Open ocean or no named place", source: "© OpenStreetMap contributors (ODbL)" }, maxAge: 86400 };
    }
    const a = d.address || {};
    return {
      body: {
        lat, lon,
        name: d.name || null,
        nearest: d.display_name || null,
        kind: d.type || null,
        town: a.city || a.town || a.village || a.hamlet || a.suburb || null,
        region: a.state || a.region || a.county || null,
        country: a.country || null,
        countryCode: a.country_code ? a.country_code.toUpperCase() : null,
        source: "© OpenStreetMap contributors (ODbL), Nominatim",
      },
      maxAge: 86400,
    };
  });

async function weatherFor(lat, lon, days = 3) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max" +
    `&timezone=auto&forecast_days=${days}`;
  const d = await getJson(url);
  const c = d.current || {};
  const daily = d.daily || {};
  return {
    lat, lon, timezone: d.timezone || null,
    current: {
      time: c.time, description: WEATHER_CODES[c.weather_code] || "Unknown",
      temperatureC: c.temperature_2m, feelsLikeC: c.apparent_temperature,
      humidityPercent: c.relative_humidity_2m, precipitationMm: c.precipitation,
      windKmh: c.wind_speed_10m, windFrom: Number.isFinite(c.wind_direction_10m) ? compass(c.wind_direction_10m) : null,
      isDay: c.is_day === 1,
    },
    forecast: (daily.time || []).map((date, i) => ({
      date, description: WEATHER_CODES[daily.weather_code?.[i]] || "Unknown",
      minC: daily.temperature_2m_min?.[i], maxC: daily.temperature_2m_max?.[i],
      precipitationMm: daily.precipitation_sum?.[i], uvIndexMax: daily.uv_index_max?.[i],
    })),
    source: "Open-Meteo (open-meteo.com), CC BY 4.0",
  };
}

route("/weather", "Current weather and a short forecast. Data: Open-Meteo.", "/weather?lat=35.68&lon=139.69&days=3", async (p) => {
  const { lat, lon } = latLon(p);
  const days = num(p, "days", { min: 1, max: 16, fallback: 3 });
  return { body: await weatherFor(lat, lon, days), maxAge: 600 };
});

async function airFor(lat, lon) {
  const d = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    "&current=us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,carbon_monoxide,uv_index&timezone=auto");
  const c = d.current || {};
  const aqi = c.us_aqi;
  const level = !Number.isFinite(aqi) ? "Unknown" : aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" :
    aqi <= 150 ? "Unhealthy for sensitive groups" : aqi <= 200 ? "Unhealthy" : aqi <= 300 ? "Very unhealthy" : "Hazardous";
  return {
    lat, lon, time: c.time, usAqi: aqi, level, europeanAqi: c.european_aqi,
    pm2_5: c.pm2_5, pm10: c.pm10, ozone: c.ozone, nitrogenDioxide: c.nitrogen_dioxide,
    carbonMonoxide: c.carbon_monoxide, uvIndex: c.uv_index, units: "μg/m³",
    source: "Open-Meteo Air Quality (CAMS), CC BY 4.0",
  };
}

route("/air", "Air quality (AQI, PM2.5, ozone, UV). Data: Open-Meteo Air Quality.", "/air?lat=28.61&lon=77.21", async (p) => {
  const { lat, lon } = latLon(p);
  return { body: await airFor(lat, lon), maxAge: 900 };
});

route("/elevation", "Height above sea level of any point. Data: Open-Meteo Elevation (Copernicus DEM).",
  "/elevation?lat=27.988&lon=86.925", async (p) => {
    const { lat, lon } = latLon(p);
    const d = await getJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    const m = d.elevation?.[0] ?? null;
    return {
      body: { lat, lon, elevationM: m, elevationFt: m === null ? null : round(m * 3.28084, 0), source: "Copernicus DEM via Open-Meteo" },
      maxAge: 86400,
    };
  });

route("/earthquakes", "Recent earthquakes worldwide or near a point. Data: USGS.",
  "/earthquakes?minmag=4.5&days=7&limit=10", async (p) => {
    const minmag = num(p, "minmag", { min: 0, max: 10, fallback: 4.5 });
    const days = num(p, "days", { min: 1, max: 30, fallback: 1 });
    const limit = num(p, "limit", { min: 1, max: 200, fallback: 20 });
    const start = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 19);
    let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&minmagnitude=${minmag}&starttime=${start}&limit=${limit}`;
    if (p.get("lat") !== null || p.get("lon") !== null) {
      const { lat, lon } = latLon(p);
      const radius = num(p, "radius", { min: 1, max: 20000, fallback: 500 });
      url += `&latitude=${lat}&longitude=${lon}&maxradiuskm=${radius}`;
    }
    const d = await getJson(url);
    const quakes = (d.features || []).map((f) => ({
      id: f.id,
      magnitude: f.properties.mag,
      place: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      depthKm: f.geometry.coordinates[2],
      tsunamiWarning: f.properties.tsunami === 1,
      alert: f.properties.alert || null,
      url: f.properties.url,
    }));
    return {
      body: {
        count: quakes.length,
        strongest: quakes.reduce((best, q) => (!best || q.magnitude > best.magnitude ? q : best), null),
        earthquakes: quakes,
        source: "U.S. Geological Survey (earthquake.usgs.gov), public domain",
      },
      maxAge: 300,
    };
  });

route("/events", "Natural events happening now: wildfires, storms, volcanoes, floods, icebergs. Data: NASA EONET.",
  "/events?category=wildfires&limit=10", async (p) => {
    const limit = num(p, "limit", { min: 1, max: 200, fallback: 20 });
    const days = num(p, "days", { min: 1, max: 365, fallback: 30 });
    const category = (p.get("category") || "").trim();
    if (category && !/^[a-zA-Z]+$/.test(category)) throw new ApiError(400, `"category" is a word like wildfires, severeStorms, volcanoes, floods, seaLakeIce.`);
    let url = `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=${limit}&days=${days}`;
    if (category) url += `&category=${category}`;
    const d = await getJson(url, 15000);
    return {
      body: {
        count: (d.events || []).length,
        events: (d.events || []).map((e) => {
          const last = e.geometry?.[e.geometry.length - 1];
          const point = last?.type === "Point" ? last.coordinates : null;
          return {
            id: e.id, title: e.title,
            category: e.categories?.[0]?.title || null,
            lastSeen: last?.date || null,
            lat: point ? point[1] : null, lon: point ? point[0] : null,
            magnitude: last?.magnitudeValue != null ? `${last.magnitudeValue} ${last.magnitudeUnit || ""}`.trim() : null,
            link: e.sources?.[0]?.url || e.link || null,
          };
        }),
        source: "NASA Earth Observatory Natural Event Tracker (eonet.gsfc.nasa.gov)",
      },
      maxAge: 900,
    };
  });

// Countries come from the World Bank's free API (REST Countries proved unreachable).
const WORLD_BANK = "https://api.worldbank.org/v2";
let countryList = null;

const coord = (v) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const flagEmoji = (code) => (/^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((ch) => 127397 + ch.charCodeAt(0))) : null);

async function allCountries() {
  if (!countryList) {
    const d = await getJson(`${WORLD_BANK}/country?format=json&per_page=400`, 15000);
    // Drop groupings such as "World" or "Euro area"; keep real countries.
    countryList = (d?.[1] || []).filter((c) => (c.region?.value || "").trim() !== "Aggregates");
  }
  return countryList;
}

async function countryInfo(c) {
  let population = null, populationYear = null, areaKm2 = null;
  try {
    const d = await getJson(`${WORLD_BANK}/country/${c.iso2Code}/indicator/SP.POP.TOTL;AG.SRF.TOTL.K2?format=json&mrnev=1&source=2`);
    for (const row of d?.[1] || []) {
      if (row.indicator?.id === "SP.POP.TOTL") { population = row.value; populationYear = row.date; }
      if (row.indicator?.id === "AG.SRF.TOTL.K2") areaKm2 = row.value;
    }
  } catch { /* the basics below are still useful without numbers */ }
  const code = (c.iso2Code || "").toUpperCase();
  const lat = coord(c.latitude), lon = coord(c.longitude);
  return {
    name: c.name, code, code3: c.id,
    flag: flagEmoji(code),
    flagImage: code ? `https://flagcdn.com/${code.toLowerCase()}.svg` : null,
    capital: c.capitalCity || null,
    region: (c.region?.value || "").trim() || null,
    incomeLevel: c.incomeLevel?.value || null,
    population, populationYear, areaKm2,
    peoplePerKm2: population && areaKm2 ? round(population / areaKm2, 1) : null,
    lat, lon,
    map: lat !== null ? `https://www.openstreetmap.org/#map=5/${lat}/${lon}` : null,
  };
}

async function countryBy(code, name) {
  if (code) {
    if (!/^[a-zA-Z]{2,3}$/.test(code)) throw new ApiError(400, `"code" must be 2 or 3 letters, like FR or FRA.`);
    const d = await getJson(`${WORLD_BANK}/country/${code}?format=json`);
    const c = d?.[1]?.[0];
    if (!c) throw new ApiError(404, `No country with code "${code}".`);
    return [await countryInfo(c)];
  }
  if (name) {
    const n = name.toLowerCase();
    const all = await allCountries();
    const hits = all.filter((c) => c.name.toLowerCase() === n)
      .concat(all.filter((c) => c.name.toLowerCase() !== n && c.name.toLowerCase().includes(n)))
      .slice(0, 5);
    if (!hits.length) throw new ApiError(404, `No country called "${name}".`);
    return Promise.all(hits.map(countryInfo));
  }
  throw new ApiError(400, `Give "code" (like JP) or "name" (like japan).`);
}

route("/country", "Facts about a country: capital, population, area, region, flag. Data: World Bank.",
  "/country?code=BR", async (p) => ({
    body: { results: await countryBy(p.get("code"), (p.get("name") || "").trim()), source: "World Bank Open Data (data.worldbank.org), CC BY 4.0" },
    maxAge: 86400,
  }));

route("/iss", "Where the International Space Station is right now. Data: wheretheiss.at.", "/iss", async () => {
  const d = await getJson("https://api.wheretheiss.at/v1/satellites/25544");
  return {
    body: {
      lat: round(d.latitude, 4), lon: round(d.longitude, 4),
      altitudeKm: round(d.altitude, 1), speedKmh: round(d.velocity, 0),
      inSunlight: d.visibility === "daylight",
      at: new Date(d.timestamp * 1000).toISOString(),
      orbitsPerDay: round(d.velocity * 24 / (2 * Math.PI * (R_EARTH_KM + d.altitude)), 2),
      source: "wheretheiss.at",
    },
  };
});

route("/place", "Everything about one place in one call: location, weather, air, sun, moon and country. My own mashup.",
  "/place?q=Reykjavik", async (p) => {
    const q = (p.get("q") || "").trim();
    if (q.length < 2) throw new ApiError(400, `"q" needs at least 2 letters.`);
    const r = (await searchPlaces(q, 1)).results[0];
    if (!r) throw new ApiError(404, `No place called "${q}".`);
    const lat = r.lat, lon = r.lon;
    const [weather, air, country] = await Promise.allSettled([
      weatherFor(lat, lon, 3),
      airFor(lat, lon),
      r.countryCode ? countryBy(r.countryCode) : Promise.resolve([null]),
    ]);
    const now = new Date();
    const pos = sunPosition(now, lat, lon);
    const settled = (s) => (s.status === "fulfilled" ? s.value : { error: s.reason?.message || "unavailable" });
    const strip = (o) => { if (o && !o.error) { delete o.lat; delete o.lon; delete o.source; } return o; };
    return {
      body: {
        place: { name: r.name, region: r.region, country: r.country, lat, lon,
          elevationM: r.elevationM, population: r.population, timezone: r.timezone || weather.value?.timezone || null },
        weather: strip(settled(weather)),
        air: strip(settled(air)),
        sun: { ...sunTimes(now, lat, lon), altitudeDeg: round(pos.altitude, 1), direction: compass(pos.azimuth) },
        moon: moonPhase(now),
        country: country.status === "fulfilled" ? country.value[0] : { error: country.reason?.message || "unavailable" },
        sources: ["Open-Meteo (CC BY 4.0)", "World Bank Open Data (CC BY 4.0)", "OpenStreetMap (ODbL)", "Earth API's own sun and moon math"],
      },
      maxAge: 600,
    };
  });

// ---------- entry point ----------

async function handle(request) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return json(null, 204);
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Only GET is supported." }, 405);

  const path = url.pathname.replace(/\/+$/, "").replace(/^\/api/, "") || "/";
  if (path === "/") {
    return json({ name: "Earth API", version: VERSION, endpoints: docs }, 200, 3600);
  }
  const handler = routes[path];
  if (!handler) return json({ error: `Unknown endpoint ${url.pathname}. See /api for the list.` }, 404);
  try {
    const { body, maxAge = 0 } = await handler(url.searchParams);
    return json(body, 200, maxAge);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    return json({ error: status === 500 ? "Something went wrong." : err.message }, status);
  }
}

export { handle, docs, VERSION, sunTimes, sunPosition, moonPhase, haversine };
