/**
 * Latest desktop + Android download artifacts for the website.
 * User-facing installer URLs = GitHub Releases；版本发现可读品牌域 latest.json。
 *
 * Discovery order:
 *   1. CDN desktop/{stable|beta}/latest.json + android/latest.json（version / filenames）
 *   2. FALLBACK_VERSION → 构造 GitHub asset URLs（SSG / offline；仅稳定轨）
 *   3. 测试轨无 CDN 且无 FALLBACK_BETA_VERSION → 空（官网隐藏入口）
 *
 * → apps/website/functions/_lib/downloadsCdn.mjs · 发布与门禁.md §7.6b / §7.6c
 */
import {
  androidArtifactUrls,
  androidLatestJsonUrl,
  artifactUrlsForVersion,
  cdnUrl,
  desktopLatestJsonUrl,
  DOWNLOADS_DESKTOP_PREFIX,
  normalizeDesktopChannel,
} from "./downloadsCdn.mjs";

/** @typedef {{
 *   version: string,
 *   releaseNotesUrl: string,
 *   winUrl: string,
 *   winFilename: string,
 *   macUrl: string,
 *   macFilename: string,
 * }} DesktopArtifacts */

/** @typedef {DesktopArtifacts & {
 *   androidUrl: string,
 *   androidFilename: string,
 *   androidVersion: string,
 *   beta: DesktopArtifacts | null,
 * }} ReleaseArtifacts */

const EMPTY_ANDROID = {
  androidUrl: "",
  androidFilename: "",
  androidVersion: "",
};

export { artifactUrlsForVersion };

/**
 * @returns {Promise<{ androidUrl: string, androidFilename: string, androidVersion: string }>}
 */
async function fetchLatestAndroidArtifacts() {
  try {
    const res = await fetch(androidLatestJsonUrl(), {
      headers: { "User-Agent": "agentcore-website" },
    });
    if (!res.ok) return { ...EMPTY_ANDROID };
    const data = await res.json();
    const version = String(data.version ?? "").trim();
    const filename = String(data.filename ?? "").trim();
    if (!version || !filename) return { ...EMPTY_ANDROID };
    // Always reconstruct GitHub URL — ignore stale brand-host downloadUrl in manifest.
    return androidArtifactUrls(version, filename);
  } catch {
    return { ...EMPTY_ANDROID };
  }
}

/**
 * Fetch one desktop channel from CDN (no Android merge).
 * @param {string} [fallbackVersion] empty → no offline fallback (beta)
 * @param {"stable"|"beta"} [channel]
 * @returns {Promise<DesktopArtifacts | null>}
 */
export async function fetchDesktopChannelArtifacts(
  fallbackVersion = "",
  channel = "stable",
) {
  const ch = normalizeDesktopChannel(channel);
  const fb = String(fallbackVersion ?? "").trim();
  /** @type {DesktopArtifacts | null} */
  const fallback = fb ? { ...artifactUrlsForVersion(fb) } : null;

  const manifestUrls = [desktopLatestJsonUrl(ch)];
  // 迁移窗：stable 目录尚未镜像时，仍可读扁平 desktop/latest.json（旧 feed）。
  if (ch === "stable") {
    manifestUrls.push(cdnUrl(`${DOWNLOADS_DESKTOP_PREFIX}/latest.json`));
  }

  for (const url of manifestUrls) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "agentcore-website" },
      });
      if (!res.ok) {
        throw new Error(`${url} HTTP ${res.status}`);
      }
      const data = await res.json();
      const version = String(data.version ?? "").trim();
      if (!version) throw new Error(`${url} missing version`);

      if (fb && compareSemver(fb, version) > 0) {
        return fallback;
      }

      const winFilename = String(data.winFilename ?? "").trim();
      const macFilename = String(data.macFilename ?? "").trim();
      if (!winFilename) {
        throw new Error(`${url} missing winFilename`);
      }

      // Always reconstruct GitHub URL from manifest filenames（对齐 Android；勿忽略 CDN 里的真实文件名）.
      const base = artifactUrlsForVersion(version, { winFilename, macFilename });
      return {
        version,
        releaseNotesUrl:
          String(data.releaseNotesUrl ?? "").trim() || base.releaseNotesUrl,
        winUrl: base.winUrl,
        winFilename: base.winFilename,
        macUrl: base.macUrl,
        macFilename: base.macFilename,
      };
    } catch {
      // try next URL
    }
  }

  return fallback;
}

/**
 * Latest published desktop artifacts from CDN manifest, merged with Android + beta.
 *
 * When CDN stable manifest is older than ``fallbackVersion`` (bump already in source
 * but CDN not synced yet), keep the fallback so a premature website deploy
 * cannot bake a regressive version into SSG.
 *
 * @param {string} fallbackVersion stable FALLBACK
 * @param {string} [fallbackBetaVersion] beta FALLBACK；空则无 CDN 时隐藏测试入口
 * @returns {Promise<ReleaseArtifacts>}
 */
export async function fetchLatestReleaseArtifacts(
  fallbackVersion,
  fallbackBetaVersion = "",
) {
  const fallback = {
    ...artifactUrlsForVersion(fallbackVersion),
    ...EMPTY_ANDROID,
    beta: null,
  };
  const android = await fetchLatestAndroidArtifacts();
  const beta = await fetchDesktopChannelArtifacts(
    fallbackBetaVersion,
    "beta",
  );

  const stable = await fetchDesktopChannelArtifacts(
    fallbackVersion,
    "stable",
  );
  if (!stable) {
    return { ...fallback, ...android, beta };
  }

  return {
    ...stable,
    ...android,
    beta,
  };
}

/** @param {string} a @param {string} b @returns {number} */
function compareSemver(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
