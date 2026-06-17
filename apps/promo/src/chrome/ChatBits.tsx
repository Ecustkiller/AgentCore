import { Paperclip, Send, SlidersHorizontal } from "lucide-react";
import { ChevronDown } from "lucide-react";

/*
 * Chat surface bits, re-stated from ChatView / MessageInput / MessageBubble with
 * the store/IPC wiring stripped: the empty-state prompt, the composer card, the
 * user bubble and the streaming assistant answer. Pixel-faithful to the product
 * (same Tailwind classes), driven by plain props so scenes can animate them by
 * frame.
 */

/** ChatView's empty state — centered 今天想解决什么问题？ */
export function ChatEmptyState({ style }: { style?: React.CSSProperties }) {
  return (
    <div className="flex h-full items-center justify-center" style={style}>
      <div className="text-center">
        <p className="text-2xl font-medium text-foreground">
          今天想解决什么问题？
        </p>
      </div>
    </div>
  );
}

/** The composer card (MessageInput) with a typed value + optional blinking caret. */
export function InputBar({
  text,
  caret,
}: {
  text: string;
  caret: boolean;
}) {
  const empty = text.length === 0;
  return (
    <div className="px-4 pb-4 pt-2">
      <div className="relative rounded-xl border border-border bg-card shadow-sm">
        <div className="min-h-[44px] w-full px-4 pt-3 pb-1 text-sm">
          {empty ? (
            <span className="text-muted-foreground">输入消息，@ 引用文件…</span>
          ) : (
            <span className="whitespace-pre-wrap text-foreground">
              {text}
              {caret && (
                <span className="ml-px inline-block h-4 w-px -translate-y-0.5 bg-foreground/70 align-middle" />
              )}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-1">
            <span className="flex size-8 items-center justify-center rounded-lg text-muted-foreground">
              <Paperclip size={16} />
            </span>
            <span className="flex h-8 max-w-[180px] items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground">
              <SlidersHorizontal size={14} className="shrink-0" />
              <span className="truncate">跟随默认</span>
              <ChevronDown size={12} className="shrink-0 opacity-60" />
            </span>
          </div>
          <div className="flex items-center gap-3">
            {!empty && (
              <span className="text-xs text-muted-foreground">
                {text.length}字
              </span>
            )}
            <span
              className={`flex size-8 items-center justify-center rounded-lg ${
                empty
                  ? "bg-primary text-primary-foreground opacity-40"
                  : "bg-primary text-primary-foreground"
              }`}
            >
              <Send size={14} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The 等待首 token 的「正在思考…」cue (AssistantMessage's pre-stream state). */
export function AssistantThinking() {
  return (
    <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <span className="inline-flex gap-1">
        <span className="size-1.5 rounded-full bg-muted-foreground/70" />
        <span className="size-1.5 rounded-full bg-muted-foreground/70" />
        <span className="size-1.5 rounded-full bg-muted-foreground/70" />
      </span>
      正在思考…
    </div>
  );
}

/** A right-aligned user message bubble (UserMessage). */
export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="max-w-[80%] rounded-xl rounded-br-none bg-secondary px-4 py-3 text-sm text-secondary-foreground">
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}

/**
 * The streaming assistant answer (AssistantMessage body). Prose is rendered in
 * the product's `.markdown-body` typography; a trailing caret blinks while
 * streaming, mirroring the real blink-cursor span.
 */
export function AssistantProse({
  text,
  caret,
}: {
  text: string;
  caret: boolean;
}) {
  return (
    <div className="group min-w-0">
      <div className="markdown-body whitespace-pre-wrap text-sm text-foreground">
        {text}
        {caret && (
          <span className="ml-0.5 inline-block h-4 w-1.5 -translate-y-0.5 rounded-full bg-foreground/60 align-middle" />
        )}
      </div>
    </div>
  );
}
