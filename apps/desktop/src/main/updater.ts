import { join } from "node:path";
import {
  UPDATER_CHANNELS,
  type UpdaterPhase,
  type UpdaterStatus,
} from "@shared/updater-contract";
import { net, shell, type BrowserWindow, app, ipcMain, powerMonitor } from "electron";
import { type UpdateInfo, autoUpdater } from "electron-updater";
import {
  downloadHttpToFile,
  fetchLatestDesktopJson,
} from "./installer-download";
import {
  desktopLatestJsonUrl,
  releaseChannelFromDefine,
  resolveInstallerArtifact,
} from "./installer-feed";
import { logDesktop } from "./log-service";
import { isMacAutoUpdateInstallCapable } from "./mac-auto-update-capable";

declare const __DESKTOP_RELEASE_CHANNEL__: string | undefined;

// 检查频率（发布与门禁.md §7.6）：启动 + 每 4h + 系统唤醒。
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** download-progress 落盘节流，避免刷盘。 */
const PROGRESS_LOG_MIN_MS = 1000;
/** UI 速度用近期窗口，避免全程平均被续传冲高。 */
const SPEED_SAMPLE_MIN_MS = 1500;
/** 单样本速度上限：挡住续传首包把已有字节算进瞬时速率的离谱尖峰。 */
const SPEED_CAP_BPS = 50 * 1024 * 1024;

type CheckTrigger = "startup" | "interval" | "resume" | "manual";

let mainWindow: BrowserWindow | null = null;
/** 与 phase 正交的本机 Squirrel 安装能力；每次 push 都附带。不再拦截安装包下载。 */
let autoInstallCapable = true;
let status: UpdaterStatus = { phase: "idle", autoInstallCapable: true };
let pendingVersion = "";
let pendingSizeBytes: number | null = null;
/** 已下载安装包的本机路径；不下发 renderer。 */
let pendingInstallerPath: string | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let apiBaseUrl: string | null = null;
let scheduleStarted = false;
let downloadInFlight = false;
let checkStartedAt = 0;
let lastCheckTrigger: CheckTrigger | null = null;
let lastProgressLogAt = 0;
let downloadStartedAt = 0;
let speedSampleAt = 0;
let speedSampleTransferred = 0;
let displayBytesPerSecond = 0;

function resetSpeedTracker(): void {
  speedSampleAt = 0;
  speedSampleTransferred = 0;
  displayBytesPerSecond = 0;
}

function recentBytesPerSecond(now: number, transferred: number): number {
  if (speedSampleAt === 0) {
    speedSampleAt = now;
    speedSampleTransferred = transferred;
    return displayBytesPerSecond;
  }
  const dt = now - speedSampleAt;
  const dBytes = transferred - speedSampleTransferred;
  if (dBytes < 0) {
    speedSampleAt = now;
    speedSampleTransferred = transferred;
    displayBytesPerSecond = 0;
    return 0;
  }
  if (dt >= SPEED_SAMPLE_MIN_MS) {
    const rate = (dBytes / dt) * 1000;
    displayBytesPerSecond = Math.min(
      SPEED_CAP_BPS,
      Math.max(0, Math.round(rate)),
    );
    speedSampleAt = now;
    speedSampleTransferred = transferred;
  }
  return displayBytesPerSecond;
}

function pushStatus(next: UpdaterPhase): void {
  const full: UpdaterStatus = { ...next, autoInstallCapable };
  status = full;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(UPDATER_CHANNELS.status, full);
  }
}

function currentPhase(): UpdaterPhase {
  const { autoInstallCapable: _capable, ...phase } = status;
  return phase;
}

function sinceCheckMs(): number | null {
  return checkStartedAt > 0 ? Date.now() - checkStartedAt : null;
}

function logUpdater(
  level: "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>,
): void {
  logDesktop({ level, event, fields });
}

