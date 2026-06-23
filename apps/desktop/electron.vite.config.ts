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
