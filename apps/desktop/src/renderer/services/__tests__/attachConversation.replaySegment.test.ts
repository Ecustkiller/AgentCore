// @vitest-environment jsdom
/**
 * 回合级 attach：清屏与否由重放段段首说了算（实时重连续看 · 流式回复持久化 §3.6 · P3）。
 *
 * 服务端认得客户端游标时只补游标之后的事实，段首 ``message_start`` **不带**
 * ``full_replay``——那是一句「你手里那半场是对的，往后接」。客户端若照旧无条件
 * clear-then-fold，这半场只在自己内存里，清掉就永远回不来：掉线重连一次，回合前半段
 * 就永久消失一次。段首带标记时才是整段重放，那时必须先清，否则正文折两遍。
 *
 * 两种段各钉一遍，且两个入口都走真实 SSE 泵（缓冲到 ``: attach-caught-up`` → 一次性折）：
 * `attachConversation` 自己的判断，以及掉线重连真正的调用方 `rejoinLiveTurn`——它从前抢在
 * attach 之前无条件 clear-then-fold，正是前半段消失的成因。
 *
 * ``full_replay`` 原位清空正文/过程/执行槽、保留气泡 id（打开/刷新时换泡会把已画 Markdown
 * 卸掉，正文看起来像又加载一次）。增量段一个字都不许清。
 */
import { flushPendingContent } from "@/services/sse/contentBuffer";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import { attachConversation } from "@/services/streamConversation";
import { rejoinLiveTurn } from "@/services/turns/recovery";
import { resetStreamOwnershipForTests } from "@/services/turns/streamOwnership";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import {
  beginTurnPreflight,
  enterTurnStreaming,
} from "@/stores/conversation/turnPhaseActions";
import type { ExecutionJournal } from "@/stores/execution";
import { useExecutionStore } from "@/stores/execution";
import type { SSEEvent } from "@/types/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CID = "conv-attach-segment";
const TURN_ID = "srv-turn-1";

function frame(type: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, timestamp: "t", payload })}\n\n`;
}

/**
 * 服务端的一段 attach catch-up：段首 + 一帧正文 + 边界注释 + 收口。
 * `fullReplay` = 段首那句「先重置本回合本地态再折本段」。
 */
function stubAttachSegment(fullReplay: boolean, delta: string): void {
  const body = [
    frame("message_start", {
      message_id: TURN_ID,
      ...(fullReplay ? { full_replay: true } : {}),
    }),
    frame("content_delta", { delta }),
    ": attach-caught-up\n\n",
    frame("message_end", { finish_reason: "end_turn" }),
  ].join("");
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    ),
  );
}

/** 一个已在跑的团队回合（重连前客户端手上的执行槽）。 */
const journal: ExecutionJournal = {
  finishReason: "stop",
  events: [
    {
      type: "run_plan",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {
        execution_id: "exec-1",
        plan_type: "multi_agent",
        task_summary: "上半场已经派过单",
        agents: [{ id: "agent-1", role: "研究员" }],
        runs: [
          { id: "run-1", agent_id: "agent-1", task: "查", depends_on: [] },
        ],
      },
    },
  ],
};

/** 掉线之前：客户端已折进去的上半场（正文 + 团队图）。 */
function foldFirstHalf(): void {
  beginTurnPreflight(CID);
  enterTurnStreaming(CID);
  for (const e of [
    { type: "message_start", timestamp: "t", payload: { message_id: TURN_ID } },
    { type: "content_delta", timestamp: "t", payload: { delta: "上半场。" } },
  ] as SSEEvent[]) {
    dispatchSSEEvent(e, { conversationId: CID, source: "server" });
  }
  flushPendingContent(CID);
  // 执行槽随首次盖章归到服务端回合 id 名下（``alignTurnKey``），这里直接按那个键落。
  useExecutionStore.getState().hydrateFromJournal(TURN_ID, journal);
}

function tailAssistant() {
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

afterEach(() => {
  resetStreamOwnershipForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
});

describe("attachConversation · 段首决定清不清", () => {
  it("增量段（段首无 full_replay）：保留手上半场，往后接", async () => {
    foldFirstHalf();
    const before = tailAssistant();
    expect(before?.content).toBe("上半场。");
    expect(useExecutionStore.getState().byId[TURN_ID]?.plan).toBeTruthy();

    stubAttachSegment(false, "下半场。");
    await expect(attachConversation(CID)).resolves.toBe("attached");

    const after = tailAssistant();
    // 上半场没被抹掉——这正是掉线重连后前半段永久消失的那道口子。
    expect(after?.content).toBe("上半场。下半场。");
    expect(after?.id).toBe(before?.id);
    expect(getRuntime(CID).messages).toHaveLength(2);
    // 执行槽同理：增量段不重发派单行，清了团队图就再也画不回来。
    expect(useExecutionStore.getState().byId[TURN_ID]?.plan).toBeTruthy();
  });

  it("整段重放（段首带 full_replay）：原位重置再整段重折，气泡不换、正文不叠", async () => {
    foldFirstHalf();
    const before = tailAssistant();

    stubAttachSegment(true, "整段重放的全文。");
    await expect(attachConversation(CID)).resolves.toBe("attached");

    const after = tailAssistant();
    // 段里带的就是这一轮的全部：正文不得叠成两份；气泡 id 保持，避免换泡重挂 Markdown。
    expect(after?.content).toBe("整段重放的全文。");
    expect(after?.id).toBe(before?.id);
    expect(getRuntime(CID).messages).toHaveLength(2);
    expect(useExecutionStore.getState().byId[TURN_ID]?.plan).toBeFalsy();
  });
});

describe("rejoinLiveTurn · 掉线重连不抢着清屏", () => {
  it("增量段：重连后前半段还在，续看接在后面", async () => {
    foldFirstHalf();
    const before = tailAssistant();

    stubAttachSegment(false, "下半场。");
    await expect(rejoinLiveTurn(CID)).resolves.toBe(true);

    const after = tailAssistant();
    expect(after?.content).toBe("上半场。下半场。");
    expect(after?.id).toBe(before?.id);
    expect(useExecutionStore.getState().byId[TURN_ID]?.plan).toBeTruthy();
  });

  it("整段重放：原位重置后正文不叠两份", async () => {
    foldFirstHalf();
    const before = tailAssistant();

    stubAttachSegment(true, "整段重放的全文。");
    await expect(rejoinLiveTurn(CID)).resolves.toBe(true);

    expect(tailAssistant()?.content).toBe("整段重放的全文。");
    expect(tailAssistant()?.id).toBe(before?.id);
    expect(getRuntime(CID).messages).toHaveLength(2);
  });
});
