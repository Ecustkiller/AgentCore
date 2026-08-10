/**
 * Build-time desktop release channel (stable | beta) for About UI + Win AUMID.
 * Baked by electron.vite.config from DESKTOP_RELEASE_CHANNEL; defaults stable.
 */
export type DesktopReleaseChannel = "stable" | "beta";

declare const __DESKTOP_RELEASE_CHANNEL__: string | undefined;

const DOWNLOAD_ORIGIN = "https://fashitianxia.xyz/download" as const;

export function clientReleaseChannel(): DesktopReleaseChannel {
  if (
    typeof __DESKTOP_RELEASE_CHANNEL__ !== "undefined" &&
    __DESKTOP_RELEASE_CHANNEL__ === "beta"
  ) {
    return "beta";
  }
  return "stable";
}

export function clientChannelLabelZh(
  channel: DesktopReleaseChannel = clientReleaseChannel(),
): string {
  return channel === "beta" ? "测试" : "稳定";
}

export function otherReleaseChannel(
  channel: DesktopReleaseChannel = clientReleaseChannel(),
): DesktopReleaseChannel {
  return channel === "beta" ? "stable" : "beta";
}

/** Official site download page for a channel (`?channel=` aligns with website). */
export function desktopDownloadUrlForChannel(
  channel: DesktopReleaseChannel,
): string {
  return `${DOWNLOAD_ORIGIN}?channel=${channel}`;
}

/** Link target for the *other* track from the current build. */
export function otherChannelDownloadUrl(
  channel: DesktopReleaseChannel = clientReleaseChannel(),
): string {
  return desktopDownloadUrlForChannel(otherReleaseChannel(channel));
}

export function otherChannelDownloadLabel(
  channel: DesktopReleaseChannel = clientReleaseChannel(),
): string {
  return channel === "beta" ? "下载稳定版" : "下载测试版";
}
