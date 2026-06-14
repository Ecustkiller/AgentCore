import { ApiError, api } from "@/services/api";
import type { WorkspaceOpRequiredPayload } from "@/types/events";
import type { WorkspaceOpName, WorkspaceOpResult } from "@shared/ipc-contract";

/**
 * Desktop half of the local-workspace op channel (双模式工作区 P2a).
 *
 * When the server-side `LocalWorkspace` needs to touch the user's disk it streams
 * a `workspace_op_required` event; this runs the op against the bound FS root (via
 * the main process) and POSTs the structured result to the ops resolve endpoint,
 * so the paused op in the live SSE turn resumes. The result envelope is shaped to
 * match the backend `ResolveWorkspaceOpRequest` exactly, so it is posted verbatim.
 *
 * Failure policy: the channel must always answer (or the server-side op only ends
 * on its timeout). A stale request (404) is a no-op; any other POST failure is
 * logged and left to the server timeout. A non-desktop runtime (no `fsApi`) or a
 * thrown IPC error becomes a typed error envelope, so the tool reports a clean
 * failure instead of the turn hanging.
 */
export async function performWorkspaceOp(
  payload: WorkspaceOpRequiredPayload,
  conversationId: string,
): Promise<void> {
  const result = await runLocalOp(payload);
  try {
    await api.post(
      `/v1/conversations/${conversationId}/workspace/ops/${payload.request_id}`,
      result,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return; // stale — no-op
    console.error("[workspaceOps] 回填失败", err);
  }
}

async function runLocalOp(
  payload: WorkspaceOpRequiredPayload,
): Promise<WorkspaceOpResult> {
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (!fsApi?.workspaceOp) {
    return ioError("本地工作区不可用（非桌面环境）");
  }
  try {
    return await fsApi.workspaceOp(
      payload.root_id,
      payload.op as WorkspaceOpName,
      payload.args,
    );
  } catch (e) {
    return ioError(e instanceof Error ? e.message : String(e));
  }
}

function ioError(detail: string): WorkspaceOpResult {
  return { ok: false, error: { kind: "WorkspaceIOError", detail } };
}
