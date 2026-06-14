import { resolveCheckpoint } from "@/services/resolveCheckpoint";
import {
  type AgentOverride,
  resolvePlanReview,
} from "@/services/resolvePlanReview";
import { useConversationStore } from "@/stores/conversation";
import { useExecutionStore, useProjectedExecution } from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import { CheckpointCard } from "./CheckpointCard";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";
import { TaskCard } from "./TaskCard";
import { TeamPreviewCard } from "./TeamPreviewCard";

function CheckpointHost({ conversationId }: { conversationId: string | null }) {
  const pending = useExecutionStore((s) => s.pendingCheckpoint);
  if (!pending || !conversationId) return null;

  const handleResolve = (
    action: "approve" | "adjust" | "stop",
    feedback?: string,
  ) => {
    // Optimistically clear so the card dismisses immediately; the backend's
    // approval_resolved echo keeps the execution status in sync.
    useExecutionStore.getState().clearPendingCheckpoint();
    void resolveCheckpoint(
      conversationId,
      pending.checkpointId,
      action,
      feedback,
    ).catch(() => {
      useExecutionStore.getState().setPendingCheckpoint(pending);
    });
  };

  return (
    <CheckpointCard
      checkpointId={pending.checkpointId}
      summary={pending.summary}
      reason={pending.reason}
      actions={pending.actions}
      onResolve={handleResolve}
    />
  );
}

function TeamPreviewHost({
  conversationId,
}: { conversationId: string | null }) {
  const review = useExecutionStore((s) => s.pendingReview);
  const execution = useProjectedExecution();
  const setAgentTier = useExecutionStore((s) => s.setAgentTier);
  const setAgentDeep = useExecutionStore((s) => s.setAgentDeep);
  const openGraph = useUIStore((s) => s.openGraph);
  if (!review || !execution || !conversationId) return null;

  const agents = execution.agents.map((a) => ({
    id: a.id,
    role: a.role,
    modelPreference: a.modelPreference,
    thinking: a.thinking,
    reasoningEffort: a.reasoningEffort,
    stepCount: execution.steps.filter((s) => s.agentId === a.id).length,
  }));

  const resolve = (action: "start" | "cancel") => {
    const overrides: Record<string, AgentOverride> = Object.fromEntries(
      agents.map((a) => [
        a.id,
        {
          model_preference: a.modelPreference,
          thinking: a.thinking,
          reasoning_effort: a.reasoningEffort,
        },
      ]),
    );
    // Optimistically dismiss; the backend's plan_review_resolved echo keeps
    // execution status in sync (or surfaces a retry on failure).
    useExecutionStore.getState().clearPendingReview();
    if (action === "start") useExecutionStore.getState().setStatus("running");
    void resolvePlanReview(
      conversationId,
      review.reviewId,
      action,
      action === "start" ? overrides : undefined,
    ).catch(() => {
      useExecutionStore.getState().setPendingReview(review);
      useExecutionStore.getState().setStatus("paused");
    });
  };

  return (
    <TeamPreviewCard
      agents={agents}
      taskSummary={execution.taskSummary}
      onSetTier={setAgentTier}
      onSetDeep={setAgentDeep}
      onStart={() => resolve("start")}
      onCancel={() => resolve("cancel")}
      onShowGraph={openGraph}
    />
  );
}

export function ChatView() {
  const messages = useConversationStore((s) => s.messages);
  const currentConversationId = useConversationStore(
    (s) => s.currentConversationId,
  );
  const hasMessages = messages.length > 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Scrollable message area (scrollbar at container edge, content centered) */}
      <div className="flex-1 overflow-y-auto">
        {hasMessages ? (
          <div className="mx-auto w-full max-w-4xl space-y-4 px-6 py-4">
            <MessageList />
            <TaskCard />
            <TeamPreviewHost conversationId={currentConversationId} />
            <CheckpointHost conversationId={currentConversationId} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-foreground">
                AgentCore
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Multi-Agent AI 工作台
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                输入消息开始对话
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Bottom input area */}
      <div className="mx-auto w-full max-w-4xl">
        <MessageInput />
      </div>
    </div>
  );
}
