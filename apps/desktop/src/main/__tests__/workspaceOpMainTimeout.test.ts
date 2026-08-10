/**
 * 主进程墙钟 timeout + 物理 CAP 闸（含僵尸占槽 / 排队 / capacity ≠ liveness）。
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

import {
  WORKSPACE_OP_MAIN_PHYSICAL_CAP,
  resetWorkspaceOpMainInflightForTests,
  runWorkspaceOpMain,
  setWorkspaceOpMainPhysicalCapForTests,
  workspaceOpMainCapacityDetail,
} from "../fs/workspace/dispatch";
import { logDesktop } from "../log-service";

describe("runWorkspaceOpMain (主进程墙钟)", () => {
  beforeEach(() => {
    vi.mocked(logDesktop).mockClear();
    resetWorkspaceOpMainInflightForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetWorkspaceOpMainInflightForTests();
  });

  it("无 timeoutMs 时行为不变：直接返回 op 结果并打 begin/end", async () => {
    const result = await runWorkspaceOpMain(
      { rootId: "r1", op: "read" },
      async () => ({ ok: true, value: "hi" }),
    );
    expect(result).toEqual({ ok: true, value: "hi" });
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.admitted",
        fields: expect.objectContaining({
          op: "read",
          root_id: "r1",
          queue_wait_ms: 0,
          physical_running: 1,
          cap: WORKSPACE_OP_MAIN_PHYSICAL_CAP,
        }),
      }),
    );
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_begin",
        fields: expect.objectContaining({
          op: "read",
          root_id: "r1",
          timeout_ms: null,
          inflight_total: 1,
          queue_depth: 0,
          physical_running: 1,
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
      vi
        .mocked(logDesktop)
        .mock.calls.some((c) => c[0]?.event === "workspace_op.main_timeout"),
    ).toBe(false);
  });

  it("超时先返回活性 WorkspaceIOError 信封，并打 main_timeout + zombie_enter", async () => {
    const hang = new Promise<{ ok: true; value: string }>(() => {
      /* never settles */
    });
    const settled = runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "read",
        timeoutMs: 30,
        conversationId: "cid-b",
        requestId: "req-b",
      },
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
          conversation_id: "cid-b",
          request_id: "req-b",
        }),
      }),
    );
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "workspace_op.main_timeout",
        fields: expect.objectContaining({
          op: "read",
          root_id: "r1",
          timeout_ms: 30,
          conversation_id: "cid-b",
          request_id: "req-b",
          inflight_cid: 1,
          inflight_total: 1,
          physical_running: 1,
          duration_ms: expect.any(Number),
        }),
      }),
    );
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "workspace_op.zombie_enter",
        fields: expect.objectContaining({
          conversation_id: "cid-b",
          physical_running: 1,
          zombie_count: 1,
        }),
      }),
    );
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_end",
        fields: expect.objectContaining({
          ok: false,
          timeout_ms: 30,
          conversation_id: "cid-b",
          // leave-once：逻辑已卸；物理仍被僵尸占着
          inflight_total: 0,
          inflight_cid: 0,
          physical_running: 1,
          zombie_count: 1,
        }),
      }),
    );
  });

  it("超时 leave-once 后逻辑计数归零，单僵尸不挡后续 op（CAP>1）", async () => {
    const hang = new Promise<{ ok: true; value: string }>(() => {
      /* never settles */
    });
    await runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "read",
        timeoutMs: 20,
        conversationId: "cid-z",
      },
      () => hang,
    );
    const follow = await runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "exists",
        timeoutMs: 200,
        conversationId: "cid-z",
      },
      async () => ({ ok: true, value: true }),
    );
    expect(follow).toEqual({ ok: true, value: true });
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_begin",
        fields: expect.objectContaining({
          op: "exists",
          conversation_id: "cid-z",
          inflight_total: 1,
          // 僵尸仍占 1 物理槽 + 本 op
          physical_running: 2,
          zombie_count: 1,
          queue_depth: 0,
        }),
      }),
    );
  });

  it("第二对话超时日志能看到邻对话物理争用（physical_running）", async () => {
    const hangA = new Promise<{ ok: true; value: string }>(() => {
      /* never settles */
    });
    const hangB = new Promise<{ ok: true; value: string }>(() => {
      /* never settles */
    });
    void runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "grep",
        timeoutMs: 5_000,
        conversationId: "cid-a",
        requestId: "req-a",
      },
      () => hangA,
    );
    const resultB = await runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "exists",
        timeoutMs: 30,
        conversationId: "cid-b",
        requestId: "req-b",
      },
      () => hangB,
    );
    expect(resultB.ok).toBe(false);
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "workspace_op.main_timeout",
        fields: expect.objectContaining({
          conversation_id: "cid-b",
          request_id: "req-b",
          op: "exists",
          inflight_cid: 1,
          inflight_total: 2,
          physical_running: 2,
          queue_depth: 0,
          duration_ms: expect.any(Number),
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
      vi
        .mocked(logDesktop)
        .mock.calls.some((c) => c[0]?.event === "workspace_op.main_timeout"),
    ).toBe(false);
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.main_end",
        fields: expect.objectContaining({ ok: true, timeout_ms: 500 }),
      }),
    );
  });
});

