import { logEvent } from "@/lib/log";
import { fulfillClientToolOnce } from "@/services/clientToolFulfill";
import { resolveConversationLocalTarget } from "@/services/sidecarRouting";
import { useWorkspaceChannelStore } from "@/stores/workspaceChannel";
import type { WorkspaceOpRequiredPayload } from "@/types/events";
import type { WorkspaceOpName, WorkspaceOpResult } from "@shared/ipc-contract";

/** 后台进程 op：通道注入 conversation_id（公开工具 schema 不含此字段）。 */
const PROCESS_OPS = new Set<string>([
  "process_start",
  "process_read",
  "process_stop",
  "process_list",
]);

/** Language advertise / U1 git chip — hang must not raise the file-channel banner (A1/A2). */
const NON_FILE_CHANNEL_OPS = new Set<string>([
  "probe_exec",
  "git_repo_status",
  "git_scm",
  "git_run",
]);

/** 渲染层 IPC 在飞（leave-once：abort 返回后即卸，底层 hung 不再永久占计数）。 */
let ipcInflightTotal = 0;
const ipcInflightByCid = new Map<string, number>();

function ipcInflightSnapshot(conversationId: string): {
  inflight_total: number;
  inflight_cid: number;
  queue_depth: number;
} {
  return {
    inflight_total: ipcInflightTotal,
    inflight_cid: ipcInflightByCid.get(conversationId) ?? 0,
    queue_depth: Math.max(0, ipcInflightTotal - 1),
  };
}

function enterIpcInflight(conversationId: string): {
  inflight_total: number;
  inflight_cid: number;
  queue_depth: number;
} {
  const queueDepth = ipcInflightTotal;
  ipcInflightTotal += 1;
  ipcInflightByCid.set(
    conversationId,
    (ipcInflightByCid.get(conversationId) ?? 0) + 1,
  );
  return {
    inflight_total: ipcInflightTotal,
    inflight_cid: ipcInflightByCid.get(conversationId) ?? 0,
    queue_depth: queueDepth,
  };
}

function leaveIpcInflight(conversationId: string): void {
  ipcInflightTotal = Math.max(0, ipcInflightTotal - 1);
  const n = (ipcInflightByCid.get(conversationId) ?? 1) - 1;
  if (n <= 0) ipcInflightByCid.delete(conversationId);
  else ipcInflightByCid.set(conversationId, n);
}

/** Test-only: reset renderer IPC inflight counters. */
export function resetWorkspaceOpIpcInflightForTests(): void {
  ipcInflightTotal = 0;
  ipcInflightByCid.clear();
}

/**
 * Desktop half of the local-workspace op channel (双模式工作区 P2a).
 *
 * When the server-side `LocalWorkspace` needs to touch the user's disk it streams
 * a `workspace_op_required` event; this runs the op against the bound FS root (via
 * the main process) and settles the paused op over the unified interaction bridge
 * (kind `client_tool`), so the live SSE turn resumes. The result envelope matches
 * `ResolveClientToolInteraction` (sans `kind`), so it is posted with `kind` added.
 *
 * Failure policy: the channel must always answer (or the server-side op only ends
 * on its timeout). A stale request (404) is a no-op; any other POST failure is
 * logged and left to the server timeout. A non-desktop runtime (no `fsApi`) or a
 * thrown IPC error becomes a typed error envelope, so the tool reports a clean
 * failure instead of the turn hanging.
 *
 * ``timeout_ms`` (optional, from server channel): AbortSignal budget matching the
 * outer tool liveness deadline. On abort we skip settle when possible; a late
 * POST after the server discarded the Future is already a stale 404 no-op.
 * Abort 返回后 leave-once 卸 IPC inflight（底层 hung promise 不再永久占计数）。
 *
 * Same ``request_id`` is de-duplicated in-process so attach rehang does not
 * re-run write / execute side effects.
 */
export async function performWorkspaceOp(
  payload: WorkspaceOpRequiredPayload,
  conversationId: string,
): Promise<void> {
  await fulfillClientToolOnce({
    requestId: payload.request_id,
    conversationId,
    logLabel: "workspaceOps",
    perform: () => runLocalOp(payload, conversationId),
  });
}

/**
 * turnPhase gate 挡掉 `workspace_op_required` 时立刻走现有 fulfill 失败信封 settle，
 * 避免静默 drop 导致服务端 TimeoutError 冲 sticky channel-dead。
 * 不跑 IPC / 不假装 ok。
 */
export async function rejectWorkspaceOpForTurnPhase(
  payload: WorkspaceOpRequiredPayload,
  conversationId: string,
  turnPhase: string,
): Promise<void> {
  await fulfillClientToolOnce({
    requestId: payload.request_id,
    conversationId,
    logLabel: "workspaceOps",
    perform: async () =>
      ioError(`回合 phase=${turnPhase}，工作区 op 未执行（turn_phase_gate）`),
  });
}

