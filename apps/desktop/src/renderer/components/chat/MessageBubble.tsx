import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { referencedCitationNumbers } from "@/lib/citations";
import { copyText } from "@/lib/clipboard";
import { errorActionForCode } from "@/lib/errors";
import { formatCompact, formatCost, formatMessageTime } from "@/lib/format";
import { groupToolRuns } from "@/lib/processTimeline";
import { notifyError } from "@/lib/toast";
import { deleteMessage, getMessagePrompt } from "@/services/messages";
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
import type { Citation, ProcessStep } from "@/types/events";
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Code2,
  Copy,
  Download,
  FileText,
  Folder,
  Globe,
  HelpCircle,
  KeyRound,
  type LucideIcon,
  Paperclip,
  PenLine,
  Pencil,
  RefreshCw,
  ScrollText,
  Search,
  Terminal,
  Trash2,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckpointCard } from "./CheckpointCard";
import { InlineTeamGraph } from "./InlineTeamGraph";
import { Markdown } from "./Markdown";
import { NonBlockingAskCard } from "./NonBlockingAskCard";
import { PlanReviewCard } from "./PlanReviewCard";
import { type CitationFlash, SourceCards } from "./SourceCards";
import {
  type ToolResultData,
  ToolResultView,
  hasToolResultBody,
  toolResultPeek,
} from "./toolResult/ToolResultView";

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

/**
 * Hover action that deletes a single message (单条消息删除).
 *
 * A hard delete with no undo (the row is removed server-side, then dropped from
 * the window), so it asks for an inline confirm first. A failed delete leaves the
 * message on screen and toasts. The append-only cost ledger is untouched
 * server-side — deleting a message never rewrites real spend.
 */
function DeleteMessageAction({ messageId }: { messageId: string }) {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const [confirming, setConfirming] = useState(false);

  const onDelete = async () => {
    setConfirming(false);
    if (!conversationId) return;
    try {
      await deleteMessage(conversationId, messageId);
    } catch (err) {
      notifyError(err, "删除失败");
    }
  };

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => void onDelete()}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
        >
          <Check size={13} />
          <span>确认删除</span>
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={13} />
          <span>取消</span>
        </button>
      </span>
    );
  }

  return (
    <MessageAction
      icon={<Trash2 size={13} />}
      label="删除"
      onClick={() => setConfirming(true)}
    />
  );
}

type PromptState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "empty" };

/**
 * Hover action that opens the turn's verbatim system prompt (查看本回合提示词, 提示词
 * 透明 L3 · 对所有人开放). Lazily fetches on open from the turn journal's head fact —
 * the exact prompt that steered THIS reply — and shows it verbatim with a copy button.
 * A turn that journaled no prompt (legacy / salvaged) reads as a graceful empty state.
 */
