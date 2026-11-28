// A tiny stand-in for Cloudflare D1 on top of Node's built-in SQLite (node:sqlite),
// so API keys also work with the local server. Only what src/keys.js uses.
import { DatabaseSync } from "node:sqlite";

export function openD1(file) {
  const db = new DatabaseSync(file);
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...values) { args = values; return api; },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { stmt.run(...args); return { success: true }; },
      };
      return api;
    },
  };
}
