import { DraftWorkspacePicker } from "@/components/chat/DraftWorkspacePicker";
import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks";
import { useComposerDraftStore } from "@/stores/composer";
import {
  getActiveRuntime,
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { Cloud, CloudUpload, Paperclip, Send, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MentionMenu } from "./MentionMenu";
import { AttachmentChips } from "./message-input/AttachmentChips";
import type { PendingAttachment } from "./message-input/composerAttachments";
import { useComposerDrop } from "./message-input/useComposerDrop";
import { useComposerSend } from "./message-input/useComposerSend";
import { useMentionMenu } from "./message-input/useMentionMenu";

export function MessageInput() {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isGenerating = useActiveGenerating();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const [isLocal, setIsLocal] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(false);

  const mention = useMentionMenu({
    conversationId,
    value,
    setValue,
    attachments,
    setAttachments,
    textareaRef,
  });

  const drop = useComposerDrop(isGenerating, attachments, setAttachments);

  const { handleSend } = useComposerSend({
    value,
    setValue,
    attachments,
    setAttachments,
    isGenerating,
    backgroundMode,
    isLocal,
    closeMenu: mention.closeMenu,
  });

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: value is an intentional re-run key
  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const draftToken = useComposerDraftStore((s) => s.token);
  useEffect(() => {
    if (draftToken === 0) return;
    const { text, mode } = useComposerDraftStore.getState();
    setValue((v) => (mode === "append" && v.trim() ? `${v}\n${text}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draftToken]);

  useEffect(() => {
    if (!conversationId) {
      setIsLocal(false);
      setBackgroundMode(false);
      return;
    }
    let cancelled = false;
    void useBackgroundTasksStore
      .getState()
      .ensureMode(conversationId)
      .then((mode) => {
        if (cancelled) return;
        const local = mode === "local";
        setIsLocal(local);
        if (!local) setBackgroundMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setValue(text);
      mention.syncMention(text, e.target.selectionStart ?? text.length);
    },
    [mention],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const stopGeneration = useCallback(() => {
    useConversationStore.getState().stopGeneration();
  }, []);

  useEffect(() => {
    return () => {
      getActiveRuntime().abort?.abort();
      drop.disposeDropTimer();
    };
  }, [drop]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (mention.menuMode && mention.handleMenuNavKey(e)) return;

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setValue((v) => `${v}\n`);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const charCount = value.length;
  const menuOpen = mention.menuMode !== null;

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className={`relative rounded-xl border bg-card shadow-sm transition-colors ${
          drop.dragOver ? "border-primary ring-2 ring-primary/40" : "border-border"
        }`}
        onDragOver={drop.handleDragOver}
        onDragLeave={drop.handleDragLeave}
        onDrop={drop.handleDrop}
      >
        {drop.dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/80 text-sm font-medium text-primary">
            拖放文件以添加为附件
          </div>
        )}
        {drop.dropError && (
          <div className="px-3 pt-2 text-xs text-destructive">{drop.dropError}</div>
        )}
        {menuOpen && (
          <MentionMenu
            items={mention.items}
            activeIndex={mention.activeIndex}
            loading={mention.indexLoading}
            error={mention.menuError}
            query={mention.query}
            showSearch={mention.menuMode === "browse"}
            noRoots={mention.indexLoadedRef.current && mention.sourceCount === 0}
            onQueryChange={mention.setQuery}
            onKeyDown={(e) => {
              mention.handleMenuNavKey(e);
            }}
            onSelect={(entry) => void mention.attachEntry(entry)}
            onHover={mention.setActiveIndex}
            onAddRoot={mention.handleAddRoot}
            searchInputRef={mention.searchInputRef}
          />
        )}

        <AttachmentChips attachments={attachments} onRemove={removeAttachment} />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={(e) =>
            mention.syncMention(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? 0,
            )
          }
          placeholder={
            backgroundMode
              ? "描述要交给云端团队后台完成的任务…"
              : "输入消息，@ 引用文件…"
          }
          disabled={isGenerating}
          className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          rows={1}
        />
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-1">
            {!conversationId && <DraftWorkspacePicker />}
            <IconButton
              size="md"
              onClick={mention.openBrowse}
              disabled={isGenerating}
              aria-label="附加文件"
              className={
                mention.menuMode === "browse"
                  ? "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground"
                  : undefined
              }
            >
              <Paperclip size={16} />
            </IconButton>
            {isLocal && (
              <SimpleTooltip
                label={
                  backgroundMode
                    ? "已切到「后台云端」：发送会把任务交给云端团队后台跑"
                    : "切到「后台云端」：把任务交给云端团队后台跑，结果回来再应用"
                }
              >
                <IconButton
                  size="md"
                  onClick={() => setBackgroundMode((v) => !v)}
                  disabled={isGenerating}
                  aria-label="切换后台云端任务"
                  aria-pressed={backgroundMode}
                  className={
                    backgroundMode
                      ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                      : undefined
                  }
                >
                  <Cloud size={16} />
                </IconButton>
              </SimpleTooltip>
            )}
          </div>
          <div className="flex items-center gap-3">
            {charCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {charCount}字
              </span>
            )}
            {isGenerating ? (
              <IconButton
                size="md"
                tone="destructive"
                onClick={stopGeneration}
                aria-label="停止生成"
              >
                <Square size={14} />
              </IconButton>
            ) : (
              <IconButton
                size="md"
                tone="primary"
                onClick={() => void handleSend()}
                disabled={!value.trim()}
                aria-label={backgroundMode ? "派发到云端后台" : "发送"}
              >
                {backgroundMode ? (
                  <CloudUpload size={14} />
                ) : (
                  <Send size={14} />
                )}
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
