import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useState } from "react";

/**
 * Nuclear confirmation for ``DELETE /v1/folders/{id}/permanent`` — hard-deletes
 * the folder, every member conversation (incl. archived), and cloud workspace
 * files immediately. Separate from {@link DeleteProjectDialog} (soft-delete).
 */
export function PermanentDeleteProjectDialog({
  open,
  onOpenChange,
  name,
  liveConvCount,
  isLocal,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  liveConvCount: number;
  isLocal: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const canConfirm = draft.trim() === name;

  useEffect(() => {
    if (open) setDraft("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>彻底删除项目「{name}」？</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p className="text-foreground">
                此操作不可恢复，与「删除项目」（30 天保留期）不同。
              </p>
              {liveConvCount > 0 ? (
                <p>
                  · 此项目下全部对话（含已归档，当前可见 {liveConvCount}{" "}
                  条）将被永久删除
                </p>
              ) : (
                <p>· 此项目下暂无可见活跃对话（已归档成员对话仍会被清除）</p>
              )}
              <p>· 云端项目文件与快照将立即清除</p>
              {isLocal && <p>· 本地磁盘上的文件不会被删除（文件在你电脑上）</p>}
              <label className="block pt-2 text-foreground">
                <span className="mb-1.5 block text-sm">
                  输入项目名称「{name}」以确认
                </span>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:border-ring focus:outline-none"
                  autoComplete="off"
                />
              </label>
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
            disabled={!canConfirm}
            onClick={() => void onConfirm()}
          >
            彻底删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
