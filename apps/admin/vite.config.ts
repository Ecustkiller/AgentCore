import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Standalone web console (独立 origin). Dev runs on 5174 so it never clashes with
// the desktop renderer (5173); the backend must allowlist this origin for
// credentialed CORS (see config.cors_allow_origins + README).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
