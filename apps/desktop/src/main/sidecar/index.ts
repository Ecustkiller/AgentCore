/**
 * main/sidecar 桶出口。
 *
 * 拆轴：transport/spawn → rpc client → recovery（paused 帧读）→ manager → ipc 薄壳。
 */

export type { Transport, SpawnConfig } from "./transport";
export {
  resolveSpawnConfig,
  formatSidecarExitError,
  scrubSocksProxyEnv,
  spawnTransport,
} from "./transport";

export { SidecarClient, SidecarRpcError } from "./client";

export { readLocalPausedRecovery } from "./recovery";

export { entryKey, resolveWorkspaceRoot } from "./workspace";

export { SidecarManager } from "./manager";

export { registerSidecarIpc } from "./ipc";
