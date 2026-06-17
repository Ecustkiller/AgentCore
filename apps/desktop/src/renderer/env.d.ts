/// <reference types="vite/client" />

import type { FsApi } from "@shared/ipc-contract";
import type { SidecarApi } from "@shared/sidecar-contract";

interface WindowApi {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL?: string;
    /** Dev-only auto-login credentials; see apps/desktop/.env.example. */
    readonly VITE_DEV_USERNAME?: string;
    readonly VITE_DEV_PASSWORD?: string;
    /** Dev opt-in: "1" routes local-folder conversations to the local sidecar
     * engine instead of the cloud (双模式工作区 / 远期规划 §一.1, Slice 1). */
    readonly VITE_SIDECAR?: string;
  }

  interface Window {
    fsApi: FsApi;
    sidecarApi: SidecarApi;
    windowApi: WindowApi;
  }
}
