import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { is } from "@electron-toolkit/utils";
import { BrowserWindow, app, ipcMain, net, protocol, shell } from "electron";
import { registerFsIpc } from "./fs-service";

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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
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
}

app.whenReady().then(() => {
  registerAppProtocol();
  registerFsIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
