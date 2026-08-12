/**
 * 自动更新 IPC 契约 —— 主进程 / preload / renderer 三端共享的单一真相源。
 *
 * 行为锚定 `docs/05-平台与运维/发布与门禁.md` §7.6：electron-updater **发现即说明、
 * 用户同意后再下载**（软更新：同意后关窗后台静默下；硬闸全屏跟进度），且**不自动安装**
 * ——由用户点「重启安装」决定安装时机（`quitAndInstall`）。检查调度（启动 + 每 4h +
 * 系统唤醒）与 fail-open 远程熔断在主进程 `main/updater.ts`；稍后提醒 / 跳过此版本的
 * 持久化在 renderer。**临时**：主进程 `disableDifferentialDownload=true`（全量包）；
 * 分发改善后改回差分（见 §7.6 表「客户端更新 UX」）。
 *
 * 仅打包态（`app.isPackaged`）真正接入 electron-updater；dev / 未打包态状态恒为
 * `unsupported`（autoUpdater 在无 `*-update.yml` 元数据时不可用），但 IPC 句柄仍注册为
 * 安全 no-op，故 renderer 调用永不命中「缺通道」错误。
 *
 * 与 `ipc-contract.ts`（本地文件系统）/ `sidecar-contract.ts`（本地引擎）分文件：三者是
 * 各自独立的主进程能力，刻意不混在一个契约里。
 */

/** 更新状态机——主进程权威持有，经 `status` 推送给 renderer，并由 `getStatus` 同步初值。 */
export type UpdaterStatus =
  /** 空闲：尚未检查 / 检查后无更新前的初态。 */
  | { phase: "idle" }
  /** dev / 未打包：自动更新不生效（仅安装版可用）。 */
  | { phase: "unsupported" }
  /** 正在向发布源检查更新。 */
  | { phase: "checking" }
  /** 已是最新（本次检查无可用更新）。 */
  | { phase: "not-available" }
  /**
   * 发现新版本，等待用户确认后再下载。
   * `releaseNotes` 来自 feed（`latest.yml` / GitHub）；缺省时 renderer 显示兜底文案。
   * `sizeBytes` 为安装包合计（有则展示）。
   * `manualOnly`：本机 bundle 无 Developer ID 签名（当前 mac 内测包即如此）。Squirrel.Mac
   * 硬校验签名后才肯装，未签名时下完整包也必然失败，故 renderer 必须改为引导用户去下载页
   * 手动安装、不得调 `download`。签名 + 公证落地后主进程探测到即自动恢复常规自动更新。
   */
  | {
      phase: "available";
      version: string;
      releaseNotes?: string | null;
      sizeBytes?: number | null;
      manualOnly?: boolean;
    }
  /**
   * 下载中。`percent` 为 0–100 整数；`transferred` / `total` 来自 electron-updater
   * 真实字节进度（非假进度）。`bytesPerSecond` 为主进程近期窗口速率（非全程平均），
   * 避免续传/缓存冲高后百分比几乎不动、速度却看起来很快。
   */
  | {
      phase: "downloading";
      version: string;
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  /** 已下载完毕，待用户点「重启安装」。 */
  | { phase: "downloaded"; version: string }
  /** 检查 / 下载出错（fail-open：出错不阻断使用，仅记录并可重试）。 */
  | { phase: "error"; message: string };

/** IPC 通道名 —— 主进程与 preload 共用，避免硬编码漂移（对齐 fs/sidecar 契约写法）。 */
export const UPDATER_CHANNELS = {
  configure: "updater:configure",
  check: "updater:check",
  download: "updater:download",
  quitAndInstall: "updater:quitAndInstall",
  getStatus: "updater:getStatus",
  status: "updater:status",
} as const;

/** 暴露在 `window.updaterApi` 上的 renderer 端 API 面。 */
export interface UpdaterApi {
  /**
   * 告知主进程云 API 基址（renderer 是 API 地址的单一源——`services/api.ts` 的 `BASE_URL`
   * 已按环境解析好；主进程拿不到 `import.meta.env`，故经此 IPC 传入）。updater 用它查
   * 远程熔断策略 `GET /updates/policy`，并在收到地址后触发首次检查（确保首检也过熔断闸）。
   */
  configure(apiBaseUrl: string): Promise<void>;
  /** 主动触发一次检查（发现新版本 → `available`，不自动下载）；过程经 `onStatus` 推来。dev 态为 no-op。 */
  check(): Promise<void>;
  /** 开始下载当前 `available` 版本。仅打包态、且已发现更新时有意义；`manualOnly` 时为 no-op。 */
  download(): Promise<void>;
  /** 安装已下载的更新：退出并安装、装毕重启。仅 `downloaded` 态有意义。 */
  quitAndInstall(): Promise<void>;
  /** 取当前状态（首次渲染同步初值，避免空等首个推送）。 */
  getStatus(): Promise<UpdaterStatus>;
  /** 订阅状态推送；返回取消订阅函数。 */
  onStatus(cb: (status: UpdaterStatus) => void): () => void;
}
