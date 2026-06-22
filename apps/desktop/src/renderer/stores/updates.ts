import { notifyInfo } from "@/lib/toast";
import { BASE_URL } from "@/services/api";
import type { UpdaterApi, UpdaterStatus } from "@shared/updater-contract";
import { create } from "zustand";

/**
 * 自动更新状态的前端落点（前端技术与架构.md §7.6）。主进程权威持有状态机、静默下载新版本；
 * 此 store 只镜像状态供「关于」设置页呈现 + 提供「检查 / 安装」动作。订阅在应用外壳启动
 * （`startUpdates`），故新版本就绪的提示与状态在用户身处任何页面时都能更新。
 */

function getUpdaterApi(): UpdaterApi | undefined {
  return typeof window !== "undefined" ? window.updaterApi : undefined;
}

interface UpdatesState {
  status: UpdaterStatus;
  /** 主动检查更新（发现即静默下载）；dev / 未打包态为 no-op。 */
  check: () => Promise<void>;
  /** 安装已下载的更新：退出 → 安装 → 重启。 */
  install: () => Promise<void>;
}

export const useUpdatesStore = create<UpdatesState>(() => ({
  status: { phase: "idle" },
  check: async () => {
    const api = getUpdaterApi();
    if (!api) return;
    try {
      await api.check();
    } catch {
      // 检查失败经主进程 'error' 状态推送呈现；此处吞掉调用层异常。
    }
  },
  install: async () => {
    const api = getUpdaterApi();
    if (!api) return;
    await api.quitAndInstall();
  },
}));

// 已弹过「就绪」提示的版本——防同一版本在多次轮询 / 系统唤醒后重复 toast。
let notifiedVersion = "";

/**
 * 在应用外壳挂载时启动：同步初始状态 + 订阅推送写入 store。当新版本下载完毕，弹一条带
 * 「重启安装」动作的 sticky 提示（§7.6「用户决定安装时机」——提示可忽略，安装由用户点）。
 * 返回取消订阅函数。
 *
 * 非 Electron / preload 未注入 `window.updaterApi`（如纯浏览器打开 Vite 端口）时 no-op，
 * 状态置 `unsupported`，与契约「dev 态不生效」一致。
 */
export function startUpdates(): () => void {
  const api = getUpdaterApi();
  if (!api) {
    useUpdatesStore.setState({ status: { phase: "unsupported" } });
    return () => {};
  }

  // Hand the cloud API base URL to the main process (it can't read import.meta.env)
  // so the updater can poll the remote circuit breaker; this also triggers its first
  // check (前端技术与架构.md §7.6).
  void api.configure(BASE_URL);

  void api.getStatus().then((status) => useUpdatesStore.setState({ status }));

  return api.onStatus((status) => {
    useUpdatesStore.setState({ status });
    if (status.phase === "downloaded" && status.version !== notifiedVersion) {
      notifiedVersion = status.version;
      notifyInfo(`新版本 ${status.version} 已就绪`, {
        description: "将在重启后安装",
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "重启安装",
          onClick: () => {
            const installApi = getUpdaterApi();
            if (installApi) void installApi.quitAndInstall();
          },
        },
      });
    }
  });
}
