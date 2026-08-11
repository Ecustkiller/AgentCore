import { DraftWorkspaceAssignPrompt } from "@/components/chat/DraftWorkspaceAssignPrompt";
import { MentionMenu } from "@/components/chat/MentionMenu";
import { Button, IconButton } from "@/components/ui";
import { useConversations } from "@/hooks/useConversations";
import { useFolders } from "@/hooks/useFolders";
import { hasLocalFiles } from "@/lib/capabilities";
import {
  COMPOSER_CONTINUE_PLACEHOLDER,
  COMPOSER_EMPTY_INTERRUPTED_HINT,
  isContinuableAssistant,
  isEmptyInterruptedAssistant,
} from "@/lib/composerContinueHint";
import { cn } from "@/lib/utils";
import {
  useBackgroundTasksStore,
  useHandoffArmed,
} from "@/stores/backgroundTasks";
import { draftKeyFor, useComposerDraftStore } from "@/stores/composer";
import {
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import {
  usePendingApprovals,
  usePendingDelegations,
} from "@/stores/interactions";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import { useServerHealthStore } from "@/stores/serverHealth";
import {
  CloudUpload,
  ListPlus,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import type { ChangeEvent, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttachmentChips } from "./AttachmentChips";
import { ComposerCloudBridgeHint } from "./ComposerCloudBridgeHint";
import { ComposerContextCompactedHint } from "./ComposerContextCompactedHint";
import { ComposerGitStatusChip } from "./ComposerGitStatusChip";
import { ComposerNoLocalChip } from "./ComposerNoLocalChip";
import { ComposerPendingHintNotice } from "./ComposerPendingHintNotice";
import { ComposerPlusMenu, useComposerPlusClose } from "./ComposerPlusMenu";
import { ComposerWorkspaceChip } from "./ComposerWorkspaceChip";
import { ModelPicker } from "./ModelPicker";
import { PermissionAxesBadge } from "./PermissionPresetBadge";
import { RecordingBar } from "./RecordingBar";
import { ComposerConnectionNotice } from "./ServerStatusIndicator";
import { VoiceButton } from "./VoiceButton";
import type {
  PendingAgentMention,
  PendingAttachment,
} from "./composerAttachments";
import { composerHasSendableDraft } from "./composerAttachments";
import { useComposerDrop } from "./useComposerDrop";
import { useComposerSend } from "./useComposerSend";
import type { AttachmentProjectHint } from "./useMentionMenu";
import { useMentionMenu } from "./useMentionMenu";
import { useVoiceInput } from "./useVoiceInput";

const EMPTY_ATTACHMENTS: PendingAttachment[] = [];
const EMPTY_AGENT_MENTIONS: PendingAgentMention[] = [];

// 输入框自增高边界：card 空/单行草稿保底 ~2 行（text-sm 20px 行高 + pt-3/pb-1 = 56px）；
// bar 默认一行高（20px 行高 + py-2 = 36px）。上限 200px 后转内部滚动。
const MIN_COMPOSER_HEIGHT_CARD = 56;
const MIN_COMPOSER_HEIGHT_BAR = 36;
const MAX_COMPOSER_HEIGHT = 200;

/** Align with backend `MessageCreate.content` max_length. */
const MESSAGE_CHAR_LIMIT = 32_000;
/** Show the counter only when the draft is near the limit (bar mode). */
const CHAR_COUNT_NEAR_LIMIT = 28_000;

export type TurnComposerVariant = "card" | "bar";

/**
 * The ONE turn composer (统一 AI 输入框): the full-featured card — auto-growing
 * textarea, @ 文件引用 + 回形针浏览, drag-drop attachments, 停止生成,
 * char count, 回填 channel — shared by BOTH surfaces that give the team an order:
 * the chat view's {@link import("../MessageInput").MessageInput} and the canvas
 * 命令栏 {@link import("../../graph/CanvasCommandBar").CanvasCommandBar}. 下达指令 is
 * the same act in both views, so it is the same component; hosts only pick chrome
 * (placeholder, canvas follow hook, whether legacy handoff arm applies).
 *
 * `variant="bar"` is the compact single-row chrome used only by the chat bottom dock:
 * `[＋]` · textarea · 语音 · 发送；工作区/Git/模型/权限/附件收进＋菜单（遗留 handoff
 * 武装在 ModeControl，不在「＋」）。
 * default `card` keeps textarea-above-toolbar（居中草稿 + 画布指挥台），左簇摊开。
 * 离线态靠 {@link ComposerConnectionNotice} 与发送硬禁，不再用安静连接绿点。
 *
 * Draft state (text + attachments) lives in {@link useComposerDraftStore} keyed by
 * conversation, NOT in component state — switching 聊天 ⇄ 画布 swaps the mounted skin
 * but keeps the half-typed order, and 回填 (ask card / run-detail / debate) lands in the
 * draft even across that swap. The textarea stays typable while a turn is generating
 * (queue up the next order); only sending is gated, with 停止 in the send slot.
 *
 * Draft-conversation-only concerns (workspace picker, attachment→project hint) are
 * self-gated on `!conversationId`, so they never render on the canvas (which always
 * has a conversation).
 */
export function TurnComposer({
  placeholder = "输入消息，@ 引用文件或点名角色…",
  allowBackground = true,
  onDispatch,
  variant = "card",
  attachedBelowApproval = false,
}: {
  placeholder?: string;
  /**
   * Honor ModeControl legacy handoff arm (still requires a local-mode conversation).
   * No Composer「＋」toggle — arming lives in WorkspaceModeMenu.
   */
  allowBackground?: boolean;
  /** Called when a foreground turn is dispatched (canvas uses it to auto-follow). */
  onDispatch?: () => void;
  /**
   * `card` = textarea above toolbar (default; center draft + canvas).
   * `bar` = compact dock: ＋菜单收纳左簇，常显仅输入与发送。
   */
  variant?: TurnComposerVariant;
  /** Visually fuse with ApprovalPrompt stacked above (工具审批 A · Composer 一体). */
  attachedBelowApproval?: boolean;
}) {
  const isBar = variant === "bar";
  const minComposerHeight = isBar
    ? MIN_COMPOSER_HEIGHT_BAR
    : MIN_COMPOSER_HEIGHT_CARD;
  const isGenerating = useActiveGenerating();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const conversations = useConversations();
  const contextCompacted = Boolean(
    conversationId &&
      conversations.find((c) => c.id === conversationId)?.contextCompacted,
  );
  const hasPausedDecision = usePausedTurnStore((s) =>
    conversationId
      ? s.pending.some((p) => p.conversationId === conversationId)
      : false,
  );
  const pendingApprovals = usePendingApprovals(conversationId);
  const pendingDelegations = usePendingDelegations(conversationId);
  const lastMessage = useConversationStore((s) => {
    const id = s.currentConversationId;
    if (!id) return null;
    return s.byId[id]?.messages.at(-1) ?? null;
  });
  const showPendingHint =
    !!conversationId &&
    !isGenerating &&
    (hasPausedDecision ||
      pendingApprovals.length > 0 ||
      pendingDelegations.length > 0);
  // 空中断层 1：轻提示、无按钮；有挂起卡时优先挂起弱提示。
  const showEmptyInterruptedHint =
    !isGenerating &&
    !showPendingHint &&
    isEmptyInterruptedAssistant(lastMessage);
  const serverStatus = useServerHealthStore((s) => s.status);
  const serverUnhealthy = serverStatus === "offline";
  const resolvedPlaceholder = useMemo(() => {
    if (!isGenerating && isContinuableAssistant(lastMessage)) {
      return COMPOSER_CONTINUE_PLACEHOLDER;
    }
    return placeholder;
  }, [isGenerating, lastMessage, placeholder]);
  const draftKey = draftKeyFor(conversationId);
  const value = useComposerDraftStore((s) => s.drafts[draftKey]?.value ?? "");
  const attachments = useComposerDraftStore(
    (s) => s.drafts[draftKey]?.attachments ?? EMPTY_ATTACHMENTS,
  );
  const agentMentions = useComposerDraftStore(
    (s) => s.drafts[draftKey]?.agentMentions ?? EMPTY_AGENT_MENTIONS,
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
  const setAgentMentions = useCallback(
    (action: SetStateAction<PendingAgentMention[]>) =>
      useComposerDraftStore.getState().setAgentMentions(draftKey, action),
    [draftKey],
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isLocal, setIsLocal] = useState(false);
  const handoffArmed = useHandoffArmed(conversationId);
  const folders = useFolders();
  const draftIntent = useFoldersStore((s) => s.draftWorkspaceIntent);
  const pendingFolderId =
    draftIntent.kind === "project" ? draftIntent.folderId : null;
  const dismissedAssignRef = useRef<Set<string>>(new Set());
  const [assignHint, setAssignHint] = useState<AttachmentProjectHint | null>(
    null,
  );

  const handleAttachmentProjectHint = useCallback(
    (hint: AttachmentProjectHint) => {
      const store = useFoldersStore.getState();
      const intent = store.draftWorkspaceIntent;
      if (intent.kind === "project" && intent.folderId === hint.folderId) {
        return;
      }
      if (
        intent.kind !== "project" &&
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
    agentMentions,
    setAgentMentions,
    textareaRef,
    onAttachmentProjectHint: conversationId
      ? undefined
      : handleAttachmentProjectHint,
  });

  const drop = useComposerDrop(
    isGenerating,
    attachments,
    setAttachments,
    conversationId,
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  const onPaperclipClick = useCallback(() => {
    if (hasLocalFiles()) {
      void mention.pickLocalFile();
    } else {
      fileInputRef.current?.click();
    }
  }, [mention.pickLocalFile]);

  const onBrowserFilesSelected = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      for (const f of files) await drop.attachDroppedFile(f);
    },
    [drop.attachDroppedFile],
  );

  const voice = useVoiceInput({
    onTranscript: useCallback(
      (text: string) => {
        setValue((prev) => prev + text);
      },
      [setValue],
    ),
  });

  const { handleSend } = useComposerSend({
    value,
    setValue,
    attachments,
    setAttachments,
    agentMentions,
    setAgentMentions,
    isGenerating,
    backgroundMode: allowBackground && isLocal && handoffArmed,
    isLocal,
    closeMenu: mention.closeMenu,
    onDispatch,
  });

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.min(
      Math.max(el.scrollHeight, minComposerHeight),
      MAX_COMPOSER_HEIGHT,
    )}px`;
  }, [minComposerHeight]);

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
    useFoldersStore.getState().setDraftWorkspaceIntent({
      kind: "project",
      folderId: assignHint.folderId,
    });
    setAssignHint(null);
  }, [assignHint]);

  const dismissAssignHint = useCallback(() => {
    if (!assignHint) return;
    dismissedAssignRef.current.add(assignHint.folderId);
    setAssignHint(null);
  }, [assignHint]);

  // Legacy handoff gate: only local-mode conversations can dispatch a cloud copy
  // job. Arming is ModeControl-only; resolve mode so send honors the arm.
  useEffect(() => {
    if (!allowBackground || !conversationId) {
      setIsLocal(false);
      return;
    }
    let cancelled = false;
    void useBackgroundTasksStore
      .getState()
      .ensureMode(conversationId)
      .then((mode) => {
        if (cancelled) return;
        setIsLocal(mode === "local");
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
      // Soft drop errors dismiss on next edit (industry: ephemeral, not form-sticky).
      if (drop.dropError) drop.clearDropError();
    },
    [drop, mention, setValue],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    },
    [setAttachments],
  );

  const removeAgentMention = useCallback(
    (id: string) => {
      setAgentMentions((prev) => prev.filter((a) => a.id !== id));
    },
    [setAgentMentions],
  );

  const stopGeneration = useCallback(() => {
    useConversationStore.getState().stopGeneration();
  }, []);

  useEffect(() => {
    if (voice.isRecording) mention.closeMenu();
  }, [voice.isRecording, mention.closeMenu]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        !(e.ctrlKey || e.metaKey) ||
        !e.shiftKey ||
        e.key.toLowerCase() !== "v"
      )
        return;
      if (!voice.isSupported) return;
      e.preventDefault();
      voice.toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [voice.isSupported, voice.toggle]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (voice.isRecording) {
      if (e.key === "Escape") {
        e.preventDefault();
        voice.cancel();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        voice.stop();
        return;
      }
    }

    if (mention.menuMode && mention.handleMenuNavKey(e)) return;

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // 生成中强制 steer（插队）；空闲与 Enter 同路径（默认 steer），勿伪装传 queue。
      if (serverUnhealthy) return;
      if (isGenerating) {
        void handleSend({ delivery: "steer" });
      } else {
        void handleSend();
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // N4-A：离线硬禁用（与发送按钮一致；handleSend 仍有兜底）。
      if (serverUnhealthy) return;
      // 空闲默认 steer；生成中默认 queue（排队）。插队见 Ctrl/Cmd+Enter / 「插队」。
      void handleSend();
    }
  };

  const charCount = value.length;
  const menuOpen = mention.menuMode !== null;
  const bg = allowBackground && isLocal && handoffArmed;
  const showCharCount = isBar
    ? charCount >= CHAR_COUNT_NEAR_LIMIT
    : charCount > 0;

  // 左簇顺序：工作区 · Git? · 网页无本机? · 模型 · 权限 · 附件
  // bar：整簇收进 ComposerPlusMenu（权限/附件带文案）；card：底栏摊开（iconOnly）。
  // 否决 Composer 并排「本地引擎/云端过桥」切换器；过桥事后弱提示见 ComposerCloudBridgeHint。
  // 遗留 handoff 武装在 ModeControl，不进「＋」。
  const sessionChrome = (
    <>
      <ComposerWorkspaceChip conversationId={conversationId} />
      <ComposerGitStatusChip conversationId={conversationId} />
      <ComposerNoLocalChip />
      <ModelPicker disabled={isGenerating} />
      <PermissionAxesBadge disabled={isGenerating} iconOnly={!isBar} />
    </>
  );

  const attachButton = (
    <ComposerAttachButton
      disabled={isGenerating}
      onAttach={onPaperclipClick}
      iconOnly={!isBar}
    />
  );

  const leftCluster = (
    <>
      {sessionChrome}
      {attachButton}
    </>
  );

  // 生成中：停止常显（对齐手机 send+stop 并存）；有草稿时再加「插队」次级 +「排队」主键。
  // 插队 = 显式 steer（下一步生效），不把主槽改成 Stop&send。
  // N4-A：只读离线硬禁用发送。
  const sendBlocked = serverUnhealthy;
  const hasDraft = composerHasSendableDraft(value, attachments);
  const queueDisabled = !hasDraft || sendBlocked;
  const midFlightLabel = "排队发送";
  const midFlightHint = "排队至本回合结束后发送（Enter）；Ctrl/Cmd+Enter 插队";
  const stopButton = (
    <IconButton
      size="sm"
      tone="destructive"
      onClick={stopGeneration}
      aria-label="停止生成"
      title="停止生成"
    >
      <Square size={16} />
    </IconButton>
  );
  const sendControls = isGenerating ? (
    hasDraft ? (
      <div className="flex items-center gap-1.5">
        <Button
          variant="neutral"
          size="sm"
          className="border-border text-foreground"
          onClick={() => void handleSend({ delivery: "steer" })}
          disabled={queueDisabled}
          aria-label="插队"
          title={
            sendBlocked
              ? "离线时无法发送"
              : "插队：下一步生效（Ctrl/Cmd+Enter）；协调模式下 CEO 仍可能改排队"
          }
          data-testid="composer-steer-link"
        >
          插队
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<ListPlus size={14} aria-hidden />}
          onClick={() => void handleSend()}
          disabled={queueDisabled}
          aria-label={midFlightLabel}
          title={sendBlocked ? "离线时无法发送" : midFlightHint}
        >
          排队
        </Button>
        {stopButton}
      </div>
    ) : (
      stopButton
    )
  ) : (
    <IconButton
      size="sm"
      tone="primary"
      onClick={() => void handleSend()}
      disabled={!hasDraft || sendBlocked}
      aria-label={bg ? "派发到云端后台" : "发送"}
      title={sendBlocked ? "离线时无法发送" : undefined}
    >
      {bg ? <CloudUpload size={16} /> : <Send size={16} />}
    </IconButton>
  );

  const textareaBlock = (
    <div className="relative min-w-0 flex-1">
      {voice.isRecording && voice.interimText && (
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 overflow-hidden text-sm whitespace-pre-wrap break-words ${
            isBar ? "px-2 py-2" : "px-4 pt-3 pb-1"
          }`}
        >
          <span className="invisible">{value}</span>
          <span className="text-foreground/40">{voice.interimText}</span>
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
        placeholder={
          bg ? "描述要交给云端团队后台完成的任务…" : resolvedPlaceholder
        }
        className={`block w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none ${
          isBar ? "px-2 py-2" : "px-4 pt-3 pb-1"
        }`}
        rows={isBar ? 1 : 2}
        maxLength={MESSAGE_CHAR_LIMIT}
      />
    </div>
  );

  return (
    <div
      className={`relative border bg-card shadow-sm transition-colors ${
        attachedBelowApproval
          ? "rounded-b-xl rounded-t-none border-t-0"
          : "rounded-xl"
      } ${
        drop.dragOver
          ? "border-primary ring-2 ring-primary/40"
          : "border-border"
      }`}
      onDragOver={drop.handleDragOver}
      onDragLeave={drop.handleDragLeave}
      onDrop={drop.handleDrop}
      data-composer-variant={variant}
      data-composer-attached-approval={
        attachedBelowApproval ? "true" : undefined
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void onBrowserFilesSelected(e)}
      />
      {drop.dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/80 text-sm font-medium text-primary">
          拖放文件以添加为附件
        </div>
      )}
      {drop.dropError && (
        <output
          aria-live="polite"
          className="flex items-start gap-2 px-3 pt-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1">{drop.dropError}</span>
          <button
            type="button"
            className="shrink-0 rounded-lg p-0.5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="关闭提示"
            onClick={drop.clearDropError}
          >
            <X size={12} />
          </button>
        </output>
      )}
      {menuOpen && (
        <MentionMenu
          sections={mention.sections}
          flatItems={mention.flatItems}
          activeIndex={mention.activeIndex}
          loading={mention.indexLoading}
          error={mention.menuError}
          query={mention.query}
          showSearch={mention.menuMode === "browse"}
          noFileSources={
            mention.indexLoadedRef.current && mention.sourceCount === 0
          }
          onQueryChange={mention.setQuery}
          onKeyDown={(e) => {
            mention.handleMenuNavKey(e);
          }}
          onSelect={(item) => mention.selectItem(item)}
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

      <AttachmentChips
        attachments={attachments}
        agentMentions={agentMentions}
        onRemove={removeAttachment}
        onRemoveAgent={removeAgentMention}
      />

      {/* 断连提示：仅在心跳判定服务器不可达时出现，主动告知「发送前」状态。 */}
      <ComposerConnectionNotice />

      {/* 本机绑定却本轮过桥：弱状态（非引擎切换器；强制关路径不展示）。 */}
      <ComposerCloudBridgeHint />

      {/* 会话字段徽章：较早对话已压缩（旗标 only，无摘要正文）。 */}
      <ComposerContextCompactedHint show={contextCompacted} />

      {/* 挂起弱提示：有待确认/续跑卡时常驻；不强拦发送（发送前二次确认见 useComposerSend）。 */}
      <ComposerPendingHintNotice show={showPendingHint} />

      {/* 空中断层 1：无救火按钮；发送下一条=新回合重试。 */}
      {showEmptyInterruptedHint && (
        <div
          aria-live="polite"
          data-testid="composer-empty-interrupted-hint"
          className="flex items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground"
        >
          {COMPOSER_EMPTY_INTERRUPTED_HINT}
        </div>
      )}

      {voice.isRecording && (
        <RecordingBar duration={voice.duration} onCancel={voice.cancel} />
      )}

      {isBar ? (
        <div className="flex items-end gap-1 px-2 py-1">
          <div className="flex shrink-0 items-center pb-0.5">
            <ComposerPlusMenu>
              {sessionChrome}
              {attachButton}
            </ComposerPlusMenu>
          </div>
          {textareaBlock}
          <div className="flex shrink-0 items-center gap-1 pb-0.5">
            {voice.isSupported && (
              <VoiceButton state={voice.state} onClick={voice.toggle} />
            )}
            {showCharCount && (
              <span className="text-xs text-muted-foreground">
                {charCount}/{MESSAGE_CHAR_LIMIT}
              </span>
            )}
            {sendControls}
          </div>
        </div>
      ) : (
        <>
          {textareaBlock}
          <div className="flex items-center justify-between px-4 pb-3">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {leftCluster}
            </div>
            <div className="flex items-center gap-3">
              {voice.isSupported && (
                <VoiceButton state={voice.state} onClick={voice.toggle} />
              )}
              {showCharCount && (
                <span className="text-xs text-muted-foreground">
                  {charCount}字
                </span>
              )}
              {sendControls}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 附件按钮：bar「＋」菜单内带文案；card 底栏仅图标。点菜单内项时先关菜单再选文件。 */
function ComposerAttachButton({
  disabled,
  onAttach,
  iconOnly = true,
}: {
  disabled?: boolean;
  onAttach: () => void;
  iconOnly?: boolean;
}) {
  const closePlus = useComposerPlusClose();
  const onClick = () => {
    closePlus?.();
    onAttach();
  };
  if (iconOnly) {
    return (
      <IconButton
        size="md"
        onClick={onClick}
        disabled={disabled}
        aria-label="附加文件"
      >
        <Paperclip size={16} />
      </IconButton>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="附加文件"
      className={cn(
        "inline-flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <Paperclip size={14} className="shrink-0" aria-hidden />
      <span>附加文件</span>
    </button>
  );
}
