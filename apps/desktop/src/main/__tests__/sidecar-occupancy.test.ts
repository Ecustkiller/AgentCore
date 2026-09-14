/**
 * SidecarManager.occupancy — 只读活表，不 spawn、不 hydrate。
 * @vitest-environment node
 */
import { afterAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return {
    dir: `${base}/sidecar-occupancy-${Math.random().toString(36).slice(2)}`,
  };
});

vi.mock("electron", () => ({
  app: { on: vi.fn(), getAppPath: () => "", getPath: () => h.dir },
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

vi.mock("../fs/roots", () => ({
  listSessionRoots: () => [],
}));

import { rmSync } from "node:fs";
import { SidecarManager } from "../sidecar/manager";

function injectTurn(
  manager: SidecarManager,
  turn: {
    conversationId: string;
    rootId: string;
    subpath: string;
    ephemeral?: boolean;
  },
  turnId = "t1",
): void {
  (
    manager as unknown as {
      turns: Map<string, typeof turn>;
    }
  ).turns.set(turnId, turn);
}

describe("SidecarManager.occupancy", () => {
  afterAll(() => rmSync(h.dir, { recursive: true, force: true }));

  it("无活回合 → occupied false", () => {
    const manager = new SidecarManager(() => {
      throw new Error("occupancy must not spawn");
    });
    expect(manager.occupancy({ conversationId: "c1" })).toEqual({
      occupied: false,
    });
  });

  it("活回合 → occupied + 工作区", () => {
    const manager = new SidecarManager(() => {
      throw new Error("occupancy must not spawn");
    });
    injectTurn(manager, {
      conversationId: "c1",
      rootId: "r1",
      subpath: "conversations/c1",
    });
    expect(manager.occupancy({ conversationId: "c1" })).toEqual({
      occupied: true,
      rootId: "r1",
      subpath: "conversations/c1",
    });
    expect(manager.occupancy({ conversationId: "other" })).toEqual({
      occupied: false,
    });
  });

  it("harvest 临时回合不算占着", () => {
    const manager = new SidecarManager(() => {
      throw new Error("occupancy must not spawn");
    });
    injectTurn(manager, {
      conversationId: "c1",
      rootId: "r1",
      subpath: "",
      ephemeral: true,
    });
    expect(manager.occupancy({ conversationId: "c1" })).toEqual({
      occupied: false,
    });
  });
});
