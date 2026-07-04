import { EmptyHint, IconButton } from "@/components/files/parts";
import { Button } from "@/components/ui";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { hasLocalFiles } from "@/lib/capabilities";
import {
  createWorkspaceSource,
  resolveWorkspaceSource,
} from "@/services/sources/workspaceSource";
import { useConversationStore } from "@/stores/conversation";
import { FolderOpen, History, X } from "lucide-react";
import { useMemo, useState } from "react";
import { FilesSection } from "./FilesSection";
import { SnapshotsSection } from "./SnapshotsSection";
import { WorkspaceModeBar } from "./WorkspaceModeBar";

/**
 * Workspace mode of the conversation side panel — the file-in/out + persistence
 * surface for a conversation's project space (双模式工作区). Files are the panel's
 * always-on body; this view injects two workspace-level affordances into the files
 * toolbar's single header row (FileBrowser owns that row): 云端/本地选择器 (leading)
 * plus one on-demand entry (trailing) — 快照 opens a slide-over (backup / kept
 * versions / restore). The shell (SidePanel) owns the frame / resize / close.
 *
 * 交接（把活交给云端团队）已下沉为对话时间线里的「后台云端任务」卡（交接「方案 B」/
 * `BackgroundTaskCard`），完成后就地内联评审应用，不再占用工作区侧栏的独立入口。
 *
 * A draft conversation (no id yet) has no server workspace, so it shows an empty
 * hint until the first turn persists it.
 */
export function WorkspaceMode() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);

  // 与文件中枢同一份数据 + 同一个解析器：对话→其工作区(WorkspaceInfo)→FileSource。本地走桌面
  // IPC、云端走 REST，故 Agent 在本地写的文件这里也能列出（修复「写在本地、读在云端」）。
  const ws = useConversationWorkspace(conversationId);
  const fsAvailable = hasLocalFiles();
  const source = useMemo(() => {
    if (ws) return resolveWorkspaceSource(ws, fsAvailable);
    if (!conversationId) return null;
    // Cloud scratch (or pre-first-write): conversation-keyed REST source.
    return createWorkspaceSource(conversationId);
  }, [ws, conversationId, fsAvailable]);

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
      {/* 单行面板头：云端选择器（leading）+ 文件操作 + 快照（trailing）合到 FilesSection
          的工具栏一行（文件操作经其内部 FileTree 的 ref 驱动），不再单独占一行。 */}
      <div className="min-h-0 flex-1">
        <FilesSection
          source={source}
          leading={<WorkspaceModeBar conversationId={conversationId} />}
          trailing={
            // 快照（备份/版本/恢复）是云端能力；本地源 caps.snapshots=false（本地的「备份到云」
            // 在 WorkspaceModeBar 里），按 caps 门控，本地模式不挂这个入口。
            source?.caps.snapshots ? (
              <IconButton title="快照" onClick={() => setSnapshotsOpen(true)}>
                <History size={14} />
              </IconButton>
            ) : undefined
          }
        />
      </div>

      {/* 快照：从常驻 tab 降级为按需 slide-over（低频 / 恢复型操作）。 */}
      {snapshotsOpen && (
        <div className="absolute inset-0 z-20 flex">
          <Button
            variant="ghost"
            aria-label="关闭快照"
            onClick={() => setSnapshotsOpen(false)}
            className="min-w-0 flex-1 rounded-none bg-overlay/40 p-0"
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
    </div>
  );
}
