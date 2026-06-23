#!/usr/bin/env node
/**
 * Build + deploy website to Cloudflare Pages (direct-upload).
 * Token: CLOUDFLARE_API_TOKEN in .env.deploy.local or OS env — never commit.
 *
 *   pnpm -C apps/website deploy:pages
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const ACCOUNT_ID = "e784e487f8ab57882d4b24d845ccfad1";
const PROJECT = "agentcore-website";

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function run(label, cmd, args, env = process.env) {
  console.log(`→ ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

loadDotEnv(join(ROOT, ".env.deploy.local"));

const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!token) {
  console.error(
    "Missing CLOUDFLARE_API_TOKEN — copy .env.deploy.local.example → .env.deploy.local",
  );
  process.exit(1);
}

const deployEnv = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
};

run("pnpm build", "pnpm", ["build"], deployEnv);
run(
  `wrangler pages deploy → ${PROJECT}`,
  "npx",
  [
    "--yes",
    "wrangler@4",
    "pages",
    "deploy",
    "out",
    "--project-name",
    PROJECT,
    "--branch",
    "main",
  ],
  deployEnv,
);

console.log("✓ Deploy complete — verify https://fashitianxia.xyz/download/");
