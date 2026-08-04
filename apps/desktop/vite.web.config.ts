import { resolve } from "path";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

// Plain-browser build/serve of the renderer, used by the screenshot harness
// (scripts/shoot.mjs) and `pnpm dev:web`. The renderer is a normal Vite React app;
// its only Electron coupling is four injected globals, stubbed by the web entry
// (src/renderer/main.web.tsx → preview/browserStubs). The entry HTML is
// index.web.html, so open / navigate to `/index.web.html`.
export default defineConfig({
  root: resolve("src/renderer"),
  publicDir: resolve("public"),
  resolve: {
    alias: {
      "@": resolve("src/renderer"),
      "@shared": resolve("src/shared"),
    },
  },
  server: {
    port: 5199,
    // Serve the monorepo root so #/preview can glob the committed conformance
    // vectors from packages/protocol-conformance/fixtures.
    fs: { allow: [searchForWorkspaceRoot(process.cwd())] },
  },
  // Align with electron.vite.config: dynamic import("mermaid") otherwise races
  // Vite's deps optimizer →「图表引擎加载失败」(see Diagram getMermaid).
  optimizeDeps: {
    include: ["mermaid"],
  },
  plugins: [react()],
});
