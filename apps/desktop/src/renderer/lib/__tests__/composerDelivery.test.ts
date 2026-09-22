import {
  isCoordinationActive,
  isLiveCoordinatingTurn,
  resolveDefaultDelivery,
  resolveOccupiedShortcutDelivery,
} from "@/lib/composerDelivery";
import { useConversationStore } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { beforeEach, describe, expect, it } from "vitest";

const CID = "conv-delivery";

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useExecutionStore.setState({ byId: {} });
  useConversationStore.getState().switchConversation(CID);
});

describe("composerDelivery", () => {
  it("空闲 → steer", () => {
    expect(resolveDefaultDelivery(false, CID)).toBe("steer");
  });

  it("经典 in-flight（无 plan）→ queue", () => {
    useConversationStore.getState().createAssistantMessage(CID);
    expect(isCoordinationActive(CID)).toBe(false);
    expect(resolveDefaultDelivery(true, CID)).toBe("queue");
  });

  it("协调活跃（有 plan）+ 生成中 → queue", () => {
    useConversationStore.getState().createAssistantMessage(CID);
    const messages = useConversationStore.getState().byId[CID]?.messages ?? [];
    const aid = messages[0]?.id;
    expect(aid).toBeTruthy();
    useExecutionStore.setState({
      byId: {
        [aid as string]: {
          plan: {
            executionId: "e1",
            steps: [],
            acts: [{ id: "act-1", title: null }],
          },
          frames: [],
          status: "running",
          debate: null,
          debateRounds: [],
          crossExamEnabled: false,
          debateOpening: null,
          coordinationWait: null,
          deliveryStatus: null,
          userInterjections: [],
        } as never,
      },
    });
    expect(isCoordinationActive(CID)).toBe(true);
    expect(isLiveCoordinatingTurn(CID)).toBe(true);
    expect(resolveDefaultDelivery(true, CID)).toBe("queue");
  });

  it("灯灭但协作图还在转 → 仍是这桌（非空闲）", () => {
    useConversationStore.getState().createAssistantMessage(CID);
    const messages = useConversationStore.getState().byId[CID]?.messages ?? [];
    const aid = messages[0]?.id;
    expect(aid).toBeTruthy();
    useExecutionStore.getState().startExecution(
      {
        id: "e-live",
        planType: "multi_agent",
        taskSummary: "t",
        agents: [{ id: "a1", role: "r" }],
        runs: [{ id: "r1", agentId: "a1", task: "t", dependsOn: [] }],
      },
      aid as string,
    );
    expect(isLiveCoordinatingTurn(CID)).toBe(true);
    expect(resolveDefaultDelivery(false, CID)).toBe("steer");
    expect(resolveOccupiedShortcutDelivery(CID)).toBe("steer");
  });

  it("经典散文快捷键 → queue；工具步还在跑 → steer", () => {
    useConversationStore.getState().createAssistantMessage(CID);
    expect(resolveOccupiedShortcutDelivery(CID)).toBe("queue");
    const runtime = useConversationStore.getState().byId[CID];
    const message = runtime?.messages[0];
    if (runtime == null || message == null) {
      throw new Error("expected a live assistant message");
    }
    useConversationStore.setState({
      byId: {
        [CID]: {
          ...runtime,
          messages: [
            {
              ...message,
              process: [
                {
                  kind: "tool",
                  id: "t1",
                  tool_name: "read_file",
                  arguments: {},
                  result: null,
                  status: "running",
                },
              ],
            },
          ],
        },
      },
    });
    expect(resolveOccupiedShortcutDelivery(CID)).toBe("steer");
  });
});
