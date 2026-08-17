/**
 * Conservative keep/delete plan for brand-host download artifacts.
 *
 * Brand host only serves electron-updater feeds. Updater reads latest.yml /
 * latest-mac.yml (current version only); delta updates use the *new* version's
 * blockmap against the locally installed files. Old installers on this host
 * have no consumers — GitHub Releases is the archive.
 *
 * Keep set (union, per destination directory — never recurse):
 *   - latest.yml / latest-mac.yml / latest.json (always)
 *   - every versioned installer/blockmap/apk whose version is the current
 *     sync version *or* still named by that dest's feed manifests
 *   - any file we cannot attribute to a versioned artifact
 *
 * Destinations are independent: stable writes desktop/stable + flat desktop/
 * (legacy feed mirror — not a bug); beta is desktop/beta only; android/ is
 * its own rail. Callers must prune one dest at a time and never pass a parent
 * of another channel.
 *
 * Pure functions only — no SSH. Run tests:
 *   node --test deploy/scripts/prune-release-cdn.test.mjs
 */
import {
  androidApkFilename,
  macDmgFilename,
  winInstallerFilename,
} from "../../apps/website/functions/_lib/downloadsCdn.mjs";

/** Feed files updater + website always need. Never delete. */
export const FEED_KEEP_NAMES = Object.freeze([
  "latest.yml",
  "latest-mac.yml",
  "latest.json",
]);

/** @param {string} version */
export function macZipFilename(version) {
  return `AgentCore-${version}-mac-arm64.zip`;
}

/**
 * Full desktop artifact set for one version (win + mac dmg/zip + blockmaps).
 * @param {string} version
 */
export function desktopArtifactNames(version) {
  const win = winInstallerFilename(version);
  const mac = macDmgFilename(version);
  const zip = macZipFilename(version);
  return [
    win,
    `${win}.blockmap`,
    mac,
    `${mac}.blockmap`,
    zip,
    `${zip}.blockmap`,
  ];
}

/** @param {string} version @param {string} [filename] */
export function androidArtifactNames(version, filename) {
  return [filename || androidApkFilename(version)];
}

/**
 * AgentCore-<ver>-win-x64.exe[.blockmap]
 * AgentCore-<ver>-mac-arm64.(dmg|zip)[.blockmap]
 * ver may include pre-release (1.2.3-beta.1).
 */
const DESKTOP_ARTIFACT_RE =
  /^AgentCore-(.+)-(win-x64\.exe|mac-arm64\.(?:dmg|zip))(\.blockmap)?$/;

const ANDROID_ARTIFACT_RE = /^AgentCore-(.+)-android\.apk$/;

/** @param {string} name */
export function isDesktopArtifact(name) {
  return typeof name === "string" && DESKTOP_ARTIFACT_RE.test(name);
}

/** @param {string} name */
export function isAndroidArtifact(name) {
  return typeof name === "string" && ANDROID_ARTIFACT_RE.test(name);
}

/**
 * @param {string} name
 * @returns {string | null} version string, or null if not a known artifact
 */
export function versionFromArtifactName(name) {
  if (typeof name !== "string") return null;
  const desktop = name.match(DESKTOP_ARTIFACT_RE);
  if (desktop) return desktop[1];
  const android = name.match(ANDROID_ARTIFACT_RE);
  if (android) return android[1];
  return null;
}

/** Basename only — no slash, no `..`. Conservative: reject anything else. */
export function isSafeBasename(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length < 512 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !name.includes("\n") &&
    !name.includes("\r")
  );
}

