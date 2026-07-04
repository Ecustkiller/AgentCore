import { api } from "@/services/api";
import { getActiveSidecarTarget } from "@/services/sidecarRouting";

export interface SubmitRunRedirectParams {
  executionId: string;
  runId: string;
  feedback: string;
}

/**
 * Queue a mid-flight redirect for one worker (中间可见性 Phase 2a).
 *
 * Local turns route to the sidecar process (the cloud HTTP POST cannot reach the
 * in-process queue). Step 2 will drain this queue to cancel + re-run the worker.
 */
export async function submitRunRedirect(
  conversationId: string,
  params: SubmitRunRedirectParams,
): Promise<void> {
  const sidecarTarget = getActiveSidecarTarget(conversationId);
  if (sidecarTarget) {
    await window.sidecarApi.runRedirect({
      rootId: sidecarTarget.rootId,
      subpath: sidecarTarget.subpath,
      conversationId,
      executionId: params.executionId,
      runId: params.runId,
      feedback: params.feedback,
    });
    return;
  }
  await api.post(`/v1/conversations/${conversationId}/run-redirect`, {
    execution_id: params.executionId,
    run_id: params.runId,
    feedback: params.feedback,
  });
}
