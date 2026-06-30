import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { searchForWorkspaceRoot } from "vite";
import { viteClientBuildDefine } from "../../scripts/client-build-info.mjs";

const clientBuildDefine = viteClientBuildDefine(new URL("./package.json", import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
});
