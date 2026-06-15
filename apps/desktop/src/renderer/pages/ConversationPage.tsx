import { ChatView } from "@/components/chat/ChatView";
import { SidePanel } from "@/components/layout/SidePanel";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { fetchMessageWindow, jumpToMessage } from "@/services/messages";
import { getRuntime, useConversationStore } from "@/stores/conversation";
import { WORKSPACE_TAB_ID, useSidePanelStore } from "@/stores/sidePanel";
import { PanelRight } from "lucide-react";
import { useEffect } from "react";
import { useParams } from "react-router-dom";

export function ConversationPage() {
  const { id } = useParams<{ id: string }>();

  // 路由参数是 conversation 的真相来源（刷新/前进后退/直达链接时同步到 store），
  // 并从后端拉取最新一窗消息（含附件元信息）以恢复对话；更早的历史按需上滚加载。
  useEffect(() => {
    if (!id) return;
    const store = useConversationStore.getState();
    if (id !== store.currentConversationId) store.switchConversation(id);

    let cancelled = false;
    void (async () => {
      try {
        const win = await fetchMessageWindow(id);
        if (cancelled) return;
        const s = useConversationStore.getState();
        // Per-conversation load guard: only adopt fetched history into THIS
        // conversation's own slice (setMessageWindow writes by id, so bail if the
        // user switched away), and never clobber a live or already-filled slice —
        // a background turn that streamed while we fetched, or a message that was
        // just sent locally.
        if (s.currentConversationId === id) {
          const rt = getRuntime(id);
          if (!(rt.isGenerating || rt.messages.length > 0)) {
            s.setMessageWindow(
              win.messages,
              {
                hasMoreBefore: win.hasMoreBefore,
                hasMoreAfter: win.hasMoreAfter,
              },
              id,
            );
          }
        }
      } catch {
        /* 历史加载尽力而为，失败保持空对话 */
      }
      // Honor a search-hit jump that navigated in from elsewhere: now that this
      // conversation's window is loaded, land on the hit (in-window → scroll+flash;
      // outside → load-around). Runs after the load so it sees real messages.
      if (cancelled) return;
      const store = useConversationStore.getState();
      const pending = store.pendingFocus;
      if (pending && pending.conversationId === id) {
        store.clearPendingFocus();
        void jumpToMessage(id, pending.messageId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Page-scoped shortcuts for the single side panel: Ctrl/Cmd+I shows / hides it
  // (keeping the active tab), Ctrl/Cmd+J reveals it straight on the 工作区 home
  // tab. Scoped here (not the global shell) as both are only meaningful on the
  // conversation page. (Ctrl/Cmd+B is reserved by the shell for the left sidebar
  // collapse, so the panel takes I to avoid the double-fire.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        useSidePanelStore.getState().togglePanel();
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        // Smart toggle: reveal the 工作区 home tab, or dismiss the panel if it's
        // already there (press again to close, like the old dedicated dock).
        const s = useSidePanelStore.getState();
        if (s.open && s.activeTabId === WORKSPACE_TAB_ID) s.closePanel();
        else s.showWorkspace();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const panelOpen = useSidePanelStore((s) => s.open);
  const togglePanel = useSidePanelStore((s) => s.togglePanel);

  return (
    <>
      <ChatView />
      {/* Side-panel toggle — run detail opens by clicking a graph node, but the
          panel still needs a discoverable show/hide control, so it lives at the
          chat's top-right and mirrors Ctrl/Cmd+I. Opening restores the active tab
          (the 工作区 home by default), so a manual open lands on the project
          files. Stays visible while open (active state) as the close affordance. */}
      {id && (
        <SimpleTooltip
          label={panelOpen ? "隐藏侧面板 (Ctrl/Cmd+I)" : "侧面板 (Ctrl/Cmd+I)"}
        >
          <button
            type="button"
            onClick={togglePanel}
            aria-pressed={panelOpen}
            aria-label={panelOpen ? "隐藏侧面板" : "侧面板"}
            className={`absolute right-3 top-2 z-20 flex size-8 items-center justify-center rounded-lg border border-border backdrop-blur ${
              panelOpen
                ? "bg-accent text-foreground"
                : "bg-card/80 text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <PanelRight size={16} />
          </button>
        </SimpleTooltip>
      )}
      <SidePanel />
    </>
  );
}
