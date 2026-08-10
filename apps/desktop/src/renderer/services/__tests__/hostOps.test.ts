import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveInteraction = vi.fn().mockResolvedValue(undefined);
const logEvent = vi.fn();

vi.mock("@/services/interaction", () => ({
  resolveInteraction: (...args: unknown[]) => resolveInteraction(...args),
}));

vi.mock("@/lib/log", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

import { dispatchSSEEvent } from "@/services/sse/dispatch";
import { useConversationStore } from "@/stores/conversation/store";
import type { HostOpRequiredPayload } from "@/types/events";
import { resetClientToolFulfillmentForTests } from "../clientToolFulfill";
import { performHostOp, rejectHostOpForTurnPhase } from "../hostOps";

const CID = "conv-1";

function payload(
  over: Partial<HostOpRequiredPayload> = {},
): HostOpRequiredPayload {
  return {
    request_id: "host-1",
    conversation_id: CID,
    op: "shell",
    args: { command: "echo hi" },
    ...over,
  };
}

describe("performHostOp", () => {
  beforeEach(() => {
    resetClientToolFulfillmentForTests();
    resolveInteraction.mockClear();
    logEvent.mockClear();
    vi.stubGlobal("window", {
      hostApi: {
        runOp: vi.fn().mockResolvedValue({ ok: true, value: { code: 0 } }),
      },
    });
  });

  it("runs host op and posts client_tool result", async () => {
    await performHostOp(payload(), CID);
    expect(window.hostApi?.runOp).toHaveBeenCalledWith({
      op: "shell",
      args: { command: "echo hi" },
    });
    expect(resolveInteraction).toHaveBeenCalledWith(
      CID,
      "host-1",
      expect.objectContaining({
        kind: "client_tool",
        ok: true,
        value: { code: 0 },
      }),
    );
  });

  it("does not re-run host side effect on the same request_id", async () => {
    await performHostOp(payload(), CID);
    await performHostOp(payload(), CID);
    expect(window.hostApi?.runOp).toHaveBeenCalledTimes(1);
    expect(resolveInteraction).toHaveBeenCalledTimes(1);
  });
});

describe("rejectHostOpForTurnPhase", () => {
  beforeEach(() => {
    resetClientToolFulfillmentForTests();
    resolveInteraction.mockClear();
    logEvent.mockClear();
    vi.stubGlobal("window", {
      hostApi: {
        runOp: vi.fn().mockResolvedValue({ ok: true, value: { code: 0 } }),
      },
    });
  });

  it("POSTs fail_envelope without running host IPC (stopping)", async () => {
    await rejectHostOpForTurnPhase(payload(), CID, "stopping");
    expect(window.hostApi?.runOp).not.toHaveBeenCalled();
    expect(resolveInteraction).toHaveBeenCalledWith(
      CID,
      "host-1",
      expect.objectContaining({
        kind: "client_tool",
        ok: false,
        error: expect.objectContaining({
          kind: "HostOpError",
          detail: expect.stringContaining("turn_phase_gate"),
        }),
      }),
    );
  });

  it("POSTs fail_envelope without running host IPC (terminal)", async () => {
    await rejectHostOpForTurnPhase(
      payload({ request_id: "host-term" }),
      CID,
      "completed",
    );
    expect(window.hostApi?.runOp).not.toHaveBeenCalled();
    expect(resolveInteraction).toHaveBeenCalledWith(
      CID,
      "host-term",
      expect.objectContaining({
        kind: "client_tool",
        ok: false,
        error: expect.objectContaining({ kind: "HostOpError" }),
      }),
    );
  });
});

describe("dispatch drop host_op_required → fail settle", () => {
  beforeEach(() => {
    resetClientToolFulfillmentForTests();
    resolveInteraction.mockClear();
    logEvent.mockClear();
    useConversationStore.setState({ currentConversationId: CID, byId: {} });
    useConversationStore.getState().switchConversation(CID);
    vi.stubGlobal("window", {
      hostApi: {
        runOp: vi.fn().mockResolvedValue({ ok: true, value: { code: 0 } }),
      },
    });
  });

  it("stopping: logs dropped + POSTs fail settle without host IPC", async () => {
    useConversationStore.getState().setTurnPhase("stopping", CID);
    const p = payload({ request_id: "h-stop" });
    dispatchSSEEvent(
      { type: "host_op_required", payload: p, timestamp: "t0" } as never,
      { conversationId: CID, source: "server" },
    );
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      "host_op.dropped",
      expect.objectContaining({
        request_id: "h-stop",
        turn_phase: "stopping",
        settle: "fail_envelope",
      }),
    );
    await vi.waitFor(() => {
      expect(resolveInteraction).toHaveBeenCalled();
    });
    expect(window.hostApi?.runOp).not.toHaveBeenCalled();
    expect(resolveInteraction).toHaveBeenCalledWith(
      CID,
      "h-stop",
      expect.objectContaining({
        kind: "client_tool",
        ok: false,
        error: expect.objectContaining({
          kind: "HostOpError",
          detail: expect.stringContaining("turn_phase_gate"),
        }),
      }),
    );
  });

  it("terminal: POSTs fail settle without host IPC", async () => {
    useConversationStore.getState().setTurnPhase("completed", CID);
    const p = payload({ request_id: "h-term-dispatch" });
    dispatchSSEEvent(
      { type: "host_op_required", payload: p, timestamp: "t0" } as never,
      { conversationId: CID, source: "server" },
    );
    await vi.waitFor(() => {
      expect(resolveInteraction).toHaveBeenCalled();
    });
    expect(window.hostApi?.runOp).not.toHaveBeenCalled();
    expect(resolveInteraction).toHaveBeenCalledWith(
      CID,
      "h-term-dispatch",
      expect.objectContaining({
        kind: "client_tool",
        ok: false,
      }),
    );
  });
});
