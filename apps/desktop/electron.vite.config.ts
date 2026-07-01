import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin, loadEnv } from "electron-vite";
import react from "@vitejs/plugin-react";
import { searchForWorkspaceRoot } from "vite";
import { viteClientBuildDefine } from "../../scripts/client-build-info.mjs";

const clientBuildDefine = viteClientBuildDefine(new URL("./package.json", import.meta.url));

export default defineConfig(({ mode }) => {
  // 把渲染层构建期烘焙的后端地址（VITE_API_URL，见 .env.production）也喂给主进程，让主进程的 CSP
  // img-src 能精确收窄到「自己 + 后端源」——既堵任意第三方远程图（渲染期信标 V2/V3：mermaid/markmap
  // 吐 <img src=evil> 在渲染期零点击取图），又放行后端头像 / favicon。用 electron-vite 的 loadEnv 读
  // .env*，与渲染层口径一致；默认回落 localhost:8000（同 renderer services/api.ts 的 BASE_URL 缺省）。
  const env = loadEnv(mode, process.cwd());
  const apiBaseUrl = env.VITE_API_URL || "http://localhost:8000";

  return {
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __API_BASE_URL__: JSON.stringify(apiBaseUrl),
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  renderer: {
    define: clientBuildDefine,
    // SECURITY (XSS-001 前端XSS·CSP): drop Vite's inline modulepreload polyfill. Electron's
    // bundled Chromium supports <link rel=modulepreload> natively, so the polyfill is dead
    // weight — and removing it means the built index.html has NO inline <script>, which is
    // what lets the app:// CSP use a strict `script-src 'self'` (see src/main/index.ts)
    // without a blank-screen regression.
    build: {
      modulePreload: { polyfill: false },
    },
    resolve: {
      alias: {
        "@": resolve("src/renderer"),
        "@shared": resolve("src/shared"),
      },
    },
    // Allow serving the monorepo root so the 前端预览 route (#/preview) can glob the
    // committed conformance vectors from packages/protocol-conformance/fixtures.
    server: {
      fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
    },
    plugins: [react()],
  },
  };
});
