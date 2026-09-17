/**
 * 开发态 sidecar 热更新：env 闸 + debounce bounce。
 * @vitest-environment node
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return {
    dir: `${base}/sidecar-dev-reload-${Math.random().toString(36).slice(2)}`,
    isPackaged: false,
    recoverLocalPersistence: vi.fn(async () => undefined),
  };
});

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return h.isPackaged;
    },
    on: vi.fn(),
    getAppPath: () => "",
    getPath: () => h.dir,
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../log-service", () => ({
  logDesktop: vi.fn(),
}));

vi.mock("../outbox/projection", () => ({
  occupyLocalTurnBegin: vi.fn(async () => true),
  abortLocalTurnPlaceholder: vi.fn(async () => undefined),
}));

vi.mock("../outbox-writeback", () => ({
  recoverLocalPersistence: h.recoverLocalPersistence,
  setOccupiedConversationIdsProvider: vi.fn(),
  sidecarDataDir: () => h.dir,
  handleOccupiedTurnSidecarFailure: vi.fn(),
  listUnsyncedSummaries: vi.fn(() => []),
}));

import { logDesktop } from "../log-service";
import {
  SIDECAR_DEV_RELOAD_DEBOUNCE_MS,
  shouldIgnoreSidecarReloadPath,
  sidecarDevReloadEnabled,
  startSidecarDevReload,
} from "../sidecar/devReload";
import { SidecarManager } from "../sidecar/manager";
import type { Transport } from "../sidecar/transport";

afterEach(() => {
  h.isPackaged = false;
  h.recoverLocalPersistence.mockClear();
  vi.mocked(logDesktop).mockClear();
  vi.useRealTimers();
  rmSync(h.dir, { recursive: true, force: true });
});

function closingTransport() {
  let lineCb: ((line: string) => void) | null = null;
  let closeCb: ((err?: Error) => void) | null = null;
  const transport: Transport = {
    send: (line) => {
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (typeof msg.id === "number") {
        Promise.resolve().then(() => {
          lineCb?.(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { ok: true },
            }),
          );
        });
      }
    },
    onLine: (cb) => {
      lineCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    close: vi.fn(() => {
      closeCb?.(undefined);
    }),
  };
  return { transport };
}

describe("sidecarDevReloadEnabled", () => {
  it("packaged is always off", () => {
    expect(
      sidecarDevReloadEnabled({ AGENTCORE_SIDECAR_RELOAD: "true" }, true),
    ).toBe(false);
  });

  it("unpackaged defaults on", () => {
    expect(sidecarDevReloadEnabled({}, false)).toBe(true);
  });

  it("unpackaged honors explicit off", () => {
    expect(
      sidecarDevReloadEnabled({ AGENTCORE_SIDECAR_RELOAD: "false" }, false),
    ).toBe(false);
    expect(
      sidecarDevReloadEnabled({ AGENTCORE_SIDECAR_RELOAD: "off" }, false),
    ).toBe(false);
  });
});

describe("shouldIgnoreSidecarReloadPath", () => {
  it("skips pycache and bytecode", () => {
    expect(
      shouldIgnoreSidecarReloadPath("runtime/__pycache__/loop.cpython-313.pyc"),
    ).toBe(true);
    expect(shouldIgnoreSidecarReloadPath("foo.pyc")).toBe(true);
    expect(shouldIgnoreSidecarReloadPath("runtime/engine/loop.py")).toBe(false);
  });
});

describe("startSidecarDevReload", () => {
  it("no-ops when disabled", () => {
    const bounce = vi.fn(() => 1);
    const watchFn = vi.fn();
    const stop = startSidecarDevReload(
      { bounceForDevReload: bounce },
      {
        packaged: false,
        env: { AGENTCORE_SIDECAR_RELOAD: "false" },
        watchDir: "/x/agentcore",
        dirExists: () => true,
        watchFn,
      },
    );
    expect(watchFn).not.toHaveBeenCalled();
    stop();
  });

  it("debounces bursts into one bounce", () => {
    vi.useFakeTimers();
    const bounce = vi.fn(() => 1);
    let listener:
      | ((event: string, filename: string | null) => void)
      | undefined;
    const close = vi.fn();
    const stop = startSidecarDevReload(
      { bounceForDevReload: bounce },
      {
        packaged: false,
        env: {},
        watchDir: "/x/agentcore",
        dirExists: () => true,
        watchFn: (_dir, _opts, cb) => {
          listener = cb;
          return { close, on: vi.fn() };
        },
      },
    );
    listener?.("change", "a.py");
    listener?.("change", "b.py");
    expect(bounce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SIDECAR_DEV_RELOAD_DEBOUNCE_MS);
    expect(bounce).toHaveBeenCalledTimes(1);
    stop();
    expect(close).toHaveBeenCalled();
  });

  it("does not bounce on pycache churn", () => {
    vi.useFakeTimers();
    const bounce = vi.fn(() => 1);
    let listener:
      | ((event: string, filename: string | null) => void)
      | undefined;
    const stop = startSidecarDevReload(
      { bounceForDevReload: bounce },
      {
        packaged: false,
        env: {},
        watchDir: "/x/agentcore",
        dirExists: () => true,
        watchFn: (_dir, _opts, cb) => {
          listener = cb;
          return { close: vi.fn(), on: vi.fn() };
        },
      },
    );
    listener?.("change", "runtime/__pycache__/x.pyc");
    vi.advanceTimersByTime(SIDECAR_DEV_RELOAD_DEBOUNCE_MS);
    expect(bounce).not.toHaveBeenCalled();
    stop();
  });
});

describe("SidecarManager.bounceForDevReload", () => {
  it("closes the live process so the next probe respawns", async () => {
    const first = closingTransport();
    const second = closingTransport();
    let n = 0;
    const manager = new SidecarManager(() => {
      n += 1;
      return n === 1 ? first.transport : second.transport;
    });

    await manager.probe("r1", "", "/tmp/ws");
    expect(n).toBe(1);
    expect(manager.bounceForDevReload()).toBe(1);
    expect(first.transport.close).toHaveBeenCalled();

    await manager.probe("r1", "", "/tmp/ws");
    expect(n).toBe(2);
  });

  it("planned bounce still salvages via onClosed", async () => {
    const t = closingTransport();
    const manager = new SidecarManager(() => t.transport);
    await manager.probe("r-reload", "", "/tmp/ws");
    manager.bounceForDevReload();
    // salvage still runs with a scoped conversation list (empty when idle).
    expect(h.recoverLocalPersistence).toHaveBeenCalled();
  });
});
