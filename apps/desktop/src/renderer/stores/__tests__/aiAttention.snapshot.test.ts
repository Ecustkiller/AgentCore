import {
  aiAttentionEntriesExcept,
  applyAiAttention,
  applyAiAttentionSnapshot,
  useAiAttentionStore,
} from "@/stores/aiAttention";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  useAiAttentionStore.setState({ entries: [] });
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
});
