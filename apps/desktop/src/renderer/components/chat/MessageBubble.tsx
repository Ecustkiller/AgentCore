import { copyText } from "@/lib/clipboard";
import { formatCost, formatMessageTime } from "@/lib/format";
import { runRegenerate } from "@/services/turns";
import { downloadWorkspaceFile } from "@/services/workspace";
import {
  type Message,
  type MessageAttachmentMeta,
  getActiveRuntime,
  useActiveGenerating,
  useActiveMessageFocus,
  useConversationStore,
} from "@/stores/conversation";
import { useUsageStore } from "@/stores/usage";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Folder,
  Paperclip,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { InlineTeamGraph } from "./InlineTeamGraph";
import { Markdown } from "./Markdown";
import { type CitationFlash, SourceCards } from "./SourceCards";

interface Props {
  message: Message;
}

/** Small icon+label action shown beneath a message on hover. */
function MessageAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Subtle, hover-revealed message timestamp (§二); full datetime on hover. */
function MessageTime({ iso }: { iso: string }) {
  const label = formatMessageTime(iso);
  if (!label) return null;
  return (
    <span
      title={new Date(iso).toLocaleString()}
      className="ml-1 cursor-default text-xs text-muted-foreground/60"
    >
      {label}
    </span>
  );
}

function useCopyAction(getText: () => string) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(getText())) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return { copied, onCopy };
}

/**
 * Collapsible panel showing the model's thinking (reasoning_content).
 *
 * Default-expands while the reasoning is still streaming so the user sees the
 * model think live, then auto-collapses once the turn finishes. Manual toggles
 * are always respected.
 */
