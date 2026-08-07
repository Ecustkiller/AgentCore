/**
 * D1 主进程墙钟 timeout + D3 main_begin/end/timeout 观测。
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => ".",
    getVersion: () => "0.0.0-test",
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

vi.mock("../log-service", () => ({
  logDesktop: vi.fn(),
}));

import { runWorkspaceOpMain } from "../fs/workspace/dispatch";
import { logDesktop } from "../log-service";

describe("runWorkspaceOpMain (主进程墙钟)", () => {
  beforeEach(() => {
    vi.mocked(logDesktop).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("无 timeoutMs 时行为不变：直接返回 op 结果并打 begin/end", async () => {
    const result = await runWorkspaceOpMain(
      { rootId: "r1", op: "read" },
      async () => ({ ok: true, value: "hi" }),
    );
    expect(result).toEqual({ ok: true, value: "hi" });
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_begin",
        fields: expect.objectContaining({
          op: "read",
          root_id: "r1",
          timeout_ms: null,
        }),
      }),
    );
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_end",
        fields: expect.objectContaining({
          op: "read",
          root_id: "r1",
          timeout_ms: null,
          ok: true,
        }),
      }),
    );
    expect(
      vi.mocked(logDesktop).mock.calls.some(
        (c) => c[0]?.event === "workspace_op.main_timeout",
      ),
    ).toBe(false);
  });

  it("超时先返回活性 WorkspaceIOError 信封，并打 main_timeout", async () => {
    const hang = new Promise<{ ok: true; value: string }>(() => {
      /* never settles */
    });
    const settled = runWorkspaceOpMain(
      { rootId: "r1", op: "read", timeoutMs: 30 },
      () => hang,
    );
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("WorkspaceIOError");
      expect(result.error.detail).toContain("活性");
    }
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_begin",
        fields: expect.objectContaining({
          op: "read",
          root_id: "r1",
          timeout_ms: 30,
        }),
      }),
    );
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_timeout",
        fields: expect.objectContaining({
          op: "read",
          root_id: "r1",
          timeout_ms: 30,
        }),
      }),
    );
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_end",
        fields: expect.objectContaining({
          ok: false,
          timeout_ms: 30,
        }),
      }),
    );
  });

  it("timeoutMs 内完成则不打 main_timeout", async () => {
    const result = await runWorkspaceOpMain(
      { rootId: "r1", op: "exists", timeoutMs: 500 },
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true, value: true };
      },
    );
    expect(result).toEqual({ ok: true, value: true });
    expect(
      vi.mocked(logDesktop).mock.calls.some(
        (c) => c[0]?.event === "workspace_op.main_timeout",
      ),
    ).toBe(false);
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_end",
        fields: expect.objectContaining({ ok: true, timeout_ms: 500 }),
      }),
    );
  });
});
