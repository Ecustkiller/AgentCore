import { useLocalTurnBaselineIds } from "@/hooks/useLocalTurnBaselineIds";
import {
  conversationHasFileArtifacts,
  conversationHasRestorableEntry,
} from "@/lib/conversationFileChanges";
import { useConversationStore } from "@/stores/conversation";
import {
  assistantProjectionId,
  runtimeOf,
} from "@/stores/conversation/runtime";
import type { Message } from "@/stores/conversation/types";
import { useExecutionStore } from "@/stores/execution";
import { useMemo } from "react";

/**
 * 当前对话是否有可恢复入口（AI 文件改动或本机回合基线）。
 * 选择器只回 boolean / 稳定 key，避免 SidePanel 跟流式 token 重绘。
 */
export function useConversationHasRestorableEntry(
  conversationId: string | null,
): boolean {
  const hasFileFromConv = useConversationStore((s) => {
    if (!conversationId) return false;
    return conversationHasFileArtifacts(
      runtimeOf(s, conversationId).messages,
      useExecutionStore.getState().byId,
    );
  });
  const hasFileFromExec = useExecutionStore((s) => {
    if (!conversationId) return false;
    const conv = useConversationStore.getState();
    return conversationHasFileArtifacts(
      runtimeOf(conv, conversationId).messages,
      s.byId,
    );
  });

  const assistantKey = useConversationStore((s) => {
    if (!conversationId) return "";
    const messages = runtimeOf(s, conversationId).messages;
    const ids: string[] = [];
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      ids.push(assistantProjectionId(msg));
    }
    return ids.join("\u0001");
  });

  const stubMessages = useMemo((): Message[] => {
    if (!assistantKey) return [];
    return assistantKey.split("\u0001").map((id) => ({
      id,
      serverMessageId: id,
      role: "assistant",
      content: "",
      createdAt: "",
      executionId: null,
      isStreaming: false,
    }));
  }, [assistantKey]);

  const baselineMessageIds = useLocalTurnBaselineIds(
    conversationId,
    stubMessages,
  );

  return (
    hasFileFromConv ||
    hasFileFromExec ||
    conversationHasRestorableEntry(stubMessages, {}, baselineMessageIds)
  );
}