function desktopChannel(): "stable" | "beta" {
  return releaseChannelFromDefine(
    typeof __DESKTOP_RELEASE_CHANNEL__ !== "undefined"
      ? __DESKTOP_RELEASE_CHANNEL__
      : undefined,
  );
}

/** Normalize electron-updater releaseNotes (string | note list) to plain text. */
function normalizeReleaseNotes(info: UpdateInfo): string | null {
  const raw = info.releaseNotes;
  if (raw == null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const note = (item as { note?: string | null }).note;
      if (typeof note === "string" && note.trim()) parts.push(note.trim());
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return null;
}

function packageSizeBytes(info: UpdateInfo): number | null {
  const files = info.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  let total = 0;
  let any = false;
  for (const f of files) {
    const size = (f as { size?: number }).size;
    if (typeof size === "number" && Number.isFinite(size) && size > 0) {
      total += size;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * 远程熔断查询（发布与门禁.md §7.6）：检查前查后端策略
 * `GET /updates/policy`，`enabled:false` 即暂停检查（坏版本急停闸）。**fail-open**。
 */
async function updatesEnabled(): Promise<boolean> {
  if (!apiBaseUrl) {
    logUpdater("info", "updater.policy", {
      result: "skip_no_base",
      enabled: true,
      failOpen: true,
      durationMs: 0,
    });
    return true;
  }
  const t0 = Date.now();
  try {
    const res = await net.fetch(`${apiBaseUrl}/updates/policy`);
    const durationMs = Date.now() - t0;
    if (!res.ok) {
      logUpdater("warn", "updater.policy", {
        result: "http_fail_open",
        status: res.status,
        enabled: true,
        failOpen: true,
        durationMs,
      });
      return true;
    }
    const policy = (await res.json()) as { enabled?: boolean };
    const enabled = policy.enabled !== false;
    logUpdater("info", "updater.policy", {
      result: "ok",
      status: res.status,
      enabled,
      failOpen: false,
      durationMs,
    });
    return enabled;
  } catch (err) {
    logUpdater("warn", "updater.policy", {
      result: "network_fail_open",
      enabled: true,
      failOpen: true,
      durationMs: Date.now() - t0,
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

function isDownloadInFlight(): boolean {
  return downloadInFlight || status.phase === "downloading";
}

/** 已落到本机的安装包：检查事件不得冲掉路径。 */
function hasPendingInstaller(): boolean {
  return pendingInstallerPath != null && pendingInstallerPath.length > 0;
}

async function runCheck(trigger: CheckTrigger): Promise<void> {
  if (isDownloadInFlight()) {
    logUpdater("info", "updater.check_end", {
      trigger,
      result: "skipped_downloading",
      phase: status.phase,
    });
    return;
  }
  lastCheckTrigger = trigger;
  checkStartedAt = Date.now();
  logUpdater("info", "updater.check_begin", { trigger });
  if (!(await updatesEnabled())) {
    logUpdater("info", "updater.check_end", {
      trigger,
      result: "skipped_disabled",
      durationMs: Date.now() - checkStartedAt,
    });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
    logUpdater("info", "updater.check_end", {
      trigger,
      result: "resolved",
      durationMs: Date.now() - checkStartedAt,
      phase: status.phase,
    });
  } catch (err) {
    logUpdater("warn", "updater.check_end", {
      trigger,
      result: "rejected",
      durationMs: Date.now() - checkStartedAt,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function pushDownloadProgress(transferred: number, total: number): void {
  const now = Date.now();
  const safeTotal = Math.max(0, Math.round(total || pendingSizeBytes || 0));
  const safeTransferred = Math.max(0, Math.round(transferred));
  const percent =
    safeTotal > 0
      ? Math.min(100, Math.round((safeTransferred / safeTotal) * 100))
      : 0;
  const bytesPerSecond = recentBytesPerSecond(now, safeTransferred);
  pushStatus({
    phase: "downloading",
    version: pendingVersion,
    percent,
    bytesPerSecond,
    transferred: safeTransferred,
    total: safeTotal,
  });
  if (
    lastProgressLogAt === 0 ||
    now - lastProgressLogAt >= PROGRESS_LOG_MIN_MS ||
    percent >= 100
  ) {
    lastProgressLogAt = now;
    logUpdater("info", "updater.download_progress", {
      version: pendingVersion || undefined,
      percent,
      bytesPerSecond,
      transferred: safeTransferred,
      total: safeTotal,
      sinceDownloadMs: downloadStartedAt > 0 ? now - downloadStartedAt : null,
    });
  }
}

async function resolvePendingInstaller(): Promise<{
  url: string;
  filename: string;
}> {
  const version = pendingVersion.trim();
  if (!version) {
    throw new Error("当前无法开始下载，请重新检查更新");
  }
  const latest = await fetchLatestDesktopJson(
    desktopLatestJsonUrl(desktopChannel()),
  );
  const artifact = resolveInstallerArtifact(version, process.platform, latest);
  if (!artifact) {
    throw new Error("当前平台请前往下载页获取安装包");
  }
  return artifact;
}

async function runDownload(): Promise<void> {
  if (downloadInFlight) return;
  if (status.phase !== "available" && status.phase !== "error") {
    logUpdater("info", "updater.download_skipped", {
      reason: "wrong_phase",
      phase: status.phase,
      version: pendingVersion || undefined,
    });
    if (status.phase !== "downloading" && status.phase !== "downloaded") {
      pushStatus({
        phase: "error",
        message: "当前无法开始下载，请重新检查更新",
      });
    }
    return;
  }
  downloadInFlight = true;
  downloadStartedAt = Date.now();
  lastProgressLogAt = 0;
  pendingInstallerPath = null;
  resetSpeedTracker();
  pushStatus({
    phase: "downloading",
    version: pendingVersion,
    percent: 0,
    bytesPerSecond: 0,
    transferred: 0,
    total: pendingSizeBytes ?? 0,
  });
  try {
    const artifact = await resolvePendingInstaller();
    const destPath = join(app.getPath("downloads"), artifact.filename);
    logUpdater("info", "updater.download_begin", {
      version: pendingVersion || undefined,
      sizeBytes: pendingSizeBytes ?? undefined,
      filename: artifact.filename,
      source: "github",
    });
    await downloadHttpToFile({
      url: artifact.url,
      destPath,
      onProgress: ({ transferred, total }) => {
        pushDownloadProgress(transferred, total);
      },
    });
    pendingInstallerPath = destPath;
    pushStatus({ phase: "downloaded", version: pendingVersion });
    logUpdater("info", "updater.download_end", {
      result: "resolved",
      durationMs: Date.now() - downloadStartedAt,
      version: pendingVersion || undefined,
      filename: artifact.filename,
      phase: "downloaded",
    });
  } catch (err) {
    pendingInstallerPath = null;
    const message = err instanceof Error ? err.message : String(err);
    pushStatus({ phase: "error", message });
    logUpdater("warn", "updater.download_end", {
      result: "rejected",
      durationMs: Date.now() - downloadStartedAt,
      version: pendingVersion || undefined,
      message,
    });
  } finally {
    downloadInFlight = false;
  }
}

async function runOpenInstaller(): Promise<void> {
  if (!pendingInstallerPath) {
    logUpdater("warn", "updater.open_installer", { result: "no_file" });
    pushStatus({
      phase: "error",
      message: "请先下载安装包",
    });
    return;
  }
  logUpdater("info", "updater.open_installer", {
    version: pendingVersion || undefined,
  });
  const err = await shell.openPath(pendingInstallerPath);
  if (err) {
    logUpdater("error", "updater.open_installer", { result: "failed", err });
    pushStatus({
      phase: "error",
      message: `无法打开安装包：${err}`,
    });
  }
}

function startSchedule(): void {
  if (scheduleStarted) return;
  scheduleStarted = true;
  logUpdater("info", "updater.schedule_start", { firstCheck: true });
  void runCheck("startup");
  intervalTimer = setInterval(
    () => void runCheck("interval"),
    CHECK_INTERVAL_MS,
  );
  powerMonitor.on("resume", () => void runCheck("resume"));
}

/**
 * 初始化自动更新。**始终**注册 IPC 句柄；仅打包态接入检查调度与安装包下载。
 */
export function initUpdater(window: BrowserWindow): void {
  mainWindow = window;

  ipcMain.handle(UPDATER_CHANNELS.getStatus, () => status);

  if (!app.isPackaged) {
    autoInstallCapable = false;
    status = { phase: "unsupported", autoInstallCapable: false };
    ipcMain.handle(UPDATER_CHANNELS.configure, () => {});
    ipcMain.handle(UPDATER_CHANNELS.check, () => {});
    ipcMain.handle(UPDATER_CHANNELS.download, () => {});
    ipcMain.handle(UPDATER_CHANNELS.openInstaller, () => {});
    return;
  }

  void isMacAutoUpdateInstallCapable().then((capable) => {
    if (autoInstallCapable === capable) return;
    autoInstallCapable = capable;
    pushStatus(currentPhase());
  });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on("checking-for-update", () => {
    if (isDownloadInFlight() || hasPendingInstaller()) return;
    pushStatus({ phase: "checking" });
    logUpdater("info", "updater.phase", {
      phase: "checking",
      trigger: lastCheckTrigger,
      sinceCheckMs: sinceCheckMs(),
    });
  });
  autoUpdater.on("update-available", (info) => {
    if (isDownloadInFlight()) return;
    if (hasPendingInstaller() && info.version === pendingVersion) return;
    void (async () => {
      autoInstallCapable = await isMacAutoUpdateInstallCapable();
      if (isDownloadInFlight()) return;
      if (hasPendingInstaller() && info.version === pendingVersion) return;
      pendingVersion = info.version;
      pendingSizeBytes = packageSizeBytes(info);
      pendingInstallerPath = null;
      pushStatus({
        phase: "available",
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info),
        sizeBytes: pendingSizeBytes,
      });
      logUpdater("info", "updater.phase", {
        phase: "available",
        version: info.version,
        sizeBytes: pendingSizeBytes ?? undefined,
        autoInstallCapable,
        trigger: lastCheckTrigger,
        sinceCheckMs: sinceCheckMs(),
      });
    })();
  });
  autoUpdater.on("update-not-available", () => {
    if (isDownloadInFlight() || hasPendingInstaller()) return;
    pushStatus({ phase: "not-available" });
    logUpdater("info", "updater.phase", {
      phase: "not-available",
      trigger: lastCheckTrigger,
      sinceCheckMs: sinceCheckMs(),
    });
  });
  autoUpdater.on("error", (err) => {
    if (isDownloadInFlight() || hasPendingInstaller()) return;
    const message = err?.message ?? "更新检查失败";
    const phaseBefore = status.phase;
    pushStatus({ phase: "error", message });
    logUpdater("error", "updater.error", {
      message,
      phaseBefore,
      trigger: lastCheckTrigger,
      sinceCheckMs: sinceCheckMs(),
      sinceDownloadMs:
        downloadStartedAt > 0 ? Date.now() - downloadStartedAt : null,
    });
  });

  ipcMain.handle(UPDATER_CHANNELS.configure, (_e, baseUrl: unknown) => {
    if (typeof baseUrl !== "string") return;
    apiBaseUrl = baseUrl;
    logUpdater("info", "updater.configure", {
      hasBaseUrl: baseUrl.length > 0,
      installerSource: "github",
      channel: desktopChannel(),
    });
    startSchedule();
  });
  ipcMain.handle(UPDATER_CHANNELS.check, () => runCheck("manual"));
  ipcMain.handle(UPDATER_CHANNELS.download, () => runDownload());
  ipcMain.handle(UPDATER_CHANNELS.openInstaller, () => runOpenInstaller());

  app.on("before-quit", () => {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  });
}
