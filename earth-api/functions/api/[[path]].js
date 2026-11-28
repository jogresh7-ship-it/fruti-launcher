// Cloudflare Pages Function: every request to /api/* lands here.
// Bind a D1 database as "DB" in the Pages project to switch on API keys.
import { handle } from "../../src/earth.js";
import { withKeys } from "../../src/keys.js";

export const onRequest = ({ request, env }) => withKeys(request, env, handle);
