import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor shell config (手机端落地设计 P2 · 上架 + 安全存储). The web SPA is built to
// `dist` (vite default) and Capacitor serves it from the native scheme root. `appId` is
// the reverse-domain bundle id shared by iOS/Android; keep it stable — changing it after
// release orphans every device's Keychain/Keystore data (incl. the bearer tokens).
const config: CapacitorConfig = {
  appId: "com.agentcore.mobile",
  appName: "AgentCore",
  webDir: "dist",
  plugins: {
    // Show the「需要你」pause push even when the app is in the foreground (iOS otherwise
    // suppresses foreground alerts). Android shows foreground notifications regardless.
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
