import { UPDATER_CHANNELS, type UpdaterStatus } from "@shared/updater-contract";
import { net, type BrowserWindow, app, ipcMain, powerMonitor } from "electron";
import { type UpdateInfo, autoUpdater } from "electron-updater";
import { logDesktop } from "./log-service";
import { isMacAutoUpdateInstallCapable } from "./mac-auto-update-capable";

// 检查频率（发布与门禁.md §7.6）：启动 + 每 4h + 系统唤醒。
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** download-progress 落盘节流，避免刷盘。 */
const PROGRESS_LOG_MIN_MS = 1000;
/** UI 速度用近期窗口，避免 electron-updater 全程平均被续传冲高。 */
const SPEED_SAMPLE_MIN_MS = 1500;
/** 单样本速度上限：挡住续传首包把已有字节算进瞬时速率的离谱尖峰。 */
const SPEED_CAP_BPS = 50 * 1024 * 1024;

type CheckTrigger = "startup" | "interval" | "resume" | "manual";

let mainWindow: BrowserWindow | null = null;
let status: UpdaterStatus = { phase: "idle" };
// 下载中的目标版本：download-progress 事件不带版本，从 update-available 暂存补上。
let pendingVersion = "";
let pendingSizeBytes: number | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
// 云 API 基址，由 renderer 经 `configure` 传入（它是 API 地址单一源）；null = 尚未配置。
let apiBaseUrl: string | null = null;
// 检查调度只起一次——在收到 API 基址后启动，确保首检也过远程熔断闸。
let scheduleStarted = false;
// 防重复点「立即更新」并发起多次 downloadUpdate。
let downloadInFlight = false;
/** 最近一次 runCheck 起点（ms），供 phase / error 算 sinceCheckMs。 */
let checkStartedAt = 0;
let lastCheckTrigger: CheckTrigger | null = null;
let lastProgressLogAt = 0;
let downloadStartedAt = 0;
/** 近期速度窗口锚点（ms / transferred）。 */
let speedSampleAt = 0;
let speedSampleTransferred = 0;
/** 最近一次算稳的窗口速率（B/s），推给 UI。 */
let displayBytesPerSecond = 0;

function resetSpeedTracker(): void {
  speedSampleAt = 0;
  speedSampleTransferred = 0;
  displayBytesPerSecond = 0;
}

/**
 * 用 transferred 增量估近期速率；窗口未满时沿用上一稳值。
 * 续传/回退时重置，避免把缓存字节算成「几十 MB/s」。
 */
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

function pushStatus(next: UpdaterStatus): void {
  status = next;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(UPDATER_CHANNELS.status, next);
  }
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

/** Sum package file sizes from UpdateInfo when present. */
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
 * 远程熔断查询（发布与门禁.md §7.6, 部署与运维.md §7.9）：检查前查后端策略
 * `GET /updates/policy`，`enabled:false` 即暂停下载（坏版本急停闸）。**fail-open**——
 * 未配置基址 / 非 200 / 网络错一律视为放行（已发布的安全网络要保活，与特性开关的
 * fail-safe 刻意相反）。完整灰度 / 双通道仍依赖 §7.9 特性开关，未在此消费。
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

