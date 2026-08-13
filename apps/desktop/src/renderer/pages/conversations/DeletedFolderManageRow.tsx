import { Badge, IconButton, SurfaceRow } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useRestoreFolder } from "@/hooks/useFolders";
import { timeAgo } from "@/lib/format";
import type { DeletedFolderMeta } from "@/services/folders";
import { ArchiveRestore, Cloud, HardDrive } from "lucide-react";
import { retentionRemainingLabel } from "./constants";
import { folderAccentVar } from "./folderAccent";

/**
 * One row of「最近删除」— a deleted folder waiting out its retention window.
 * Same density / chrome as {@link ArchivedConversationManageRow}, but a folder
 * cannot be opened while it sits in the bin, so the row is inert apart from 恢复.
 */
export function DeletedFolderManageRow({
  folder,
}: {
  folder: DeletedFolderMeta;
}) {
  const restoreMutation = useRestoreFolder();
  const isLocal = folder.mode === "local";

  const handleRestore = () => {
    restoreMutation.mutate({ id: folder.id, name: folder.name });
  };

  return (
    <SurfaceRow className="group relative min-h-14 items-stretch gap-3 px-3 py-2.5 hover:bg-accent/60">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: folderAccentVar(folder.id) }}
            aria-hidden
          />
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {folder.name}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground">
            {isLocal ? <HardDrive size={11} /> : <Cloud size={11} />}
            {isLocal ? "本机" : "云端"}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          删除于 {timeAgo(folder.deletedAt)}
          {isLocal && " · 电脑上的文件夹未被改动"}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end justify-between gap-1 py-0.5">
        <span className="flex h-6 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <SimpleTooltip label="恢复到文件夹列表">
            <IconButton
              aria-label={`恢复文件夹 ${folder.name}`}
              onClick={handleRestore}
              disabled={restoreMutation.isPending}
              className="size-6 text-muted-foreground hover:text-foreground"
            >
              <ArchiveRestore size={13} />
            </IconButton>
          </SimpleTooltip>
        </span>
        <Badge tone="muted" pill className="tabular-nums">
          {retentionRemainingLabel(folder.purgeAt)}
        </Badge>
      </div>
    </SurfaceRow>
  );
}
