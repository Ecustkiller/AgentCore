import { notifyInfo } from "@/lib/toast";
import { BASE_URL } from "@/services/api";
import type { UpdaterStatus } from "@shared/updater-contract";
import { create } from "zustand";

/**
 * 自动更新状态的前端落点（前端技术与架构.md §7.6）。主进程权威持有状态机、静默下载新版本；
 * 此 store 只镜像状态供「关于」设置页呈现 + 提供「检查 / 安装」动作。订阅在应用外壳启动
 * （`startUpdates`），故新版本就绪的提示与状态在用户身处任何页面时都能更新。
 */
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
    try {
      await window.updaterApi.check();
    } catch {
      // 检查失败经主进程 'error' 状态推送呈现；此处吞掉调用层异常。
    }
  },
  install: async () => {
    await window.updaterApi.quitAndInstall();
  },
}));

// 已弹过「就绪」提示的版本——防同一版本在多次轮询 / 系统唤醒后重复 toast。
let notifiedVersion = "";

/**
 * 在应用外壳挂载时启动：同步初始状态 + 订阅推送写入 store。当新版本下载完毕，弹一条带
 * 「重启安装」动作的 sticky 提示（§7.6「用户决定安装时机」——提示可忽略，安装由用户点）。
 * 返回取消订阅函数。
 */
export function startUpdates(): () => void {
  // Hand the cloud API base URL to the main process (it can't read import.meta.env)
  // so the updater can poll the remote circuit breaker; this also triggers its first
  // check (前端技术与架构.md §7.6).
  void window.updaterApi.configure(BASE_URL);

  void window.updaterApi
    .getStatus()
    .then((status) => useUpdatesStore.setState({ status }));

  return window.updaterApi.onStatus((status) => {
    useUpdatesStore.setState({ status });
    if (status.phase === "downloaded" && status.version !== notifiedVersion) {
      notifiedVersion = status.version;
      notifyInfo(`新版本 ${status.version} 已就绪`, {
        description: "将在重启后安装",
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "重启安装",
          onClick: () => void window.updaterApi.quitAndInstall(),
        },
      });
    }
  });
}
