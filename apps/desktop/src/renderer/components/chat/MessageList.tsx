import {
  useBackgroundTasks,
  useBackgroundTasksSync,
  useWorkspaceRootId,
} from "@/stores/backgroundTasks";
import {
  useActiveMemoryUpdates,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
import { useMemo } from "react";
import { BackgroundTaskCard } from "./BackgroundTaskCard";
import { MemoryUpdateCard } from "./MemoryUpdateCard";
import { MessageBubble } from "./MessageBubble";
import { mergeTimeline } from "./messageTimeline";

// Auto-scroll lives in ChatView's useStickToBottom: it owns the scroll container
// and only follows new content while the user is already at the bottom.
export function MessageList() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const messages = useActiveMessages();
  // 后台云端任务（交接「方案 B」）：本地模式对话才同步，按时间戳并入时间线，故卡片
  // 与消息一同**原位**渲染、随对话重开重放（数据源是后端持久化的 handoff jobs）。
  useBackgroundTasksSync(conversationId);
  const tasks = useBackgroundTasks(conversationId);
  // 绑定的本地根，供成功任务的内联评审写回本地（同一对话所有卡共用，故在此读取一次下传）。
  const rootId = useWorkspaceRootId(conversationId);

  // 记忆更新对话内可见 (§1.6): the offline-consolidation cards sit at the very tail —
  // consolidation folds a window of finished turns, so it post-dates every message and
  // background card (no timestamp merge needed, just append after them).
  const memoryUpdates = useActiveMemoryUpdates();

  const items = useMemo(
    () => mergeTimeline(messages, tasks),
    [messages, tasks],
  );

  return (
    <div className="space-y-6">
      {items.map((it) =>
        it.kind === "message" ? (
          <MessageBubble key={it.key} message={it.msg} />
        ) : (
          <BackgroundTaskCard key={it.key} job={it.job} rootId={rootId} />
        ),
      )}
      {memoryUpdates.map((u) => (
        <MemoryUpdateCard key={u.id} update={u} />
      ))}
    </div>
  );
}
