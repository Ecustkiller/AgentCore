import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useConversationStore } from "@/stores/conversation";
import { FolderOpen, GitPullRequest, History, X } from "lucide-react";
import { useState } from "react";
import { FilesSection } from "./FilesSection";
import { HandoffSection } from "./HandoffSection";
import { SnapshotsSection } from "./SnapshotsSection";
import { WorkspaceModeBar } from "./WorkspaceModeBar";
import { EmptyHint, IconButton } from "@/components/files/parts";

/**
 * Workspace mode of the conversation side panel — the file-in/out + persistence
 * surface for a conversation's project space (双模式工作区). Files are the panel's
 * always-on body; this view only injects three workspace-level affordances into the
 * files toolbar's single header row (FileBrowser owns that row): 云端/本地选择器
 * (leading), plus two on-demand entries (trailing) — 快照 opens a slide-over (backup
 * / kept versions / restore), 交接 opens a wide modal (PR three-way review needs more
 * width than the ≤560px panel). The shell (SidePanel) owns the frame / resize / close.
 *
 * A draft conversation (no id yet) has no server workspace, so it shows an empty
 * hint until the first turn persists it.
 */
export function WorkspaceMode() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);

  if (!conversationId) {
    return (
      <EmptyHint
        inline
        icon={<FolderOpen size={26} className="text-muted-foreground/40" />}
        title="尚无工作区"
        hint="发送第一条消息后，这个对话的项目空间就会出现在这里。"
      />
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* 单行面板头：云端选择器（leading）+ 文件操作 + 快照/交接（trailing）合到 FilesSection
          的工具栏一行（文件操作经其内部 FileTree 的 ref 驱动），不再单独占一行。 */}
      <div className="min-h-0 flex-1">
        <FilesSection
          conversationId={conversationId}
          leading={<WorkspaceModeBar conversationId={conversationId} />}
          trailing={
            <>
              <IconButton title="快照" onClick={() => setSnapshotsOpen(true)}>
                <History size={14} />
              </IconButton>
              <IconButton title="交接" onClick={() => setHandoffOpen(true)}>
                <GitPullRequest size={14} />
              </IconButton>
            </>
          }
        />
      </div>

      {/* 快照：从常驻 tab 降级为按需 slide-over（低频 / 恢复型操作）。 */}
      {snapshotsOpen && (
        <div className="absolute inset-0 z-20 flex">
          <button
            type="button"
            aria-label="关闭快照"
            onClick={() => setSnapshotsOpen(false)}
            className="min-w-0 flex-1 bg-overlay/40"
          />
          <div className="flex w-[85%] max-w-[420px] flex-col border-l border-border bg-card shadow-lg animate-dropdown-in">
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-1">
              <History size={13} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                快照
              </span>
              <IconButton title="关闭" onClick={() => setSnapshotsOpen(false)}>
                <X size={14} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1">
              <SnapshotsSection conversationId={conversationId} />
            </div>
          </div>
        </div>
      )}

      {/* 交接：PR 三方评审需要宽度，升级为居中宽模态（面板 ≤560px 装不下逐文件评审）。 */}
      <Dialog open={handoffOpen} onOpenChange={setHandoffOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="flex h-[80vh] w-[calc(100vw-4rem)] max-w-5xl flex-col p-0"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
            <GitPullRequest size={16} className="text-muted-foreground" />
            <DialogTitle className="text-base">交接</DialogTitle>
          </div>
          <div className="min-h-0 flex-1">
            <HandoffSection conversationId={conversationId} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
