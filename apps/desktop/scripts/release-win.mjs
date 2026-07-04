#!/usr/bin/env node
/**
 * Windows desktop release: bundle sidecar → electron-vite build → electron-builder upload.
 *
 *   pnpm -C apps/desktop release:win
 *   pnpm -C apps/desktop release:win -- --skip-draft   # draft already exists
 *
 * Prerequisites:
 *   - `gh auth login` with write access to Lawofall/AgentCore-releases
 *   - GH_TOKEN or `gh auth token` available (electron-builder publish)
 *
 * See docs/05-平台与运维/部署与运维.md §7.6 — pre-create draft release to avoid
 * electron-builder#6676 upload race (only .blockmap, missing .exe).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadDeployEnv, REPO_ROOT, run } from "../../../deploy/scripts/load-deploy-env.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dir, "..");
const RELEASES_REPO = "Lawofall/AgentCore-releases";

const skipDraft = process.argv.includes("--skip-draft");

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(DESKTOP_DIR, "package.json"), "utf8"));
  return pkg.version;
}

function gh(args, { allowFail = false } = {}) {
  const result = spawnSync("gh", args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  if (!allowFail && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.status === 0;
}

function ensureGhToken() {
  if (process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()) return;
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status === 0 && result.stdout?.trim()) {
    process.env.GH_TOKEN = result.stdout.trim();
    console.log("→ GH_TOKEN from gh auth token");
    return;
  }
  console.error("Missing GH_TOKEN — run `gh auth login` or export GH_TOKEN");
  process.exit(1);
}

function ensureDraftRelease(tag) {
  if (skipDraft) {
    console.log(`→ skip draft (--skip-draft); expecting ${tag} on ${RELEASES_REPO}`);
    return;
  }
  console.log(`→ ensure draft release ${tag} on ${RELEASES_REPO}`);
  if (gh(["release", "view", tag, "--repo", RELEASES_REPO], { allowFail: true })) {
    console.log(`  draft/release ${tag} already exists`);
    return;
  }
  gh([
    "release",
    "create",
    tag,
    "--repo",
    RELEASES_REPO,
    "--draft",
    "--title",
    tag,
    "--notes",
    "Desktop release (draft — publish after asset check).",
  ]);
}

function main() {
  loadDeployEnv();
  ensureGhToken();

  const version = readVersion();
  const tag = `v${version}`;
  const releaseDir = join(DESKTOP_DIR, "release", version);

  console.log(`→ desktop release ${version} (Windows)`);
  ensureDraftRelease(tag);

  run("bundle:sidecar", "pnpm", ["bundle:sidecar"], { cwd: DESKTOP_DIR });
  run("electron-vite build", "pnpm", ["exec", "electron-vite", "build"], {
    cwd: DESKTOP_DIR,
  });
  run("electron-builder --win --publish always", "pnpm", [
    "exec",
    "electron-builder",
    "--win",
    "--publish",
    "always",
  ], { cwd: DESKTOP_DIR, env: process.env });

  console.log("");
  console.log("✓ Build + upload finished. Verify assets:");
  console.log(`  gh release view ${tag} --repo ${RELEASES_REPO}`);
  console.log(`  ls ${releaseDir}`);
  console.log("");
  console.log("Win-only dev publish (optional):");
  console.log(
    `  gh release edit ${tag} --repo ${RELEASES_REPO} --draft=false --latest`,
  );
  console.log("Then bump website FALLBACK_VERSION + pnpm -C apps/website deploy:pages");
}

main();
