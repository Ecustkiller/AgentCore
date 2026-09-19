import {
  aiAttentionEntriesExcept,
  applyAiAttention,
  applyAiAttentionSnapshot,
  useAiAttentionStore,
} from "@/stores/aiAttention";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  useAiAttentionStore.setState({
    entries: [],
    resolvedSeq: 0,
    lastResolvedId: null,
  });
});

describe("aiAttention snapshot / banner filter", () => {
  it("空快照灭假灯；缺 entries 不清表", () => {
    useAiAttentionStore.setState({
      entries: [
        {
          interactionId: "stale",
          conversationId: "c1",
          turnId: "t",
          kind: "approval",
          title: "假灯",
        },
      ],
    });
    applyAiAttentionSnapshot({ entries: [] });
    expect(useAiAttentionStore.getState().entries).toEqual([]);

    applyAiAttention({
      type: "ai_attention",
      state: "required",
      conversation_id: "c1",
      turn_id: "t",
      interaction_id: "keep",
      kind: "approval",
      title: "真灯",
    });
    applyAiAttentionSnapshot(null);
    applyAiAttentionSnapshot({ entries: "nope" });
    expect(useAiAttentionStore.getState().entries).toHaveLength(1);
  });

  it("banner 可按当前页过滤，不必清 store", () => {
    applyAiAttention({
      type: "ai_attention",
      state: "required",
      conversation_id: "here",
      turn_id: "t",
      interaction_id: "a",
      kind: "approval",
      title: "当前页",
    });
    applyAiAttention({
      type: "ai_attention",
      state: "required",
      conversation_id: "away",
      turn_id: "t",
      interaction_id: "b",
      kind: "ask_user",
      title: "别的页",
    });
    expect(
      aiAttentionEntriesExcept("here").map((e) => e.conversationId),
    ).toEqual(["away"]);
    expect(useAiAttentionStore.getState().entries).toHaveLength(2);
  });

  it("空快照灭灯但不记 resolved（重连 ≠ 结案）", () => {
    applyAiAttention({
      type: "ai_attention",
      state: "required",
      conversation_id: "c1",
      turn_id: "t",
      interaction_id: "keep",
      kind: "ask_user",
      title: "真灯",
    });
    const seq = useAiAttentionStore.getState().resolvedSeq;
    applyAiAttentionSnapshot({ entries: [] });
    expect(useAiAttentionStore.getState().entries).toEqual([]);
    expect(useAiAttentionStore.getState().resolvedSeq).toBe(seq);

    applyAiAttention({
      type: "ai_attention",
      state: "required",
      conversation_id: "c1",
      turn_id: "t",
      interaction_id: "keep",
      kind: "ask_user",
      title: "真灯",
    });
    applyAiAttention({
      type: "ai_attention",
      state: "resolved",
      conversation_id: "c1",
      turn_id: "t",
      interaction_id: "keep",
      kind: "ask_user",
      title: "真灯",
    });
    expect(useAiAttentionStore.getState().resolvedSeq).toBe(seq + 1);
    expect(useAiAttentionStore.getState().lastResolvedId).toBe("keep");
  });
});
