import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Mobile-web dev server runs on 5175 — that origin is allow-listed in the backend
// CORS config (config.py cors_allow_origins, 前端技术与架构 §七). SPA history fallback
// is built into the Vite dev server; the Capacitor shell serves the built SPA directly.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { port: 5175 },
});
