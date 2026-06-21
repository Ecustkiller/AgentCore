/**
 * 桌面端下载单一源（部署与运维.md §7.6 / electron-builder publish）。
 * 发新版时 bump DESKTOP_VERSION → 重部署官网；应用内更新走 latest.yml，不依赖此页。
 */
export const DESKTOP_VERSION = "0.2.0";

export const RELEASES_REPO =
  "https://github.com/Lawofall/AgentCore-releases" as const;

/** GitHub Latest 正式 release（人工转正后 electron-updater 与「所有版本」入口共用）。 */
export const RELEASES_LATEST = `${RELEASES_REPO}/releases/latest` as const;

export const RELEASE_NOTES_URL =
  `${RELEASES_REPO}/releases/tag/v${DESKTOP_VERSION}` as const;

export type PlatformId = "win" | "mac" | "linux";

export type PlatformDownload = {
  id: PlatformId;
  label: string;
  subtitle: string;
  available: boolean;
  /** 直链安装包；未上线平台为 undefined。 */
  url?: string;
  fileLabel?: string;
};

const winInstallerUrl = `${RELEASES_REPO}/releases/download/v${DESKTOP_VERSION}/AgentCore-${DESKTOP_VERSION}-win-x64.exe`;

export const PLATFORMS: PlatformDownload[] = [
  {
    id: "win",
    label: "Windows",
    subtitle: "Windows 10/11 · 64 位",
    available: true,
    url: winInstallerUrl,
    fileLabel: `AgentCore-${DESKTOP_VERSION}-win-x64.exe`,
  },
  {
    id: "mac",
    label: "macOS",
    subtitle: "Apple Silicon / Intel",
    available: false,
  },
  {
    id: "linux",
    label: "Linux",
    subtitle: "AppImage",
    available: false,
  },
];

export const SYSTEM_REQUIREMENTS: Record<PlatformId, string[]> = {
  win: [
    "Windows 10 或 11（64 位）",
    "8 GB 内存（推荐 16 GB）",
    "约 500 MB 可用磁盘空间",
    "可访问 agentcore 云端 API（需联网）",
  ],
  mac: ["即将推出"],
  linux: ["即将推出"],
};

export const INSTALL_STEPS = [
  "下载并运行安装程序，按向导完成安装。",
  "首次启动使用邀请码注册并登录。",
  "在设置 → 关于 可检查更新；已安装用户会自动收到新版本。",
];

/** 首页 / 导航用的下载页入口（行业惯例：营销页 → 专用下载页 → 安装包）。 */
export const DOWNLOAD_PAGE_PATH = "/download" as const;
