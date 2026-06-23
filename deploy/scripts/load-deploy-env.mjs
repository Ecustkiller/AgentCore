/**
 * Load deploy secrets from local env files (gitignored). Later files do not override earlier keys.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dir, "../..");
export const CF_ACCOUNT_ID = "e784e487f8ab57882d4b24d845ccfad1";

const ENV_FILES = [
  join(REPO_ROOT, "deploy/.env.deploy.local"),
  join(REPO_ROOT, "apps/website/.env.deploy.local"),
];

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

export function loadDeployEnv() {
  for (const file of ENV_FILES) {
    loadDotEnv(file);
  }
}

export function requireEnv(name) {
  const val = process.env[name]?.trim();
  if (!val) {
    console.error(`Missing ${name} — set in deploy/.env.deploy.local`);
    process.exit(1);
  }
  return val;
}

export function run(label, cmd, args, opts = {}) {
  console.log(`→ ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: opts.input ? ["pipe", "inherit", "inherit"] : (opts.stdio ?? "inherit"),
    env: opts.env ?? process.env,
    input: opts.input,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function cfEnv() {
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  return {
    ...process.env,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
  };
}

export function sshArgs() {
  const host = requireEnv("DEPLOY_SSH_HOST");
  const user = requireEnv("DEPLOY_SSH_USER");
  const port = process.env.DEPLOY_SSH_PORT?.trim() || "22";
  const keyPath =
    process.env.DEPLOY_SSH_KEY_PATH?.trim() ||
    process.env.DEPLOY_SSH_KEY?.trim();
  if (!keyPath) {
    console.error(
      "Missing DEPLOY_SSH_KEY_PATH — path to SSH private key for production server",
    );
    process.exit(1);
  }
  if (!existsSync(keyPath)) {
    console.error(`SSH key not found: ${keyPath}`);
    process.exit(1);
  }
  return { host, user, port, keyPath };
}

export function scp(localPath, remotePath) {
  const { host, user, port, keyPath } = sshArgs();
  run(`scp ${localPath}`, "scp", [
    "-i",
    keyPath,
    "-P",
    port,
    "-o",
    "StrictHostKeyChecking=accept-new",
    localPath,
    `${user}@${host}:${remotePath}`,
  ]);
}

export function sshScript(scriptText) {
  const { host, user, port, keyPath } = sshArgs();
  run("ssh remote script", "ssh", [
    "-i",
    keyPath,
    "-p",
    port,
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${user}@${host}`,
    "bash -s",
  ], { input: scriptText });
}