async function runLocalOp(
  payload: WorkspaceOpRequiredPayload,
  conversationId: string,
): Promise<WorkspaceOpResult> {
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  if (!fsApi?.workspaceOp) {
    return ioError("本地工作区不可用（非桌面环境）");
  }
  let rootId = payload.root_id;
  let args = payload.args;
  if (PROCESS_OPS.has(payload.op)) {
    args = {
      ...payload.args,
      conversation_id: payload.conversation_id || conversationId,
    };
    // 进程 op 直发通道、绕过 LocalWorkspace 的 subpath 前缀（工具不感知 scratch），
    // 且 sidecar 通道不知道桌面根注册表（root_id 恒空）。按会话绑定统一补齐：
    // 仅空 root_id 才回退绑定容器根（与 sidecar respond 寻址同构）；process_start
    // 的 cwd 仅在落在会话绑定根时前缀 scratch（绑定无 subpath 时为无操作）。
    // 异桌：payload 已带 worker 目标 root_id → 不得回退会话根，也不得用会话
    // subpath 盖住 cwd（多 local C0 · 桶 F）。read / stop / list 按 process_id /
    // conversation_id 寻址，root 存在即可。
    if (!rootId) {
      const target = await resolveConversationLocalTarget(conversationId);
      if (!target) {
        return ioError("会话未绑定本地工作区，无法执行后台进程操作");
      }
      rootId = target.rootId;
      if (payload.op === "process_start" && target.subpath) {
        const cwd = String(args.cwd ?? "").trim();
        args.cwd =
          cwd && cwd !== "." ? `${target.subpath}/${cwd}` : target.subpath;
      }
    } else if (payload.op === "process_start") {
      const target = await resolveConversationLocalTarget(conversationId);
      if (target?.subpath && target.rootId === rootId) {
        const cwd = String(args.cwd ?? "").trim();
        args.cwd =
          cwd && cwd !== "." ? `${target.subpath}/${cwd}` : target.subpath;
      }
    }
  }
  const timeoutMs =
    typeof payload.timeout_ms === "number" && payload.timeout_ms > 0
      ? payload.timeout_ms
      : undefined;
  const ac = timeoutMs != null ? new AbortController() : null;
  const timer =
    ac && timeoutMs != null ? setTimeout(() => ac.abort(), timeoutMs) : null;
  const t0 = Date.now();
  const enter = enterIpcInflight(conversationId);
  const corr = {
    conversation_id: conversationId,
    request_id: payload.request_id,
    op: payload.op,
  };
  logEvent("debug", "workspace_op.ipc_begin", {
    ...corr,
    root_id: rootId,
    timeout_ms: timeoutMs ?? null,
    ...enter,
  });
  const correlation = {
    conversationId,
    requestId: payload.request_id,
  };
  // leave-once：abort/超时先返回时立刻卸 inflight，避免永不 settle 的 IPC 永久占计数。
  let left = false;
  const leaveOnce = (): void => {
    if (left) return;
    left = true;
    leaveIpcInflight(conversationId);
  };
  const opPromise = (
    timeoutMs != null
      ? fsApi.workspaceOp(
          rootId,
          payload.op as WorkspaceOpName,
          args,
          timeoutMs,
          correlation,
        )
      : fsApi.workspaceOp(
          rootId,
          payload.op as WorkspaceOpName,
          args,
          undefined,
          correlation,
        )
  ).finally(leaveOnce);
  try {
    const result = !ac
      ? await opPromise
      : await Promise.race([
          opPromise,
          new Promise<WorkspaceOpResult>((_, reject) => {
            if (ac.signal.aborted) {
              reject(new DOMException("workspace op aborted", "AbortError"));
              return;
            }
            ac.signal.addEventListener(
              "abort",
              () =>
                reject(new DOMException("workspace op aborted", "AbortError")),
              { once: true },
            );
          }),
        ]);
    const endLevel = result.ok ? "debug" : "warn";
    logEvent(endLevel, "workspace_op.ipc_end", {
      ...corr,
      ok: result.ok,
      duration_ms: Date.now() - t0,
      error_kind: result.ok ? null : result.error?.kind,
      // L3：失败 detail 通常是路径/原因短串（非文件正文）
      error_detail: result.ok
        ? null
        : typeof result.error?.detail === "string"
          ? result.error.detail.slice(0, 200)
          : null,
      ...ipcInflightSnapshot(conversationId),
    });
    return result;
  } catch (e) {
    if (
      (e instanceof DOMException && e.name === "AbortError") ||
      (e instanceof Error && e.name === "AbortError")
    ) {
      logEvent("warn", "workspace_op.aborted", {
        ...corr,
        duration_ms: Date.now() - t0,
        timeout_ms: timeoutMs ?? null,
        ...ipcInflightSnapshot(conversationId),
      });
      // abort 日志快照仍含本 op；随后 leave，避免僵尸占无界计数。
      leaveOnce();
      if (!NON_FILE_CHANNEL_OPS.has(payload.op)) {
        useWorkspaceChannelStore.getState().markNotReady();
      }
      return ioError("本地工作区 op 活性挂起（已按服务端 deadline abort）");
    }
    logEvent("error", "workspace_op.ipc_end", {
      ...corr,
      ok: false,
      duration_ms: Date.now() - t0,
      error_kind: "throw",
      ...ipcInflightSnapshot(conversationId),
    });
    return ioError(e instanceof Error ? e.message : String(e));
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

function ioError(detail: string): WorkspaceOpResult {
  return { ok: false, error: { kind: "WorkspaceIOError", detail } };
}
