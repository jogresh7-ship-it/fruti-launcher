# Earth API

A free JSON API about planet Earth. No API key, no sign-up, no npm packages.

Part of it is its own math (sun, moon, distance, random points, Earth facts). The rest wraps free, keyless public APIs and cleans up what they return.

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
| `/api/geocode?q=Tokyo&count=3` | Find places by name | [Open-Meteo](https://open-meteo.com) |
| `/api/weather?lat=..&lon=..&days=3` | Current weather and forecast (1–16 days) | Open-Meteo |
| `/api/air?lat=..&lon=..` | AQI, PM2.5, PM10, ozone, UV | Open-Meteo Air Quality |
| `/api/elevation?lat=..&lon=..` | Height above sea level | Copernicus DEM via Open-Meteo |
| `/api/earthquakes?minmag=4.5&days=7&limit=10` | Recent quakes; add `lat`, `lon`, `radius` (km) to search near a point | [USGS](https://earthquake.usgs.gov) |
| `/api/events?category=wildfires` | Open natural events: `wildfires`, `severeStorms`, `volcanoes`, `floods`, `seaLakeIce` … | [NASA EONET](https://eonet.gsfc.nasa.gov) |
| `/api/country?code=BR` or `?name=japan` | Capital, population, languages, currencies, flag | [REST Countries](https://restcountries.com) |
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

Weather, air quality, geocoding and elevation: Open-Meteo, CC BY 4.0. Earthquakes: U.S. Geological Survey (public domain). Natural events: NASA EONET. Countries: REST Countries. ISS: wheretheiss.at. Sun and moon formulas follow the standard NOAA / Astronomical Algorithms approximations.

License: MIT.
