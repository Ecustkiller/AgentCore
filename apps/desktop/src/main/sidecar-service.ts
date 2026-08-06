/**
 * sidecar 主进程入口（薄 re-export）。
 *
 * 实现已按职责拆到 `./sidecar/`：transport → client → recovery → manager → ipc。
 * 本文件保持历史 import 路径稳定（`index.ts` / 单测仍可从这里取公开符号）。
 */

export type { Transport } from "./sidecar";
export {
  resolveSpawnConfig,
  formatSidecarExitError,
  scrubSocksProxyEnv,
  SidecarClient,
  SidecarRpcError,
  SidecarManager,
  registerSidecarIpc,
} from "./sidecar";
