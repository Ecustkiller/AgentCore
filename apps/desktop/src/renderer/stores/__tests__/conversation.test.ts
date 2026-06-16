import type { PlanReviewRequiredPayload, SSEEvent } from "@/types/events";
import { beforeEach, describe, expect, it } from "vitest";
import { useApprovalStore } from "../approvals";
import {
  getActiveRuntime,
  getRuntime,
  planReviewsFromEvents,
  useConversationStore,
} from "../conversation";

const store = () => useConversationStore.getState();
/** Active conversation's runtime slice — runtime state is now keyed by id. */
const rt = () => getActiveRuntime();

beforeEach(() => {
  useConversationStore.setState({
    currentConversationId: null,
    byId: {},
  });
  // The release predicate reads the approval store; keep suites isolated.
  useApprovalStore.getState().clear();
});

describe("conversation store", () => {
  describe("switchConversation", () => {
    it("clears messages and sets current id", () => {
      store().addMessage({
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: "",
        executionId: null,
        isStreaming: false,
      });
      store().setGenerating(true);

      store().switchConversation("conv-new");

      expect(store().currentConversationId).toBe("conv-new");
      expect(rt().messages).toEqual([]);
      expect(rt().isGenerating).toBe(false);
    });

    it("starts a fresh draft chat when switched to null", () => {
      store().switchConversation("conv-existing");
      store().addMessage({
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: "",
        executionId: null,
        isStreaming: false,
      });
      store().setGenerating(true);

      store().switchConversation(null);

      expect(store().currentConversationId).toBeNull();
      expect(rt().messages).toEqual([]);
      expect(rt().isGenerating).toBe(false);
    });
  });

  // Step 4: switching no longer aborts the turn you leave. A live turn keeps
  // streaming into its own slice in the background; an idle slice is released.
  describe("switchConversation (background turns)", () => {
    const userMsg = {
      id: "m1",
      role: "user" as const,
      content: "hi",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    };

    it("keeps a generating conversation's slice alive when leaving it", () => {
      store().switchConversation("a");
      store().createAssistantMessage(); // byId.a: streaming, isGenerating
      store().switchConversation("b");
      // a's live turn survives — not aborted, not released.
      expect(store().byId.a?.isGenerating).toBe(true);
      expect(store().byId.a?.messages).toHaveLength(1);
    });

    it("releases an idle conversation's buffer when leaving it", () => {
      store().switchConversation("a");
      store().addMessage(userMsg); // byId.a: idle (no live turn)
      store().switchConversation("b");
      // a is idle → buffer dropped so memory stays bounded (reloads on return).
      expect(store().byId.a).toBeUndefined();
    });

    it("returns to a live background turn without wiping its stream", () => {
      store().switchConversation("a");
      store().createAssistantMessage();
      store().appendToLastMessage("partial");
      store().switchConversation("b"); // a kept (busy)
      store().switchConversation("a"); // return to a
      expect(store().byId.a?.messages[0].content).toBe("partial");
      expect(store().byId.a?.isGenerating).toBe(true);
    });
  });

  // Step 6: the sidebar status dot (useConversationGenerating) reads each
  // conversation's *own* slice by id, not the active one — so a background turn
  // lights up its dot while the user looks at another conversation. getRuntime
  // is the imperative form of that selector (runtimeOf), so it covers the read.
  describe("per-conversation generating (sidebar status dot)", () => {
    const userMsg = {
      id: "m1",
      role: "user" as const,
      content: "hi",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    };

    it("reports a background conversation as generating while another is active", () => {
      store().switchConversation("a");
      store().createAssistantMessage(); // a is generating
      store().switchConversation("b"); // active = b, a kept alive (busy)

      expect(getRuntime("a").isGenerating).toBe(true);
      expect(getRuntime("b").isGenerating).toBe(false);
    });

    it("reports a released idle conversation as not generating", () => {
      store().switchConversation("a");
      store().addMessage(userMsg); // a idle (no live turn)
      store().switchConversation("b"); // a released
      expect(getRuntime("a").isGenerating).toBe(false);
    });
  });

  // Companion to Step 4's release-on-leave: a turn that finishes while the user
  // is on another conversation leaves an idle slice no switch will reclaim, so
  // the turn pipeline calls releaseBackgroundSlice on its terminal events.
  describe("releaseBackgroundSlice (background turn completion)", () => {
    it("drops an idle background conversation's buffer", () => {
      store().switchConversation("a");
      store().createAssistantMessage(); // a: streaming in the background
      store().switchConversation("b"); // a kept alive (busy)
      store().finalizeLastMessage("a"); // a's background turn completes → idle
      store().releaseBackgroundSlice("a");
      expect(store().byId.a).toBeUndefined();
    });

    it("never releases the active conversation", () => {
      store().switchConversation("a");
      store().createAssistantMessage();
      store().finalizeLastMessage(); // active a, now idle
      store().releaseBackgroundSlice("a");
      // a is on screen — releasing it would blank the view, so it must survive.
      expect(store().byId.a).toBeDefined();
    });

    it("keeps a background slice that still has a pending approval", () => {
      store().switchConversation("a");
      store().createAssistantMessage();
      store().switchConversation("b");
      store().finalizeLastMessage("a"); // a is no longer generating…
      useApprovalStore.getState().add({
        approval_id: "x",
        conversation_id: "a",
        tool_call_id: "t",
        tool_name: "file_write",
        arguments: {},
      });
      store().releaseBackgroundSlice("a"); // …but a paused approval keeps it
      expect(store().byId.a).toBeDefined();
    });

    it("is a no-op for an unknown conversation", () => {
      store().switchConversation("a");
      store().releaseBackgroundSlice("ghost");
      expect(store().byId.a).toBeDefined();
    });
  });

  describe("addMessage", () => {
    it("appends a message to the list", () => {
      const msg = {
        id: "m1",
        role: "user" as const,
        content: "test",
        createdAt: "",
        executionId: null,
        isStreaming: false,
      };

      store().addMessage(msg);
      expect(rt().messages).toHaveLength(1);
      expect(rt().messages[0].content).toBe("test");
    });
  });

  describe("appendToLastMessage", () => {
    it("appends chunk to last message content", () => {
      store().addMessage({
        id: "m1",
        role: "assistant",
        content: "Hello",
        createdAt: "",
        executionId: null,
        isStreaming: true,
      });

      store().appendToLastMessage(" world");
      expect(rt().messages[0].content).toBe("Hello world");
    });

    it("does nothing when no messages", () => {
      store().appendToLastMessage("chunk");
      expect(rt().messages).toEqual([]);
    });
  });

  describe("attachErrorToLastMessage", () => {
    it("attaches a structured error to the last assistant message", () => {
      store().createAssistantMessage();
      store().appendToLastMessage("partial answer");

      store().attachErrorToLastMessage({
        code: "LLM_INSUFFICIENT_BALANCE",
        message: "DeepSeek 账户余额不足，请前往 DeepSeek 开放平台充值后重试。",
      });

      const last = rt().messages[0];
      expect(last.content).toBe("partial answer");
      expect(last.error?.code).toBe("LLM_INSUFFICIENT_BALANCE");
      expect(last.error?.message).toContain("余额不足");
    });

    it("does nothing when there is no assistant message", () => {
      store().attachErrorToLastMessage({ code: "X", message: "boom" });
      expect(rt().messages).toEqual([]);
    });
  });

  describe("createAssistantMessage", () => {
    it("creates an empty streaming assistant message", () => {
      const id = store().createAssistantMessage();

      expect(rt().messages).toHaveLength(1);
      expect(rt().messages[0].id).toBe(id);
      expect(rt().messages[0].role).toBe("assistant");
      expect(rt().messages[0].content).toBe("");
      expect(rt().messages[0].isStreaming).toBe(true);
      expect(rt().isGenerating).toBe(true);
    });
  });

  describe("finalizeLastMessage", () => {
    it("marks last message as non-streaming and clears isGenerating", () => {
      store().createAssistantMessage();
      store().appendToLastMessage("done");

      store().finalizeLastMessage();

      expect(rt().messages[0].isStreaming).toBe(false);
      expect(rt().isGenerating).toBe(false);
    });
  });

  describe("dropConversationRuntime", () => {
    const userMsg = {
      id: "m1",
      role: "user" as const,
      content: "hi",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    };

    it("forgets a conversation's runtime slice", () => {
      store().switchConversation("a");
      store().addMessage(userMsg);
      store().dropConversationRuntime("a");
      expect(store().byId.a).toBeUndefined();
    });

    it("clears currentConversationId when the dropped one was open", () => {
      store().switchConversation("a");
      store().dropConversationRuntime("a");
      expect(store().currentConversationId).toBeNull();
    });

    it("keeps current when a different conversation is dropped", () => {
      store().switchConversation("a");
      store().dropConversationRuntime("b");
      expect(store().currentConversationId).toBe("a");
    });
  });

  // Cursor-window state for the latest-window + infinite-scroll + load-around
  // model (载入模型 B): the window mutators that the message service drives.
  describe("cursor-window (load-around B)", () => {
    const mk = (id: string) => ({
      id,
      role: "user" as const,
      content: id,
      createdAt: id,
      executionId: null,
      isStreaming: false,
    });

    it("setMessageWindow replaces messages and sets both edge flags", () => {
      store().switchConversation("a");
      store().setMessageWindow(
        [mk("m2"), mk("m3")],
        { hasMoreBefore: true, hasMoreAfter: true },
        "a",
      );
      expect(rt().messages.map((m) => m.id)).toEqual(["m2", "m3"]);
      expect(rt().hasMoreBefore).toBe(true);
      expect(rt().hasMoreAfter).toBe(true);
    });

    it("prependMessages adds older messages and updates hasMoreBefore", () => {
      store().switchConversation("a");
      store().setMessageWindow(
        [mk("m3")],
        { hasMoreBefore: true, hasMoreAfter: false },
        "a",
      );
      store().prependMessages([mk("m1"), mk("m2")], false, "a");
      expect(rt().messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(rt().hasMoreBefore).toBe(false);
    });

    it("prependMessages dedupes ids already in the window", () => {
      store().switchConversation("a");
      store().setMessageWindow(
        [mk("m2"), mk("m3")],
        { hasMoreBefore: true, hasMoreAfter: false },
        "a",
      );
      store().prependMessages([mk("m1"), mk("m2")], false, "a");
      expect(rt().messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    });

    it("appendNewerMessages adds newer history and updates hasMoreAfter", () => {
      store().switchConversation("a");
      store().setMessageWindow(
        [mk("m1")],
        { hasMoreBefore: false, hasMoreAfter: true },
        "a",
      );
      store().appendNewerMessages([mk("m2"), mk("m3")], false, "a");
      expect(rt().messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
      expect(rt().hasMoreAfter).toBe(false);
    });

    it("truncateAfter clears a stale hasMoreAfter (fork from history)", () => {
      store().switchConversation("a");
      store().setMessageWindow(
        [mk("m1"), mk("m2")],
        { hasMoreBefore: false, hasMoreAfter: true },
        "a",
      );
      store().truncateAfter("m1", "a");
      expect(rt().messages.map((m) => m.id)).toEqual(["m1"]);
      expect(rt().hasMoreAfter).toBe(false);
    });

    it("tracks per-direction loading flags", () => {
      store().switchConversation("a");
      store().setLoadingOlder(true, "a");
      store().setLoadingNewer(true, "a");
      expect(rt().loadingOlder).toBe(true);
      expect(rt().loadingNewer).toBe(true);
      store().setLoadingOlder(false, "a");
      expect(rt().loadingOlder).toBe(false);
      expect(rt().loadingNewer).toBe(true);
    });

    it("records and clears a pending cross-conversation focus", () => {
      store().requestMessageFocus("conv-x", "msg-y");
      expect(store().pendingFocus).toEqual({
        conversationId: "conv-x",
        messageId: "msg-y",
      });
      store().clearPendingFocus();
      expect(store().pendingFocus).toBeNull();
    });
  });
});

// 结构化挂起 2a (7.1): a plan_review card lives on the assistant message it paused —
// set live (addPlanReview/settlePlanReview) and rebuilt from the journal on reload
// (planReviewsFromEvents), exactly like an ask_user checkpoint.
describe("plan_review cards (结构化挂起 2a)", () => {
  const reqPayload = (
    id: string,
    runIds: string[],
  ): PlanReviewRequiredPayload => ({
    checkpoint_id: id,
    conversation_id: "a",
    steps: runIds.map((r) => ({
      run_id: r,
      role: `角色 ${r}`,
      summary: "产出",
    })),
    pending: [{ run_id: "next", role: "下游" }],
  });
  const reqEvent = (id: string, runIds: string[]): SSEEvent => ({
    type: "plan_review_required",
    timestamp: "",
    payload: reqPayload(id, runIds),
  });
  const resEvent = (
    id: string,
    decision: "continue" | "stop",
    note = "",
  ): SSEEvent => ({
    type: "plan_review_resolved",
    timestamp: "",
    payload: { checkpoint_id: id, decision, note },
  });

  describe("planReviewsFromEvents (history replay)", () => {
    it("folds a required→resolved pair into one resolved card", () => {
      const cards = planReviewsFromEvents([
        reqEvent("c1", ["run-1"]),
        resEvent("c1", "continue", "放行"),
      ]);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        id: "c1",
        status: "resolved",
        decision: "continue",
        note: "放行",
      });
      expect(cards[0].steps.map((s) => s.run_id)).toEqual(["run-1"]);
      expect(cards[0].pending.map((p) => p.run_id)).toEqual(["next"]);
    });

    it("keeps an unresolved required as a pending card", () => {
      const cards = planReviewsFromEvents([reqEvent("c1", ["run-1"])]);
      expect(cards[0]).toMatchObject({ status: "pending", decision: null });
    });

    it("preserves raise order across multiple checkpoints", () => {
      const cards = planReviewsFromEvents([
        reqEvent("c1", ["run-1"]),
        reqEvent("c2", ["run-2"]),
        resEvent("c1", "stop"),
      ]);
      expect(cards.map((c) => c.id)).toEqual(["c1", "c2"]);
      expect(cards[0].status).toBe("resolved");
      expect(cards[1].status).toBe("pending");
    });
  });

  describe("addPlanReview / settlePlanReview (live)", () => {
    it("attaches a pending card to the live assistant message", () => {
      store().switchConversation("a");
      store().createAssistantMessage();
      store().addPlanReview(reqPayload("c1", ["run-1"]), "a");
      expect(rt().messages[0].planReviews?.[0]).toMatchObject({
        id: "c1",
        status: "pending",
      });
    });

    it("dedupes a re-delivered required event", () => {
      store().switchConversation("a");
      store().createAssistantMessage();
      store().addPlanReview(reqPayload("c1", ["run-1"]), "a");
      store().addPlanReview(reqPayload("c1", ["run-1"]), "a");
      expect(rt().messages[0].planReviews).toHaveLength(1);
    });

    it("is a no-op when there is no assistant message yet", () => {
      store().switchConversation("a");
      store().addPlanReview(reqPayload("c1", ["run-1"]), "a");
      expect(rt().messages).toHaveLength(0);
    });

    it("settlePlanReview flips the card to resolved", () => {
      store().switchConversation("a");
      store().createAssistantMessage();
      store().addPlanReview(reqPayload("c1", ["run-1"]), "a");
      store().settlePlanReview("c1", "stop", "就此打住", "a");
      expect(rt().messages[0].planReviews?.[0]).toMatchObject({
        status: "resolved",
        decision: "stop",
        note: "就此打住",
      });
    });

    it("settlePlanReview records an adjust decision + its steer note", () => {
      store().switchConversation("a");
      store().createAssistantMessage();
      store().addPlanReview(reqPayload("c1", ["run-1"]), "a");
      store().settlePlanReview("c1", "adjust", "把重点放在风险上", "a");
      expect(rt().messages[0].planReviews?.[0]).toMatchObject({
        status: "resolved",
        decision: "adjust",
        note: "把重点放在风险上",
      });
    });
  });
});
