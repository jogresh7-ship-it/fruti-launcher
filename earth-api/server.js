// Local server: node server.js, then open http://localhost:8787
// No packages needed. Serves public/ and the same /api routes as Cloudflare.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { handle } from "./src/earth.js";

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = new URL("./public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".glb": "model/gltf-binary" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const response = await handle(new Request(url, { method: req.method }));
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
