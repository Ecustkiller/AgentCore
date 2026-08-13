import { Button } from "@/components/ui";

export function DraftWorkspaceAssignPrompt({
  attachmentFolderName,
  currentFolderName,
  onAssign,
  onKeep,
}: {
  attachmentFolderName: string;
  /** When set, user already picked a different folder for this draft. */
  currentFolderName?: string | null;
  onAssign: () => void;
  onKeep: () => void;
}) {
  const message = currentFolderName
    ? `附件来自「${attachmentFolderName}」，当前将在「${currentFolderName}」工作。改为在附件所在文件夹？`
    : `附件来自「${attachmentFolderName}」，是否在该文件夹中开始本对话？`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
      <p className="min-w-0 flex-1 text-xs text-foreground">{message}</p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="neutral" size="sm" onClick={onKeep}>
          {currentFolderName ? "保持现状" : "先聊到再说"}
        </Button>
        <Button variant="primary" size="sm" onClick={onAssign}>
          改用该文件夹
        </Button>
      </div>
    </div>
  );
}
