# Earth API

A free JSON API about planet Earth. No API key, no sign-up, no npm packages.

Part of it is its own math (sun, moon, distance, random points, Earth facts). The rest wraps free, keyless public APIs and cleans up what they return.

**Live:** https://earth-api.pages.dev

## The map

The home page is a live 3D map of the whole planet:

- **Streets:** colorful map with green parks and forests, blue water, and buildings that rise in 3D when you zoom in.
- **Satellite:** real aerial photos, so you see the actual colors of trees, fields, beaches and roofs, with 3D buildings and labels on top.
- **Terrain:** topographic map with forests, contour lines, rivers and peaks.
- **3D mountains**, **globe view**, and live layers for **earthquakes**, **wildfires / storms / volcanoes** and the **space station**.
- Search any town or landmark, or click anywhere to see the place name, weather, air quality, elevation, sunrise, sunset and moon.

Map data: [OpenFreeMap](https://openfreemap.org) and © OpenStreetMap contributors, Esri World Imagery, OpenTopoMap and Mapzen terrain tiles. Drawn with [MapLibre GL JS](https://maplibre.org) 5.24.0.

## Endpoints

| Endpoint | What it gives you | Data |
| --- | --- | --- |
| `/api` | List of every endpoint | — |
| `/api/facts` | Earth by the numbers | Own |
| `/api/sun?lat=48.85&lon=2.35&date=2026-06-21` | Sunrise, sunset, dawn, dusk, day length, sun position, moon | Own math |
| `/api/moon?date=2026-12-24` | Moon phase, age, how much is lit | Own math |
| `/api/distance?from=48.85,2.35&to=40.71,-74.01` | Distance (km, miles, nautical), bearing, midpoint | Own math |
| `/api/random` | Random spot on Earth and its antipode | Own math |
| `/api/place?q=Reykjavik` | Location + weather + air + sun + moon + country in one call | Own mashup |
| `/api/geocode?q=Eiffel Tower&count=3` | Find towns, landmarks and addresses by name | [Open-Meteo](https://open-meteo.com), then OpenStreetMap |
| `/api/reverse?lat=40.6892&lon=-74.0445` | What's at a point: name, town, region, country | [OpenStreetMap Nominatim](https://nominatim.org) |
| `/api/weather?lat=..&lon=..&days=3` | Current weather and forecast (1–16 days) | Open-Meteo |
| `/api/air?lat=..&lon=..` | AQI, PM2.5, PM10, ozone, UV | Open-Meteo Air Quality |
| `/api/elevation?lat=..&lon=..` | Height above sea level | Copernicus DEM via Open-Meteo |
| `/api/earthquakes?minmag=4.5&days=7&limit=10` | Recent quakes; add `lat`, `lon`, `radius` (km) to search near a point | [USGS](https://earthquake.usgs.gov) |
| `/api/events?category=wildfires` | Open natural events: `wildfires`, `severeStorms`, `volcanoes`, `floods`, `seaLakeIce` … | [NASA EONET](https://eonet.gsfc.nasa.gov) |
| `/api/country?code=BR` or `?name=japan` | Capital, population, area, region, income level, flag | [World Bank](https://data.worldbank.org) |
| `/api/iss` | Where the International Space Station is now | [wheretheiss.at](https://wheretheiss.at) |

All responses are JSON with `access-control-allow-origin: *`, so any website can call them. Errors look like `{"error": "..."}` with status 400, 404 or 502.

## Three ways to run it

**1. Open the file.** Double-click `public/index.html`. The whole API runs inside the page (no server), and you can try every endpoint.

**2. Local server.** Needs Node 18 or newer:

```bash
cd earth-api && node server.js
```

Then open http://localhost:8787 or call http://localhost:8787/api/place?q=London.

**3. Host it free on Cloudflare Pages (`*.pages.dev`).** In the Cloudflare dashboard: *Workers & Pages → Create → Pages → Connect to Git*, pick this repository, then set

- **Root directory:** `earth-api`
- **Build command:** `node build.js`
- **Build output directory:** `public`

Cloudflare finds `functions/api/[[path]].js` and serves the API at `https://<your-project>.pages.dev/api`. Every push redeploys it. Or deploy from your computer:

```bash
cd earth-api && npx wrangler pages deploy public
```

## Changing it

- All endpoints live in `src/earth.js`. Add one with `route("/name", "description", "/name?example", handler)`.
- After editing, run `node build.js` to refresh `public/earth-browser.js` (the copy the page uses when opened from disk).
- `node --test test.js` runs the tests offline (upstream APIs are mocked).

## Credits

Weather, air quality, geocoding and elevation: Open-Meteo, CC BY 4.0. Earthquakes: U.S. Geological Survey (public domain). Natural events: NASA EONET. Countries: World Bank Open Data, CC BY 4.0. Place names: © OpenStreetMap contributors (ODbL). ISS: wheretheiss.at. Sun and moon formulas follow the standard NOAA / Astronomical Algorithms approximations.

License: MIT.