async function runCheck(trigger: CheckTrigger): Promise<void> {
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
    // 网络等失败也会经 'error' 事件推状态；这里吞掉 reject 防未处理的 promise 异常。
    logUpdater("warn", "updater.check_end", {
      trigger,
      result: "rejected",
      durationMs: Date.now() - checkStartedAt,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runDownload(): Promise<void> {
  if (downloadInFlight) return;
  if (status.phase !== "available" && status.phase !== "error") return;
  // 未签名 mac：Squirrel.Mac 装不了，任何入口都不许发起下载（避免白下 ~190MB 再必然失败）。
  // 按能力探测而非 status.manualOnly：硬闸在 error 态还有「重试下载」，那条路读不到该标记。
  if (!(await isMacAutoUpdateInstallCapable())) {
    logUpdater("info", "updater.download_skipped", {
      reason: "manual_only",
      version: pendingVersion || undefined,
    });
    return;
  }
  downloadInFlight = true;
  downloadStartedAt = Date.now();
  lastProgressLogAt = 0;
  resetSpeedTracker();
  // 立刻进入 downloading，避免首包 progress 前 UI /「关于」仍停在 available。
  pushStatus({
    phase: "downloading",
    version: pendingVersion,
    percent: 0,
    bytesPerSecond: 0,
    transferred: 0,
    total: pendingSizeBytes ?? 0,
  });
  logUpdater("info", "updater.download_begin", {
    version: pendingVersion || undefined,
    sizeBytes: pendingSizeBytes ?? undefined,
  });
  try {
    await autoUpdater.downloadUpdate();
    logUpdater("info", "updater.download_end", {
      result: "resolved",
      durationMs: Date.now() - downloadStartedAt,
      version: pendingVersion || undefined,
      phase: status.phase,
    });
  } catch (err) {
    // 失败经 'error' 事件推状态。
    logUpdater("warn", "updater.download_end", {
      result: "rejected",
      durationMs: Date.now() - downloadStartedAt,
      version: pendingVersion || undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    downloadInFlight = false;
  }
}

/** 启动检查调度（仅一次）：立即首检 + 每 4h + 系统唤醒（§7.6）。 */
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
 * 初始化自动更新。**始终**注册 IPC 句柄（renderer 不会命中缺通道）；仅打包态接入
 * electron-updater 与检查调度，dev / 未打包态状态恒为 `unsupported`。
 *
 * 只应调用一次（IPC 句柄全局唯一）——在 `app.whenReady` 里随首个窗口创建后调用。
 */
export function initUpdater(window: BrowserWindow): void {
  mainWindow = window;

  ipcMain.handle(UPDATER_CHANNELS.getStatus, () => status);

  if (!app.isPackaged) {
    status = { phase: "unsupported" };
    ipcMain.handle(UPDATER_CHANNELS.configure, () => {});
    ipcMain.handle(UPDATER_CHANNELS.check, () => {});
    ipcMain.handle(UPDATER_CHANNELS.download, () => {});
    ipcMain.handle(UPDATER_CHANNELS.quitAndInstall, () => {});
    return;
  }

  // 预热 mac 签名探测缓存（仅 darwin 打包态真正跑 codesign）。
  void isMacAutoUpdateInstallCapable();

  // 发现即说明、用户同意后再下载；安装仍须显式 quitAndInstall（§7.6）。
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // 临时默认：关闭 blockmap 差分，改拉全量安装包（~190MB）。
  // 动机：downloads 经 Tunnel 时差分小 Range / multipart 易卡到数分钟～十余分钟
  //（本机日志 8.5MB 差分 ≈509s）；全量单连接更稳。分发改国内 OSS/CDN（§7.6b 方案 B）
  // 并验收 Range 后应改回 false。→ 发布与门禁.md §7.6 客户端更新 UX。
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on("checking-for-update", () => {
    pushStatus({ phase: "checking" });
    logUpdater("info", "updater.phase", {
      phase: "checking",
      trigger: lastCheckTrigger,
      sinceCheckMs: sinceCheckMs(),
    });
  });
  autoUpdater.on("update-available", (info) => {
    void (async () => {
      pendingVersion = info.version;
      pendingSizeBytes = packageSizeBytes(info);
      // darwin 未签名 → manualOnly；签名/公证落地后探测自动恢复常规自动更新。
      const capable = await isMacAutoUpdateInstallCapable();
      const manualOnly = !capable;
      pushStatus({
        phase: "available",
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info),
        sizeBytes: pendingSizeBytes,
        ...(manualOnly ? { manualOnly: true } : {}),
      });
      logUpdater("info", "updater.phase", {
        phase: "available",
        version: info.version,
        sizeBytes: pendingSizeBytes ?? undefined,
        manualOnly: manualOnly || undefined,
        trigger: lastCheckTrigger,
        sinceCheckMs: sinceCheckMs(),
      });
    })();
  });
  autoUpdater.on("update-not-available", () => {
    pushStatus({ phase: "not-available" });
    logUpdater("info", "updater.phase", {
      phase: "not-available",
      trigger: lastCheckTrigger,
      sinceCheckMs: sinceCheckMs(),
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    const now = Date.now();
    const percent = Math.round(progress.percent);
    const transferred = Math.max(0, Math.round(progress.transferred || 0));
    const total = Math.max(0, Math.round(progress.total || 0));
    // UI / 日志用近期窗口速率；reportedAvg 仅诊断（续传会虚高）。
    const reportedAvgBps = Math.max(
      0,
      Math.round(progress.bytesPerSecond || 0),
    );
    const bytesPerSecond = recentBytesPerSecond(now, transferred);
    pushStatus({
      phase: "downloading",
      version: pendingVersion,
      percent,
      bytesPerSecond,
      transferred,
      total,
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
        reportedAvgBps,
        transferred,
        total,
        sinceDownloadMs: downloadStartedAt > 0 ? now - downloadStartedAt : null,
      });
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    pushStatus({ phase: "downloaded", version: info.version });
    logUpdater("info", "updater.phase", {
      phase: "downloaded",
      version: info.version,
      sinceDownloadMs:
        downloadStartedAt > 0 ? Date.now() - downloadStartedAt : null,
    });
  });
  autoUpdater.on("error", (err) => {
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

  // renderer 传入 API 基址后才启动调度——确保首次检查也先过远程熔断闸（fail-open）。
  ipcMain.handle(UPDATER_CHANNELS.configure, (_e, baseUrl: unknown) => {
    // IPC-004（第五轮 IPC 权限面审计）：边界结构校验——非 string 基址直接忽略（renderer 是
    // API 地址单一源，畸形仅可能来自被攻破的 renderer）。不抛：configure 契约为 Promise<void>。
    if (typeof baseUrl !== "string") return;
    apiBaseUrl = baseUrl;
    logUpdater("info", "updater.configure", {
      hasBaseUrl: baseUrl.length > 0,
      disableDifferentialDownload: autoUpdater.disableDifferentialDownload,
    });
    startSchedule();
  });
  ipcMain.handle(UPDATER_CHANNELS.check, () => runCheck("manual"));
  ipcMain.handle(UPDATER_CHANNELS.download, () => runDownload());
  ipcMain.handle(UPDATER_CHANNELS.quitAndInstall, () => {
    logUpdater("info", "updater.quit_and_install", {
      version: pendingVersion || undefined,
    });
    // isSilent=false：显示安装进度；isForceRunAfter=true：装毕重启应用。
    autoUpdater.quitAndInstall(false, true);
  });

  app.on("before-quit", () => {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  });
}
