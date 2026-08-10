#!/usr/bin/env node
/**
 * Sync desktop / Android release assets to the brand download host (self-hosted nginx).
 *
 *   pnpm sync:release-cdn --desktop <dir> --version <ver> [--channel stable|beta]
 *   pnpm sync:release-cdn --android <apkPath> --version <ver>
 *   pnpm sync:release-cdn --from-github [--channel stable|beta]
 *   pnpm sync:release-cdn --from-github --desktop-only
 *   pnpm sync:release-cdn --from-github --android-only
 *   pnpm sync:release-cdn --install-nginx            # one-time nginx site on :8092
 *
 * Desktop channels (§7.6c):
 *   stable (default) → write desktop/stable/* and mirror same content to flat desktop/
 *     (旧客户端曾把 desktop/latest.yml 当 feed；镜像避免断更)
 *   beta → write desktop/beta/* only（绝不污染 flat 或 stable）
 *
 * Env (deploy/.env.deploy.local):
 *   DEPLOY_SSH_*                 (same as deploy:web / admin)
 *   AGENTCORE_DOWNLOADS_BASE     (optional; default https://downloads.fashitianxia.xyz)
 *   AGENTCORE_DOWNLOADS_HOST     (optional; nginx server_name / tunnel hostname)
 *   AGENTCORE_DOWNLOADS_ROOT     (optional; remote dir, default /opt/agentcore/downloads)
 *
 * Prerequisites: downloads-remote-install + Cloudflare Tunnel Public Hostname — §7.6b.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  REPO_ROOT,
  loadDeployEnv,
  requireEnv,
  scp,
  sshScript,
} from "./load-deploy-env.mjs";
import {
  DESKTOP_CHANNEL_DEFAULT,
  DOWNLOADS_ANDROID_PREFIX,
  DOWNLOADS_DESKTOP_PREFIX,
  RELEASES_REPO,
  androidApkFilename,
  artifactUrlsForVersion,
  buildAndroidLatestJson,
  buildDesktopLatestJson,
  cdnUrl,
  desktopChannelPrefix,
  desktopLatestJsonUrl,
  desktopSyncDestPrefixes,
  macDmgFilename,
  normalizeDesktopChannel,
  winInstallerFilename,
} from "../../apps/website/functions/_lib/downloadsCdn.mjs";

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {
    desktopDir: "",
    androidPath: "",
    version: "",
    channel: DESKTOP_CHANNEL_DEFAULT,
    fromGithub: false,
    desktopOnly: false,
    androidOnly: false,
    installNginx: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--desktop" && argv[i + 1]) out.desktopDir = argv[++i];
    else if (a === "--android" && argv[i + 1]) out.androidPath = argv[++i];
    else if (a === "--version" && argv[i + 1]) out.version = argv[++i];
    else if (a === "--channel" && argv[i + 1]) {
      out.channel = normalizeDesktopChannel(argv[++i]);
    } else if (a === "--from-github") out.fromGithub = true;
    else if (a === "--desktop-only") out.desktopOnly = true;
    else if (a === "--android-only") out.androidOnly = true;
    else if (a === "--install-nginx") out.installNginx = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function downloadsRoot() {
  return (
    process.env.AGENTCORE_DOWNLOADS_ROOT?.trim() || "/opt/agentcore/downloads"
  );
}

function downloadsHost() {
  return (
    process.env.AGENTCORE_DOWNLOADS_HOST?.trim() || "downloads.fashitianxia.xyz"
  );
}

/** Upload one local file to remote absolute path (creates parent dirs). */
function putRemoteFile(localPath, remoteAbsPath) {
  const remoteDir = dirname(remoteAbsPath).replace(/\\/g, "/");
  const tmpName = `ac-dl-${Date.now()}-${basename(localPath)}`;
  const tmpRemote = `/tmp/${tmpName}`;
  console.log(`→ scp ${basename(localPath)} → ${remoteAbsPath}`);
  scp(localPath, tmpRemote);
  sshScript(`set -euo pipefail
mkdir -p "${remoteDir}"
mv -f "${tmpRemote}" "${remoteAbsPath}"
`);
}

