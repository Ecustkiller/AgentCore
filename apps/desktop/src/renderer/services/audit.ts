import { ApiError, api } from "@/services/api";
import type {
  AgentAuditEvent,
  AgentAuditListResponse,
} from "@agentcore/contract-rest-types/audit";

export type { AgentAuditEvent, AgentAuditListResponse };

/** 按 run_id 分组计数（无 run_id 的事件跳过）。 */
export function groupAuditCountsByRun(
  events: AgentAuditEvent[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ev of events) {
    const rid = ev.run_id;
    if (!rid) continue;
    counts[rid] = (counts[rid] ?? 0) + 1;
  }
  return counts;
}

export type FetchTurnAuditOptions = {
  includeCausal?: boolean;
};

/** 查询单回合审计事件（owner-scoped）；按 run_id 过滤在调用方客户端完成。 */
export async function fetchTurnAudit(
  conversationId: string,
  messageId: string,
  options?: FetchTurnAuditOptions,
): Promise<AgentAuditListResponse> {
  const query =
    options?.includeCausal === true ? "?include_causal=true" : "";
  return api.get<AgentAuditListResponse>(
    `/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/audit${query}`,
  );
}

/**
 * 按工作区相对路径反查写入链（owner-scoped）。
 * 后端未就绪时 404 → `null`（调用方展示空态，勿当硬错误）。
 */
export async function fetchFileAudit(
  conversationId: string,
  path: string,
): Promise<AgentAuditListResponse | null> {
  try {
    return await api.get<AgentAuditListResponse>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/audit/file?path=${encodeURIComponent(path)}`,
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
