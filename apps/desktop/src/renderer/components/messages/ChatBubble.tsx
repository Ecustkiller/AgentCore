import { Button } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { formatMessageTime } from "@/lib/format";
import {
  type ChatMessageDetail,
  type StoredAttachment,
  downloadChatAttachment,
  fetchChatAttachmentBlob,
  isImageAttachment,
} from "@/services/messaging";
import { Download, FileText, Folder, ImageOff } from "lucide-react";
import { useEffect, useState } from "react";

interface Props {
  message: ChatMessageDetail;
  /** Sent by the viewing user → right-aligned. */
  mine: boolean;
  /** Sender's display name, shown above the bubble in group threads (others only). */
  senderName?: string;
}

/** A human-readable byte size for a file chip (e.g. "1.2 MB"). */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * An inline image attachment: fetched as a blob (the file API is cookie-authed
 * raw bytes, so a bare <img src> URL wouldn't carry auth) and shown via an
 * object URL that is revoked on unmount. The preview loads the server-generated
 * WebP thumbnail (`thumb_path`) when present — the bandwidth win — and falls
 * back to the original for small images / legacy rows. Clicking always saves the
 * full-resolution original. A small error tile shows if the fetch fails (e.g.
 * the file was removed).
 */
function ChatImageAttachment({
  chatId,
  attachment,
}: {
  chatId: string;
  attachment: StoredAttachment;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Show the lightweight thumbnail; download the original.
  const previewPath = attachment.thumb_path ?? attachment.workspace_path;
  const originalPath = attachment.workspace_path;

  useEffect(() => {
    if (!previewPath) {
      setFailed(true);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    fetchChatAttachmentBlob(chatId, previewPath)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [chatId, previewPath]);

  if (failed) {
    return (
      <div className="flex size-24 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <ImageOff size={18} />
      </div>
    );
  }
  if (!url) {
    return <div className="size-24 animate-pulse rounded-lg bg-muted" />;
  }
  return (
    <Button
      variant="ghost"
      onClick={() =>
        originalPath &&
        void downloadChatAttachment(chatId, originalPath, attachment.name)
      }
      className="block h-auto overflow-hidden rounded-lg border border-border p-0 hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-ring"
      title={attachment.name}
    >
      <img
        src={url}
        alt={attachment.name}
        className="max-h-60 max-w-[260px] object-cover"
      />
    </Button>
  );
}

/**
 * One IM message bubble. Human chat is rendered as plain wrapped text (not
 * Markdown): a stray `#`/`*` in a person's message shouldn't become a heading,
 * and own-bubble theming (primary background) would fight Markdown's fixed
 * foreground color.
 *
 * 富消息 (Stage 4): image attachments render inline (fetched as blobs); other
 * files render as download chips. `system_card` (official notices) renders as a
 * centered system pill.
 */
export function ChatBubble({ message, mine, senderName }: Props) {
  const time = formatMessageTime(message.created_at);

  if (message.content_type === "system_card") {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-lg bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {message.content || "[通知]"}
        </span>
      </div>
    );
  }

  const attachments = message.attachments ?? [];
  const images = attachments.filter(
    (a) => a.kind !== "dir" && a.workspace_path && isImageAttachment(a.name),
  );
  const files = attachments.filter((a) => !images.includes(a));
  const hasText = Boolean(message.content);

  return (
    <div
      className={`group flex flex-col ${mine ? "items-end" : "items-start"}`}
    >
      {!mine && senderName && (
        <span className="mb-0.5 px-1 text-xs text-muted-foreground">
          {senderName}
        </span>
      )}

      <div
        className={`flex max-w-[75%] flex-col gap-1.5 ${mine ? "items-end" : "items-start"}`}
      >
        {hasText && (
          <div
            className={`whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm ${
              mine
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-foreground"
            }`}
          >
            {message.content}
          </div>
        )}

        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {images.map((a) => (
              <ChatImageAttachment
                key={a.workspace_path ?? a.path}
                chatId={message.chat_id}
                attachment={a}
              />
            ))}
          </div>
        )}

        {files.map((a) => {
          const downloadable = a.kind !== "dir" && Boolean(a.workspace_path);
          return (
            <Button
              key={a.workspace_path ?? a.path}
              variant="ghost"
              disabled={!downloadable}
              onClick={() =>
                downloadable &&
                a.workspace_path &&
                void downloadChatAttachment(
                  message.chat_id,
                  a.workspace_path,
                  a.name,
                )
              }
              className={`h-auto w-full max-w-[260px] justify-start gap-2 rounded-xl border border-border bg-card px-3 py-2 text-left font-normal ${
                downloadable ? "hover:bg-accent" : "opacity-70"
              }`}
            >
              <span className="flex w-full items-center gap-2">
                {a.kind === "dir" ? (
                  <Folder size={16} className="shrink-0 text-muted-foreground" />
                ) : (
                  <FileText
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <SimpleTooltip label={a.name}>
                    <span className="block truncate text-sm text-foreground">
                      {a.name}
                      {a.kind === "dir" ? "/" : ""}
                    </span>
                  </SimpleTooltip>
                  {a.size_bytes != null && (
                    <span className="block text-xs text-muted-foreground">
                      {formatBytes(a.size_bytes)}
                    </span>
                  )}
                </span>
                {downloadable && (
                  <Download
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                )}
              </span>
            </Button>
          );
        })}
      </div>

      {time && (
        <span className="mt-0.5 px-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {time}
        </span>
      )}
    </div>
  );
}
