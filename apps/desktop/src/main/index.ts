import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { is } from "@electron-toolkit/utils";
import { isSafeExternalUrl } from "@shared/safe-url";
import { net, BrowserWindow, app, ipcMain, protocol, shell } from "electron";
// `?asset` 让 electron-vite 把图标拷入产物并解析为运行时绝对路径；用作窗口/任务栏图标
// （dev 与 Linux 主要靠它；打包后 Windows exe / macOS 包图标另由 electron-builder 从
// build/icon.png 派生）。
import icon from "../../resources/icon.png?asset";
import { registerFsIpc } from "./fs-service";
import { registerLogIpc } from "./log-service";
import { registerSidecarIpc } from "./sidecar-service";
import { initUpdater } from "./updater";
import { loadWindowState, manageWindowState } from "./window-state";

// Production renderer is served from a custom app:// scheme instead of file://,
// so it gets a real, stable origin (app://agentcore). That origin is what makes
// credentialed cross-origin calls to the cloud API governable by CORS + cookies
// (前端技术与架构.md §7.2) — a file:// (null/opaque) origin can't be allowlisted.
// Scheme privileges must be registered before the app `ready` event.
const APP_SCHEME = "app";
const APP_ORIGIN_HOST = "agentcore"; // renderer origin = app://agentcore
const APP_ORIGIN = `${APP_SCHEME}://${APP_ORIGIN_HOST}`;
const RENDERER_ROOT = join(__dirname, "../renderer");

// SECURITY (XSS-001 前端XSS·纵深 CSP): the packaged renderer is served over app://, so we
// stamp a Content-Security-Policy on every app:// response — the containment layer for any
// future DOM-XSS.
//
// 设计取舍（最正确设计，非便利妥协）: `script-src 'self'` WITHOUT `'unsafe-eval'` /
// `'unsafe-inline'`. mermaid 的图表源是【攻击者可影响】的（模型 / 间接注入可吐 ```mermaid
// 块），而 `'unsafe-eval'` 会把 eval/new Function 在【整个文档】放开——正好是恶意 mermaid 块
// 把「解析图表」变成「主源代码执行」所需的原语，所以绝不全局放开 eval。
// 实测（apps/mobile 打包产物，同一 mermaid 包）证明严格策略可行：mermaid v11 把每种图表当成普通
// 动态 import() 的 ES chunk 从 'self' 加载（script-src 'self' 已覆盖），全程无 new Worker /
// createObjectURL / 真 eval；唯一的 Function 构造器用法是 lodash 取全局的 `Function("return this")()`，
// 在浏览器里被前面的 `self` 短路、根本不执行。`script-src 'self'` 可行的另一前提是 built index.html
// 无 inline `<script>`（electron.vite.config.ts 关掉 Vite 的 modulepreload polyfill）。
// `style-src` 必须留 'unsafe-inline'——React / Tailwind / KaTeX 用 style【属性】，CSP 的 nonce/hash
// 管不到 style 属性，且样式注入风险远低于脚本。
// NOTE: 此 header 仅作用于 app://（prod）；`pnpm dev` 经 loadURL 走 Vite server，HMR 不受影响。
// 兜底阶梯（若未来 mermaid 改为主线程 eval 而报错）: 升级为 mermaid securityLevel:'sandbox'
// （沙箱 iframe 隔离其动态代码），而【绝不】全局加 'unsafe-eval'。
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // worker-src = 前瞻防御：当前 mermaid 不开 worker（走 dynamic import chunk），但若未来版本把
  // 解析挪进 Web Worker，self + blob 让动态能力留在 worker 边界内，仍不必污染主文档 script-src。
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  // connect-src stays broad: the cloud API base URL is user-configured at runtime (https,
  // and http(s)://localhost for self-host) and SSE/websocket may ride it — script-src is
  // what contains XSS here, not connect-src.
  "connect-src 'self' https: http: ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true, // proper origin semantics (app://host/path)
      secure: true, // secure context → allows Secure cookies, etc.
      supportFetchAPI: true, // renderer can use fetch (API client + SSE)
      corsEnabled: true, // cross-origin requests go through CORS
    },
  },
]);

