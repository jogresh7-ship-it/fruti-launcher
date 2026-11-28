// API keys for the Earth API.
//
// Anyone can create a free key (POST /api/keys) and use it from their own site or app
// with ?key=ek_... or an "x-api-key" header. Keys are stored only as SHA-256 hashes.
//
// Limits per UTC day:
//   with a key ............................ 10,000 requests
//   without a key, from another site ...... 200 requests per visitor (hashed IP)
//   from this site's own pages ............ unlimited (the map and the game)
//   new keys .............................. 5 per visitor
//
// `env.DB` is a Cloudflare D1 database (or the SQLite adapter in server.js). Without one,
// keys are switched off and every request is allowed, as before.

const KEY_LIMIT = 10000;
const ANON_LIMIT = 200;
const SIGNUPS_PER_DAY = 5;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS api_keys (hash TEXT PRIMARY KEY, prefix TEXT NOT NULL, name TEXT NOT NULL, site TEXT,
     created TEXT NOT NULL, daily_limit INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS api_usage (who TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL,
     PRIMARY KEY (who, day))`,
];

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => { for (const sql of SCHEMA) await db.prepare(sql).run(); })()
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

const today = () => new Date().toISOString().slice(0, 10);
const secondsToMidnight = () => {
  const now = new Date();
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now) / 1000);
};

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return "ek_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function reply(body, status = 200, extra = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, x-api-key, authorization",
      "access-control-expose-headers": "x-ratelimit-limit, x-ratelimit-remaining, retry-after",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function keyFrom(request, url) {
  const auth = request.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(ek_[0-9a-f]{48})$/i.exec(auth.trim());
  const key = url.searchParams.get("key") || request.headers.get("x-api-key") || (bearer && bearer[1]) || "";
  return key.trim();
}

// Requests made by this site's own pages (the map, the game, the key page).
function sameSite(request, url) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const referer = request.headers.get("referer");
  return !!referer && referer.startsWith(url.origin + "/");
}

async function visitor(request) {
  const ip = request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
  return "ip:" + (await sha256("earth-api:" + ip)).slice(0, 32);
}

async function bump(db, who, day) {
  const row = await db.prepare(
    `INSERT INTO api_usage (who, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT (who, day) DO UPDATE SET count = count + 1 RETURNING count`,
  ).bind(who, day).first();
  return row ? Number(row.count) : 1;
}

async function usedToday(db, who) {
  const row = await db.prepare("SELECT count FROM api_usage WHERE who = ?1 AND day = ?2").bind(who, today()).first();
  return row ? Number(row.count) : 0;
}

function clean(text, max) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);
}

// ---------- /api/keys ----------
async function keysEndpoint(request, url, db) {
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/keys" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* empty or not JSON */ }
    const name = clean(body.name, 60);
    const site = clean(body.site, 200);
    if (name.length < 2) return reply({ error: 'Give your project a "name" (2 to 60 characters).' }, 400);
    if (site && !/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(site)) return reply({ error: '"site" must be a web address starting with http:// or https://.' }, 400);
    const who = (await visitor(request)) + ":signup";
    if ((await usedToday(db, who)) >= SIGNUPS_PER_DAY) {
      return reply({ error: `You can create ${SIGNUPS_PER_DAY} keys a day. Try again tomorrow.` }, 429, { "retry-after": String(secondsToMidnight()) });
    }
    const key = newKey();
    const created = new Date().toISOString();
    await db.prepare("INSERT INTO api_keys (hash, prefix, name, site, created, daily_limit) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(await sha256(key), key.slice(0, 10), name, site || null, created, KEY_LIMIT).run();
    await bump(db, who, today());
    return reply({
      key, prefix: key.slice(0, 10), name, site: site || null, created, dailyLimit: KEY_LIMIT,
      note: "Save this key now: it is shown only once. Send it as ?key=... or an x-api-key header.",
      example: `${url.origin}/api/weather?lat=48.85&lon=2.35&key=${key}`,
    }, 201);
  }

  if (path === "/api/keys/me" && (request.method === "GET" || request.method === "DELETE")) {
    const key = keyFrom(request, url);
    if (!key) return reply({ error: "Send your key as ?key=... or an x-api-key header." }, 401);
    const hash = await sha256(key);
    const row = await db.prepare("SELECT prefix, name, site, created, daily_limit, revoked FROM api_keys WHERE hash = ?1").bind(hash).first();
    if (!row || row.revoked) return reply({ error: "This key does not exist or was revoked." }, 401);
    if (request.method === "DELETE") {
      await db.prepare("UPDATE api_keys SET revoked = 1 WHERE hash = ?1").bind(hash).run();
      return reply({ revoked: true, prefix: row.prefix });
    }
    const used = await usedToday(db, "key:" + hash);
    return reply({
      prefix: row.prefix, name: row.name, site: row.site, created: row.created,
      dailyLimit: Number(row.daily_limit), usedToday: used, remainingToday: Math.max(0, Number(row.daily_limit) - used),
      resetsInSeconds: secondsToMidnight(),
    });
  }

  return reply({ error: "Use POST /api/keys to create a key, GET /api/keys/me to see it, DELETE /api/keys/me to revoke it." }, 405);
}

// ---------- wrapper around the Earth API ----------
export async function withKeys(request, env, handle) {
  const url = new URL(request.url);
  const db = env && env.DB;
  if (request.method === "OPTIONS") return reply(null, 204);

  const isKeys = url.pathname === "/api/keys" || url.pathname.startsWith("/api/keys/");
  if (!db) return isKeys ? reply({ error: "API keys need a database, which this server does not have." }, 503) : handle(request);

  try {
    await ensureSchema(db);
    if (isKeys) return await keysEndpoint(request, url, db);

    const key = keyFrom(request, url);
    let who, limit;
    if (key) {
      const hash = await sha256(key);
      const row = await db.prepare("SELECT daily_limit, revoked FROM api_keys WHERE hash = ?1").bind(hash).first();
      if (!row || row.revoked) return reply({ error: "Unknown or revoked API key. Get one at " + url.origin + "/keys.html" }, 401);
      who = "key:" + hash; limit = Number(row.daily_limit);
    } else if (sameSite(request, url)) {
      return handle(request); // the site's own map and game
    } else {
      who = await visitor(request); limit = ANON_LIMIT;
    }

    const count = await bump(db, who, today());
    if (count > limit) {
      return reply({ error: key
        ? `This key used its ${limit} requests for today. It resets at midnight UTC.`
        : `Free requests without a key are limited to ${limit} a day. Get a free key at ${url.origin}/keys.html` },
      429, { "retry-after": String(secondsToMidnight()), "x-ratelimit-limit": String(limit), "x-ratelimit-remaining": "0" });
    }
    const res = await handle(request);
    const out = new Response(res.body, res);
    out.headers.set("x-ratelimit-limit", String(limit));
    out.headers.set("x-ratelimit-remaining", String(Math.max(0, limit - count)));
    out.headers.set("access-control-allow-headers", "content-type, x-api-key, authorization");
    out.headers.set("access-control-expose-headers", "x-ratelimit-limit, x-ratelimit-remaining, retry-after");
    return out;
  } catch (err) {
    console.error("api keys:", err);
    if (isKeys) return reply({ error: "The key service is having trouble. Try again in a minute." }, 503);
    return handle(request); // never take the API down because of the key database
  }
}

export const LIMITS = { KEY_LIMIT, ANON_LIMIT, SIGNUPS_PER_DAY };
