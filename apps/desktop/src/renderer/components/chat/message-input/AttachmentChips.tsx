import { SimpleTooltip } from "@/components/ui/tooltip";
import { Folder, MessageSquare, Paperclip, X } from "lucide-react";
import type { PendingAttachment } from "./composerAttachments";

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-3">
      {attachments.map((a) => (
        <span
          key={a.id}
          className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg bg-accent px-2 py-1 text-xs text-accent-foreground"
        >
          {a.kind === "dir" ? (
            <Folder size={12} className="shrink-0" />
          ) : a.kind === "conversation" ? (
            <MessageSquare size={12} className="shrink-0" />
          ) : (
            <Paperclip size={12} className="shrink-0" />
          )}
          <SimpleTooltip
            label={a.kind === "conversation" ? "引用对话" : a.path}
          >
            <span className="truncate">
              {a.name}
              {a.kind === "dir" ? "/" : ""}
            </span>
          </SimpleTooltip>
          {a.truncated && (
            <span className="shrink-0 text-muted-foreground">
              {a.kind === "dir"
                ? "部分"
                : a.kind === "conversation"
                  ? "近期"
                  : "已截断"}
            </span>
          )}
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="移除附件"
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
