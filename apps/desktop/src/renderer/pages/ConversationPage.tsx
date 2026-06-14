import { ChatView } from "@/components/chat/ChatView";
import { DetailPanel } from "@/components/chat/DetailPanel";
import { WorkspacePanel } from "@/components/workspace/WorkspacePanel";
import { api } from "@/services/api";
import {
  type Message,
  getRuntime,
  useConversationStore,
} from "@/stores/conversation";
import { useDetailPanelStore } from "@/stores/detailPanel";
import { useUsageStore } from "@/stores/usage";
import { useWorkspacePanelStore } from "@/stores/workspacePanel";
import type { SSEEvent } from "@/types/events";
import { FolderOpen } from "lucide-react";
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
    workspace_path?: string | null;
  }[];
  citations?: {
    url: string;
    title: string;
    snippet?: string;
    site?: string;
  }[];
  /** Persisted multi-agent execution journal (the turn's ordered run/tool SSE
   * events). null for user / single-agent turns. Replayed through the same fold
   * as the live stream to rebuild the team graph on reload (§9.3). */
  runs?: { events: SSEEvent[]; finish_reason: string | null } | null;
  created_at: string;
}

interface MessageListResponse {
  data: BackendMessage[];
}

/** The execution (plan) id of a reloaded multi-agent turn — the first
 * `run_plan`'s id in the persisted journal. null for user / single-agent turns
 * (no journal, or a journal with no plan), which then render as plain bubbles. */
function executionIdOf(events: SSEEvent[]): string | null {
  const plan = events.find((e) => e.type === "run_plan");
  const id = (plan?.payload as { execution_id?: string } | undefined)
    ?.execution_id;
  return id ?? null;
}

function toMessage(m: BackendMessage): Message {
  const events = m.runs?.events ?? [];
  const executionId = executionIdOf(events);
  return {
    id: m.id,
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content ?? "",
    reasoning: m.reasoning_content ?? undefined,
    createdAt: m.created_at,
    // Stamp the plan id so the bubble renders its inline team graph; the journal
    // below lets that graph replay the turn (both null for non-team turns).
    executionId,
    runs: executionId
      ? { events, finishReason: m.runs?.finish_reason ?? "stop" }
      : undefined,
    isStreaming: false,
    attachments: m.attachments?.length
      ? m.attachments.map((a) => ({
          id: crypto.randomUUID(),
          name: a.name,
          path: a.path,
          truncated: a.truncated,
          kind: a.kind ?? "file",
          workspacePath: a.workspace_path ?? undefined,
        }))
      : undefined,
    citations: m.citations?.length ? m.citations : undefined,
  };
}

export function ConversationPage() {
  const { id } = useParams<{ id: string }>();

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
        // Per-conversation load guard: only adopt fetched history into THIS
        // conversation's own slice (setMessages writes the active slice, so bail
        // if the user switched away), and never clobber a live or already-filled
        // slice — a background turn that streamed while we fetched, or a message
        // that was just sent locally.
        if (s.currentConversationId !== id) return;
        const rt = getRuntime(id);
        if (rt.isGenerating || rt.messages.length > 0) return;
        s.setMessages(res.data.map(toMessage));
      } catch {
        /* 历史加载尽力而为，失败保持空对话 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Page-scoped shortcuts: Ctrl/Cmd+B toggles the run-detail panel, Ctrl/Cmd+J
  // the workspace panel. Scoped here (not the global shell) as both are only
  // meaningful on the conversation page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        useDetailPanelStore.getState().togglePanel();
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        useWorkspacePanelStore.getState().togglePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const workspaceOpen = useWorkspacePanelStore((s) => s.open);
  const openWorkspace = useWorkspacePanelStore((s) => s.openPanel);

  return (
    <>
      <ChatView />
      {/* Workspace toggle — the panel has no graph node to open it from, so a
          discoverable affordance lives at the chat's top-right (hidden while
          open; the panel carries its own close). */}
      {id && !workspaceOpen && (
        <button
          type="button"
          onClick={openWorkspace}
          title="工作区文件 (Ctrl/Cmd+J)"
          className="absolute right-3 top-2 z-20 flex size-8 items-center justify-center rounded-lg border border-border bg-card/80 text-muted-foreground backdrop-blur hover:bg-accent hover:text-foreground"
        >
          <FolderOpen size={16} />
        </button>
      )}
      <DetailPanel />
      <WorkspacePanel />
    </>
  );
}
