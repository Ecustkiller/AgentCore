/**
 * Diagnostic: switch-away while a turn finishes — terminal SSE no longer drops
 * the complete local window (step 2). Idle eviction is LRU-only on switch.
 * Step-1 residency gate still refuses soft materialize after LRU eviction
 * (`reject_not_resident`); while still resident, thin soft refresh is blocked
 * by the richer gate (`reject_not_richer`).
 *
 * Step 3 warm open: mid-history leave+return snaps to latest via intentional
 * `loadLatestWindow` (same weight as composer「跳到最新」); generating /
 * destination keep slice (`decideWarmOpenAction`).
 *
 * Logs under `conversation.slice_diag`: message_end_slice_kept /
 * reject_not_resident / warm_skip_reconcile / warm_keep_anchor /
 * warm_snap_latest / load_latest_window. Richer-gate soft refresh while still
 * resident is covered by messages.loadLatestWindow tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/detachLocalBrowserHost", () => ({
  detachLocalBrowserHost: vi.fn().mockResolvedValue(undefined),
}));

const logEvent = vi.fn();
vi.mock("@/lib/log", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
}));

const apiGet = vi.fn();
vi.mock("@/services/api", () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

import { decideWarmOpenAction, loadLatestWindow } from "@/services/messages";
import { handleMessageStreamEvent } from "@/services/sse/handlers/messageStream";
import {
  CONVERSATION_SLICE_LRU_LIMIT,
  getRuntime,
  useConversationStore,
} from "../conversation";
import { useInteractionStore } from "../interactions";

const store = () => useConversationStore.getState();

function msg(
  id: string,
  role: "user" | "assistant",
  content: string,
): {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  executionId: null;
  isStreaming: boolean;
} {
  return {
    id,
    role,
    content,
    createdAt: "",
    executionId: null,
    isStreaming: false,
  };
}

function mockLatestWindow(
  messages: ReturnType<typeof msg>[],
  flags: { before?: boolean; after?: boolean } = {},
) {
  apiGet.mockResolvedValueOnce({
    data: messages.map((m) => ({
      id: m.id,
      conversation_id: "a",
      role: m.role,
      content: m.content,
      reasoning_content: null,
      created_at: m.createdAt || "2026-01-01T00:00:00Z",
      runs: null,
    })),
    total: messages.length,
    has_more_before: flags.before ?? false,
    has_more_after: flags.after ?? false,
    memory_updates: [],
  });
}

beforeEach(() => {
  logEvent.mockClear();
  apiGet.mockReset();
  useConversationStore.setState({
    currentConversationId: null,
    byId: {},
    sliceLruOrder: [],
  });
  useInteractionStore.getState().clear();
});

describe("switch-conversation stale window (diag repro)", () => {
  it("background message_end keeps the complete slice (no release)", () => {
    store().switchConversation("a");
    store().setMessageWindow(
      [
        msg("m1", "user", "first"),
        msg("m2", "assistant", "reply1"),
        msg("m3", "user", "second"),
        msg("m4", "assistant", "reply2-full"),
      ],
      { hasMoreBefore: false, hasMoreAfter: false },
      "a",
    );
    store().createAssistantMessage("a");
    store().setServerMessageIdOnLastMessage("m5", "a");

    // User switches away while the turn is live — A stays (busy).
    store().switchConversation("b");
    expect(store().byId.a?.messages.length).toBeGreaterThanOrEqual(4);

    handleMessageStreamEvent(
      {
        type: "message_end",
        timestamp: "",
        payload: { finish_reason: "end_turn" },
      },
      { conversationId: "a", source: "server" },
    );

    // Step 2: terminal no longer releaseBackgroundSlice — complete window stays.
    expect(store().byId.a).toBeDefined();
    expect(store().byId.a?.messages.some((m) => m.id === "m4")).toBe(true);
    expect(store().byId.a?.isGenerating).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      "info",
      "conversation.slice_diag",
      expect.objectContaining({
        action: "message_end_slice_kept",
        conversation_id: "a",
        still_in_memory: true,
      }),
    );
  });

  it("LRU eviction then soft materialize is refused (no thin resurrect)", () => {
    store().switchConversation("a");
    store().setMessageWindow(
      [
        msg("m1", "user", "first"),
        msg("m2", "assistant", "reply1"),
        msg("m3", "user", "second"),
        msg("m4", "assistant", "reply2-full"),
      ],
      { hasMoreBefore: false, hasMoreAfter: false },
      "a",
    );
    store().switchConversation("b");
    expect(store().byId.a).toBeDefined();

    // LIMIT+1 more idle slices with messages → oldest idle (a) overflows.
    for (let i = 0; i < CONVERSATION_SLICE_LRU_LIMIT + 1; i++) {
      const id = `idle-${i}`;
      store().switchConversation(id);
      store().addMessage({
        ...msg(`m-${id}`, "user", id),
      });
    }
    expect(store().byId.a).toBeUndefined();

    store().setMessageWindow(
      [msg("m1", "user", "first"), msg("m2", "assistant", "reply1")],
      { hasMoreBefore: false, hasMoreAfter: false },
      "a",
    );
    expect(store().byId.a).toBeUndefined();
    expect(logEvent).toHaveBeenCalledWith(
      "info",
      "conversation.slice_diag",
      expect.objectContaining({
        action: "reject_not_resident",
        conversation_id: "a",
      }),
    );

    store().switchConversation("a");
    const rt = getRuntime("a");
    const warm = rt.messages.length > 0 || rt.isGenerating;
    expect(warm).toBe(false);
    expect(rt.messages).toHaveLength(0);
  });

  it("mid-history leave and return: warm idle snap lands on latest", async () => {
    store().switchConversation("a");
    // Search jump installed an around-window (recent tail not loaded).
    store().setMessageWindow(
      [msg("m10", "user", "old"), msg("m11", "assistant", "old-reply")],
      { hasMoreBefore: true, hasMoreAfter: true },
      "a",
    );
    store().switchConversation("b");
    store().switchConversation("a");

    const rtWarm = getRuntime("a");
    expect(rtWarm.hasMoreAfter).toBe(true);
    expect(rtWarm.messages.map((m) => m.id)).toEqual(["m10", "m11"]);
    // Idle warm + no destination → ConversationPage calls intentional snap.
    expect(
      decideWarmOpenAction({
        isGenerating: rtWarm.isGenerating,
        hasDestination: false,
      }),
    ).toBe("snap_latest");

    mockLatestWindow([
      msg("m20", "user", "new"),
      msg("m21", "assistant", "new-reply"),
    ]);
    const wrote = await loadLatestWindow("a");
    expect(wrote).toBe(true);
    expect(getRuntime("a").messages.map((m) => m.id)).toEqual(["m20", "m21"]);
    expect(getRuntime("a").hasMoreAfter).toBe(false);
  });

  it("warm open policy: generating / destination keep slice", () => {
    expect(
      decideWarmOpenAction({ isGenerating: true, hasDestination: false }),
    ).toBe("skip_generating");
    expect(
      decideWarmOpenAction({ isGenerating: true, hasDestination: true }),
    ).toBe("skip_generating");
    expect(
      decideWarmOpenAction({ isGenerating: false, hasDestination: true }),
    ).toBe("keep_anchor");
    expect(
      decideWarmOpenAction({ isGenerating: false, hasDestination: false }),
    ).toBe("snap_latest");
  });
});
