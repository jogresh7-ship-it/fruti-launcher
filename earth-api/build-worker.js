// Builds dist/_worker.js: one file that serves the page and the API on
// Cloudflare Pages (advanced mode). Used by the API-based deploy; the normal
// Git deploy uses functions/ + public/ instead.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const core = read("./src/earth.js").replace(/^export \{[^}]*\};?\s*$/m, "");
const files = {
  "/": ["text/html; charset=utf-8", read("./public/index.html")],
  "/earth-browser.js": ["text/javascript; charset=utf-8", read("./public/earth-browser.js")],
  "/app.js": ["text/javascript; charset=utf-8", read("./public/app.js")],
};
const worker = `${core}
const FILES = ${JSON.stringify(files)};
FILES["/index.html"] = FILES["/"];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handle(request);
    const file = FILES[url.pathname];
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(file[1], { headers: { "content-type": file[0], "cache-control": "public, max-age=300" } });
  },
};
`;
mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/_worker.js", import.meta.url), worker);
console.log("Wrote dist/_worker.js", worker.length, "bytes");