function ViewPromptAction({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PromptState>({ status: "loading" });
  const { copied, onCopy } = useCopyAction(() =>
    state.status === "ready" ? state.text : "",
  );

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setState({ status: "loading" });
      getMessagePrompt(conversationId, messageId)
        .then((text) => setState({ status: "ready", text }))
        .catch(() => setState({ status: "empty" }));
    }
  };

  return (
    <>
      <MessageAction
        icon={<ScrollText size={13} />}
        label="提示词"
        onClick={() => onOpenChange(true)}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>本回合系统提示词</DialogTitle>
            <DialogDescription>
              AI
              本回合实际遵循的逐字系统提示词（含当日日期、能力目录等动态内容）。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
            {state.status === "loading" && (
              <p className="py-8 text-center text-muted-foreground text-sm">
                加载中…
              </p>
            )}
            {state.status === "empty" && (
              <p className="py-8 text-center text-muted-foreground text-sm">
                本回合没有可查看的提示词。
              </p>
            )}
            {state.status === "ready" && (
              <div className="flex h-full min-h-0 flex-col">
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={onCopy}
                    className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 text-foreground/90 text-xs leading-relaxed">
                  {state.text}
                </pre>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Subtle, hover-revealed message timestamp (§二); full datetime on hover. */
function MessageTime({ iso }: { iso: string }) {
  const label = formatMessageTime(iso);
  if (!label) return null;
  return (
    <SimpleTooltip label={new Date(iso).toLocaleString()}>
      <span className="ml-1 cursor-default text-xs text-muted-foreground/60">
        {label}
      </span>
    </SimpleTooltip>
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

/** Three pulsing dots — the shared「正在思考」liveliness cue (图2 的 ● ● ●). */
function ThinkingDots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}

/**
 * Borderless disclosure header shared by {@link ThinkingPanel} and
 * {@link ProcessTimeline} (对齐 Cursor 的轻量内联思考样式).
 *
 * While streaming it shows the 图2 dots + a live label and no chevron — the dots
 * are the "live" cue and the panel auto-expands; a finished turn shows a chevron
 * + static label. The whole row is the toggle in both states.
 */
function ThinkingHeader({
  isStreaming,
  expanded,
  streamingLabel,
  doneLabel,
  onToggle,
}: {
  isStreaming: boolean;
  expanded: boolean;
  streamingLabel: string;
  doneLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {isStreaming ? (
        <>
          <ThinkingDots />
          <span>{streamingLabel}</span>
        </>
      ) : (
        <>
          {expanded ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight size={14} className="shrink-0" />
          )}
          <span>{doneLabel}</span>
        </>
      )}
    </button>
  );
}

/**
 * Collapsible panel showing the model's thinking (reasoning_content).
 *
 * Borderless & inline (Cursor 风格): default-expands while streaming so the user
 * watches it think live, then auto-collapses once the turn finishes. Manual
 * toggles always win. Used by multi-agent turns — the single-agent turn uses the
 * richer {@link ProcessTimeline} instead.
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
    <div className="mb-2">
      <ThinkingHeader
        isStreaming={isStreaming}
        expanded={expanded}
        streamingLabel="正在思考…"
        doneLabel="思考过程"
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div className="mt-1.5 pl-3">
          <Markdown content={reasoning} isStreaming={isStreaming} muted />
        </div>
      )}
    </div>
  );
}

/** Icon + 中文标签 for a builtin tool, by its backend name. Unknown tools fall
 * back to a generic wrench + the raw name, so a newly added tool still renders. */
const TOOL_META: Record<string, { Icon: LucideIcon; label: string }> = {
  web_search: { Icon: Search, label: "搜索网页" },
  read_url: { Icon: Globe, label: "读取网页" },
  grep: { Icon: Code2, label: "检索代码" },
  code_execute: { Icon: Terminal, label: "执行代码" },
  file_read: { Icon: FileText, label: "读取文件" },
  file_write: { Icon: FileText, label: "写入文件" },
  file_list: { Icon: Folder, label: "列出目录" },
  str_replace: { Icon: Pencil, label: "编辑文件" },
  file_delete: { Icon: Trash2, label: "删除文件" },
  file_move: { Icon: FileText, label: "移动文件" },
  // CEO captain tools — the delegate 任务书 is the prime large call surfaced by
  // ComposingToolLine; both also label the captain's process timeline steps.
  delegate: { Icon: Users, label: "委派任务" },
  ask_user: { Icon: HelpCircle, label: "向你确认" },
  consult_skill: { Icon: BookOpen, label: "查阅能力" },
  revise: { Icon: PenLine, label: "修订产物" },
  // Worker-only upward channel (build_worker_registry); surfaces in run detail.
  escalate: { Icon: ArrowUp, label: "上报问题" },
};

const toolMeta = (name: string): { Icon: LucideIcon; label: string } =>
  TOOL_META[name] ?? { Icon: Wrench, label: name };

/**
 * Live「正在生成 {工具}…」line for the CEO captain composing a tool call's
 * arguments (tool_progress) — the bubble-scoped twin of the worker node's liveTool.
 * Surfaces the otherwise-blank gap while the captain assembles a big call (the
 * delegate 任务书) before any content streams or the team graph appears, so a long
 * assembly reads as live progress, not a frozen bubble.
 */
function ComposingToolLine({
  tool,
}: {
  tool: { toolName: string; chars: number };
}) {
  const { Icon, label } = toolMeta(tool.toolName);
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Icon size={14} className="shrink-0 text-primary" />
      <span>
        正在生成 {label}
        {tool.chars > 0 && (
          <span className="text-muted-foreground/70">
            {" · "}
            {formatCompact(tool.chars)} 字
          </span>
        )}
      </span>
      <span className="inline-block animate-pulse text-primary">▋</span>
    </span>
  );
}

/** The most descriptive argument to show beside a tool's label (its query / url /
 * path / …); empty when the call carries no representative string arg. */
const TOOL_DETAIL_KEYS = [
  "query",
  "url",
  "pattern",
  "path",
  "command",
  "code",
  "q",
  "text",
];
function toolDetail(args: Record<string, unknown>): string {
  for (const k of TOOL_DETAIL_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Last path segment of a detail string (a file 名 from a path / url); the whole
 * string when it carries no separator (a query / pattern). Keeps a group header's
 * name list compact instead of echoing full paths. */
function baseName(detail: string): string {
  if (!detail) return "";
  const segs = detail.split(/[/\\]/);
  return segs[segs.length - 1] || detail;
}

/**
 * Header summary for a folded tool group (前端UX设计.md §一B). A single-category run
 * of ≤3 lists each call's 名/查询 (e.g.「读取文件 a.ts · b.ts」) since the names beat a
 * bare count when there are only a few; otherwise per-category counts in first-seen
 * order (e.g.「读取文件 6 · 编辑文件 2 · 列出目录 1」), reusing the TOOL_META 中文名.
 */
function toolGroupSummary(
  tools: Extract<ProcessStep, { kind: "tool" }>[],
): string {
  const sameKind = tools.every((t) => t.tool_name === tools[0].tool_name);
  if (sameKind && tools.length <= 3) {
    const { label } = toolMeta(tools[0].tool_name);
    const names = tools.map((t) => baseName(toolDetail(t.arguments)));
    if (names.every(Boolean)) return `${label} ${names.join(" · ")}`;
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const t of tools) {
    const { label } = toolMeta(t.tool_name);
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order.map((l) => `${l} ${counts.get(l)}`).join(" · ");
}

/** A tool step's status dot in the process timeline (running / ok / error). */
function ProcessStatusIcon({
  status,
}: {
  status: "running" | "success" | "error";
}) {
  if (status === "running")
    return (
      <span className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
    );
  if (status === "error")
    return <X size={14} className="mt-0.5 shrink-0 text-destructive" />;
  return <Check size={14} className="mt-0.5 shrink-0 text-success" />;
}

/** One tool call in the process timeline: icon · label · arg · status, with a
 * click-to-expand full result (capped server-side). Collapsed shows a one-line
 * result peek so the row is informative without being noisy. */
function ProcessToolRow({
  step,
}: {
  step: Extract<ProcessStep, { kind: "tool" }>;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, label } = toolMeta(step.tool_name);
  const detail = toolDetail(step.arguments);
  const data: ToolResultData = {
    toolName: step.tool_name,
    args: step.arguments,
    result: step.result,
    display: step.display,
    status: step.status,
  };
  const hasBody = hasToolResultBody(data);
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`flex w-full items-start gap-2 text-left ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="text-sm text-foreground">
            <span className="font-medium">{label}</span>
            {detail && (
              <span className="ml-1.5 break-all text-muted-foreground">
                {detail}
              </span>
            )}
          </span>
          {hasBody && !open && (
            <span
              className={`block truncate text-xs ${
                step.status === "error"
                  ? "text-destructive/80"
                  : "text-muted-foreground/70"
              }`}
            >
              {toolResultPeek(data)}
            </span>
          )}
        </span>
        <ProcessStatusIcon status={step.status} />
      </button>
      {open && hasBody && <ToolResultView data={data} />}
    </div>
  );
}

/**
 * A folded run of ≥2 consecutive tool calls in the process timeline (前端UX设计.md
 * §一B — 连续同类折叠). Mirrors {@link InlineReasoning}'s fold state machine: it
 * auto-expands while it is the live trailing activity (watch it work), auto-collapses
 * once the turn finishes; manual toggles always win. The header summarizes the run
 * (per-category counts / file names), pulses the 图2 dots while a tool is still
 * running, and surfaces a「N 个失败」badge on any error. Expanded, it renders the
 * unchanged {@link ProcessToolRow} per tool — each row still opens its own result, so
 * no detail is lost by grouping.
 */
function ProcessToolGroup({
  tools,
  isStreaming,
}: {
  tools: Extract<ProcessStep, { kind: "tool" }>[];
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(isStreaming);
  const prevStreaming = useRef(isStreaming);

  useEffect(() => {
    if (prevStreaming.current && !isStreaming) setExpanded(false);
    prevStreaming.current = isStreaming;
  }, [isStreaming]);

  const summary = toolGroupSummary(tools);
  const errorCount = tools.reduce(
    (n, t) => n + (t.status === "error" ? 1 : 0),
    0,
  );
  const running = tools.some((t) => t.status === "running");

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {running ? (
          <ThinkingDots />
        ) : expanded ? (
          <ChevronDown size={14} className="shrink-0" />
        ) : (
          <ChevronRight size={14} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        {errorCount > 0 && (
          <span className="shrink-0 text-destructive">
            {errorCount} 个失败
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-2 pl-3">
          {tools.map((t) => (
            <ProcessToolRow key={t.id} step={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One reasoning segment in the inline process timeline (前端UX设计.md §一B): a
 * borderless, muted, collapsible「思考过程」block (Cursor 式轻量内联). Auto-expands
 * while it is the live trailing segment (watch it think), auto-collapses once the
 * next step begins or the turn ends; manual toggles win. A turn can hold several
 * (思考→正文→工具→思考…), each its own collapsible — so the answer never gets buried
 * under one giant thinking dump.
 */
function InlineReasoning({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(streaming);
  const prevStreaming = useRef(streaming);

  useEffect(() => {
    if (prevStreaming.current && !streaming) setExpanded(false);
    prevStreaming.current = streaming;
  }, [streaming]);

  return (
    <div>
      <ThinkingHeader
        isStreaming={streaming}
        expanded={expanded}
        streamingLabel="正在思考…"
        doneLabel="思考过程"
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div className="mt-1.5 pl-3">
          <Markdown content={text} isStreaming={streaming} muted />
        </div>
      )}
    </div>
  );
}

/** One row in the inline process timeline (前端UX设计.md §一B): a reasoning segment
 * renders as a muted collapsible block, a content segment as normal rich text (the
 * reply, with inline citations), a tool call as its icon · label · result row.
 * `streaming` is true only for the trailing step, so the live cursor / dots ride the
 * last segment and finished segments still highlight any code they carry. */
function ProcessRow({
  step,
  streaming,
  citations,
  onCitationClick,
}: {
  step: ProcessStep;
  streaming: boolean;
  citations: Citation[];
  onCitationClick: (n: number) => void;
}) {
  if (step.kind === "reasoning") {
    return <InlineReasoning text={step.text} streaming={streaming} />;
  }
  if (step.kind === "content") {
    return (
      <Markdown
        content={step.text}
        citations={citations}
        onCitationClick={onCitationClick}
        isStreaming={streaming}
      />
    );
  }
  return <ProcessToolRow step={step} />;
}

/**
 * The single-agent turn's「思考·正文·工具」inline timeline (前端UX设计.md §一B —
 * Cursor 式全内联).
 *
 * Renders the CEO's reasoning, reply text, and tool calls in their TRUE
 * chronological order as one stream: reasoning segments are muted collapsible
 * blocks (零噪音), reply text is normal rich text (with inline citations), tool
 * calls are their icon · label · result rows. The TRAILING content step IS the
 * final answer — there is no separate answer block below; the timeline is the
 * reply. A reloaded tool-less turn carries no persisted content steps (only tools
 * journal interleaving), so it falls back to rendering `fallbackContent`
 * (message.content) as the trailing answer — the reply never disappears.
 */
function ProcessTimeline({
  process,
  isStreaming,
  citations,
  onCitationClick,
  composingTool,
  fallbackContent,
}: {
  process: ProcessStep[];
  isStreaming: boolean;
  citations: Citation[];
  onCitationClick: (n: number) => void;
  composingTool: { toolName: string; chars: number } | null;
  fallbackContent: string;
}) {
  const last = process[process.length - 1];
  // The timeline carries the reply when it has a content step; otherwise (a
  // reloaded tool-less turn whose reply wasn't journaled as steps) render
  // message.content as the trailing answer so the reply is never lost.
  const hasContentStep = process.some((s) => s.kind === "content");
  // Between rounds (the last step is a resolved tool, the next round's thinking not
  // yet streamed) show a live「正在思考…」cue so the bubble doesn't read as frozen; a
  // streaming reasoning / content / still-running-tool step carries its own
  // liveliness, and an arg-assembly (composingTool) takes precedence.
  const showThinkingTail =
    isStreaming &&
    !composingTool &&
    last?.kind === "tool" &&
    last.status !== "running";

  // Coalesce consecutive tool steps into collapsible groups before rendering
  // (前端UX设计.md §一B); reasoning/content stay 1:1 and break runs, so order is
  // preserved. View-only — `process[]` is untouched, so journal/conformance are not.
  const nodes = groupToolRuns(process);

  return (
    <div className="space-y-2">
      {nodes.map((node, i) => {
        // The trailing node carries the live cue (streaming cursor / dots / the
        // expanded active tool group); finished nodes stay static & collapsed.
        const live = isStreaming && i === nodes.length - 1;
        if (node.kind === "tool-group") {
          return (
            <ProcessToolGroup
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only timeline — a node's index is stable for its lifetime (only the trailing node mutates), so the index is a safe key.
              key={i}
              tools={node.tools}
              isStreaming={live}
            />
          );
        }
        const step: ProcessStep = node.kind === "tool" ? node.step : node;
        return (
          <ProcessRow
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only timeline — a node's index is stable for its lifetime (only the trailing node mutates), so the index is a safe key.
            key={i}
            step={step}
            streaming={live}
            citations={citations}
            onCitationClick={onCitationClick}
          />
        );
      })}
      {!hasContentStep && fallbackContent && (
        <Markdown
          content={fallbackContent}
          citations={citations}
          onCitationClick={onCitationClick}
          isStreaming={isStreaming}
        />
      )}
      {isStreaming && composingTool && (
        <ComposingToolLine tool={composingTool} />
      )}
      {showThinkingTail && (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ThinkingDots />
          正在思考…
        </span>
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
      <SimpleTooltip label={att.path}>
        <span className={base}>
          {icon}
          {label}
        </span>
      </SimpleTooltip>
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
    <SimpleTooltip
      label={state === "error" ? "下载失败，点击重试" : `下载 ${att.name}`}
    >
      <button
        type="button"
        onClick={onDownload}
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
    </SimpleTooltip>
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
          <DeleteMessageAction messageId={message.id} />
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
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const navigate = useNavigate();
  // A config remedy for a mid-stream failure (e.g. an invalid key → 去配置); null
  // for errors whose only remedy is regenerating (or topping up off-app).
  const errorAction = message.error
    ? errorActionForCode(message.error.code)
    : null;
  const hasReasoning =
    !!message.reasoning && message.reasoning.trim().length > 0;
  // Single-agent turns render the merged 思考+工具 process timeline; a multi-agent
  // turn (executionId set) keeps the standalone ThinkingPanel — its team graph
  // already carries the tool activity (前端UX设计.md §一).
  const hasProcess =
    message.executionId === null && (message.process?.length ?? 0) > 0;
  // Stable ref so Markdown's memo holds across idle re-renders (a fresh `?? []`
  // each render would otherwise re-render the whole body needlessly).
  const citations = useMemo(() => message.citations ?? [], [message.citations]);
  // Which sources the reply actually cites inline ([n]); the rest render dimmed
  // in the source list as "retrieved but not cited".
  const referenced = useMemo(
    () => referencedCitationNumbers(message.content, citations.length),
    [message.content, citations.length],
  );
  const checkpoints = message.checkpoints ?? [];
  const nonBlockingAsks = message.nonBlockingAsks ?? [];
  const planReviews = message.planReviews ?? [];
  // A turn salvaged after a disconnect / stop (断线别白干): the backend persisted the
  // finished team work as an incomplete message, flagged via runs.finish_reason. A
  // quiet status chip frames the bubble as interrupted, not as a normal reply.
  const isIncomplete =
    !message.isStreaming && message.runs?.finishReason === "cancelled";
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
      {hasProcess ? (
        // Single-agent turn: the inline「思考·正文·工具」timeline IS the reply — it
        // renders the reasoning, reply text, and tool calls in true order, with the
        // trailing content step as the final answer (前端UX设计.md §一B). No separate
        // bottom answer block / cursor here — the timeline owns them.
        <ProcessTimeline
          process={message.process ?? []}
          isStreaming={message.isStreaming}
          citations={citations}
          onCitationClick={onCitationClick}
          composingTool={
            message.executionId === null
              ? (message.composingTool ?? null)
              : null
          }
          fallbackContent={message.content}
        />
      ) : (
        // Multi-agent turn (team graph carries the activity) or a plain/no-process
        // turn: keep the standalone thinking panel + the answer rendered below.
        <>
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
          {isIncomplete && (
            <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              <CircleSlash size={14} />
              已中断 · 已保存完成的部分
            </div>
          )}
          <Markdown
            content={message.content}
            citations={citations}
            onCitationClick={onCitationClick}
            isStreaming={message.isStreaming}
          />
          {message.isStreaming &&
            (message.composingTool && message.executionId === null ? (
              // Captain is assembling a big tool call (the delegate 任务书) — show its
              // live char count instead of a bare cursor. Pre-graph only: once
              // delegate executes, run_plan sets executionId and the graph takes over.
              <ComposingToolLine tool={message.composingTool} />
            ) : message.content.length === 0 && !hasReasoning ? (
              // Nothing streamed yet (the gap between send and the first token):
              // show an explicit "正在思考…" so the turn never looks like it stalled.
              // Same 图2 dots as the thinking header → a seamless 等待→思考 transition.
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <ThinkingDots />
                正在思考…
              </span>
            ) : (
              <span
                className="mt-1 inline-block h-4 w-1.5 rounded-full bg-foreground/60"
                style={{ animation: "blink-cursor 0.8s step-end infinite" }}
              />
            ))}
        </>
      )}
      {message.error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {message.error.message}
          </p>
          {errorAction && (
            <button
              type="button"
              onClick={() => navigate(errorAction.href)}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              <KeyRound size={13} />
              {errorAction.label}
            </button>
          )}
          <button
            type="button"
            onClick={handleRegenerate}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-destructive/40 px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
          >
            <RefreshCw size={13} />
            重新生成
          </button>
        </div>
      )}
      {citations.length > 0 && (
        <SourceCards
          citations={citations}
          flash={citeFlash}
          referenced={referenced}
        />
      )}
      {/* ask_user cards the CEO raised this turn (统一开场引导 + 途中拍板) —
          interactive only while this bubble is the live, suspended turn; otherwise
          a replayed record. */}
      {checkpoints.map((cp) => (
        <CheckpointCard
          key={cp.id}
          checkpoint={cp}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
      ))}
      {/* Non-blocking asks (ask_user blocking=false) — non-gating cards whose option
          chips 回填 the composer; live + replayed alike (no interactive/resolved split,
          they were never pending). */}
      {nonBlockingAsks.map((ask) => (
        <NonBlockingAskCard key={ask.id} ask={ask} />
      ))}
      {/* Structured DAG checkpoints the WaveScheduler paused on this turn
          (plan_review, 结构化挂起 2a) — same live/replay rule as ask_user above. */}
      {planReviews.map((pr) => (
        <PlanReviewCard
          key={pr.id}
          review={pr}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
      ))}
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
          <DeleteMessageAction messageId={message.id} />
          {conversationId && (
            <ViewPromptAction
              conversationId={conversationId}
              messageId={message.id}
            />
          )}
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

  // Cross-component focus (e.g. the collaboration graph's CEO captain 汇聚点 node
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
