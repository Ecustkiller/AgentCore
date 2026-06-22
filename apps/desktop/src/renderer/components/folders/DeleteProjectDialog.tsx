import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Conversation } from "@/stores/conversation";
import { useEffect, useState } from "react";

/** Matches server retention default (双模式工作区 §七). */
export const PROJECT_FILE_RETENTION_DAYS = 30;

export interface DeleteProjectOptions {
  /** When true, archive every live conversation in the folder before soft-delete. */
  archiveConversations: boolean;
}

/**
 * Archive each conversation in `convs` before deleting the folder. Returns false
 * on the first failure (caller should abort delete).
 */
export async function archiveConversationsBeforeDelete(
  convs: Conversation[],
  {
    archive,
    dropRuntime,
    currentId,
    onLeaveActive,
  }: {
    archive: (id: string) => Promise<unknown>;
    dropRuntime: (id: string) => void;
    currentId: string | null;
    onLeaveActive: () => void;
  },
): Promise<boolean> {
  for (const { id } of convs) {
    try {
      await archive(id);
      dropRuntime(id);
      if (id === currentId) onLeaveActive();
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Shared confirmation when soft-deleting a folder (= workspace / 项目).
 * Used by the file hub {@link WorkspaceSection} and sidebar
 * {@link WorkspaceGroupHeader} so copy stays in one place.
 */
export function DeleteProjectDialog({
  open,
  onOpenChange,
  name,
  liveConvCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  liveConvCount: number;
  onConfirm: (options: DeleteProjectOptions) => void | Promise<void>;
}) {
  const [archiveConversations, setArchiveConversations] = useState(true);

  useEffect(() => {
    if (open) setArchiveConversations(true);
  }, [open]);

  const convOutcome =
    liveConvCount > 0
      ? archiveConversations
        ? `· ${liveConvCount} 条对话将一并归档`
        : `· ${liveConvCount} 条对话将移入「未分组」（对话记录不会删除）`
      : "· 此项目下暂无活跃对话";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除项目「{name}」？</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{convOutcome}</p>
              <p>
                · 项目文件将保留 {PROJECT_FILE_RETENTION_DAYS}{" "}
                天，之后由系统自动清理
              </p>
              {liveConvCount > 0 && (
                <label className="flex cursor-pointer items-start gap-2 pt-1 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={archiveConversations}
                    onChange={(e) => setArchiveConversations(e.target.checked)}
                    className="mt-0.5 size-4 shrink-0 rounded border-border accent-primary"
                  />
                  <span>同时归档其下全部对话</span>
                </label>
              )}
              <p className="text-xs">
                若只想整理聊天列表，请使用「归档对话」而非删除项目。
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="neutral"
            className="h-9 px-4"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            variant="danger"
            className="h-9 px-4"
            onClick={() => void onConfirm({ archiveConversations })}
          >
            删除项目
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
