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
import { performWorkspaceOp } from "@/services/workspaceOps";
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
    useWorkspaceChannelStore.setState({ notReady: false });
    logEvent.mockReset();
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    useConversationStore.getState().setTurnPhase("idle", CID);
    enterTurnStreaming(CID);
  });

  afterEach(() => {
    resetClientToolFulfillmentForTests();
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

  it("logs dropped when turnPhase gate blocks workspace_op_required", () => {
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
      }),
    );
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

  it("logs aborted when timeout_ms elapses before IPC returns", async () => {
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

    expect(logEvent.mock.calls.map((c) => c[1])).toContain(
      "workspace_op.aborted",
    );
    expect(useWorkspaceChannelStore.getState().notReady).toBe(true);
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
