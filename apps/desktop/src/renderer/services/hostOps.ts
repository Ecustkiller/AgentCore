import { fulfillClientToolOnce } from "@/services/clientToolFulfill";
import type { HostOpRequiredPayload } from "@/types/events";
import type { HostOpResult } from "@shared/host-contract";

/**
 * Desktop half of the Host ClientTool channel.
 *
 * After the server suspends and streams ``host_op_required``, we run the op in
 * the main process and settle over the unified interaction bridge
 * (kind ``client_tool``). Same ``request_id`` is de-duplicated in-process so
 * attach rehang does not re-run host side effects (e.g. shell).
 */
export async function performHostOp(
  payload: HostOpRequiredPayload,
  conversationId: string,
): Promise<void> {
  await fulfillClientToolOnce({
    requestId: payload.request_id,
    conversationId,
    logLabel: "hostOps",
    perform: () => runHostOp(payload),
  });
}

/**
 * turnPhase gate 挡掉 `host_op_required` 时立刻走现有 fulfill 失败信封 settle，
 * 避免静默 drop 导致服务端 TimeoutError 冲 sticky channel-dead。
 * 不跑 IPC / 不假装 ok。对齐 `rejectWorkspaceOpForTurnPhase`。
 */
export async function rejectHostOpForTurnPhase(
  payload: HostOpRequiredPayload,
  conversationId: string,
  turnPhase: string,
): Promise<void> {
  await fulfillClientToolOnce({
    requestId: payload.request_id,
    conversationId,
    logLabel: "hostOps",
    perform: async (): Promise<HostOpResult> => ({
      ok: false,
      error: {
        kind: "HostOpError",
        detail: `回合 phase=${turnPhase}，本机 Host op 未执行（turn_phase_gate）`,
      },
    }),
  });
}

async function runHostOp(
  payload: HostOpRequiredPayload,
): Promise<HostOpResult> {
  const api = typeof window !== "undefined" ? window.hostApi : undefined;
  if (!api?.runOp) {
    return {
      ok: false,
      error: {
        kind: "HostOpError",
        detail: "非桌面环境，无法履行本机 Host 操作",
      },
    };
  }
  try {
    return await api.runOp({
      op: payload.op,
      args: (payload.args ?? {}) as Record<string, unknown>,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "HostOpError",
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }
}
