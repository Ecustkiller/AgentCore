/**
 * 桌面端下载配置（构建时由 scripts/fetch-release.mjs 从 GitHub Releases 刷新）。
 */
import {
  DESKTOP_VERSION,
  RELEASE_NOTES_URL,
  WIN_INSTALLER_FILENAME,
  WIN_INSTALLER_URL,
} from "./download.generated";

export {
  DESKTOP_VERSION,
  RELEASE_NOTES_URL,
  WIN_INSTALLER_FILENAME,
  WIN_INSTALLER_URL,
};

export const RELEASES_REPO =
  "https://github.com/Lawofall/AgentCore-releases" as const;

export const RELEASES_LATEST = `${RELEASES_REPO}/releases/latest` as const;

export type PlatformId = "win" | "mac" | "linux";

export type PlatformDownload = {
  id: PlatformId;
  label: string;
  subtitle: string;
  available: boolean;
  url?: string;
  fileLabel?: string;
};

export const PLATFORMS: PlatformDownload[] = [
  {
    id: "win",
    label: "Windows",
    subtitle: "Windows 10/11 · 64 位",
    available: true,
    url: WIN_INSTALLER_URL,
    fileLabel: WIN_INSTALLER_FILENAME,
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

export const DOWNLOAD_PAGE_PATH = "/download" as const;
