import { formatMessageTime } from "@/lib/format";
import type { ChatMessageDetail } from "@/services/messaging";
import { Folder, Paperclip } from "lucide-react";

interface Props {
  message: ChatMessageDetail;
  /** Sent by the viewing user → right-aligned. */
  mine: boolean;
}

/**
 * One IM message bubble. Human chat is rendered as plain wrapped text (not
 * Markdown): a stray `#`/`*` in a person's message shouldn't become a heading,
 * and own-bubble theming (primary background) would fight Markdown's fixed
 * foreground color. Rich rendering + attachment upload are P1 (消息IM.md §六).
 *
 * `system_card` (official-account notices) renders as a centered system pill; its
 * deep-link payload is not wired yet (backend business pending), so it is shown
 * but not actionable.
 */
export function ChatBubble({ message, mine }: Props) {
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

  const placeholder =
    message.content_type === "image"
      ? "[图片]"
      : message.content_type === "file"
        ? "[文件]"
        : "";
  const body = message.content ?? placeholder;

  return (
    <div className={`group flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[75%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm ${
          mine
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-card text-foreground"
        }`}
      >
        {body}
        {message.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {message.attachments.map((a) => (
              <span
                key={a.path}
                title={a.path}
                className={`inline-flex max-w-[200px] items-center gap-1.5 rounded-lg px-2 py-1 text-xs ${
                  mine
                    ? "bg-primary-foreground/15"
                    : "bg-accent text-accent-foreground"
                }`}
              >
                {a.kind === "dir" ? (
                  <Folder size={12} className="shrink-0" />
                ) : (
                  <Paperclip size={12} className="shrink-0" />
                )}
                <span className="truncate">
                  {a.name}
                  {a.kind === "dir" ? "/" : ""}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
      {time && (
        <span className="mt-0.5 px-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {time}
        </span>
      )}
    </div>
  );
}
