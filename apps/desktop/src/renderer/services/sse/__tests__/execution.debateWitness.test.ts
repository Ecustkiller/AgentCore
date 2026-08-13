import { handleExecutionEvent } from "@/services/sse/handlers/execution";
import { useConversationStore } from "@/stores/conversation";
import {
  type ExecutionPlan,
  execRuntime,
  useExecutionStore,
} from "@/stores/execution";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * 证人质询行在直播中就该看见，不该等刷新。
 *
 * 这条只能在这里拦：`conformanceFold` 与 journal 重建都自己读了 `witness_exam`，
 * 所以向量与刷新路径恒绿，唯独 live handler 漏传时没有任何门禁会红——而
 * `DebateNarrativeRound.witness_exam` 是可选字段，typecheck 也拦不住。
 */

const CID = "conv-debate-witness";
const MID = "srv-turn-witness";

const plan: ExecutionPlan = {
  id: "exec-debate",
  planType: "multi_agent",
  taskSummary: "要不要自建仓储",
  agents: [
    { id: "a1", role: "正方" },
    { id: "a2", role: "反方" },
  ],
  runs: [
    { id: "r1", agentId: "a1", task: "陈述", dependsOn: [] },
    { id: "r2", agentId: "a2", task: "陈述", dependsOn: [] },
  ],
};

const witness = {
  witness_key: "w-ops",
  lens_run_id: "r1",
  name: "仓储运营主管",
  origin_caption: "由正方传唤",
};

function seedTurn(): void {
  const conv = useConversationStore.getState();
  conv.switchConversation(CID);
  conv.addMessage({
    id: "u1",
    role: "user",
    content: "go",
    createdAt: "",
    executionId: null,
    isStreaming: false,
  });
  conv.createAssistantMessage(CID);
  conv.setServerMessageIdOnLastMessage(MID, CID);
}

const rt = () => execRuntime(useExecutionStore.getState(), MID);

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
  seedTurn();
  useExecutionStore.getState().startExecution(plan, MID);
});

describe("debate_round live path", () => {
  it("carries witness_exam into the slot", () => {
    handleExecutionEvent(
      {
        type: "debate_round",
        timestamp: "",
        payload: {
          round_no: 1,
          focus: "自建 vs 三方",
          summary: "第一轮交锋",
          verdict: null,
          sides: [],
          clashes: [],
          witness_exam: [witness],
        },
      },
      { conversationId: CID, source: "server" },
    );

    expect(rt().debateRounds[0]?.witness_exam).toEqual([witness]);
  });

  it("opens the round with an empty witness_exam instead of leaving it undefined", () => {
    handleExecutionEvent(
      {
        type: "debate_round_started",
        timestamp: "",
        payload: { round_no: 1, focus: "自建 vs 三方" },
      },
      { conversationId: CID, source: "server" },
    );

    expect(rt().debateRounds[0]?.witness_exam).toEqual([]);
  });
});
