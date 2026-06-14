/// <reference types="vite/client" />

import type { FsApi } from "@shared/ipc-contract";

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
    windowApi: WindowApi;
  }
}
