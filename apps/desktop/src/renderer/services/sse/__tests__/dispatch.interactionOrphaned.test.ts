// @vitest-environment jsdom
/**
 * 收尾 orphan 必须穿过 turnPhase 门闩。
 *
 * `interaction_orphaned` 只出自收尾（settlement 预写 / 重启对账），天生落在
 * `message_end` 之后的 terminal 窗。门闩若挡掉它，失效卡就一直显示可点、点必失败，
 * 直到刷新或切会话才变灰。
 *
 * 为什么不能靠 conformance 兜：那套 fold 直接吃事件数组，**没有 turnPhase 门闩**这一层，
 * 同一条 `multi_agent_stage_card_orphaned` 向量在裁判里恒绿。要抓这个只能从
 * `dispatchSSEEvent` 进——门闩就在它里面。
 *
 * 也不能靠 `message_end` 那道热三类兜底：stage_card 是跨回合耐久卡，收口后仍可正常
 * 待办，把它一并灰掉会误杀真实待办；这里要的是「服务端说它死了」这条事实本身。
 */
import { logEvent } from "@/lib/log";
import { dispatchSSEEvent } from "@/services/sse/dispatch";
import {
  beginTurnPreflight,
  enterTurnStreaming,
  useConversationStore,
} from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/log", () => ({
  logEvent: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  api: { post: vi.fn() },
}));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
  notifySuccess: vi.fn(),
}));

const CID = "conv-orphan-gate";
const CARD = "sc_stage_1";
const logEventMock = vi.mocked(logEvent);

function startTurn(): void {
  beginTurnPreflight(CID);
  enterTurnStreaming(CID);
  useConversationStore.getState().createAssistantMessage(CID);
}

function stageCardRequired(): void {
  dispatchSSEEvent(
    {
      type: "stage_card_required",
      payload: {
        stage_card_id: CARD,
        motion: "要不要就这个结论开个辩论",
        form: "debate",
      },
    } as never,
    { conversationId: CID, source: "server" },
  );
}

function orphaned(): void {
  dispatchSSEEvent(
    {
      type: "interaction_orphaned",
      payload: { interaction_id: CARD, kind: "stage_card" },
    } as never,
    { conversationId: CID, source: "server" },
  );
}

function cardStatus(): string | undefined {
  return useInteractionStore.getState().byId.get(CARD)?.status;
}

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: CID, byId: {} });
  useConversationStore.getState().switchConversation(CID);
  useInteractionStore.getState().clear();
  logEventMock.mockReset();
});

describe("dispatchSSEEvent · interaction_orphaned 收尾帧", () => {
  it("message_end 之后到达仍把卡灰掉（terminal 窗不得丢）", () => {
    startTurn();
    stageCardRequired();
    expect(cardStatus()).toBe("pending");

    dispatchSSEEvent(
      {
        type: "message_end",
        payload: { finish_reason: "end_turn" },
      } as never,
      { conversationId: CID, source: "server" },
    );
    // 热三类兜底不覆盖 stage_card——所以这张卡此刻仍是可点的 pending。
    expect(cardStatus()).toBe("pending");
    expect(useConversationStore.getState().byId[CID]?.turnPhase).toBe(
      "completed",
    );

    orphaned();

    expect(cardStatus()).toBe("orphaned");
    expect(logEventMock).not.toHaveBeenCalledWith(
      "warn",
      "sse.event_dropped",
      expect.anything(),
    );
  });

  it("stopping 窗（用户按停、后端仍在收尾）同样放行", () => {
    startTurn();
    stageCardRequired();
    useConversationStore.getState().setTurnPhase("stopping", CID);

    orphaned();

    expect(cardStatus()).toBe("orphaned");
    expect(logEventMock).not.toHaveBeenCalledWith(
      "warn",
      "sse.event_dropped",
      expect.anything(),
    );
  });

  it("放行的只有这一帧：同窗正文突变照旧丢弃", () => {
    startTurn();
    useConversationStore.getState().setTurnPhase("completed", CID);

    dispatchSSEEvent(
      { type: "content_delta", payload: { delta: "迟到正文" } } as never,
      { conversationId: CID, source: "server" },
    );

    expect(logEventMock).toHaveBeenCalledWith(
      "warn",
      "sse.event_dropped",
      expect.objectContaining({
        event_type: "content_delta",
        turn_phase: "completed",
      }),
    );
  });
});
