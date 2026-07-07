import { isWebPreview } from "@/lib/preview";
import { fetchTurnAudit, groupAuditCountsByRun } from "@/services/audit";
import { useEffect, useState } from "react";

/**
 * 单回合审计按 run_id 计数，供 GraphView 节点角标。
 * 拉取失败、无数据或离线预览时返回空对象（角标隐藏，不影响图主链路）。
 */
export function useTurnAuditCounts(
  conversationId: string | null,
  messageId: string | null,
): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (isWebPreview() || !conversationId || !messageId) {
      setCounts({});
      return;
    }
    let cancelled = false;
    void fetchTurnAudit(conversationId, messageId)
      .then((res) => {
        if (!cancelled) setCounts(groupAuditCountsByRun(res.data));
      })
      .catch(() => {
        if (!cancelled) setCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, messageId]);

  return counts;
}
