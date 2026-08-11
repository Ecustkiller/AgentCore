import { isUndismissedRecoverable } from "@/lib/turnRecoverable";
import { acceptRunOutcome } from "@/services/runRedirect";
import { assistantProjectionId, getRuntime } from "@/stores/conversation";
import {
  execRuntime,
  projectRuntime,
  useExecutionStore,
} from "@/stores/execution";
import { useRecoveryDismissedStore } from "@/stores/recoveryDismissed";

/**
 * Implicit「忽略」when the user starts a new turn: audit `recovery_ignored` +
 * latch a session UI flag so 救火 chips / dock firefighting hide. Keeps the
 * execution projection so the inline collaboration graph stays on screen.
 */
export function dismissRecoverableHints(conversationId: string): void {
  const messages = getRuntime(conversationId).messages;
  const execStore = useExecutionStore.getState();
  const dismissed = useRecoveryDismissedStore.getState();

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const messageId = assistantProjectionId(m);
    const rt = execRuntime(execStore, messageId);
    const execution = projectRuntime(rt);
    // Skip already-latched ids (idempotent) and non-recoverable turns.
    if (!isUndismissedRecoverable(messageId, execution)) continue;

    void acceptRunOutcome(conversationId, {
      messageId,
      runId: messageId,
      reason: "recovery_ignored",
      note: "用户发起新回合，隐式忽略上次救火",
    }).catch(() => {
      /* local UI latch still proceeds */
    });
    dismissed.markDismissed(messageId);
  }
}
