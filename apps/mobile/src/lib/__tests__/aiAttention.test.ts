/**
 * `ai_attention` 存储 —— required/resolved 生命周期、重发去重、打开对话即清。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type AiAttentionEvent,
  __resetAiAttentionForTests,
  applyAiAttention,
  clearAiAttentionForConversation,
  getAiAttentionSnapshot,
  subscribeAiAttention,
} from "../aiAttention";

function attention(over: Partial<AiAttentionEvent> = {}): AiAttentionEvent {
  return {
    type: "ai_attention",
    state: "required",
    conversation_id: "conv-1",
    turn_id: "turn-1",
    interaction_id: "ix-1",
    kind: "ask_user",
    title: "要不要继续部署？",
    ...over,
  };
}

afterEach(() => {
  __resetAiAttentionForTests();
});

describe("applyAiAttention", () => {
  it("required 入列，resolved 出列", () => {
    applyAiAttention(attention());
    expect(getAiAttentionSnapshot()).toEqual([
      {
        interactionId: "ix-1",
        conversationId: "conv-1",
        turnId: "turn-1",
        kind: "ask_user",
        title: "要不要继续部署？",
      },
    ]);

    applyAiAttention(attention({ state: "resolved" }));
    expect(getAiAttentionSnapshot()).toEqual([]);
  });

  it("同一 interaction 重发只更新文案，不重复入列也不跳序", () => {
    applyAiAttention(attention({ interaction_id: "ix-1" }));
    applyAiAttention(
      attention({ interaction_id: "ix-2", conversation_id: "conv-2" }),
    );
    applyAiAttention(attention({ interaction_id: "ix-1", title: "改了标题" }));

    const entries = getAiAttentionSnapshot();
    expect(entries.map((e) => e.interactionId)).toEqual(["ix-1", "ix-2"]);
    expect(entries[0].title).toBe("改了标题");
  });

  it("缺 conversation_id / interaction_id 的帧丢弃", () => {
    applyAiAttention(attention({ conversation_id: "" }));
    applyAiAttention(attention({ interaction_id: "" }));
    expect(getAiAttentionSnapshot()).toEqual([]);
  });

  it("未知 state 不改变现状", () => {
    applyAiAttention(attention());
    applyAiAttention(
      attention({ state: "whatever" as AiAttentionEvent["state"] }),
    );
    expect(getAiAttentionSnapshot()).toHaveLength(1);
  });

  it("无变化时不打扰订阅者", () => {
    let notified = 0;
    const unsubscribe = subscribeAiAttention(() => {
      notified += 1;
    });
    // 从没入列过的 interaction 收到 resolved（断线补发 / 多端）。
    applyAiAttention(attention({ state: "resolved" }));
    expect(notified).toBe(0);
    unsubscribe();
  });
});

describe("clearAiAttentionForConversation", () => {
  it("只清该对话，其余保留", () => {
    applyAiAttention(attention({ interaction_id: "ix-1" }));
    applyAiAttention(
      attention({ interaction_id: "ix-2", conversation_id: "conv-2" }),
    );

    clearAiAttentionForConversation("conv-1");
    expect(getAiAttentionSnapshot().map((e) => e.conversationId)).toEqual([
      "conv-2",
    ]);
  });
});
