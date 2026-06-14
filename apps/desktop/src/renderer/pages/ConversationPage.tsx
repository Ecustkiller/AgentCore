import { ChatView } from "@/components/chat/ChatView";
import { DetailPanel } from "@/components/chat/DetailPanel";
import { GraphOverlay } from "@/components/graph/GraphOverlay";
import { api } from "@/services/api";
import { type Message, useConversationStore } from "@/stores/conversation";
import { useDetailPanelStore } from "@/stores/detailPanel";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import { useEffect } from "react";
import { useParams } from "react-router-dom";

interface BackendMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string | null;
  reasoning_content: string | null;
  attachments?: {
    name: string;
    path: string;
    truncated: boolean;
    kind?: "file" | "dir";
  }[];
  citations?: {
    url: string;
    title: string;
    snippet?: string;
    site?: string;
  }[];
  created_at: string;
}

interface MessageListResponse {
  data: BackendMessage[];
}

function toMessage(m: BackendMessage): Message {
  return {
    id: m.id,
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content ?? "",
    reasoning: m.reasoning_content ?? undefined,
    createdAt: m.created_at,
    executionId: null,
    isStreaming: false,
    attachments: m.attachments?.length
      ? m.attachments.map((a) => ({
          id: crypto.randomUUID(),
          name: a.name,
          path: a.path,
          truncated: a.truncated,
          kind: a.kind ?? "file",
        }))
      : undefined,
    citations: m.citations?.length ? m.citations : undefined,
  };
}

export function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const graphOpen = useUIStore((s) => s.graphOpen);

  // 路由参数是 conversation 的真相来源（刷新/前进后退/直达链接时同步到 store），
  // 并从后端拉取历史消息（含附件元信息）以恢复对话。
  useEffect(() => {
    if (!id) return;
    const store = useConversationStore.getState();
    if (id !== store.currentConversationId) store.switchConversation(id);

    // Seed the 对话累计 chip (§7.3C) from the ledger; live turns bump it after.
    void useUsageStore.getState().fetchConversationCost(id);

    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<MessageListResponse>(
          `/v1/conversations/${id}/messages?page_size=100`,
        );
        if (cancelled) return;
        const s = useConversationStore.getState();
        // 期间发生了会话切换 / 正在生成 / 本地已有消息（如刚发送），则不覆盖。
        if (s.currentConversationId !== id || s.isGenerating) return;
        if (s.messages.length > 0) return;
        s.setMessages(res.data.map(toMessage));
      } catch {
        /* 历史加载尽力而为，失败保持空对话 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Ctrl/Cmd+B toggles the detail panel — only meaningful on the conversation
  // page, so the listener is scoped here rather than in the global shell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        useDetailPanelStore.getState().togglePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <ChatView />
      <DetailPanel />
      {graphOpen && <GraphOverlay />}
    </>
  );
}
