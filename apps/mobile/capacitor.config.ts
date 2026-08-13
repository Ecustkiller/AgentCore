import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor shell config (前端技术与架构 §七 · 上架 + 安全存储). The web SPA is built to
// `dist` (vite default) and Capacitor serves it from the native scheme root. `appId` is
// the reverse-domain bundle id shared by iOS/Android; keep it stable — changing it after
// release orphans every device's Keychain/Keystore data (incl. the bearer tokens).
const config: CapacitorConfig = {
  appId: "com.agentcore.mobile",
  appName: "AgentCore",
  webDir: "dist",
  // WebView + DecorView fill under transparent system bars (Cap 8 edge-to-edge).
  // Keep in sync with android `shellBackground` / mobile-light `--panel`.
  backgroundColor: "#ffffff",
  plugins: {
    // Dark icons on the light shell (Cap LIGHT = light appearance / dark glyphs; not the legacy StatusBar plugin).
    SystemBars: {
      style: "LIGHT",
    },
    // iOS-only knob: without it iOS suppresses the「需要你」pause alert while the app is
    // foregrounded. Android ignores presentationOptions entirely — a foreground message just
    // fires the JS `pushNotificationReceived` event and posts no tray notification. That gap is
    // covered on purpose by the in-app AiAttentionBanner (firehose `ai_attention`), so don't
    // "fix" it by posting a local notification from JS.
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