// Serve the built renderer bundle over app://agentcore/<path>. HashRouter keeps
// every route on index.html (only the hash changes), so no SPA path fallback is
// needed. Reads are confined to RENDERER_ROOT (path-traversal guard).
function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const relativePath =
      pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const filePath = join(RENDERER_ROOT, relativePath);
    if (!filePath.startsWith(RENDERER_ROOT + sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    const res = await net.fetch(pathToFileURL(filePath).toString());
    // Stamp the CSP on every app:// response (it only takes effect on the HTML document;
    // harmless on assets) so the renderer always loads under the policy.
    const headers = new Headers(res.headers);
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  });
}

function createWindow(): BrowserWindow {
  // 恢复上次的窗口尺寸/位置/最大化（x/y 缺省时由 OS 居中）。
  const windowState = loadWindowState();
  const mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    title: is.dev ? "AgentCore [DEV]" : "AgentCore",
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    icon,
    ...(process.platform === "darwin" && {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 12, y: 12 },
    }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      // SECURITY (XSS-003 前端XSS·渲染进程沙箱): run the renderer in the OS sandbox. The
      // preload is sandbox-compatible — it only uses contextBridge + ipcRenderer (no Node
      // built-ins / npm Node deps), so the contextBridge API surface is unchanged. With
      // contextIsolation (default-on) + nodeIntegration (default-off), this shrinks the
      // blast radius of any renderer compromise to a sandboxed process.
      sandbox: true,
    },
  });
  if (windowState.isMaximized) mainWindow.maximize();
  manageWindowState(mainWindow);

  // Dev-only: forward the renderer's console warnings/errors to this process's
  // stdout so a renderer crash (e.g. a React error-boundary stack logged via
  // console.error) shows up in the `pnpm dev` terminal, not only in DevTools.
  // Electron 35+ passes details on the event object; level is a string.
  if (is.dev) {
    mainWindow.webContents.on(
      "console-message",
      ({ level, message, lineNumber, sourceId }) => {
        if (level !== "warning" && level !== "error") return;
        const tag = level === "error" ? "renderer:error" : "renderer:warn";
        console.log(`[${tag}] ${message} (${sourceId}:${lineNumber})`);
      },
    );
  }

  ipcMain.on("window:minimize", () => mainWindow.minimize());
  ipcMain.on("window:maximize", () => {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on("window:close", () => mainWindow.close());

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  // SECURITY (XSS-002 前端XSS·外链交付): only hand http/https/mailto URLs to the OS shell.
  // `shell.openExternal` launches ANY registered URI scheme (file://, ms-msdt:, custom
  // protocols — Follina-class on Windows); a target=_blank anchor carrying an attacker-
  // influenceable URL (a web-source / tool-result card URL) would otherwise let a single
  // click launch a dangerous local handler. Unsafe schemes are denied + logged.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url);
    } else {
      console.warn(
        `[security] blocked openExternal for unsafe URL scheme: ${details.url}`,
      );
    }
    return { action: "deny" };
  });

  // SECURITY (XSS-004 前端XSS·导航逃逸): the SPA is HashRouter, so legitimate route changes
  // only mutate the URL hash and never fire will-navigate with a new document URL. Any
  // will-navigate to a URL outside the trusted renderer origin (prod: app://agentcore; dev:
  // the Vite server) is an attempted navigation away from the app — block it. Outbound
  // links go through setWindowOpenHandler above, not here.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowedBase =
      is.dev && process.env.ELECTRON_RENDERER_URL
        ? process.env.ELECTRON_RENDERER_URL
        : APP_ORIGIN;
    if (!url.startsWith(allowedBase)) {
      event.preventDefault();
      console.warn(`[security] blocked in-page navigation to: ${url}`);
    }
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }

  return mainWindow;
}

app.whenReady().then(() => {
  registerAppProtocol();
  registerLogIpc();
  registerFsIpc();
  registerSidecarIpc();
  const mainWindow = createWindow();
  // 自动更新随首个窗口创建后初始化一次（IPC 句柄全局唯一，不在 createWindow 内调用，
  // 以免 macOS 上 activate 重建窗口时重复注册）。
  initUpdater(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
