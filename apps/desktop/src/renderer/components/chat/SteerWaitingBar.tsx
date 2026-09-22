import { steerWaitingItems } from "@/lib/pendingUserMessage";
import {
  type Message,
  assistantProjectionId,
  useConversationStore,
} from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { useQueuedTurns } from "@/stores/queuedTurns";
import { Loader2 } from "lucide-react";
import { useMemo } from "react";

const NO_MESSAGES: Message[] = [];

/**
 * 插话尚未被读取：挂在输入框上方，进上下文后再出现在时间线。
 * 已经升格进排队的不在这里重复。
 */
export function SteerWaitingBar({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const messages = useConversationStore((s) =>
    conversationId
      ? (s.byId[conversationId]?.messages ?? NO_MESSAGES)
      : NO_MESSAGES,
  );
  const byId = useExecutionStore((s) => s.byId);
  const queued = useQueuedTurns(conversationId);
  const items = useMemo(() => {
    const queuedIds = new Set(
      queued
        .map((entry) => entry.interjectionId)
        .filter((id): id is string => Boolean(id)),
    );
    return steerWaitingItems(
      messages,
      (index) => {
        const message = messages[index];
        if (!message || message.role !== "assistant") return undefined;
        const key = assistantProjectionId(message);
        return (
          byId[key]?.userInterjections ??
          byId[message.id]?.userInterjections
        );
      },
      queuedIds,
    );
  }, [messages, byId, queued]);

  if (!conversationId || items.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1 px-1 pb-1"
      data-testid="steer-waiting-bar"
      aria-live="polite"
      aria-label="等待读取"
    >
      {items.map((item) => {
        const preview =
          item.content.length > 48 ? `${item.content.slice(0, 48)}…` : item.content;
        return (
          <div
            key={item.interjectionId}
            className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
            data-testid="steer-waiting-row"
            data-interjection-id={item.interjectionId}
          >
            <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              等待读取：{preview}
            </span>
          </div>
        );
      })}
    </div>
  );
}
