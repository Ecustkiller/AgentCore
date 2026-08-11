import { actAuthorizedByLabel } from "@/components/graph/actAuthLabels";
import {
  assistantProjectionId,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
import { useDisclosureStore } from "@/stores/disclosure";
import type { ActKind } from "@/stores/execution";
import { ArrowUp } from "lucide-react";

/**
 * 「续自上一张图」锚点文案。新路径（prev_execution_id）与旧 journal
 *（graph_append）共用续自口径；辩论幕略作区分。
 */
export function graphAppendAnchorLabel(
  actKind?: ActKind | string | null,
): string {
  if (actKind === "debate") {
    return "↑ 续自上一场辩论图";
  }
  return "↑ 续自上一张协作图";
}

/**
 * 协作图续自锚点——渲染在**当前**回合新图上，点击导航到上一张图。
 *
 * - 新路径：`prevExecutionId`（来自 `run_plan.prev_execution_id`）
 * - 旧 journal：`hostMessageId`（来自 `graph_append` process 步）
 */
export function GraphAppendAnchor({
  prevExecutionId,
  hostMessageId,
  actKind,
  authorizedBy,
}: {
  prevExecutionId?: string | null;
  hostMessageId?: string | null;
  actKind?: ActKind | string | null;
  authorizedBy?: string | null;
}) {
  const messages = useActiveMessages();
  const focusMessage = useConversationStore((s) => s.focusMessage);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const label = graphAppendAnchorLabel(actKind);
  const authLabel = actAuthorizedByLabel(authorizedBy);

  return (
    <button
      type="button"
      data-testid="graph-append-anchor"
      onClick={() => {
        const prevId =
          typeof prevExecutionId === "string" ? prevExecutionId.trim() : "";
        const hostRef =
          typeof hostMessageId === "string" ? hostMessageId.trim() : "";

        const host = prevId
          ? messages.find(
              (m) =>
                m.executionId === prevId ||
                m.process?.some(
                  (s) => s.kind === "team" && s.execution_id === prevId,
                ),
            )
          : messages.find(
              (m) => m.id === hostRef || m.serverMessageId === hostRef,
            );

        const focusId = host?.id ?? hostRef;
        if (!focusId) return;
        const slotId = host ? assistantProjectionId(host) : hostRef;
        if (conversationId && slotId) {
          // 展开目标内联协作图（默认展开时清掉「已收起」偏离值）。
          useDisclosureStore
            .getState()
            .setKey(`${conversationId}::${slotId}:inline-graph`, true, true);
        }
        focusMessage(focusId, conversationId);
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowUp size={14} className="shrink-0" aria-hidden />
      <span className="truncate">
        {label}
        {authLabel ? (
          <span className="text-xs opacity-80"> · {authLabel}</span>
        ) : null}
      </span>
    </button>
  );
}
