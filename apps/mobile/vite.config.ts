/// <reference path="../../scripts/client-build-info.d.ts" />
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteClientBuildDefine } from "../../scripts/client-build-info.mjs";
import { viteCspPlugin } from "../../scripts/vite-csp.mjs";

const clientBuildDefine = viteClientBuildDefine(new URL("./package.json", import.meta.url));

// Mobile-web dev server runs on 5175 — that origin is allow-listed in the backend
// CORS config (config.py cors_allow_origins, 前端技术与架构 §七). SPA history fallback
// is built into the Vite dev server; the Capacitor shell serves the built SPA directly.
export default defineConfig({
  define: clientBuildDefine,
  plugins: [react(), viteCspPlugin()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 5175 },
  // XSS-001: disable Vite's inline modulepreload polyfill so the prod build has NO inline
  // <script>, letting the injected `script-src 'self'` CSP hold without 'unsafe-inline'.
  build: { modulePreload: { polyfill: false } },
});
