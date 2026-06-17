import { StreamError } from "@/lib/errors";
import type { components } from "@/types/api.generated";
import type { SidecarTurnResult } from "@shared/sidecar-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Resume reuses the普通本地回合 scaffolding; mock the heavy collaborators so the
// resume link's observable contract is asserted in isolation: the `resume` RPC
// params, event forwarding/filtering, write-back keyed on the *injected* user
// bubble (a paused sidecar turn's user message was never cloud-persisted), and the
// failure→StreamError("sidecar") / abort→AbortError mapping. The real conversation
// store is used (seeded below) so the optimistic-id reconcile is faithful.
vi.mock("@/services/localTurns", () => ({ recordLocalTurn: vi.fn() }));
vi.mock("@/services/streamConversation", () => ({
  dispatchSSEEvent: vi.fn(),
  flushPendingContent: vi.fn(),
}));
vi.mock("@/services/sidecarRouting", () => ({
  setActiveSidecarTurn: vi.fn(),
  clearActiveSidecarTurn: vi.fn(),
}));
vi.mock("@/services/sidecarStatus", () => ({
  takeRecentSidecarFailure: vi.fn(() => null),
}));
vi.mock("@/hooks/useConversations", () => ({ patchConversationCache: vi.fn() }));
vi.mock("@/lib/toast", () => ({ notifyWarning: vi.fn(), notifySuccess: vi.fn() }));

import { recordLocalTurn } from "@/services/localTurns";
import { dispatchSSEEvent } from "@/services/streamConversation";
import { takeRecentSidecarFailure } from "@/services/sidecarStatus";
import { useConversationStore } from "@/stores/conversation";
import { resumeConversationViaSidecar } from "../streamConversationViaSidecar";

const recordLocalTurnMock = vi.mocked(recordLocalTurn);
const dispatchSSEEventMock = vi.mocked(dispatchSSEEvent);
const takeRecentSidecarFailureMock = vi.mocked(takeRecentSidecarFailure);

type RecordTurnResponse = components["schemas"]["RecordTurnResponse"];
type EventPush = { conversationId: string; event: unknown };

function turnResult(): SidecarTurnResult {
  return {
    turnId: "m-asst",
    messageId: "m-asst",
    content: "续答完成",
    reasoningContent: null,
    finishReason: "stop",
    rounds: 1,
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
    citations: [],
    runs: null,
    error: null,
  };
}

const baseRequest = {
  conversationId: "c1",
  rootId: "r1",
  messageId: "m-asst",
  decision: "continue" as const,
  note: "",
  selected: [],
  userMessage: "原始问题",
  userMessageId: "u-inj",
};

let onEventCb: ((push: EventPush) => void) | null;
let resumeMock: ReturnType<typeof vi.fn>;
let cancelMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  recordLocalTurnMock.mockReset();
  dispatchSSEEventMock.mockReset();
  takeRecentSidecarFailureMock.mockReturnValue(null);

  onEventCb = null;
  resumeMock = vi.fn();
  cancelMock = vi.fn(() => Promise.resolve());

  // The SUT bridges to the main process via the preload `window.sidecarApi`; the
  // node test env has no `window`, so define it directly.
  (globalThis as Record<string, unknown>).window = {
    sidecarApi: {
      onEvent: vi.fn((cb: (push: EventPush) => void) => {
        onEventCb = cb;
        return () => {};
      }),
      cancel: cancelMock,
      resume: resumeMock,
      startTurn: vi.fn(),
      respond: vi.fn(),
      listPaused: vi.fn(),
    },
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).window = undefined;
});

/** Seed the user bubble runResume injects before resuming (the paused turn's
 *  original message, absent from the reopened transcript). */
function seedInjectedUserBubble(
  conversationId: string,
  userMessageId: string,
  content: string,
): void {
  useConversationStore.getState().addMessage(
    {
      id: userMessageId,
      role: "user",
      content,
      createdAt: "",
      executionId: null,
      isStreaming: false,
    },
    conversationId,
  );
}

describe("resumeConversationViaSidecar", () => {
  it("drives the resume RPC, forwards only this conversation's events, and reconciles the injected bubble on write-back", async () => {
    recordLocalTurnMock.mockResolvedValue({
      user_message_id: "real-uid",
      title: "续跑标题",
    } as unknown as RecordTurnResponse);
    seedInjectedUserBubble("c1", "u-inj", "原始问题");

    const result = turnResult();
    // `resume` runs once the SUT reaches `await invoke()` — by then onEvent is
    // subscribed, so the engine "streams" one matching + one foreign event.
    resumeMock.mockImplementation(async () => {
      onEventCb?.({
        conversationId: "c1",
        event: { type: "content_delta", payload: { delta: "x" } },
      });
      onEventCb?.({
        conversationId: "other",
        event: { type: "content_delta", payload: { delta: "y" } },
      });
      return result;
    });

    await expect(resumeConversationViaSidecar(baseRequest)).resolves.toBe(
      result,
    );

    expect(resumeMock).toHaveBeenCalledWith({
      rootId: "r1",
      conversationId: "c1",
      messageId: "m-asst",
      decision: "continue",
      note: "",
      selected: [],
    });
    // Foreign-conversation event filtered out; only c1's reached the dispatcher.
    expect(dispatchSSEEventMock).toHaveBeenCalledTimes(1);

    // Write-back carries the *injected* user message + its optimistic id (a paused
    // sidecar turn's user message is otherwise lost — never cloud-persisted).
    expect(recordLocalTurnMock).toHaveBeenCalledWith(
      "c1",
      "原始问题",
      "u-inj",
      result,
    );

    // The injected bubble's optimistic id is swapped for the authoritative one.
    const userMsg = useConversationStore
      .getState()
      .byId.c1?.messages.find((m) => m.role === "user");
    expect(userMsg?.id).toBe("real-uid");
  });

  it("maps a resume failure to a sidecar StreamError carrying the engine's reason", async () => {
    resumeMock.mockRejectedValue(new Error("引擎崩了"));

    const err = await resumeConversationViaSidecar(baseRequest).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).kind).toBe("sidecar");
    expect((err as StreamError).serverMessage).toContain("引擎崩了");
    // A turn that never completed must not be written back to the cloud.
    expect(recordLocalTurnMock).not.toHaveBeenCalled();
  });

  it("prefers an onStatus lifecycle diagnostic over the rejection reason", async () => {
    takeRecentSidecarFailureMock.mockReturnValue("找不到 Python，无法启动本地引擎");
    resumeMock.mockRejectedValue(new Error("generic rpc error"));

    const err = await resumeConversationViaSidecar(baseRequest).catch(
      (e: unknown) => e,
    );
    expect((err as StreamError).serverMessage).toBe(
      "找不到 Python，无法启动本地引擎",
    );
  });

  it("surfaces a user stop as AbortError and cancels the engine", async () => {
    const ac = new AbortController();
    let rejectResume: (e: unknown) => void = () => {};
    resumeMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectResume = reject;
        }),
    );

    const p = resumeConversationViaSidecar({ ...baseRequest, signal: ac.signal });
    p.catch(() => {});

    // `resume` is invoked only after the abort listener is registered, so waiting
    // for it guarantees the stop button is wired before we press it.
    await vi.waitFor(() => expect(resumeMock).toHaveBeenCalled());
    ac.abort();
    expect(cancelMock).toHaveBeenCalledWith({ rootId: "r1", turnId: "m-asst" });

    // The cancelled RPC then rejects; the abort wins → AbortError, no error banner.
    rejectResume(new Error("turn cancelled"));
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(recordLocalTurnMock).not.toHaveBeenCalled();
  });
});
