import { ReceivedContextDialog } from "@/components/chat/ReceivedContext";
import { IconButton } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { formatCompact, formatDuration, formatOutputSpeed } from "@/lib/format";
import { MESSAGE_ACTION_REVEAL_CLASS } from "@/lib/messageActionReveal";
import { formatMessageExport } from "@/lib/messageExport";
import { completedAtIso } from "@/lib/runningElapsed";
import {
  buildSupportDiagnosticPack,
  formatSupportDiagnosticText,
  precedingUserMessageId,
  supportDiagnosticExtrasFromError,
} from "@/lib/supportDiagnostics";
import { notifyError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { setMessageFeedback } from "@/services/messages";
import type { UsageBreakdown } from "@/services/usage";
import type { Message } from "@/stores/conversation";
import {
  assistantProjectionId,
  getActiveRuntime,
  useConversationStore,
} from "@/stores/conversation";
import type { ContextBlockWire } from "@/types/events";
import {
  CACHE_BILLED_AS_MISS_LABEL,
  cacheUsageDisplay,
} from "@agentcore/protocol-fold-kit";
import {
  Check,
  Copy,
  Fingerprint,
  Layers,
  Link2,
  MoreHorizontal,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  CloneMessageAction,
  MessageTime,
  RegenerateMessageAction,
} from "./MessageActions";
import { useCopyAction } from "./useCopyAction";

/** Signal-only summary (cost / duration) — token, 输出速度, ReAct rounds live in「更多」. */
export function AssistantMessageMetaSummary({
  costText,
  durationMs,
}: {
  costText: string | null;
  durationMs?: number;
}) {
  const durationText =
    durationMs != null && durationMs > 0 ? formatDuration(durationMs) : null;
  if (!costText && !durationText) return null;

  const parts: ReactNode[] = [];
  const pushSep = () => {
    if (parts.length > 0)
      parts.push(
        <span key={`sep-${parts.length}`} aria-hidden>
          ·
        </span>,
      );
  };

  if (costText) {
    pushSep();
    parts.push(<span key="cost">{costText}</span>);
  }
  if (durationText) {
    pushSep();
    parts.push(
      <span key="dur" aria-label={`用时 ${durationText}`}>
        {durationText}
      </span>,
    );
  }

  return (
    <span className="inline-flex cursor-default items-center gap-1.5 text-xs tabular-nums text-muted-foreground/70">
      {parts}
    </span>
  );
}

function UsageDetailPanel({
  usage,
  generationMs,
}: {
  usage: UsageBreakdown;
  generationMs?: number;
}) {
  const cache = cacheUsageDisplay(usage);
  const speedText =
    generationMs != null ? formatOutputSpeed(usage.output, generationMs) : null;
  return (
    <div className="space-y-1 px-3 py-1.5 text-xs text-muted-foreground">
      <div className="flex justify-between gap-3 tabular-nums">
        <span>输入</span>
        <span className="text-foreground">{formatCompact(usage.input)}</span>
      </div>
      {cache.billedAsMiss ? (
        <div className="flex justify-between gap-3 tabular-nums">
          <span>{CACHE_BILLED_AS_MISS_LABEL}</span>
          <span className="text-foreground">
            {formatCompact(cache.cacheMiss)}
          </span>
        </div>
      ) : (
        <>
          <div className="flex justify-between gap-3 tabular-nums">
            <span>缓存命中</span>
            <span className="text-foreground">
              {formatCompact(cache.cacheHit)}
              {cache.hitRatePercent != null
                ? ` · ${cache.hitRatePercent}%`
                : ""}
            </span>
          </div>
          <div className="flex justify-between gap-3 tabular-nums">
            <span>缓存未命中</span>
            <span className="text-foreground">
              {formatCompact(cache.cacheMiss)}
            </span>
          </div>
        </>
      )}
      <div className="flex justify-between gap-3 tabular-nums">
        <span>输出</span>
        <span className="text-foreground">{formatCompact(usage.output)}</span>
      </div>
      {speedText ? (
        <div className="flex justify-between gap-3 tabular-nums">
          <span>输出速度</span>
          <span className="text-foreground">{speedText}</span>
        </div>
      ) : null}
      {usage.reasoning > 0 && (
        <div className="flex justify-between gap-3 tabular-nums">
          <span>思考</span>
          <span className="text-foreground">
            {formatCompact(usage.reasoning)}
          </span>
        </div>
      )}
    </div>
  );
}

async function copyDiagnostic(value: string) {
  await copyText(value);
}

/** 消息永久链接 (对话基础功能补齐): a hash anchor that reopens the conversation and
 * lands on this exact turn (scroll). Portable to the web build as a real
 * shareable URL; in desktop it round-trips through the same #/conversations/:id?msg=
 * route ConversationPage honors on load. */
function messagePermalink(conversationId: string, messageId: string): string {
  const base = window.location.href.split("#")[0];
  return `${base}#/conversations/${conversationId}?msg=${messageId}`;
}

export function MessageMoreMenu({
  message,
  captainContext,
  showSupportPack = true,
}: {
  message: Message;
  captainContext: ContextBlockWire[];
  /** False when this bubble is not the pack host. */
  showSupportPack?: boolean;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const conversationId = useConversationStore((s) => s.currentConversationId);

  // 查 bug 走排查包喂 AI。失败横幅不挂这一项。
  const serverMessageId = assistantProjectionId(message);
  const diagnosticIds = {
    conversationId,
    messageId: serverMessageId,
    userMessageId: precedingUserMessageId(
      getActiveRuntime().messages,
      message.id,
    ),
    traceId: message.traceId,
    executionId: message.executionId,
    ...supportDiagnosticExtrasFromError(message.error),
  };
  const diagnosticText = formatSupportDiagnosticText(diagnosticIds);
  const usage = message.usage;
  const hasSpendUsage = !!usage && (usage.input > 0 || usage.output > 0);
  const hasMenu =
    !!conversationId ||
    captainContext.length > 0 ||
    hasSpendUsage ||
    !!diagnosticText;

  if (!hasMenu) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="sm"
            aria-label="更多"
            data-testid="assistant-more-menu"
          >
            <MoreHorizontal size={14} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {conversationId && (
            <DropdownMenuItem
              onSelect={() =>
                void copyDiagnostic(
                  messagePermalink(conversationId, serverMessageId),
                )
              }
            >
              <Link2 size={14} className="shrink-0 text-muted-foreground" />
              复制消息链接
            </DropdownMenuItem>
          )}
          {captainContext.length > 0 && (
            <DropdownMenuItem onSelect={() => setContextOpen(true)}>
              <Layers size={14} className="shrink-0 text-muted-foreground" />
              收到的上下文
            </DropdownMenuItem>
          )}
          {hasSpendUsage && usage && (
            <>
              {(!!conversationId || captainContext.length > 0) && (
                <DropdownMenuSeparator />
              )}
              <DropdownMenuLabel>用量详情</DropdownMenuLabel>
              <UsageDetailPanel
                usage={usage}
                generationMs={message.generationMs}
              />
              {message.rounds != null && message.rounds > 1 && (
                <div className="flex justify-between gap-3 px-3 pb-1.5 text-xs text-muted-foreground">
                  <span>ReAct 轮次</span>
                  <span className="tabular-nums text-foreground">
                    {message.rounds} 轮
                  </span>
                </div>
              )}
            </>
          )}
          {showSupportPack && diagnosticText && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  void buildSupportDiagnosticPack(diagnosticIds).then(
                    (text) => {
                      if (text) void copyDiagnostic(text);
                    },
                  );
                }}
              >
                <Fingerprint
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
                复制排查包
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ReceivedContextDialog
        blocks={captainContext}
        process={message.process}
        open={contextOpen}
        onOpenChange={setContextOpen}
      />
    </>
  );
}

