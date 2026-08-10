/**
 * Desktop release channel → install identity + updater feed (定案 §7.6c).
 *
 * Channel is build-time only (`DESKTOP_RELEASE_CHANNEL` / `--channel=`).
 * Defaults to `stable`. Updater still reads builder-written app-update.yml
 * (no setFeedURL).
 */

/** @typedef {"stable" | "beta"} DesktopReleaseChannel */

export const DESKTOP_DOWNLOAD_ORIGIN = "https://fashitianxia.xyz/download";

export const RELEASE_CHANNEL_ENV = "DESKTOP_RELEASE_CHANNEL";

/**
 * @param {string | undefined | null} raw
 * @returns {DesktopReleaseChannel}
 */
export function parseReleaseChannel(raw) {
  const v = String(raw ?? "stable")
    .trim()
    .toLowerCase();
  if (v === "" || v === "stable") return "stable";
  if (v === "beta") return "beta";
  throw new Error(
    `Invalid ${RELEASE_CHANNEL_ENV}="${raw}" (expected stable|beta)`,
  );
}

/**
 * Prefer `--channel=beta` / `--channel beta`, else env, else stable.
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DesktopReleaseChannel}
 */
export function resolveChannelFromArgv(
  argv = process.argv.slice(2),
  env = process.env,
) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--channel=")) {
      return parseReleaseChannel(a.slice("--channel=".length));
    }
    if (a === "--channel") {
      return parseReleaseChannel(argv[i + 1]);
    }
  }
  return parseReleaseChannel(env[RELEASE_CHANNEL_ENV]);
}

/**
 * @param {DesktopReleaseChannel} channel
 * @returns {DesktopReleaseChannel}
 */
export function otherReleaseChannel(channel) {
  return channel === "beta" ? "stable" : "beta";
}

/**
 * Official download page with `?channel=` (aligns with website block).
 * @param {DesktopReleaseChannel} channel
 */
export function desktopDownloadUrlForChannel(channel) {
  const ch = parseReleaseChannel(channel);
  return `${DESKTOP_DOWNLOAD_ORIGIN}?channel=${ch}`;
}

/**
 * @param {DesktopReleaseChannel} [channel]
 */
export function resolveReleaseIdentity(channel) {
  const ch = parseReleaseChannel(channel ?? "stable");
  if (ch === "beta") {
    return {
      channel: /** @type {const} */ ("beta"),
      appId: "xyz.fashitianxia.agentcore.beta",
      productName: "AgentCore 测试版",
      shortcutName: "AgentCore 测试版",
      publishUrl: "https://downloads.fashitianxia.xyz/desktop/beta",
      // Same ASCII slug as stable so CDN/sync/官网文件名约定（AgentCore-${ver}-…）不断缝；
      // 通道靠 appId / productName / feed 目录 / GitHub tag 预发布后缀区分。
      artifactSlug: "AgentCore",
      channelLabelZh: "测试",
      /** Distinct from stable so Win taskbar does not merge the two installs. */
      windowsAppUserModelId: "xyz.fashitianxia.agentcore.beta",
      winIcon: "resources/channel-icons/icon-win-beta.png",
      macIcon: "resources/channel-icons/icon-mac-beta.png",
      linuxIcon: "resources/channel-icons/icon-win-beta.png",
      runtimeIcon: "resources/icon-beta.png",
    };
  }
  return {
    channel: /** @type {const} */ ("stable"),
    appId: "xyz.fashitianxia.agentcore",
    productName: "AgentCore",
    shortcutName: "AgentCore",
    publishUrl: "https://downloads.fashitianxia.xyz/desktop/stable",
    artifactSlug: "AgentCore",
    channelLabelZh: "稳定",
    /** Preserve pre-channel Win toast / taskbar id (do not retarget stable installs). */
    windowsAppUserModelId: "com.agentcore.desktop",
    winIcon: "build/icon-win.png",
    macIcon: "build/icon-mac.png",
    linuxIcon: "build/icon-win.png",
    runtimeIcon: "resources/icon.png",
  };
}