function ThinkingPanel({
  reasoning,
  isStreaming,
}: {
  reasoning: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(isStreaming);
  const prevStreaming = useRef(isStreaming);

  useEffect(() => {
    if (prevStreaming.current && !isStreaming) setExpanded(false);
    prevStreaming.current = isStreaming;
  }, [isStreaming]);

  return (
    <div className="mb-2 rounded-lg border border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <Brain size={14} className="shrink-0" />
        <span>{isStreaming ? "正在思考…" : "思考过程"}</span>
        {expanded ? (
          <ChevronDown size={14} className="ml-auto shrink-0" />
        ) : (
          <ChevronRight size={14} className="ml-auto shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="whitespace-pre-wrap border-t border-border px-3 py-2 text-sm text-muted-foreground">
          {reasoning}
        </div>
      )}
    </div>
  );
}

/**
 * One attachment pill under a user message.
 *
 * A resident file attachment (附件驻留 — it carries a `workspacePath`) renders as
 * a download button that pulls the saved copy from the workspace; directories and
 * legacy/un-resident attachments stay as static labels.
 */
function AttachmentChip({
  att,
  conversationId,
}: {
  att: MessageAttachmentMeta;
  conversationId: string | null;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const downloadable =
    att.kind !== "dir" && !!att.workspacePath && !!conversationId;

  const base =
    "inline-flex max-w-[220px] items-center gap-1.5 rounded-lg bg-accent px-2 py-1 text-xs text-accent-foreground";
  const icon =
    att.kind === "dir" ? (
      <Folder size={12} className="shrink-0" />
    ) : (
      <Paperclip size={12} className="shrink-0" />
    );
  const label = (
    <>
      <span className="truncate">
        {att.name}
        {att.kind === "dir" ? "/" : ""}
      </span>
      {att.truncated && (
        <span className="shrink-0 text-muted-foreground">
          {att.kind === "dir" ? "部分" : "已截断"}
        </span>
      )}
    </>
  );

  if (!downloadable) {
    return (
      <span title={att.path} className={base}>
        {icon}
        {label}
      </span>
    );
  }

  const onDownload = async () => {
    if (state === "loading") return;
    setState("loading");
    try {
      await downloadWorkspaceFile(
        conversationId as string,
        att.workspacePath as string,
        att.name,
      );
      setState("idle");
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={onDownload}
      title={state === "error" ? "下载失败，点击重试" : `下载 ${att.name}`}
      className={`${base} transition-colors hover:bg-accent/70 ${
        state === "error" ? "text-destructive" : ""
      }`}
    >
      {icon}
      {label}
      <Download
        size={12}
        className={`shrink-0 ${state === "loading" ? "animate-pulse" : "opacity-60"}`}
      />
    </button>
  );
}

function UserMessage({ message }: Props) {
  const isGenerating = useActiveGenerating();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const { copied, onCopy } = useCopyAction(() => message.content);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const attachments = message.attachments ?? [];

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };

  useEffect(() => {
    if (editing) {
      const el = editRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
        el.style.height = "0";
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
      }
    }
  }, [editing]);

  const submitEdit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setEditing(false);
    if (trimmed === message.content) return;
    useConversationStore
      .getState()
      .updateMessage(message.id, { content: trimmed });
    void runRegenerate(message.id, trimmed);
  };

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-2">
        <div className="w-full max-w-[80%] rounded-xl rounded-br-none border border-border bg-card p-2">
          <textarea
            ref={editRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "0";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 240)}px`;
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submitEdit();
              }
            }}
            className="w-full resize-none bg-transparent px-2 py-1 text-sm text-foreground focus:outline-none"
            rows={1}
          />
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X size={13} />
              <span>取消</span>
            </button>
            <button
              type="button"
              onClick={submitEdit}
              disabled={!draft.trim()}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-primary px-2 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              <Check size={13} />
              <span>发送</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end gap-1.5">
      {attachments.length > 0 && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              att={a}
              conversationId={conversationId}
            />
          ))}
        </div>
      )}
      <div className="max-w-[80%] rounded-xl rounded-br-none bg-secondary px-4 py-3 text-sm text-secondary-foreground">
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
      {!isGenerating && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <MessageAction
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
            label={copied ? "已复制" : "复制"}
            onClick={onCopy}
          />
          <MessageAction
            icon={<Pencil size={13} />}
            label="编辑"
            onClick={startEdit}
          />
          <MessageTime iso={message.createdAt} />
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ message }: Props) {
  const isGenerating = useActiveGenerating();
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const loadMessageCost = useUsageStore((s) => s.loadMessageCost);
  // 回落快照: a reloaded turn carries no live `message.cost`; its persisted total
  // comes from the ledger cache (fetched on hover below).
  const cachedTotal = useUsageStore(
    (s) => s.messageCosts[message.id]?.cost.total ?? null,
  );
  const { copied, onCopy } = useCopyAction(() => message.content);
  const hasReasoning =
    !!message.reasoning && message.reasoning.trim().length > 0;
  const citations = message.citations ?? [];
  // 回合成本 caption (§7.3A) — single-agent turns only. A multi-agent turn stamps
  // `executionId`, so its cost shows on the team card instead (avoids double
  // display). Live cost wins; a reloaded turn falls back to the ledger snapshot.
  // 0 / unknown shows nothing, never「¥0.00」(§7.5).
  const turnTotal = message.cost?.total ?? cachedTotal;
  const costText =
    message.executionId === null && turnTotal != null && turnTotal > 0
      ? formatCost(turnTotal, cnyPerUsd)
      : null;

  // The caption is hover-revealed, so only a hovered reloaded turn pays for its
  // ledger fetch (live turns already carry their cost and skip this).
  const onPeekCost = () => {
    if (!message.isStreaming && message.cost == null) {
      void loadMessageCost(message.id);
    }
  };

  // Clicking an inline `[n]` chip flashes the matching source card. The nonce
  // makes re-clicking the same marker re-trigger the scroll/highlight.
  const [citeFlash, setCiteFlash] = useState<CitationFlash | null>(null);
  const onCitationClick = useCallback((n: number) => {
    setCiteFlash((prev) => ({ index: n, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const handleRegenerate = () => {
    const msgs = getActiveRuntime().messages;
    const idx = msgs.findIndex((m) => m.id === message.id);
    if (idx <= 0) return;
    let userId: string | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        userId = msgs[i].id;
        break;
      }
    }
    if (userId) void runRegenerate(userId);
  };

  return (
    <div className="group min-w-0" onMouseEnter={onPeekCost}>
      {hasReasoning && (
        <ThinkingPanel
          reasoning={message.reasoning ?? ""}
          isStreaming={message.isStreaming}
        />
      )}
      {message.executionId && (
        <InlineTeamGraph
          messageId={message.id}
          executionId={message.executionId}
          journal={message.runs}
        />
      )}
      <Markdown
        content={message.content}
        citationCount={citations.length}
        onCitationClick={onCitationClick}
      />
      {message.isStreaming && (
        <span
          className="mt-1 inline-block h-4 w-1.5 rounded-full bg-foreground/60"
          style={{ animation: "blink-cursor 0.8s step-end infinite" }}
        />
      )}
      {citations.length > 0 && (
        <SourceCards citations={citations} flash={citeFlash} />
      )}
      {!message.isStreaming && !isGenerating && message.content.length > 0 && (
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <MessageAction
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
            label={copied ? "已复制" : "复制"}
            onClick={onCopy}
          />
          <MessageAction
            icon={<RefreshCw size={13} />}
            label="重新生成"
            onClick={handleRegenerate}
          />
          {costText && (
            <span className="ml-1 text-xs text-muted-foreground/70">
              {costText}
            </span>
          )}
          <MessageTime iso={message.createdAt} />
        </div>
      )}
    </div>
  );
}

export function MessageBubble({ message }: Props) {
  const focus = useActiveMessageFocus();
  const ref = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);

  // Cross-component focus (e.g. the collaboration graph's CEO synthesis node
  // jumping to this turn's final answer): scroll this message into view and
  // flash a ring. The nonce dependency re-triggers when the same message is
  // focused again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus.nonce is an intentional re-run key (re-focusing the same message must re-flash); it is not read in the body.
  useEffect(() => {
    if (focus?.id !== message.id) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [focus?.id, focus?.nonce, message.id]);

  return (
    <div
      ref={ref}
      className={`scroll-mt-6 rounded-xl transition-shadow ${
        flash ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
      }`}
    >
      {message.role === "user" ? (
        <UserMessage message={message} />
      ) : (
        <AssistantMessage message={message} />
      )}
    </div>
  );
}
