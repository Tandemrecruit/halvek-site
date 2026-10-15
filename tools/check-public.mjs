// Runs before `npm run deploy` and stops a deploy of a public/ folder that isn't ready:
// missing, or carrying a placeholder or test Turnstile site key (the form would never send).
import { readFileSync } from "node:fs";

function stop(message) {
  console.error(`Not deploying: ${message}`);
  process.exit(1);
}

let html = "";
try {
  html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
} catch {
  stop("public/index.html is missing. Build it with: python3 tools/export_site.py");
}

const key = (html.match(/data-sitekey="([^"]*)"/) || [])[1] || "";
if (!key || key === "TURNSTILE_SITE_KEY" || /^[123]x0{20}[A-F]{2}$/.test(key)) {
  stop(`public/index.html has no real Turnstile site key (found "${key || "none"}"). Put it in tools/site.json and rebuild.`);
}
if (!html.includes('src="/quote.js"')) stop("public/index.html doesn't load /quote.js.");

console.log(`public/ is ready (Turnstile site key ${key.slice(0, 8)}…).`);