/** 回复反馈 (点赞/点踩, 对话基础功能补齐): thumbs up/down on an assistant reply. The active
 * side highlights in the brand color; clicking it again clears the rating (toggle off).
 * Optimistic — the service flips the bubble immediately and reverts on a failed persist. */
function FeedbackButtons({ message }: { message: Message }) {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const feedback = message.feedback ?? null;
  const rate = (side: "up" | "down") => {
    if (!conversationId) return;
    const next = feedback === side ? null : side;
    void setMessageFeedback(conversationId, message.id, next).catch((err) =>
      notifyError(err, "反馈失败"),
    );
  };
  return (
    <>
      <SimpleTooltip label="有帮助">
        <IconButton
          size="sm"
          aria-label="有帮助"
          aria-pressed={feedback === "up"}
          className={feedback === "up" ? "text-primary" : undefined}
          onClick={() => rate("up")}
        >
          <ThumbsUp size={14} />
        </IconButton>
      </SimpleTooltip>
      <SimpleTooltip label="没帮助">
        <IconButton
          size="sm"
          aria-label="没帮助"
          aria-pressed={feedback === "down"}
          className={feedback === "down" ? "text-primary" : undefined}
          onClick={() => rate("down")}
        >
          <ThumbsDown size={14} />
        </IconButton>
      </SimpleTooltip>
    </>
  );
}

