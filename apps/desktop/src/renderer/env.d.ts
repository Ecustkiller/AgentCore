/// <reference types="vite/client" />

import type { FsApi } from "@shared/ipc-contract";
import type { SidecarApi } from "@shared/sidecar-contract";
import type { UpdaterApi } from "@shared/updater-contract";

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
  }

  interface Window {
    fsApi: FsApi;
    sidecarApi: SidecarApi;
    /** Electron preload 注入；纯浏览器 / 单测环境可能缺失。 */
    updaterApi?: UpdaterApi;
    windowApi: WindowApi;
    /** 仅由纯浏览器预览入口（main.web.tsx → browserStubs）设置，标记「离线、无后端」运行，
     *  使 AuthGate 跳过认证 bootstrap。Electron 构建里始终缺失。 */
    __WEB_PREVIEW__?: boolean;
  }
}