describe("runWorkspaceOpMain (物理 CAP 闸)", () => {
  beforeEach(() => {
    vi.mocked(logDesktop).mockClear();
    resetWorkspaceOpMainInflightForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetWorkspaceOpMainInflightForTests();
  });

  it("默认 CAP 对齐服务端 workspace_channel_max_inflight=16", () => {
    expect(WORKSPACE_OP_MAIN_PHYSICAL_CAP).toBe(16);
  });

  it("僵尸占满物理槽挡住第 17 个；capacity fail 不含活性文案", async () => {
    const hangs: Promise<{ ok: true; value: string }>[] = [];
    const timedOut: Promise<unknown>[] = [];
    for (let i = 0; i < WORKSPACE_OP_MAIN_PHYSICAL_CAP; i++) {
      const hang = new Promise<{ ok: true; value: string }>(() => {
        /* never settles → zombie after timeout */
      });
      hangs.push(hang);
      timedOut.push(
        runWorkspaceOpMain(
          {
            rootId: "r1",
            op: "read",
            timeoutMs: 25,
            conversationId: `cid-z${i}`,
          },
          () => hang,
        ),
      );
    }
    await Promise.all(timedOut);

    const seventeenth = await runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "exists",
        timeoutMs: 40,
        conversationId: "cid-blocked",
        requestId: "req-17",
      },
      async () => ({ ok: true, value: true }),
    );
    expect(seventeenth.ok).toBe(false);
    if (!seventeenth.ok) {
      expect(seventeenth.error.kind).toBe("WorkspaceIOError");
      expect(seventeenth.error.detail).toBe(
        workspaceOpMainCapacityDetail(WORKSPACE_OP_MAIN_PHYSICAL_CAP),
      );
      expect(seventeenth.error.detail).not.toContain("活性");
      expect(seventeenth.error.detail.toLowerCase()).not.toContain("timed out");
    }
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.queued",
        fields: expect.objectContaining({
          conversation_id: "cid-blocked",
          physical_running: WORKSPACE_OP_MAIN_PHYSICAL_CAP,
          zombie_count: WORKSPACE_OP_MAIN_PHYSICAL_CAP,
        }),
      }),
    );
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "workspace_op.rejected_capacity",
        fields: expect.objectContaining({
          conversation_id: "cid-blocked",
          request_id: "req-17",
          physical_running: WORKSPACE_OP_MAIN_PHYSICAL_CAP,
        }),
      }),
    );
    expect(
      vi
        .mocked(logDesktop)
        .mock.calls.some(
          (c) =>
            c[0]?.event === "workspace_op.main_begin" &&
            c[0]?.fields?.conversation_id === "cid-blocked",
        ),
    ).toBe(false);
  });

  it("排队后放行：槽释放后排队 op 获 admit 并完成", async () => {
    setWorkspaceOpMainPhysicalCapForTests(1);
    let releaseHold!: () => void;
    const hold = new Promise<void>((r) => {
      releaseHold = r;
    });
    let holderEntered!: () => void;
    const holderEnteredP = new Promise<void>((r) => {
      holderEntered = r;
    });
    const first = runWorkspaceOpMain(
      { rootId: "r1", op: "read", conversationId: "cid-hold" },
      async () => {
        holderEntered();
        await hold;
        return { ok: true, value: "held" };
      },
    );
    await holderEnteredP;

    const secondPromise = runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "exists",
        timeoutMs: 2_000,
        conversationId: "cid-wait",
      },
      async () => ({ ok: true, value: true }),
    );
    // 等到 queued 日志（真实入队）
    for (let i = 0; i < 40; i++) {
      const queued = vi
        .mocked(logDesktop)
        .mock.calls.some(
          (c) =>
            c[0]?.event === "workspace_op.queued" &&
            c[0]?.fields?.conversation_id === "cid-wait",
        );
      if (queued) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.queued",
        fields: expect.objectContaining({
          conversation_id: "cid-wait",
          physical_running: 1,
          queue_depth: 1,
          cap: 1,
        }),
      }),
    );

    releaseHold();
    const [firstResult, secondResult] = await Promise.all([
      first,
      secondPromise,
    ]);
    expect(firstResult).toEqual({ ok: true, value: "held" });
    expect(secondResult).toEqual({ ok: true, value: true });
    expect(logDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_op.admitted",
        fields: expect.objectContaining({
          conversation_id: "cid-wait",
          queue_wait_ms: expect.any(Number),
        }),
      }),
    );
  });

  it("CAP=1 时排队耗尽 → capacity fail，detail 无活性/timed out", async () => {
    setWorkspaceOpMainPhysicalCapForTests(1);
    const hang = new Promise<{ ok: true; value: string }>(() => {
      /* never settles */
    });
    let holderEntered!: () => void;
    const holderEnteredP = new Promise<void>((r) => {
      holderEntered = r;
    });
    void runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "read",
        timeoutMs: 5_000,
        conversationId: "cid-holder",
      },
      () => {
        holderEntered();
        return hang;
      },
    );
    await holderEnteredP;

    const blocked = await runWorkspaceOpMain(
      {
        rootId: "r1",
        op: "exists",
        timeoutMs: 30,
        conversationId: "cid-cap",
      },
      async () => ({ ok: true, value: true }),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.detail).toBe(workspaceOpMainCapacityDetail(1));
      expect(blocked.error.detail).not.toMatch(/活性挂起|timed out/i);
    }
  });
});