/** Assistant bubble footer — actions left, usage summary + time right, low-freq in「更多」. */
export function AssistantMessageFooter({
  message,
  captainContext,
  costText,
  onRegenerate,
  displayError,
  pinSupportPack = false,
  showSupportPack = true,
  showRegenerate,
}: {
  message: Message;
  captainContext: ContextBlockWire[];
  costText: string | null;
  onRegenerate: () => void;
  /** Settled failure face; feeds copy via visibleMessageText. */
  displayError?: { code: string; message: string } | null;
  /** Keep「更多」visible (not hover-reveal) when it is the pack host. */
  pinSupportPack?: boolean;
  /** False when this bubble is not the pack host. */
  showSupportPack?: boolean;
  /** Arbitrator: hide when a named recovery is already the unique retry. */
  showRegenerate: boolean;
}) {
  const hasProcess = (message.process?.length ?? 0) > 0;
  // Prefer displayError so synthesizable empty failures (no error payload) still copy.
  const exportError = {
    error: displayError ?? message.error,
    runs: message.runs,
  };
  const { copied, onCopy } = useCopyAction(() =>
    formatMessageExport(
      message.content,
      message.process,
      "deliverable",
      exportError,
    ),
  );
  const { copied: copiedProcess, onCopy: onCopyProcess } = useCopyAction(() =>
    formatMessageExport(
      message.content,
      message.process,
      "with_process",
      exportError,
    ),
  );
  const more = (
    <MessageMoreMenu
      message={message}
      captainContext={captainContext}
      showSupportPack={showSupportPack}
    />
  );
  return (
    <div className="mt-1 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-0.5">
        <div
          className={cn(
            "flex min-w-0 items-center gap-0.5",
            MESSAGE_ACTION_REVEAL_CLASS,
          )}
        >
          {hasProcess ? (
            <DropdownMenu>
              <SimpleTooltip
                label={copied || copiedProcess ? "已复制" : "复制"}
              >
                <DropdownMenuTrigger asChild>
                  <IconButton size="sm" aria-label="复制">
                    {copied || copiedProcess ? (
                      <Check size={14} />
                    ) : (
                      <Copy size={14} />
                    )}
                  </IconButton>
                </DropdownMenuTrigger>
              </SimpleTooltip>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => void onCopy()}>
                  仅交付
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void onCopyProcess()}>
                  含过程
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <SimpleTooltip label={copied ? "已复制" : "复制"}>
              <IconButton
                size="sm"
                aria-label="复制"
                onClick={() => void onCopy()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </IconButton>
            </SimpleTooltip>
          )}
          <FeedbackButtons message={message} />
          {showRegenerate ? (
            <RegenerateMessageAction onRegenerate={onRegenerate} />
          ) : null}
          <CloneMessageAction messageId={message.id} />
          {!pinSupportPack ? more : null}
        </div>
        {pinSupportPack ? more : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <AssistantMessageMetaSummary
          costText={costText}
          durationMs={message.durationMs}
        />
        <MessageTime
          iso={completedAtIso(message.createdAt, message.durationMs)}
        />
      </div>
    </div>
  );
}
