import { DraftWorkspaceAssignPrompt } from "@/components/chat/DraftWorkspaceAssignPrompt";
import { DraftWorkspacePicker } from "@/components/chat/DraftWorkspacePicker";
import { MentionMenu } from "@/components/chat/MentionMenu";
import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useFolders } from "@/hooks/useFolders";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks";
import { draftKeyFor, useComposerDraftStore } from "@/stores/composer";
import {
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import {
  Cloud,
  CloudUpload,
  Loader2,
  Paperclip,
  Send,
  Square,
} from "lucide-react";
import type { SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AttachmentChips } from "./AttachmentChips";
import { ConversationInstructions } from "./ConversationInstructions";
import { ModelModePicker } from "./ModelModePicker";
import {
  ComposerConnectionNotice,
  ServerStatusIndicator,
} from "./ServerStatusIndicator";
import type { PendingAttachment } from "./composerAttachments";
import { useComposerDrop } from "./useComposerDrop";
import { useComposerSend } from "./useComposerSend";
import type { AttachmentProjectHint } from "./useMentionMenu";
import { useMentionMenu } from "./useMentionMenu";

const EMPTY_ATTACHMENTS: PendingAttachment[] = [];

/**
 * The ONE turn composer (统一 AI 输入框): the full-featured card — auto-growing
 * textarea, @ 文件引用 + 回形针浏览, drag-drop attachments, 后台云端 toggle, 停止生成,
 * char count, 回填 channel — shared by BOTH surfaces that give the team an order:
 * the chat view's {@link import("../MessageInput").MessageInput} and the canvas
 * 命令栏 {@link import("../../graph/CanvasCommandBar").CanvasCommandBar}. 下达指令 is
 * the same act in both views, so it is the same component; hosts only pick chrome
 * (placeholder, canvas follow hook, whether 后台云端 applies).
 *
 * Draft state (text + attachments) lives in {@link useComposerDraftStore} keyed by
 * conversation, NOT in component state — switching 聊天 ⇄ 画布 swaps the mounted skin
 * but keeps the half-typed order, and 回填 (ask card / 下一步推荐 chips) lands in the
 * draft even across that swap. The textarea stays typable while a turn is generating
 * (queue up the next order); only sending is gated, with 停止 in the send slot.
 *
 * Draft-conversation-only concerns (workspace picker, attachment→project hint) are
 * self-gated on `!conversationId`, so they never render on the canvas (which always
 * has a conversation).
 */
export function TurnComposer({
  placeholder = "输入消息，@ 引用文件…",
  allowBackground = true,
  onDispatch,
}: {
  placeholder?: string;
  /** Offer the 后台云端 toggle (still requires a local-mode conversation). */
  allowBackground?: boolean;
  /** Called when a foreground turn is dispatched (canvas uses it to auto-follow). */
  onDispatch?: () => void;
}) {
  const isGenerating = useActiveGenerating();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const draftKey = draftKeyFor(conversationId);
  const value = useComposerDraftStore((s) => s.drafts[draftKey]?.value ?? "");
  const attachments = useComposerDraftStore(
    (s) => s.drafts[draftKey]?.attachments ?? EMPTY_ATTACHMENTS,
  );
  const setValue = useCallback(
    (action: SetStateAction<string>) =>
      useComposerDraftStore.getState().setValue(draftKey, action),
    [draftKey],
  );
  const setAttachments = useCallback(
    (action: SetStateAction<PendingAttachment[]>) =>
      useComposerDraftStore.getState().setAttachments(draftKey, action),
    [draftKey],
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isLocal, setIsLocal] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(false);
  const folders = useFolders();
  const pendingFolderId = useFoldersStore((s) => s.pendingNewChatFolderId);
  const dismissedAssignRef = useRef<Set<string>>(new Set());
  const [assignHint, setAssignHint] = useState<AttachmentProjectHint | null>(
    null,
  );

  const handleAttachmentProjectHint = useCallback(
    (hint: AttachmentProjectHint) => {
      const store = useFoldersStore.getState();
      if (store.pendingNewChatFolderId === hint.folderId) return;
      if (
        !store.pendingNewChatFolderId &&
        !store.pendingNewChatCloud &&
        dismissedAssignRef.current.has(hint.folderId)
      ) {
        return;
      }
      setAssignHint(hint);
    },
    [],
  );

  const mention = useMentionMenu({
    conversationId,
    value,
    setValue,
    attachments,
    setAttachments,
    textareaRef,
    onAttachmentProjectHint: conversationId
      ? undefined
      : handleAttachmentProjectHint,
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
    onDispatch,
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

  // 回填 focus hint: the fill's text arrives through the store subscription; the token
  // only asks the mounted composer to refocus. Seeding the ref with the current token
  // makes a remount (view switch / navigation) ignore fills that happened before it.
  const fillToken = useComposerDraftStore((s) => s.fillToken);
  const seenFillRef = useRef(fillToken);
  useEffect(() => {
    if (fillToken === seenFillRef.current) return;
    seenFillRef.current = fillToken;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [fillToken]);

  useEffect(() => {
    if (!conversationId) {
      dismissedAssignRef.current = new Set();
    }
    setAssignHint(null);
  }, [conversationId]);

  useEffect(() => {
    if (assignHint && pendingFolderId === assignHint.folderId) {
      setAssignHint(null);
    }
  }, [assignHint, pendingFolderId]);

  const currentProjectName = pendingFolderId
    ? (folders.find((f) => f.id === pendingFolderId)?.name ?? null)
    : null;

  const acceptAssignHint = useCallback(() => {
    if (!assignHint) return;
    const store = useFoldersStore.getState();
    store.setPendingNewChatFolder(assignHint.folderId);
    store.setPendingNewChatCloud(false);
    setAssignHint(null);
  }, [assignHint]);

  const dismissAssignHint = useCallback(() => {
    if (!assignHint) return;
    dismissedAssignRef.current.add(assignHint.folderId);
    setAssignHint(null);
  }, [assignHint]);

  // 后台云端 gate: only local-mode conversations can hand off to a cloud team, so
  // resolve the bound mode (shared store, deduped) and show the toggle only then.
  useEffect(() => {
    if (!allowBackground || !conversationId) {
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
  }, [allowBackground, conversationId]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setValue(text);
      mention.syncMention(text, e.target.selectionStart ?? text.length);
    },
    [mention, setValue],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    },
    [setAttachments],
  );

  const stopGeneration = useCallback(() => {
    useConversationStore.getState().stopGeneration();
  }, []);

  // 生成中「回车想发送」的即时反馈：文案不变，短暂转 warning 强调——解释为什么没发出去。
  const [sendNudge, setSendNudge] = useState(false);
  const nudgeTimer = useRef<number | null>(null);
  const nudgeSend = useCallback(() => {
    setSendNudge(true);
    if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => setSendNudge(false), 1200);
  }, []);
  // 独立的仅卸载清理——不能挂进下面 [drop] 那个 effect：drop 每次渲染换新引用，其
  // cleanup 每轮渲染都跑，会把还没到点的 nudge 定时器掐掉（琥珀色提示永不复位）。
  useEffect(() => {
    return () => {
      if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      // 回合 AbortController 挂在会话 slice 上，由 stop 按钮 / sendTurn 自己管理。
      // 勿在组件卸载时 abort：首条消息会从 `/` navigate 到 `/conversations/:id`，
      // 两个 ConversationPage 实例会卸载再挂载 MessageInput——若此处 abort 会把
      // 刚发出的 POST 掐断（DB 0 消息 + UI 僵尸「正在思考」）。
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
      if (isGenerating) {
        if (value.trim()) nudgeSend();
        return;
      }
      void handleSend();
    }
  };

  const charCount = value.length;
  const menuOpen = mention.menuMode !== null;
  const showBackground = allowBackground && isLocal;
  const bg = showBackground && backgroundMode;

  return (
    <div
      className={`relative rounded-xl border bg-card shadow-sm transition-colors ${
        drop.dragOver
          ? "border-primary ring-2 ring-primary/40"
          : "border-border"
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
        <div className="px-3 pt-2 text-xs text-destructive">
          {drop.dropError}
        </div>
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

      {!conversationId && assignHint && (
        <DraftWorkspaceAssignPrompt
          attachmentProjectName={assignHint.folderName}
          currentProjectName={currentProjectName}
          onAssign={acceptAssignHint}
          onKeep={dismissAssignHint}
        />
      )}

      <AttachmentChips attachments={attachments} onRemove={removeAttachment} />

      {/* 断连提示：仅在心跳判定服务器不可达时出现，主动告知「发送前」状态。 */}
      <ComposerConnectionNotice />

      {/* 生成中排队提示：可打字、暂不可发。平时低调说明；按了 Enter 想发时短暂转
          warning 强调（sendNudge），解释「为什么没发出去 + 草稿不会丢」。 */}
      {isGenerating && value.trim() && (
        <div
          aria-live="polite"
          className={`flex items-center gap-1.5 px-4 pt-2 text-xs ${
            sendNudge ? "font-medium text-warning" : "text-muted-foreground"
          }`}
        >
          <Loader2 size={12} className="shrink-0 animate-spin" />
          {sendNudge
            ? "回合还在执行，暂不能发送——这条指令已留在草稿"
            : "回合执行中，可先写下一条指令，结束后发送"}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={drop.handlePaste}
        onSelect={(e) =>
          mention.syncMention(
            e.currentTarget.value,
            e.currentTarget.selectionStart ?? 0,
          )
        }
        placeholder={bg ? "描述要交给云端团队后台完成的任务…" : placeholder}
        className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        rows={1}
      />
      <div className="flex items-center justify-between px-4 pb-3">
        <div className="flex items-center gap-1">
          {!conversationId && <DraftWorkspacePicker />}
          {conversationId && (
            <ModelModePicker
              conversationId={conversationId}
              disabled={isGenerating}
            />
          )}
          {conversationId && (
            <ConversationInstructions
              conversationId={conversationId}
              disabled={isGenerating}
            />
          )}
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
          {showBackground && (
            <SimpleTooltip
              label={
                bg
                  ? "已切到「后台云端」：发送会把任务交给云端团队后台跑"
                  : "切到「后台云端」：把任务交给云端团队后台跑，结果回来再应用"
              }
            >
              <IconButton
                size="md"
                onClick={() => setBackgroundMode((v) => !v)}
                disabled={isGenerating}
                aria-label="切换后台云端任务"
                aria-pressed={bg}
                className={
                  bg
                    ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                    : undefined
                }
              >
                <Cloud size={16} />
              </IconButton>
            </SimpleTooltip>
          )}
          <ServerStatusIndicator />
        </div>
        <div className="flex items-center gap-3">
          {charCount > 0 && (
            <span className="text-xs text-muted-foreground">{charCount}字</span>
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
              aria-label={bg ? "派发到云端后台" : "发送"}
            >
              {bg ? <CloudUpload size={14} /> : <Send size={14} />}
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}
