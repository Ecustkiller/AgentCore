import type { Execution } from "@/stores/execution";
import { useRecoveryDismissedStore } from "@/stores/recoveryDismissed";

/** Whether a turn has terminal trouble the boss can 救火 — failed / cancelled /
 * partial failure (completed with ≥1 failed run). Pure projection check. */
export function isTurnRecoverable(
  execution: Execution | null | undefined,
): boolean {
  if (!execution) return false;
  if (execution.status === "failed" || execution.status === "cancelled")
    return true;
  return (
    execution.status === "completed" &&
    execution.runs.some((r) => r.status === "failed")
  );
}

/**
 * Display-facing: recoverable AND not session-dismissed for this assistant
 * projection id. Pass `dismissed` from a zustand subscription when the caller
 * must re-render on ignore; omit to read the current store snapshot.
 */
export function isUndismissedRecoverable(
  messageId: string,
  execution: Execution | null | undefined,
  dismissed?: ReadonlySet<string>,
): boolean {
  if (!isTurnRecoverable(execution)) return false;
  const ignored = dismissed ?? useRecoveryDismissedStore.getState().dismissed;
  return !ignored.has(messageId);
}

/** Reactive: 救火 hint visible for this projection until the boss dismisses it. */
export function useIsUndismissedRecoverable(
  messageId: string | null | undefined,
  execution: Execution | null | undefined,
): boolean {
  const dismissed = useRecoveryDismissedStore((s) =>
    messageId ? s.dismissed.has(messageId) : false,
  );
  return isTurnRecoverable(execution) && !dismissed;
}
