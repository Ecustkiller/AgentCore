import { beforeEach, describe, expect, it, vi } from "vitest";

const acceptRunOutcome = vi.fn().mockResolvedValue({ recorded: true });
const clearExecution = vi.fn();
const markDismissed = vi.fn();
const projectRuntime = vi.fn();

vi.mock("@/services/runRedirect", () => ({
  acceptRunOutcome: (...args: unknown[]) => acceptRunOutcome(...args),
}));

vi.mock("@/stores/conversation", () => ({
  assistantProjectionId: (m: { id: string }) => m.id,
  getRuntime: () => ({
    messages: [
      {
        id: "u1",
        role: "user",
        content: "q",
        createdAt: "",
        executionId: null,
        isStreaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        content: "a",
        createdAt: "",
        executionId: "e1",
        isStreaming: false,
      },
    ],
  }),
}));

vi.mock("@/stores/execution", () => ({
  execRuntime: () => ({ plan: { id: "p1" } }),
  projectRuntime: (...args: unknown[]) => projectRuntime(...args),
  useExecutionStore: {
    getState: () => ({ clearExecution }),
  },
}));

vi.mock("@/stores/recoveryDismissed", () => ({
  useRecoveryDismissedStore: {
    getState: () => ({
      dismissed: new Set<string>(),
      markDismissed,
      isDismissed: () => false,
      reset: () => {},
    }),
  },
}));

describe("dismissRecoverableHints", () => {
  beforeEach(() => {
    acceptRunOutcome.mockClear();
    clearExecution.mockClear();
    markDismissed.mockClear();
    projectRuntime.mockReset();
  });

  it("audits recovery_ignored and latches UI dismiss without clearing projection", async () => {
    projectRuntime.mockReturnValue({
      status: "failed",
      runs: [{ status: "failed" }],
    });
    const { dismissRecoverableHints } = await import(
      "../turns/dismissRecovery"
    );
    dismissRecoverableHints("conv-1");
    expect(acceptRunOutcome).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({
        messageId: "a1",
        reason: "recovery_ignored",
      }),
    );
    expect(markDismissed).toHaveBeenCalledWith("a1");
    expect(clearExecution).not.toHaveBeenCalled();
  });

  it("skips non-recoverable executions", async () => {
    projectRuntime.mockReturnValue({
      status: "completed",
      runs: [{ status: "completed" }],
    });
    const { dismissRecoverableHints } = await import(
      "../turns/dismissRecovery"
    );
    dismissRecoverableHints("conv-1");
    expect(acceptRunOutcome).not.toHaveBeenCalled();
    expect(markDismissed).not.toHaveBeenCalled();
    expect(clearExecution).not.toHaveBeenCalled();
  });
});
