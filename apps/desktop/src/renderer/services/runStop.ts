import { api } from "@/services/api";
import { getActiveSidecarTarget } from "@/services/sidecarRouting";

export interface SubmitRunStopParams {
  executionId: string;
  /** Omit / null = stop every in-flight & queued worker under this execution. */
  runId?: string | null;
}

/**
 * Queue a mid-flight worker stop (does **not** cancel the turn or CEO).
 *
 * Routing mirrors ``submitRunRedirect``:
 * - **Local (sidecar) turn** → ``sidecarApi.runStop``
 * - **Cloud turn** → ``POST …/run-stop``
 *
 * Fire-and-forget; server responds with how many stop intents are queued.
 */
export async function submitRunStop(
  conversationId: string,
  params: SubmitRunStopParams,
): Promise<{ queued: number }> {
  const sidecarTarget = getActiveSidecarTarget(conversationId);
  if (sidecarTarget) {
    return window.sidecarApi.runStop({
      rootId: sidecarTarget.rootId,
      subpath: sidecarTarget.subpath,
      conversationId,
      executionId: params.executionId,
      runId: params.runId ?? null,
    });
  }
  return api.post<{ queued: number }>(
    `/v1/conversations/${conversationId}/run-stop`,
    {
      execution_id: params.executionId,
      run_id: params.runId ?? null,
    },
  );
}
