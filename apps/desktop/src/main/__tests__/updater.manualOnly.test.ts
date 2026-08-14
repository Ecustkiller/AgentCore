/**
 * updater：安装包走 GitHub 本地下载，不调用 electron-updater.downloadUpdate；
 * 未签名 mac 也不再拒绝下载。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    isPackaged: true,
    capable: true as boolean,
    downloadUpdate: vi.fn(async () => undefined),
    downloadHttpToFile: vi.fn(
      async (opts: {
        url: string;
        destPath: string;
        onProgress?: (p: { transferred: number; total: number }) => void;
      }) => {
        opts.onProgress?.({ transferred: 2_000_000, total: 2_000_000 });
        return { transferred: 2_000_000, total: 2_000_000 };
      },
    ),
    fetchLatestDesktopJson: vi.fn(async () => ({
      version: "1.2.3",
      winUrl:
        "https://github.com/Lawofall/AgentCore-releases/releases/download/v1.2.3/AgentCore-1.2.3-win-x64.exe",
      winFilename: "AgentCore-1.2.3-win-x64.exe",
      macUrl:
        "https://github.com/Lawofall/AgentCore-releases/releases/download/v1.2.3/AgentCore-1.2.3-mac-arm64.dmg",
      macFilename: "AgentCore-1.2.3-mac-arm64.dmg",
    })),
    openPath: vi.fn(async (_path: string) => ""),
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
    getPath: (name: string) =>
      name === "downloads"
        ? "/tmp/downloads"
        : "/Applications/AgentCore.app/Contents/MacOS/AgentCore",
  },
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  powerMonitor: { on: vi.fn() },
  shell: { openPath: (path: string) => h.openPath(path) },
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

vi.mock("../installer-download", () => ({
  downloadHttpToFile: (opts: {
    url: string;
    destPath: string;
    onProgress?: (p: { transferred: number; total: number }) => void;
  }) => h.downloadHttpToFile(opts),
  fetchLatestDesktopJson: () => h.fetchLatestDesktopJson(),
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
    check: () => invoke(UPDATER_CHANNELS.check) as Promise<void>,
    download: () => invoke(UPDATER_CHANNELS.download) as Promise<void>,
    openInstaller: () =>
      invoke(UPDATER_CHANNELS.openInstaller) as Promise<void>,
    emitAvailable: (version = "1.2.3") => {
      h.emit("update-available", {
        version,
        files: [{ url: "x.exe", size: 190_000_000 }],
        releaseNotes: "notes",
      });
    },
    emitChecking: () => h.emit("checking-for-update"),
    emitNotAvailable: () => h.emit("update-not-available"),
    emitError: (message = "update check failed") =>
      h.emit("error", new Error(message)),
  };
}

describe("updater installer download (GitHub → Downloads)", () => {
  beforeEach(() => {
    h.isPackaged = true;
    h.capable = true;
    h.downloadUpdate.mockClear();
    h.downloadHttpToFile.mockReset();
    h.downloadHttpToFile.mockImplementation(
      async (opts: {
        url: string;
        destPath: string;
        onProgress?: (p: { transferred: number; total: number }) => void;
      }) => {
        opts.onProgress?.({ transferred: 2_000_000, total: 2_000_000 });
        return { transferred: 2_000_000, total: 2_000_000 };
      },
    );
    h.openPath.mockClear();
    h.fetchLatestDesktopJson.mockClear();
    h.clearListeners();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("unsigned mac still downloads the installer and does not call downloadUpdate", async () => {
    h.capable = false;
    const u = await loadUpdater();
    u.emitAvailable("1.2.3");
    await vi.waitFor(() => {
      expect(u.sent.at(-1)?.phase).toBe("available");
    });
    expect(u.lastStatus()).toMatchObject({
      phase: "available",
      version: "1.2.3",
      autoInstallCapable: false,
    });

    await u.download();
    expect(h.downloadUpdate).not.toHaveBeenCalled();
    expect(h.downloadHttpToFile).toHaveBeenCalledTimes(1);
    expect(u.getStatus()).toMatchObject({
      phase: "downloaded",
      version: "1.2.3",
      autoInstallCapable: false,
    });
  });

  it("signed download writes GitHub installer then openInstaller uses shell.openPath", async () => {
    h.capable = true;
    const u = await loadUpdater();
    u.emitAvailable("1.2.3");
    await vi.waitFor(() => {
      expect(u.sent.at(-1)?.phase).toBe("available");
    });
    await u.download();
    expect(h.downloadUpdate).not.toHaveBeenCalled();
    expect(h.downloadHttpToFile).toHaveBeenCalledTimes(1);
    const call = h.downloadHttpToFile.mock.calls[0]?.[0];
    expect(call?.destPath).toMatch(/AgentCore-1\.2\.3-/);
    expect(call?.destPath?.replaceAll("\\", "/")).toContain("/tmp/downloads");
    expect(call?.url).toContain("github.com");
    expect(u.getStatus().phase).toBe("downloaded");

    await u.openInstaller();
    expect(h.openPath).toHaveBeenCalledWith(call?.destPath);
  });

  it("openInstaller without a file pushes error", async () => {
    const u = await loadUpdater();
    await u.openInstaller();
    expect(h.openPath).not.toHaveBeenCalled();
    expect(u.getStatus()).toMatchObject({
      phase: "error",
      message: expect.stringMatching(/请先下载安装包/),
    });
  });

  it("check events during download do not interrupt; openInstaller still works", async () => {
    const { autoUpdater } = await import("electron-updater");
    vi.mocked(autoUpdater.checkForUpdates).mockClear();

    let releaseDownload: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    h.downloadHttpToFile.mockImplementation(
      async (opts: {
        url: string;
        destPath: string;
        onProgress?: (p: { transferred: number; total: number }) => void;
      }) => {
        await held;
        opts.onProgress?.({ transferred: 2_000_000, total: 2_000_000 });
        return { transferred: 2_000_000, total: 2_000_000 };
      },
    );

    const u = await loadUpdater();
    u.emitAvailable("1.2.3");
    await vi.waitFor(() => {
      expect(u.sent.at(-1)?.phase).toBe("available");
    });

    const downloading = u.download();
    await vi.waitFor(() => {
      expect(u.getStatus().phase).toBe("downloading");
    });

    await u.check();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    u.emitChecking();
    u.emitAvailable("1.2.3");
    u.emitNotAvailable();
    u.emitError();
    expect(u.getStatus().phase).toBe("downloading");

    releaseDownload();
    await downloading;
    expect(u.getStatus().phase).toBe("downloaded");

    await u.openInstaller();
    expect(h.openPath).toHaveBeenCalledTimes(1);
    expect(h.openPath.mock.calls[0]?.[0]).toMatch(/AgentCore-1\.2\.3-/);
  });

  it("same version update-available after download keeps installer; different version clears", async () => {
    const u = await loadUpdater();
    u.emitAvailable("1.2.3");
    await vi.waitFor(() => {
      expect(u.sent.at(-1)?.phase).toBe("available");
    });
    await u.download();
    const destPath = h.downloadHttpToFile.mock.calls[0]?.[0]?.destPath;
    expect(u.getStatus().phase).toBe("downloaded");

    u.emitChecking();
    u.emitAvailable("1.2.3");
    u.emitNotAvailable();
    u.emitError();
    expect(u.getStatus().phase).toBe("downloaded");

    await u.openInstaller();
    expect(h.openPath).toHaveBeenCalledWith(destPath);

    u.emitAvailable("2.0.0");
    await vi.waitFor(() => {
      expect(u.getStatus()).toMatchObject({
        phase: "available",
        version: "2.0.0",
      });
    });

    h.openPath.mockClear();
    await u.openInstaller();
    expect(h.openPath).not.toHaveBeenCalled();
    expect(u.getStatus()).toMatchObject({
      phase: "error",
      message: expect.stringMatching(/请先下载安装包/),
    });
  });
});
