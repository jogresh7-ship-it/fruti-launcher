// Local server: node server.js, then open http://localhost:8787
// No packages needed. Serves public/ and the same /api routes as Cloudflare.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";
import { handle } from "./src/earth.js";
import { withKeys } from "./src/keys.js";
import { openD1 } from "./src/sqlite-d1.js";

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = new URL("./public/", import.meta.url).pathname;
// API keys are stored in data/keys.sqlite (git-ignored).
mkdirSync(new URL("./data/", import.meta.url), { recursive: true });
const env = { DB: openD1(new URL("./data/keys.sqlite", import.meta.url).pathname) };

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".glb": "model/gltf-binary" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length && !["GET", "HEAD"].includes(req.method) ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      headers.set("x-forwarded-for", req.socket.remoteAddress || "local");
      const response = await withKeys(new Request(url, { method: req.method, headers, body }), env, handle);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = normalize(join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC)) throw new Error("outside");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, () => console.log(`Earth API running at http://localhost:${PORT}  (try /api/sun?lat=48.85&lon=2.35)`));