function basenameish(p) {
  const s = String(p).replace(/\\/g, "/").trim();
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * @param {string | object | null | undefined} textOrObj
 * @returns {{ version: string | null, filenames: string[] }}
 */
export function filenamesFromLatestJson(textOrObj) {
  let obj = textOrObj;
  if (typeof textOrObj === "string") {
    const t = textOrObj.trim();
    if (!t) return { version: null, filenames: [] };
    try {
      obj = JSON.parse(t);
    } catch {
      return { version: null, filenames: [] };
    }
  }
  if (!obj || typeof obj !== "object") return { version: null, filenames: [] };
  const version =
    typeof obj.version === "string" && obj.version.trim()
      ? obj.version.trim()
      : null;
  /** @type {string[]} */
  const filenames = [];
  for (const key of ["winFilename", "macFilename", "filename"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) {
      const base = basenameish(v);
      if (base) filenames.push(base);
    }
  }
  return { version, filenames };
}

/**
 * Best-effort parse of electron-builder generic latest.yml / latest-mac.yml.
 * Unknown / unparseable text contributes nothing (caller still keeps current
 * version + feed filenames).
 *
 * @param {string | null | undefined} text
 * @returns {{ version: string | null, filenames: string[] }}
 */
export function filenamesFromUpdaterYml(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { version: null, filenames: [] };
  }
  let version = null;
  const ver = text.match(/^\s*version:\s*['"]?([^\s'"#]+)/m);
  if (ver) version = ver[1];
  /** @type {string[]} */
  const filenames = [];
  for (const m of text.matchAll(/^\s*(?:-\s*)?(?:path|url):\s*(.+)$/gm)) {
    let val = m[1].trim();
    const hash = val.search(/\s+#/);
    if (hash >= 0) val = val.slice(0, hash).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    const base = basenameish(val);
    if (base.startsWith("AgentCore-")) filenames.push(base);
  }
  return { version, filenames };
}

/**
 * Union extra keep versions/filenames from the three feed files in one dest.
 * @param {{ latestJson?: string, latestYml?: string, latestMacYml?: string }} manifests
 */
export function keepHintsFromManifests(manifests = {}) {
  /** @type {string[]} */
  const extraVersions = [];
  /** @type {string[]} */
  const extraFilenames = [];
  const parts = [
    filenamesFromLatestJson(manifests.latestJson),
    filenamesFromUpdaterYml(manifests.latestYml),
    filenamesFromUpdaterYml(manifests.latestMacYml),
  ];
  for (const part of parts) {
    if (part.version) extraVersions.push(part.version);
    extraFilenames.push(...part.filenames);
  }
  return { extraVersions, extraFilenames };
}

/**
 * @typedef {"desktop" | "android"} PruneKind
 *
 * @param {{
 *   listedNames: string[],
 *   kind: PruneKind,
 *   currentVersion: string,
 *   extraVersions?: string[],
 *   extraFilenames?: string[],
 * }} input
 * @returns {{
 *   keep: string[],
 *   delete: string[],
 *   keepVersions: string[],
 *   skipped?: string,
 * }}
 */
export function planPrune(input) {
  const listedNames = Array.isArray(input.listedNames) ? input.listedNames : [];
  const currentVersion = String(input.currentVersion || "").trim();
  if (!currentVersion) {
    return {
      keep: [...listedNames],
      delete: [],
      keepVersions: [],
      skipped: "no currentVersion",
    };
  }

  const keepVersions = new Set([currentVersion]);
  for (const v of input.extraVersions || []) {
    const t = String(v || "").trim();
    if (t) keepVersions.add(t);
  }
  const extraExact = new Set();
  for (const f of input.extraFilenames || []) {
    const name = String(f || "").trim();
    if (isSafeBasename(name)) extraExact.add(name);
    const ver = versionFromArtifactName(name);
    if (ver) keepVersions.add(ver);
  }

  const feedKeep = new Set(FEED_KEEP_NAMES);
  /** @type {string[]} */
  const keep = [];
  /** @type {string[]} */
  const del = [];

  for (const name of listedNames) {
    if (!isSafeBasename(name)) {
      keep.push(name);
      continue;
    }
    if (feedKeep.has(name) || extraExact.has(name)) {
      keep.push(name);
      continue;
    }
    const ver = versionFromArtifactName(name);
    if (ver == null) {
      keep.push(name);
      continue;
    }
    const matchesKind =
      input.kind === "android"
        ? isAndroidArtifact(name)
        : isDesktopArtifact(name);
    if (!matchesKind) {
      keep.push(name);
      continue;
    }
    if (keepVersions.has(ver)) {
      keep.push(name);
      continue;
    }
    del.push(name);
  }

  return {
    keep,
    delete: del,
    keepVersions: [...keepVersions],
  };
}
