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
import {
  installClientToolIngress,
  resetClientToolIngressForTests,
} from "@/services/clientToolIngress";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import {
  performWorkspaceOp,
  resetWorkspaceOpIpcInflightForTests,
} from "@/services/workspaceOps";
import { useConversationStore } from "@/stores/conversation/store";
import { enterTurnStreaming } from "@/stores/conversation/turnPhaseActions";
import { useWorkspaceChannelStore } from "@/stores/workspaceChannel";
import type { WorkspaceOpRequiredPayload } from "@/types/events";
import type { SidecarFulfillPush } from "@shared/sidecar-contract";

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
    resetClientToolIngressForTests();
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
    resetClientToolIngressForTests();
    resetClientToolFulfillmentForTests();
    resetWorkspaceOpIpcInflightForTests();
    useWorkspaceChannelStore.setState({ notReady: false });
    useConversationStore.getState().setTurnPhase("idle", CID);
    vi.unstubAllGlobals();
  });

  it("logs received → ipc → resolve on happy path", async () => {
    const workspaceOp = vi.fn().mockResolvedValue({ ok: true, value: "hi" });
    stubFsApi(workspaceOp);

    await performWorkspaceOp(payload(), CID, "cloud");

    const events = logEvent.mock.calls.map((c) => c[1]);
    expect(events).toContain("workspace_op.received");
    expect(events).toContain("workspace_op.ipc_begin");
    expect(events).toContain("workspace_op.ipc_end");
    expect(events).toContain("workspace_op.resolve");
    expect(
      logEvent.mock.calls.find((c) => c[1] === "workspace_op.resolve")?.[2],
    ).toMatchObject({ outcome: "ok" });
  });

  it("sidecar fulfill push fulfills with origin sidecar (HTTP not used)", async () => {
    const workspaceOp = vi.fn().mockResolvedValue({ ok: true, value: "hi" });
    const respond = vi.fn().mockResolvedValue({ resolved: true });
    const bridge: { push: ((e: SidecarFulfillPush) => void) | null } = {
      push: null,
    };
    vi.stubGlobal("window", {
      fsApi: { workspaceOp },
      sidecarApi: {
        respond,
        onFulfillFrame: (cb: (e: SidecarFulfillPush) => void) => {
          bridge.push = cb;
          return () => {
            bridge.push = null;
          };
        },
      },
    });
    const { getActiveSidecarTarget } = await import(
      "@/services/sidecarRouting"
    );
    vi.mocked(getActiveSidecarTarget).mockReturnValue({
      rootId: "root-1",
      subpath: "",
      turnId: "t1",
    });

    installClientToolIngress();
    expect(bridge.push).not.toBeNull();
    bridge.push?.({
      conversationId: CID,
      frame: {
        type: "workspace_op_required",
        timestamp: "t0",
        payload: payload(),
      },
    });

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalled();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r-l3",
        conversationId: CID,
        result: expect.objectContaining({ kind: "client_tool", ok: true }),
      }),
    );
  });

  it("ignores conversation-SSE workspace_op (fulfill channel owns CLIENT_TOOL)", async () => {
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
      "client_tool.ignored_on_conversation_sse",
      expect.objectContaining({
        event_type: "workspace_op_required",
        reason: "fulfill_channel_owns_client_tool",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores stray cloud conversation-SSE workspace_op in terminal phase", async () => {
    useConversationStore.getState().setTurnPhase("completed", CID);
    dispatchSSEEvent(
      {
        type: "workspace_op_required",
        payload: payload({ request_id: "r-term" }),
        timestamp: "t0",
      },
      { conversationId: CID, source: "server" },
    );
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "client_tool.ignored_on_conversation_sse",
      expect.objectContaining({
        event_type: "workspace_op_required",
        reason: "fulfill_channel_owns_client_tool",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs resolve fail when POST is non-404 error", async () => {
    const workspaceOp = vi.fn().mockResolvedValue({ ok: true, value: "hi" });
    stubFsApi(workspaceOp);
    fetchMock.mockResolvedValue(errResponse(500));

    await performWorkspaceOp(payload({ request_id: "r-fail" }), CID, "cloud");

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
      "cloud",
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
      "cloud",
    );
    await aReady;
    await performWorkspaceOp(
      payload({
        request_id: "r-b",
        conversation_id: "cid-b",
        timeout_ms: 30,
      }),
      "cid-b",
      "cloud",
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
    await performWorkspaceOp(payload({ request_id: "r-url" }), CID, "cloud");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE_URL}/v1/conversations/${CID}/interactions/r-url`,
    );
  });
});
