import { useTurnAudit } from "@/hooks/useTurnAudit";
import { groupAuditCountsByRun } from "@/services/audit";
import { useMemo } from "react";

/**
 * 单回合审计按 run_id 计数，供 GraphView 节点角标。
 * 拉取失败、无数据或离线预览时返回空对象（角标隐藏，不影响图主链路）。
 */
export function useTurnAuditCounts(
  conversationId: string | null,
  messageId: string | null,
): Record<string, number> {
  const { data } = useTurnAudit(conversationId, messageId);
  return useMemo(() => (data ? groupAuditCountsByRun(data.data) : {}), [data]);
}
