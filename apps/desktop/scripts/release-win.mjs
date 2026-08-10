#!/usr/bin/env node
/**
 * Windows desktop release: bundle sidecar → electron-vite build → local package
 * → `gh release upload` (Mac-aligned; no electron-builder --publish).
 *
 *   pnpm -C apps/desktop release:win
 *   pnpm -C apps/desktop release:win -- --skip-draft   # draft already exists
 *   pnpm -C apps/desktop release:win -- --channel=beta
 *   DESKTOP_RELEASE_CHANNEL=beta pnpm -C apps/desktop release:win
 *
 * Prerequisites:
 *   - `gh auth login` with write access to Lawofall/AgentCore-releases
 *   - GH_TOKEN or `gh auth token` available
 *
 * Mirrors `.github/workflows/release-desktop.yml` Mac path:
 *   electron-builder --publish never → assert local assets → gh upload --clobber
 *   → parse `gh release view` asset list (missing → non-zero exit).
 *
 * See docs/05-平台与运维/部署与运维.md §7.6 — pre-create draft release.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ROOT,
  loadDeployEnv,
  run,
} from "../../../deploy/scripts/load-deploy-env.mjs";
import {
  RELEASE_CHANNEL_ENV,
  resolveChannelFromArgv,
  resolveReleaseIdentity,
} from "./release-channel.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dir, "..");
const RELEASES_REPO = "Lawofall/AgentCore-releases";

const skipDraft = process.argv.includes("--skip-draft");
const channel = resolveChannelFromArgv(process.argv.slice(2));
const identity = resolveReleaseIdentity(channel);
process.env[RELEASE_CHANNEL_ENV] = channel;

function readVersion() {
  const pkg = JSON.parse(
    readFileSync(join(DESKTOP_DIR, "package.json"), "utf8"),
  );
  return pkg.version;
}

function winAssetNames(version) {
  const slug = identity.artifactSlug;
  return [
    `${slug}-${version}-win-x64.exe`,
    `${slug}-${version}-win-x64.exe.blockmap`,
    "latest.yml",
  ];
}

function gh(args, { allowFail = false, capture = false } = {}) {
  const result = spawnSync("gh", args, {
    cwd: REPO_ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: capture ? "utf8" : undefined,
    shell: false,
    env: process.env,
  });
  if (!allowFail && result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return capture
    ? {
        ok: result.status === 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      }
    : result.status === 0;
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
    console.log(
      `→ skip draft (--skip-draft); expecting ${tag} on ${RELEASES_REPO}`,
    );
    return;
  }
  console.log(`→ ensure draft release ${tag} on ${RELEASES_REPO}`);
  if (
    gh(["release", "view", tag, "--repo", RELEASES_REPO], { allowFail: true })
  ) {
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

function assertLocalAssets(releaseDir, version) {
  const names = winAssetNames(version);
  const paths = [];
  for (const name of names) {
    const path = join(releaseDir, name);
    if (!existsSync(path)) {
      console.error(`Missing local asset: ${path}`);
      process.exit(1);
    }
    paths.push(path);
  }
  console.log(`→ local assets ok: ${names.join(", ")}`);
  return paths;
}

function uploadAndVerify(tag, version, paths) {
  console.log(`→ gh release upload ${tag} --clobber`);
  gh([
    "release",
    "upload",
    tag,
    ...paths,
    "--repo",
    RELEASES_REPO,
    "--clobber",
  ]);

  const { stdout } = gh(
    ["release", "view", tag, "--repo", RELEASES_REPO, "--json", "assets"],
    { capture: true },
  );
  let assets;
  try {
    assets = JSON.parse(stdout).assets ?? [];
  } catch (err) {
    console.error(`Failed to parse gh release view JSON: ${err}`);
    process.exit(1);
  }
  const present = new Set(assets.map((a) => a.name));
  const required = winAssetNames(version);
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    console.error(`Release ${tag} missing assets: ${missing.join(", ")}`);
    console.error(`Present: ${[...present].join(", ") || "(none)"}`);
    process.exit(1);
  }
  console.log(`✓ remote assets verified on ${tag}: ${required.join(", ")}`);
}

function main() {
  loadDeployEnv();
  ensureGhToken();

  const version = readVersion();
  const tag = `v${version}`;
  const releaseDir = join(DESKTOP_DIR, "release", version);

  console.log(
    `→ desktop release ${version} (Windows, channel=${channel}, appId=${identity.appId})`,
  );
  ensureDraftRelease(tag);

  run("bundle:sidecar", "pnpm", ["bundle:sidecar"], { cwd: DESKTOP_DIR });
  run("electron-vite build", "pnpm", ["exec", "electron-vite", "build"], {
    cwd: DESKTOP_DIR,
    env: process.env,
  });
  // Mac-aligned: never publish via electron-builder (avoids #6676 / #2393).
  run(
    "electron-builder --win --publish never",
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--config",
      "electron-builder.config.mjs",
      "--win",
      "--publish",
      "never",
    ],
    { cwd: DESKTOP_DIR, env: process.env },
  );

  const paths = assertLocalAssets(releaseDir, version);
  uploadAndVerify(tag, version, paths);

  // Brand host (nginx) — electron-updater feed；官网首装走 GitHub Releases。
  // CDN 分目录（…/desktop/{channel}）由 sync-release-cdn 块落地；此处仍传本地产物目录。
  run(
    "sync:release-cdn (desktop)",
    process.execPath,
    [
      join(REPO_ROOT, "deploy/scripts/sync-release-cdn.mjs"),
      "--desktop",
      releaseDir,
      "--version",
      version,
      "--channel",
      channel,
    ],
    { cwd: REPO_ROOT, env: process.env },
  );

  console.log("");
  console.log(`✓ Win release ${tag} built and uploaded to ${RELEASES_REPO}`);
  console.log(`  channel: ${channel} (${identity.productName})`);
  console.log(`  local: ${releaseDir}`);
  console.log(`  feed: ${identity.publishUrl}`);
  console.log("");
  console.log("Win-only dev publish (optional):");
  console.log(
    `  gh release edit ${tag} --repo ${RELEASES_REPO} --draft=false --latest`,
  );
  console.log(
    "Then: pnpm -C apps/website deploy:pages (FALLBACK synced by bump-version desktop)",
  );
}

main();