/** Upload every file under localDir into remoteAbsDir (flat). */
function putRemoteDirFiles(localDir, remoteAbsDir, names) {
  const list = names.filter((n) => existsSync(join(localDir, n)));
  if (list.length === 0) return [];
  // Per-file scp: Windows `tar -czf` often produces archives Linux GNU tar rejects
  // (trailing garbage / xattr), which broke release:win CDN sync.
  for (const n of list) {
    putRemoteFile(join(localDir, n), `${remoteAbsDir}/${n}`);
  }
  return list;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "agentcore-sync-release-cdn",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function downloadTo(url, dest) {
  const res = await fetch(url, {
    headers: { "User-Agent": "agentcore-sync-release-cdn" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

/**
 * Merge desktop latest.json for a channel: keep the other platform's filename
 * when only win or mac is being synced this run.
 * @param {import("../../apps/website/functions/_lib/downloadsCdn.mjs").DesktopChannel} channel
 * @param {object} nextPartial
 */
async function mergeDesktopLatestJson(channel, nextPartial) {
  const candidates = [desktopLatestJsonUrl(channel)];
  // Migration: first stable sync may only have flat desktop/latest.json.
  if (channel === "stable") {
    candidates.push(cdnUrl(`${DOWNLOADS_DESKTOP_PREFIX}/latest.json`));
  }
  for (const url of candidates) {
    try {
      const prev = await fetchJson(url);
      return buildDesktopLatestJson({
        version: nextPartial.version || prev.version,
        winFilename: nextPartial.winFilename || prev.winFilename,
        macFilename:
          nextPartial.macFilename !== undefined
            ? nextPartial.macFilename
            : prev.macFilename || "",
        releaseNotesUrl: nextPartial.releaseNotesUrl || prev.releaseNotesUrl,
      });
    } catch {
      // try next candidate
    }
  }
  return buildDesktopLatestJson(nextPartial);
}

function collectDesktopNames(version, desktopDir) {
  const winName = winInstallerFilename(version);
  const macName = macDmgFilename(version);
  const macZip = `AgentCore-${version}-mac-arm64.zip`;
  const candidates = [
    winName,
    `${winName}.blockmap`,
    "latest.yml",
    macName,
    `${macName}.blockmap`,
    macZip,
    `${macZip}.blockmap`,
    "latest-mac.yml",
  ];
  const present = candidates.filter((n) => existsSync(join(desktopDir, n)));
  return {
    present,
    hasWin: present.includes(winName),
    hasMac: present.includes(macName),
    winName,
    macName: present.includes(macName) ? macName : "",
  };
}

/**
 * @param {string} version
 * @param {string} desktopDir
 * @param {import("../../apps/website/functions/_lib/downloadsCdn.mjs").DesktopChannel} channel
 */
function syncDesktopDir(version, desktopDir, channel) {
  if (!existsSync(desktopDir)) {
    console.error(`desktop dir not found: ${desktopDir}`);
    process.exit(1);
  }
  const flags = collectDesktopNames(version, desktopDir);
  if (flags.present.length === 0) {
    console.error(`No desktop assets found under ${desktopDir}`);
    process.exit(1);
  }
  if (!flags.hasWin && !flags.hasMac) {
    console.error(
      `Expected win and/or mac installer in ${desktopDir}; got: ${flags.present.join(", ")}`,
    );
    process.exit(1);
  }
  const root = downloadsRoot();
  const dests = desktopSyncDestPrefixes(channel);
  for (const rel of dests) {
    putRemoteDirFiles(desktopDir, `${root}/${rel}`, flags.present);
  }
  console.log(
    `✓ desktop assets → ${dests.map((d) => `${d}/`).join(" + ")} (channel=${channel})`,
  );
  return flags;
}

/**
 * @param {string} version
 * @param {object} flags
 * @param {import("../../apps/website/functions/_lib/downloadsCdn.mjs").DesktopChannel} channel
 */
async function writeDesktopManifest(version, flags, channel) {
  const { hasWin, hasMac, winName, macName } = flags;
  const manifest = await mergeDesktopLatestJson(channel, {
    version,
    ...(hasWin ? { winFilename: winName } : {}),
    ...(hasMac ? { macFilename: macName } : {}),
    releaseNotesUrl: artifactUrlsForVersion(version).releaseNotesUrl,
  });

  if (!manifest.winFilename) {
    console.error("desktop latest.json missing winFilename after merge");
    process.exit(1);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "ac-cdn-"));
  const tmp = join(tmpDir, "latest.json");
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const root = downloadsRoot();
  for (const rel of desktopSyncDestPrefixes(channel)) {
    putRemoteFile(tmp, `${root}/${rel}/latest.json`);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(
    `✓ desktop/${channel} latest.json → v${manifest.version}` +
      (channel === "stable" ? " (+ flat mirror)" : ""),
  );
  console.log(`  win: ${manifest.winFilename}`);
  console.log(`  mac: ${manifest.macFilename || "(none)"}`);
  return manifest;
}

async function syncAndroidFile(version, apkPath) {
  if (!existsSync(apkPath)) {
    console.error(`APK not found: ${apkPath}`);
    process.exit(1);
  }
  const name = basename(apkPath);
  const expected = androidApkFilename(version);
  if (name !== expected) {
    console.warn(`⚠ APK name ${name} ≠ expected ${expected} — uploading as ${name}`);
  }
  const root = downloadsRoot();
  putRemoteFile(apkPath, `${root}/${DOWNLOADS_ANDROID_PREFIX}/${name}`);
  const manifest = buildAndroidLatestJson({ version, filename: name });
  const tmpDir = mkdtempSync(join(tmpdir(), "ac-cdn-"));
  const tmp = join(tmpDir, "latest.json");
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  putRemoteFile(tmp, `${root}/${DOWNLOADS_ANDROID_PREFIX}/latest.json`);
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`✓ android latest.json → v${version} (${name})`);
  return manifest;
}

/** @param {string} tag */
function isStableDesktopTag(tag) {
  return /^v\d+\.\d+\.\d+$/i.test(tag);
}

/** @param {string} tag */
function isBetaDesktopTag(tag) {
  return /^v\d+\.\d+\.\d+-.+/i.test(tag) && !tag.startsWith("android-");
}

/**
 * Desktop "latest" on GitHub is NOT always /releases/latest (Android tags can win).
 * Prefer newest matching non-draft tag for the requested channel.
 * @param {import("../../apps/website/functions/_lib/downloadsCdn.mjs").DesktopChannel} channel
 */
async function fetchLatestDesktopGithubRelease(channel) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`,
  );
  if (!Array.isArray(releases)) throw new Error("GitHub releases list invalid");
  const tagOk = channel === "beta" ? isBetaDesktopTag : isStableDesktopTag;
  for (const release of releases) {
    if (release.draft) continue;
    const tag = String(release.tag_name ?? "");
    if (!tagOk(tag)) continue;
    const assets = release.assets ?? [];
    const hasDesktop = assets.some(
      (a) =>
        /-win-x64\.exe$/i.test(a.name) ||
        a.name === "latest.yml" ||
        /-mac-arm64\.dmg$/i.test(a.name),
    );
    if (!hasDesktop) continue;
    return release;
  }
  throw new Error(
    `No published desktop ${channel} release found on GitHub`,
  );
}

/**
 * @param {{ desktopOnly: boolean, androidOnly: boolean, channel: string }} opts
 */
async function syncFromGithub({ desktopOnly, androidOnly, channel }) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "ac-cdn-gh-"));
  try {
    if (!androidOnly) {
      const latest = await fetchLatestDesktopGithubRelease(channel);
      const version = String(latest.tag_name).replace(/^v/, "");
      const assets = latest.assets ?? [];
      const dir = join(tmpRoot, "desktop");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      const want = new Set([
        winInstallerFilename(version),
        `${winInstallerFilename(version)}.blockmap`,
        "latest.yml",
        macDmgFilename(version),
        `${macDmgFilename(version)}.blockmap`,
        `AgentCore-${version}-mac-arm64.zip`,
        `AgentCore-${version}-mac-arm64.zip.blockmap`,
        "latest-mac.yml",
      ]);
      for (const asset of assets) {
        if (!want.has(asset.name)) continue;
        console.log(`→ download GH ${asset.name}`);
        await downloadTo(asset.browser_download_url, join(dir, asset.name));
      }
      const flags = syncDesktopDir(version, dir, channel);
      await writeDesktopManifest(version, flags, channel);
    }

    if (!desktopOnly) {
      const releases = await fetchJson(
        `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`,
      );
      if (!Array.isArray(releases)) throw new Error("GitHub releases list invalid");
      let found = null;
      for (const release of releases) {
        if (release.draft) continue;
        const apk = (release.assets ?? []).find((a) =>
          /-android\.apk$/i.test(a.name),
        );
        if (!apk) continue;
        const tag = String(release.tag_name ?? "");
        const version = tag.startsWith("android-v")
          ? tag.slice("android-v".length)
          : tag.replace(/^v/, "");
        found = { version, apk };
        break;
      }
      if (!found) {
        console.warn("⚠ no published Android APK on GitHub — skip android sync");
      } else {
        const dest = join(tmpRoot, found.apk.name);
        console.log(`→ download GH ${found.apk.name}`);
        await downloadTo(found.apk.browser_download_url, dest);
        await syncAndroidFile(found.version, dest);
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function installNginxRemote() {
  requireEnv("DEPLOY_SSH_HOST");
  const conf = join(REPO_ROOT, "deploy/nginx/downloads.conf");
  if (!existsSync(conf)) {
    console.error(`missing ${conf}`);
    process.exit(1);
  }
  scp(conf, "/tmp/downloads.conf");
  const script = readFileSync(
    join(REPO_ROOT, "deploy/scripts/downloads-remote-install.sh"),
    "utf8",
  );
  const host = downloadsHost();
  sshScript(`export DOWNLOADS_HOST=${JSON.stringify(host)}
${script}`);
}

async function main() {
  loadDeployEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  pnpm sync:release-cdn --install-nginx
  pnpm sync:release-cdn --desktop <dir> --version <ver> [--channel stable|beta]
  pnpm sync:release-cdn --android <apk> --version <ver>
  pnpm sync:release-cdn --from-github [--channel stable|beta] [--desktop-only|--android-only]
`);
    process.exit(0);
  }

  // Touch SSH early so missing keys fail before long GH downloads.
  requireEnv("DEPLOY_SSH_HOST");
  requireEnv("DEPLOY_SSH_USER");

  if (args.installNginx) {
    installNginxRemote();
    return;
  }

  const channel = normalizeDesktopChannel(
    /** @type {string} */ (args.channel || DESKTOP_CHANNEL_DEFAULT),
  );

  if (args.fromGithub) {
    console.log(
      `→ sync from GitHub → ${downloadsRoot()} @ ${downloadsHost()} (channel=${channel})`,
    );
    await syncFromGithub({
      desktopOnly: Boolean(args.desktopOnly),
      androidOnly: Boolean(args.androidOnly),
      channel,
    });
    console.log(
      `✓ CDN sync complete → ${cdnUrl(desktopChannelPrefix(channel))}/`,
    );
    return;
  }

  if (!args.desktopDir && !args.androidPath) {
    console.error(
      "usage: pnpm sync:release-cdn --desktop <dir> --version <ver> [--channel stable|beta]\n" +
        "       pnpm sync:release-cdn --android <apk> --version <ver>\n" +
        "       pnpm sync:release-cdn --from-github [--channel stable|beta]\n" +
        "       pnpm sync:release-cdn --install-nginx",
    );
    process.exit(1);
  }
  if (!args.version) {
    console.error("Missing --version");
    process.exit(1);
  }

  if (args.desktopDir) {
    const flags = syncDesktopDir(
      /** @type {string} */ (args.version),
      /** @type {string} */ (args.desktopDir),
      channel,
    );
    await writeDesktopManifest(
      /** @type {string} */ (args.version),
      flags,
      channel,
    );
  }
  if (args.androidPath) {
    if (channel === "beta") {
      console.warn(
        "⚠ --android ignores --channel (android rail unchanged); writing android/",
      );
    }
    await syncAndroidFile(
      /** @type {string} */ (args.version),
      /** @type {string} */ (args.androidPath),
    );
  }
  console.log(`✓ CDN sync complete → ${cdnUrl("")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
