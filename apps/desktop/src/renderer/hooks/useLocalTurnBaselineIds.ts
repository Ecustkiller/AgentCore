import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { listLocalTurnBaselineIds } from "@/services/localTurnBaselines";
import { assistantProjectionId } from "@/stores/conversation/runtime";
import type { Message } from "@/stores/conversation/types";
import { useEffect, useMemo, useState } from "react";

/**
 * 本对话有哪些 assistant 回合在本机已有 Local zip 基线（与 messages 求交）。
 * 共享项目工作区可能含其他对话的 zip —— 只认当前 messages 的 projection id。
 */
export function useLocalTurnBaselineIds(
  conversationId: string | null,
  messages: Message[],
): ReadonlySet<string> {
  const ws = useConversationWorkspace(conversationId);
  const assistantKey = useMemo(() => {
    const ids: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      ids.push(assistantProjectionId(msg));
    }
    return ids.join("\u0001");
  }, [messages]);

  const [matched, setMatched] = useState<ReadonlySet<string>>(() => new Set());

  const isLocal = ws?.location === "local" && !!ws.rootId;
  const rootId = ws?.rootId ?? null;
  const subpath = ws?.subpath ?? "";

  useEffect(() => {
    if (!isLocal || !rootId) {
      setMatched(new Set());
      return;
    }
    const assistantIds = new Set(
      assistantKey ? assistantKey.split("\u0001") : [],
    );
    if (assistantIds.size === 0) {
      setMatched(new Set());
      return;
    }
    let cancelled = false;
    void listLocalTurnBaselineIds(rootId, subpath)
      .then((ids) => {
        if (cancelled) return;
        const next = new Set<string>();
        for (const id of ids) {
          if (assistantIds.has(id)) next.add(id);
        }
        setMatched(next);
      })
      .catch(() => {
        if (!cancelled) setMatched(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [isLocal, rootId, subpath, assistantKey]);

  return matched;
}
