import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { is } from "@electron-toolkit/utils";
import { net, BrowserWindow, app, ipcMain, protocol, shell } from "electron";
// `?asset` 让 electron-vite 把图标拷入产物并解析为运行时绝对路径；用作窗口/任务栏图标
// （dev 与 Linux 主要靠它；打包后 Windows exe / macOS 包图标另由 electron-builder 从
// build/icon.png 派生）。
import icon from "../../resources/icon.png?asset";
import { registerFsIpc } from "./fs-service";
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
const RENDERER_ROOT = join(__dirname, "../renderer");

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
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const relativePath =
      pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const filePath = join(RENDERER_ROOT, relativePath);
    if (!filePath.startsWith(RENDERER_ROOT + sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
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
      sandbox: false,
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadURL(`${APP_SCHEME}://${APP_ORIGIN_HOST}/index.html`);
  }

  return mainWindow;
}

app.whenReady().then(() => {
  registerAppProtocol();
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
