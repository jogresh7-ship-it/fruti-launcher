// Cloudflare Pages Function: every request to /api/* lands here.
import { handle } from "../../src/earth.js";

export const onRequest = ({ request }) => handle(request);
