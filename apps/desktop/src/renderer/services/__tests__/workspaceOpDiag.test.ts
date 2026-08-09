import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logEvent = vi.fn();
vi.mock("@/lib/log", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

vi.mock("@/services/sidecarRouting", () => ({
  resolveConversationLocalTarget: vi.fn(() => Promise.resolve(null)),
  getActiveSidecarTarget: vi.fn(() => null),
}));

import { BASE_URL } from "@/services/api";
import { resetClientToolFulfillmentForTests } from "@/services/clientToolFulfill";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import {
  performWorkspaceOp,
  resetWorkspaceOpIpcInflightForTests,
} from "@/services/workspaceOps";
import { useConversationStore } from "@/stores/conversation/store";
import { enterTurnStreaming } from "@/stores/conversation/turnPhaseActions";
import { useWorkspaceChannelStore } from "@/stores/workspaceChannel";
import type { WorkspaceOpRequiredPayload } from "@/types/events";

const CID = "c-l3";

const payload = (
  over: Partial<WorkspaceOpRequiredPayload> = {},
): WorkspaceOpRequiredPayload => ({
  request_id: "r-l3",
  conversation_id: CID,
  root_id: "root-1",
  op: "read",
  args: { path: "a.txt" },
  timeout_ms: 5_000,
  ...over,
});

const stubFsApi = (workspaceOp: unknown) =>
  vi.stubGlobal("window", { fsApi: { workspaceOp } });

const noHeaders = { get: () => null };
const okResponse = () => ({
  ok: true,
  status: 200,
  headers: noHeaders,
  text: async () => "{}",
});
const errResponse = (status: number) => ({
  ok: false,
  status,
  headers: noHeaders,
  text: async () => "{}",
});

describe("workspace_op L3 diagnostics", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetClientToolFulfillmentForTests();
    resetWorkspaceOpIpcInflightForTests();
    useWorkspaceChannelStore.setState({ notReady: false });
    logEvent.mockReset();
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    useConversationStore.getState().setTurnPhase("idle", CID);
    enterTurnStreaming(CID);
  });

  afterEach(() => {
    resetClientToolFulfillmentForTests();
    resetWorkspaceOpIpcInflightForTests();
    useWorkspaceChannelStore.setState({ notReady: false });
    useConversationStore.getState().setTurnPhase("idle", CID);
    vi.unstubAllGlobals();
  });

  it("logs received → ipc → resolve on happy path via SSE dispatch", async () => {
    const workspaceOp = vi.fn().mockResolvedValue({ ok: true, value: "hi" });
    stubFsApi(workspaceOp);

    dispatchSSEEvent(
      {
        type: "workspace_op_required",
        payload: payload(),
        timestamp: "t0",
      },
      { conversationId: CID, source: "server" },
    );
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const events = logEvent.mock.calls.map((c) => c[1]);
    expect(events).toContain("workspace_op.received");
    expect(events).toContain("workspace_op.ipc_begin");
    expect(events).toContain("workspace_op.ipc_end");
    expect(events).toContain("workspace_op.resolve");
    expect(
      logEvent.mock.calls.find((c) => c[1] === "workspace_op.resolve")?.[2],
    ).toMatchObject({ outcome: "ok" });
  });

  it("logs dropped + fail-settles when turnPhase gate blocks workspace_op_required", async () => {
    useConversationStore.getState().setTurnPhase("stopping", CID);
    dispatchSSEEvent(
      {
        type: "workspace_op_required",
        payload: payload(),
        timestamp: "t0",
      },
      { conversationId: CID, source: "server" },
    );
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "workspace_op.dropped",
      expect.objectContaining({
        request_id: "r-l3",
        turn_phase: "stopping",
        reason: "turn_phase_gate",
        settle: "fail_envelope",
      }),
    );
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body?: string },
    ];
    const body = JSON.parse(String(init.body)) as {
      kind: string;
      ok: boolean;
      error: { kind: string; detail: string };
    };
    expect(body).toMatchObject({
      kind: "client_tool",
      ok: false,
      error: { kind: "WorkspaceIOError" },
    });
    expect(body.error.detail).toContain("turn_phase_gate");
    expect(
      logEvent.mock.calls.find((c) => c[1] === "workspace_op.resolve")?.[2],
    ).toMatchObject({ outcome: "ok", result_ok: false });
  });

  it("terminal phase also fail-settles dropped workspace_op_required", async () => {
    useConversationStore.getState().setTurnPhase("completed", CID);
    dispatchSSEEvent(
      {
        type: "workspace_op_required",
        payload: payload({ request_id: "r-term" }),
        timestamp: "t0",
      },
      { conversationId: CID, source: "server" },
    );
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "workspace_op.dropped",
      expect.objectContaining({
        request_id: "r-term",
        turn_phase: "completed",
        settle: "fail_envelope",
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body?: string },
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      kind: "client_tool",
      ok: false,
    });
  });

  it("logs resolve fail when POST is non-404 error", async () => {
    const workspaceOp = vi.fn().mockResolvedValue({ ok: true, value: "hi" });
    stubFsApi(workspaceOp);
    fetchMock.mockResolvedValue(errResponse(500));

    await performWorkspaceOp(payload({ request_id: "r-fail" }), CID);

    expect(
      logEvent.mock.calls.find((c) => c[1] === "workspace_op.resolve")?.[2],
    ).toMatchObject({ outcome: "fail", http_status: 500 });
  });

  it("logs aborted when timeout_ms elapses before IPC returns（含 cid inflight）", async () => {
    const workspaceOp = vi.fn(
      () =>
        new Promise(() => {
          /* never settle */
        }),
    );
    stubFsApi(workspaceOp);

    await performWorkspaceOp(
      payload({ request_id: "r-abort", timeout_ms: 30 }),
      CID,
    );

    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "workspace_op.aborted",
      expect.objectContaining({
        conversation_id: CID,
        request_id: "r-abort",
        op: "read",
        duration_ms: expect.any(Number),
        timeout_ms: 30,
        inflight_cid: 1,
        inflight_total: 1,
        queue_depth: 0,
      }),
    );
    expect(useWorkspaceChannelStore.getState().notReady).toBe(true);
  });

  it("第二对话 abort 日志能看到邻对话 IPC 争用", async () => {
    let aStarted!: () => void;
    const aReady = new Promise<void>((resolve) => {
      aStarted = resolve;
    });
    const hang = () =>
      new Promise<never>(() => {
        /* never settle */
      });
    stubFsApi(
      vi.fn(
        (_root: string, _op: string, _args: unknown, timeoutMs?: number) => {
          if (timeoutMs === 5_000) aStarted();
          return hang();
        },
      ),
    );

    void performWorkspaceOp(
      payload({
        request_id: "r-a",
        conversation_id: "cid-a",
        timeout_ms: 5_000,
      }),
      "cid-a",
    );
    await aReady;
    await performWorkspaceOp(
      payload({
        request_id: "r-b",
        conversation_id: "cid-b",
        timeout_ms: 30,
      }),
      "cid-b",
    );

    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "workspace_op.aborted",
      expect.objectContaining({
        conversation_id: "cid-b",
        request_id: "r-b",
        inflight_cid: 1,
        inflight_total: 2,
        queue_depth: 1,
        duration_ms: expect.any(Number),
      }),
    );
  });

  it("posts resolve to the interaction URL (sanity)", async () => {
    const workspaceOp = vi.fn().mockResolvedValue({ ok: true, value: 1 });
    stubFsApi(workspaceOp);
    await performWorkspaceOp(payload({ request_id: "r-url" }), CID);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE_URL}/v1/conversations/${CID}/interactions/r-url`,
    );
  });
});
