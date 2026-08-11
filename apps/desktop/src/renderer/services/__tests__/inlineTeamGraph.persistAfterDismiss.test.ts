/**
 * Regression: starting a second turn must not wipe the prior team execution
 * projection — InlineTeamGraph gates on that slot staying populated.
 */
import { teamHasStartedRuns } from "@/components/chat/InlineTeamGraph";
import {
  isTurnRecoverable,
  isUndismissedRecoverable,
} from "@/lib/turnRecoverable";
import { dismissRecoverableHints } from "@/services/turns/dismissRecovery";
import { useConversationStore } from "@/stores/conversation";
import {
  type ExecutionPlan,
  type ExecutionRuntime,
  type RunFrame,
  projectRuntime,
  useExecutionStore,
} from "@/stores/execution";
import { useRecoveryDismissedStore } from "@/stores/recoveryDismissed";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/runRedirect", () => ({
  acceptRunOutcome: vi.fn().mockResolvedValue({ recorded: true }),
}));

const CID = "conv-graph-persist";

const plan: ExecutionPlan = {
  id: "exec-team-1",
  planType: "multi_agent",
  taskSummary: "并行调研",
  agents: [
    { id: "w1", role: "研究员" },
    { id: "w2", role: "撰写员" },
  ],
  runs: [
    { id: "r1", agentId: "w1", task: "调研", dependsOn: [] },
    { id: "r2", agentId: "w2", task: "撰写", dependsOn: ["r1"] },
  ],
};

function started(runId: string, agentId: string, t = 1): RunFrame {
  return {
    t,
    kind: "run_started",
    agentId,
    runId,
    parentRunId: null,
    runKind: "agent",
    continuesRunId: null,
  };
}

function completed(runId: string, agentId: string, t = 2): RunFrame {
  return {
    t,
    kind: "run_completed",
    runId,
    agentId,
    outputSummary: "完成",
    durationMs: 100,
  };
}

function seedAssistant(id: string, executionId: string) {
  const store = useConversationStore.getState();
  store.switchConversation(CID);
  store.addMessage(
    {
      id: "u1",
      role: "user",
      content: "q",
      createdAt: "2026-01-01T00:00:00Z",
      executionId: null,
      isStreaming: false,
    },
    CID,
  );
  store.addMessage(
    {
      id,
      role: "assistant",
      content: "done",
      createdAt: "2026-01-01T00:00:01Z",
      executionId,
      isStreaming: false,
      status: "complete",
    },
    CID,
  );
}

function requireRuntime(messageId: string): ExecutionRuntime {
  const rt = useExecutionStore.getState().byId[messageId];
  expect(rt?.plan).toBeTruthy();
  if (!rt) throw new Error(`missing runtime ${messageId}`);
  return rt;
}

describe("inline team graph survives second-turn dismiss", () => {
  beforeEach(() => {
    useConversationStore.setState({ currentConversationId: null, byId: {} });
    useExecutionStore.setState({ byId: {} });
    useRecoveryDismissedStore.getState().reset();
  });

  it("keeps cancelled team projection after dismiss (Stop → new turn)", () => {
    seedAssistant("a-cancelled", "exec-team-1");
    const exec = useExecutionStore.getState();
    exec.startExecution(plan, "a-cancelled");
    exec.recordFrames(
      [started("r1", "w1"), completed("r1", "w1")],
      "a-cancelled",
    );
    exec.setStatus("cancelled", "a-cancelled");

    const before = projectRuntime(requireRuntime("a-cancelled"));
    expect(before).toBeTruthy();
    expect(isTurnRecoverable(before)).toBe(true);
    expect(before && teamHasStartedRuns(before.runs)).toBe(true);

    dismissRecoverableHints(CID);

    const after = projectRuntime(requireRuntime("a-cancelled"));
    expect(after).toBeTruthy();
    expect(after && teamHasStartedRuns(after.runs)).toBe(true);
    expect(isTurnRecoverable(after)).toBe(true);
    expect(isUndismissedRecoverable("a-cancelled", after)).toBe(false);
  });

  it("keeps clean completed team projection after dismiss no-op", () => {
    seedAssistant("a-ok", "exec-team-1");
    const exec = useExecutionStore.getState();
    exec.startExecution(plan, "a-ok");
    exec.recordFrames(
      [
        started("r1", "w1", 1),
        completed("r1", "w1", 2),
        started("r2", "w2", 3),
        completed("r2", "w2", 4),
      ],
      "a-ok",
    );
    exec.setStatus("completed", "a-ok");

    const before = projectRuntime(requireRuntime("a-ok"));
    expect(isTurnRecoverable(before)).toBe(false);
    expect(before && teamHasStartedRuns(before.runs)).toBe(true);

    dismissRecoverableHints(CID);

    const after = projectRuntime(requireRuntime("a-ok"));
    expect(after && teamHasStartedRuns(after.runs)).toBe(true);
    expect(isUndismissedRecoverable("a-ok", after)).toBe(false);
    expect(useRecoveryDismissedStore.getState().isDismissed("a-ok")).toBe(
      false,
    );
  });
});
