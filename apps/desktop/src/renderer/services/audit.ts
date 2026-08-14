import { ApiError, api } from "@/services/api";
import type {
  AgentAuditEvent,
  AgentAuditListResponse,
} from "@agentcore/contract-rest-types/audit";

export type { AgentAuditEvent, AgentAuditListResponse };

export type FetchTurnAuditOptions = {
  includeCausal?: boolean;
};

export type FetchConversationAuditOptions = {
  limit?: number;
  category?: string;
};

/** 查询单回合审计事件（owner-scoped）；按 run_id 过滤在调用方客户端完成。 */
export async function fetchTurnAudit(
  conversationId: string,
  messageId: string,
  options?: FetchTurnAuditOptions,
): Promise<AgentAuditListResponse> {
  const query = options?.includeCausal === true ? "?include_causal=true" : "";
  return api.get<AgentAuditListResponse>(
    `/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/audit${query}`,
  );
}

/** 会话级审计（含 permission.axes_changed，供主流权限切换系统行）；404 → null。 */
export async function fetchConversationAudit(
  conversationId: string,
  options?: FetchConversationAuditOptions,
): Promise<AgentAuditListResponse | null> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.category) params.set("category", options.category);
  const q = params.toString() ? `?${params}` : "";
  try {
    return await api.get<AgentAuditListResponse>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/audit${q}`,
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
