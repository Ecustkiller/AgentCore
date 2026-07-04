#!/usr/bin/env node
/**
 * Upload a static dist directory to Cloudflare Pages (wrangler direct-upload).
 *
 * Run as a **standalone Node process** so heavy prior steps (vite build, pnpm) in the
 * parent deploy script do not trip Windows libuv handle teardown
 * (Assertion failed: UV_HANDLE_CLOSING on spawnSync + shell:true).
 *
 *   node deploy/scripts/wrangler-pages-deploy.mjs <project> <distPath> [--branch main]
 *
 * Env: CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID via cfEnv when invoked from deploy).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cfEnv, loadDeployEnv } from "./load-deploy-env.mjs";

function parseArgs(argv) {
  const positional = [];
  let branch = "main";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--branch" && argv[i + 1]) {
      branch = argv[++i];
    } else {
      positional.push(arg);
    }
  }
  const [project, distPath] = positional;
  if (!project || !distPath) {
    console.error(
      "usage: node deploy/scripts/wrangler-pages-deploy.mjs <project> <distPath> [--branch main]",
    );
    process.exit(1);
  }
  return { project, distPath: resolve(distPath), branch };
}

loadDeployEnv();

const { project, distPath, branch } = parseArgs(process.argv.slice(2));

if (!existsSync(distPath)) {
  console.error(`dist not found: ${distPath}`);
  process.exit(1);
}

const env = cfEnv();
console.log(`→ wrangler pages deploy → ${project} (${distPath})`);

const result = spawnSync(
  "npx",
  [
    "--yes",
    "wrangler@4",
    "pages",
    "deploy",
    distPath,
    "--project-name",
    project,
    "--branch",
    branch,
  ],
  {
    stdio: "inherit",
    env,
    shell: false,
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
