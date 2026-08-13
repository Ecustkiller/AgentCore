// @vitest-environment jsdom
/**
 * Attach 增量重放段 → 帧级替换（`replace`）。
 *
 * 重放不再整回合全量：客户端没看过的那部分单独成段（**不带** ``full_replay``，不清不重折，
 * 直接往后接）。但增量段里有几类帧天生携带「全文」而非「增量」——还没说完的那一步会带整步
 * 文字——按追加处理就会看到重复。带 ``replace`` 的帧说的是：本帧是这条通道**末尾那个尚未
 * 闭合的块**的完整内容，换掉它。
 *
 * 这里从真实入口 `dispatchSSEEvent` 灌一段增量，钉住整条管线（handler → rAF 合批 → store
 * fold）：开放块被整个换掉、已闭合的步骤一个不动、气泡标量与过程时间线一致。
 */
import { flushPendingContent } from "@/services/sse/contentBuffer";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import {
  beginTurnPreflight,
  enterTurnStreaming,
} from "@/stores/conversation/turnPhaseActions";
import { useExecutionStore } from "@/stores/execution";
import type { SSEEvent } from "@/types/events";
import { beforeEach, describe, expect, it } from "vitest";

const CID = "conv-attach-replace";
const LIVE_MID = "srv-turn-live";

function ev(type: string, payload: Record<string, unknown>): SSEEvent {
  return { type, timestamp: "", payload } as SSEEvent;
}

/** 直播段：客户端已看过的部分（正文 → 思考 → 又开了一段还没说完的正文）。 */
function foldLiveSoFar(): void {
  beginTurnPreflight(CID);
  enterTurnStreaming(CID);
  for (const e of [
    ev("message_start", { message_id: LIVE_MID, conversation_id: CID }),
    ev("content_delta", { delta: "第一段结论。" }),
    ev("reasoning_delta", { delta: "再核一下" }),
    ev("content_delta", { delta: "半句还没" }),
  ]) {
    dispatchSSEEvent(e, { conversationId: CID, source: "server" });
  }
  flushPendingContent(CID);
}

/** 增量重放段：无 ``full_replay``（不清空），只补客户端没看过的部分。 */
function foldIncrement(events: SSEEvent[]): void {
  for (const e of events) {
    dispatchSSEEvent(e, {
      conversationId: CID,
      source: "server",
      replay: true,
    });
  }
  flushPendingContent(CID);
}

function lastAssistant() {
  return getRuntime(CID)
    .messages.filter((m) => m.role === "assistant")
    .at(-1);
}

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
  const conv = useConversationStore.getState();
  conv.switchConversation(CID);
  conv.addMessage({
    id: "u1",
    role: "user",
    content: "这一轮",
    createdAt: "",
    executionId: null,
    isStreaming: false,
  });
});

describe("attach 增量重放 · 帧级替换", () => {
  it("带 replace 的正文帧换掉开放块，已闭合的步骤一个不动", () => {
    foldLiveSoFar();
    foldIncrement([
      ev("content_delta", {
        delta: "半句还没说完，这是整步全文。",
        replace: true,
      }),
      ev("content_delta", { delta: "再补一句。" }),
    ]);

    const msg = lastAssistant();
    expect(msg?.content).toBe(
      "第一段结论。半句还没说完，这是整步全文。再补一句。",
    );
    expect(msg?.process).toEqual([
      { kind: "content", text: "第一段结论。" },
      { kind: "reasoning", text: "再核一下" },
      { kind: "content", text: "半句还没说完，这是整步全文。再补一句。" },
    ]);
  });

  it("带 replace 的思考帧只换思考通道的开放块", () => {
    foldLiveSoFar();
    foldIncrement([
      ev("reasoning_delta", { delta: "又想到一点", replace: true }),
    ]);

    const msg = lastAssistant();
    // 思考的开放块早被正文切开了 → 没有可换的块，开新块（不吞掉前面那段思考）。
    expect(msg?.reasoning).toBe("再核一下又想到一点");
    expect(msg?.content).toBe("第一段结论。半句还没");
    expect(msg?.process).toEqual([
      { kind: "content", text: "第一段结论。" },
      { kind: "reasoning", text: "再核一下" },
      { kind: "content", text: "半句还没" },
      { kind: "reasoning", text: "又想到一点" },
    ]);
  });
});
