// `npm run deploy`: deploys the Worker with Wrangler.
//
// TURNSTILE_SECRET_KEY and ZEPTOMAIL_TOKEN can live as build secrets in Workers Builds
// (Settings → Builds → Variables and secrets). Build secrets only exist while the build runs,
// so this passes any that are present on to the Worker itself as runtime secrets, through
// Wrangler's --secrets-file. Secrets set directly on the Worker are left alone; only the ones
// present here are added or updated.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const RUNTIME_SECRETS = ["TURNSTILE_SECRET_KEY", "ZEPTOMAIL_TOKEN"];

// Wrangler's own executable, found through its package.json (the only file it exports by path).
const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const wrangler = join(dirname(wranglerPackage), require(wranglerPackage).bin.wrangler);
const args = [wrangler, "deploy", ...process.argv.slice(2)];

const present = RUNTIME_SECRETS.filter((name) => (process.env[name] || "").trim());
let dir = null;
if (present.length) {
  dir = mkdtempSync(join(tmpdir(), "halvek-secrets-"));
  const file = join(dir, "secrets.json");
  writeFileSync(file, JSON.stringify(Object.fromEntries(present.map((name) => [name, process.env[name].trim()]))), {
    mode: 0o600,
  });
  args.push("--secrets-file", file);
  console.log(`Passing ${present.join(" and ")} to the Worker as secrets.`);
} else {
  console.log("No build secrets found; the Worker keeps whatever secrets it already has.");
}

let status = 1;
try {
  const run = spawnSync(process.execPath, args, { stdio: "inherit" });
  status = run.status ?? 1;
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
