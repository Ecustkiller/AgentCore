import { submitRunStop } from "@/services/runStop";
import { useRunStopPendingStore } from "@/stores/runStopPending";
import { toast } from "sonner";

/** Worker statuses that accept a mid-flight run-stop. */
export function isStoppableRunStatus(status: string): boolean {
  return status === "running" || status === "pending";
}

/**
 * Fire a structured run-stop (never guesses from free text). Marks honest
 * pending state; does **not** flip run status to cancelled locally.
 */
export async function requestRunStop(opts: {
  conversationId: string;
  executionId: string;
  runId?: string | null;
  /** Toast noun: node vs team. */
  scope: "node" | "team";
}): Promise<boolean> {
  const { conversationId, executionId, runId = null, scope } = opts;
  const store = useRunStopPendingStore.getState();
  if (store.isPending(executionId, runId)) return false;

  store.markPending(executionId, runId);
  try {
    await submitRunStop(conversationId, { executionId, runId });
    toast.success(scope === "team" ? "已请求停止任务" : "已请求停止此成员", {
      description:
        scope === "team"
          ? "队员将陆续停下；主 Agent 会留下来继续交代（不会结束整轮对话）。"
          : "引擎将停下这位队员；主 Agent 与对话继续。",
    });
    return true;
  } catch {
    store.clearPending(executionId, runId);
    toast.error("停止请求失败，请稍后重试");
    return false;
  }
}
