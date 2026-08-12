/**
 * updater：darwin 未签名 → autoInstallCapable:false 且 download 拒绝并推 error；
 * 已签名 → 常规自动下载路径不变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    isPackaged: true,
    capable: true as boolean,
    downloadUpdate: vi.fn(async () => undefined),
    probeCalls: 0,
    listeners,
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    clearListeners() {
      listeners.clear();
    },
  };
});

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    on: vi.fn(),
    getPath: () => "/Applications/AgentCore.app/Contents/MacOS/AgentCore",
  },
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  powerMonitor: { on: vi.fn() },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: () => h.downloadUpdate(),
    quitAndInstall: vi.fn(),
    on: (event: string, cb: (...args: unknown[]) => void) => h.on(event, cb),
  },
}));

vi.mock("../mac-auto-update-capable", () => ({
  isMacAutoUpdateInstallCapable: async () => {
    h.probeCalls += 1;
    return h.capable;
  },
}));

vi.mock("../log-service", () => ({ logDesktop: vi.fn() }));

type Status = {
  phase: string;
  version?: string;
  autoInstallCapable?: boolean;
  message?: string;
};

async function loadUpdater() {
  const { initUpdater } = await import("../updater");
  const { ipcMain } = await import("electron");
  const { UPDATER_CHANNELS } = await import("@shared/updater-contract");
  vi.mocked(ipcMain.handle).mockClear();
  h.clearListeners();
  h.probeCalls = 0;

  const sent: Status[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (_ch: string, status: Status) => {
        sent.push(status);
      },
    },
  };

  initUpdater(window as never);

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  for (const [ch, fn] of vi.mocked(ipcMain.handle).mock.calls) {
    handlers.set(ch as string, fn as (...args: unknown[]) => unknown);
  }
  const invoke = (channel: string): unknown => {
    const handler = handlers.get(channel);
    if (!handler)
      throw new Error(`updater IPC channel not registered: ${channel}`);
    return handler();
  };
  const lastStatus = (): Status => {
    const status = sent.at(-1);
    if (!status) throw new Error("no updater status pushed to the renderer");
    return status;
  };

  return {
    sent,
    lastStatus,
    channels: UPDATER_CHANNELS,
    getStatus: () => invoke(UPDATER_CHANNELS.getStatus) as Status,
    download: () => invoke(UPDATER_CHANNELS.download) as Promise<void>,
    emitAvailable: (version = "1.2.3") => {
      h.emit("update-available", {
        version,
        files: [{ url: "x.zip", size: 190_000_000 }],
        releaseNotes: "notes",
      });
    },
    emitError: (message = "boom") => {
      h.emit("error", new Error(message));
    },
  };
}

describe("updater autoInstallCapable (unsigned mac)", () => {
  beforeEach(() => {
    h.isPackaged = true;
    h.capable = true;
    h.downloadUpdate.mockClear();
    h.clearListeners();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("unsigned → available 带 autoInstallCapable:false 且 download 拒绝并推 error", async () => {
    h.capable = false;
    const u = await loadUpdater();
    u.emitAvailable("9.9.9");
    // update-available handler is async (awaits codesign probe).
    await vi.waitFor(() => {
      expect(u.sent.at(-1)?.phase).toBe("available");
    });
    expect(u.lastStatus()).toMatchObject({
      phase: "available",
      version: "9.9.9",
      autoInstallCapable: false,
    });
    expect(u.getStatus()).toMatchObject({
      phase: "available",
      autoInstallCapable: false,
    });

    const probesBeforeDownload = h.probeCalls;
    await u.download();
    expect(h.downloadUpdate).not.toHaveBeenCalled();
    // 拒绝执行必须产生状态跃迁（不得静默 return）。
    expect(u.getStatus()).toMatchObject({
      phase: "error",
      autoInstallCapable: false,
    });
    expect(u.getStatus().message).toMatch(/手动安装/);
    expect(u.sent.every((s) => s.phase !== "downloading")).toBe(true);
    // runDownload 不得二次跑 codesign 探测。
    expect(h.probeCalls).toBe(probesBeforeDownload);
  });

  it("unsigned → error 态重试下载同样拒绝并再推 error", async () => {
    h.capable = false;
    const u = await loadUpdater();
    // Warm capability cache the same way packaged init does.
    await vi.waitFor(() => {
      expect(u.getStatus().autoInstallCapable).toBe(false);
    });
    u.emitError("network down");
    expect(u.getStatus().phase).toBe("error");
    expect(u.getStatus().autoInstallCapable).toBe(false);

    const probesBefore = h.probeCalls;
    await u.download();
    expect(h.downloadUpdate).not.toHaveBeenCalled();
    expect(u.getStatus()).toMatchObject({
      phase: "error",
      autoInstallCapable: false,
    });
    expect(u.getStatus().message).toMatch(/手动安装/);
    expect(h.probeCalls).toBe(probesBefore);
  });

  it("signed → available 带 autoInstallCapable:true 且 download 走 autoUpdater", async () => {
    h.capable = true;
    const u = await loadUpdater();
    u.emitAvailable("2.0.0");
    await vi.waitFor(() => {
      expect(u.sent.at(-1)?.phase).toBe("available");
    });
    const available = u.lastStatus();
    expect(available.phase).toBe("available");
    expect(available.version).toBe("2.0.0");
    expect(available.autoInstallCapable).toBe(true);

    await u.download();
    expect(h.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(u.getStatus().phase).toBe("downloading");
    expect(u.getStatus().autoInstallCapable).toBe(true);
  });
});
