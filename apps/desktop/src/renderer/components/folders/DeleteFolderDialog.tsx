import { Button } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFolderTrash } from "@/hooks/useFolders";
import { useEffect, useState } from "react";

/**
 * Shared confirmation when deleting a folder (= the only kind of container).
 * Soft-delete is the default and recoverable from「最近删除」; check the permanent
 * option to hard-delete in the same dialog (no second step / type-to-confirm).
 * Used by {@link WorkspaceSection} and {@link WorkspaceGroupHeader}.
 */
export function DeleteFolderDialog({
  open,
  onOpenChange,
  name,
  liveConvCount,
  isLocal = false,
  onConfirm,
  onPermanentConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  liveConvCount: number;
  isLocal?: boolean;
  onConfirm: () => void | Promise<void>;
  onPermanentConfirm: () => void | Promise<void>;
}) {
  const [permanent, setPermanent] = useState(false);
  // The retention window is the server's number (`/folders/trash`), never a
  // client constant — the recoverable copy would otherwise drift from the sweeper.
  const retentionDays = useFolderTrash(open).data?.retentionDays ?? null;

  useEffect(() => {
    if (!open) return;
    setPermanent(false);
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (!next) setPermanent(false);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>删除文件夹「{name}」？</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {permanent ? (
                <>
                  <p className="text-foreground">
                    将永久删除全部对话、云端文件与这张桌的设定，不可恢复。
                  </p>
                  {liveConvCount > 0 && (
                    <p>· 含当前可见的 {liveConvCount} 条对话及已归档成员</p>
                  )}
                  {isLocal && <p>· 电脑上的文件不会被删除</p>}
                </>
              ) : (
                <>
                  <p className="text-foreground">
                    {retentionDays === null
                      ? "删除后可在「最近删除」中恢复。"
                      : `${retentionDays} 天内可在「最近删除」中恢复。`}
                  </p>
                  {liveConvCount > 0 && (
                    <p>· 其下 {liveConvCount} 条对话一并归档，恢复时一起回来</p>
                  )}
                  {isLocal && <p>· 电脑上的文件不会被删除</p>}
                </>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="pb-1">
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 rounded border border-input accent-primary"
              checked={permanent}
              onChange={(e) => setPermanent(e.target.checked)}
            />
            <span>立即永久删除（不可恢复）</span>
          </label>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="outline"
            size="md"
            onClick={() => handleOpenChange(false)}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            size="md"
            onClick={() =>
              void (permanent ? onPermanentConfirm() : onConfirm())
            }
          >
            {permanent ? "彻底删除" : "删除文件夹"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
