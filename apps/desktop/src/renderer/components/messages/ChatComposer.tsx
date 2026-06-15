import { useMessagingStore } from "@/stores/messaging";
import { AlertTriangle, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  chatId: string;
}

/**
 * IM message composer: a single auto-growing textarea + send. Enter sends,
 * Shift+Enter inserts a newline. Sending is optimistic (the store appends a
 * local twin and swaps it for the stored message), so this only owns the draft
 * and surfaces the store's last send error.
 */
export function ChatComposer({ chatId }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendError = useMessagingStore((s) => s.sendError);
  const clearSendError = useMessagingStore((s) => s.clearSendError);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: value is an intentional re-run key — re-measure on every input change.
  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Switching chats starts a fresh draft and drops any stale send error.
  useEffect(() => {
    setValue("");
    clearSendError();
  }, [chatId, clearSendError]);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    setValue("");
    void useMessagingStore.getState().sendMessage(chatId, text);
  }, [value, chatId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="px-4 pb-4 pt-2">
      {sendError && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">{sendError}</span>
          <button
            type="button"
            onClick={() => clearSendError()}
            aria-label="关闭"
            className="shrink-0 text-destructive/70 hover:text-destructive"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息…"
          className="max-h-40 w-full resize-none bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          rows={1}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!value.trim()}
          aria-label="发送"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
