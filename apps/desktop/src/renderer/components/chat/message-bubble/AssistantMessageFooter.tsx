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
import { FINISH_REASON_META } from "@/components/ui/finish-reason-chip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { formatCompact } from "@/lib/format";
import { notifySuccess } from "@/lib/toast";
import type { Message } from "@/stores/conversation";
import { useConversationStore } from "@/stores/conversation";
import { useUIStore } from "@/stores/ui";
import type { UsageBreakdown } from "@/services/usage";
import type { ContextBlockWire } from "@/types/events";
import {
  Check,
  Copy,
  Fingerprint,
  Layers,
  Maximize2,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  DeleteMessageAction,
  MessageTime,
} from "./MessageActions";
import { useCopyAction } from "./useCopyAction";

function cacheRatePercent(usage: UsageBreakdown): number | null {
  if (usage.input <= 0) return null;
  return Math.round((usage.cache_hit / usage.input) * 100);
}

/** Compact token / round / cost summary — right-aligned in the footer. */
function MessageUsageSummary({
  usage,
  usageDetail,
  rounds,
  costText,
}: {
  usage: UsageBreakdown | undefined;
  usageDetail: boolean;
  rounds: number | undefined;
  costText: string | null;
}) {
  const parts = useMemo(() => {
    const out: string[] = [];
    if (usage) {
      if (usageDetail) {
        const rate = cacheRatePercent(usage);
        const input =
          rate != null && rate > 0
            ? `↑${formatCompact(usage.input)}(缓${rate}%)`
            : `↑${formatCompact(usage.input)}`;
        const output =
          usage.reasoning > 0
            ? `↓${formatCompact(usage.output)}(思${formatCompact(usage.reasoning)})`
            : `↓${formatCompact(usage.output)}`;
        out.push(`${input} ${output}`);
      } else {
        out.push(
          `↑${formatCompact(usage.input)} ↓${formatCompact(usage.output)}`,
        );
      }
    }
    if (rounds != null && rounds > 1) out.push(`${rounds} 轮`);
    if (costText) out.push(costText);
    return out;
  }, [usage, usageDetail, rounds, costText]);

  if (parts.length === 0) return null;

  const tooltip = usage
    ? usageDetail
      ? `输入 ${formatCompact(usage.input)}（缓存命中 ${formatCompact(usage.cache_hit)} · 未命中 ${formatCompact(usage.cache_miss)}）· 输出 ${formatCompact(usage.output)}（思考 ${formatCompact(usage.reasoning)}）`
      : "本回合 token 用量（输入 ↑ / 输出 ↓）"
    : undefined;

  const text = parts.join(" · ");

  if (tooltip) {
    return (
      <SimpleTooltip label={tooltip}>
        <span className="cursor-default text-xs tabular-nums text-muted-foreground/70">
          {text}
        </span>
      </SimpleTooltip>
    );
  }

  return (
    <span className="text-xs tabular-nums text-muted-foreground/70">
      {text}
    </span>
  );
}

function UsageDetailPanel({ usage }: { usage: UsageBreakdown }) {
  const rate = cacheRatePercent(usage);
  return (
    <div className="space-y-1 px-3 py-1.5 text-xs text-muted-foreground">
      <div className="flex justify-between gap-3 tabular-nums">
        <span>输入</span>
        <span className="text-foreground">{formatCompact(usage.input)}</span>
      </div>
      <div className="flex justify-between gap-3 tabular-nums">
        <span>缓存命中</span>
        <span className="text-foreground">
          {formatCompact(usage.cache_hit)}
          {rate != null ? ` · ${rate}%` : ""}
        </span>
      </div>
      <div className="flex justify-between gap-3 tabular-nums">
        <span>缓存未命中</span>
        <span className="text-foreground">
          {formatCompact(usage.cache_miss)}
        </span>
      </div>
      <div className="flex justify-between gap-3 tabular-nums">
        <span>输出</span>
        <span className="text-foreground">{formatCompact(usage.output)}</span>
      </div>
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

async function copyDiagnostic(label: string, value: string) {
  if (await copyText(value)) notifySuccess(`已复制 ${label}`);
}

function MessageMoreMenu({
  message,
  captainContext,
  finishReason,
}: {
  message: Message;
  captainContext: ContextBlockWire[];
  finishReason: string | undefined;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const diagnosticMode = useUIStore((s) => s.diagnosticMode);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const setConversationView = useUIStore((s) => s.setConversationView);
  const requestCanvasFocus = useUIStore((s) => s.requestCanvasFocus);

  const showTrace =
    (import.meta.env.DEV || diagnosticMode) && !!message.traceId;
  const showDiagnosticIds = diagnosticMode;
  const finishLabel = finishReason
    ? FINISH_REASON_META[finishReason]?.label
    : null;

  const hasMenu =
    captainContext.length > 0 ||
    !!message.executionId ||
    !!message.usage ||
    showTrace ||
    showDiagnosticIds ||
    !!finishLabel;

  const openInCanvas = () => {
    if (!conversationId || !message.executionId) return;
    requestCanvasFocus(message.id, false);
    setConversationView(conversationId, "canvas");
  };

  if (!hasMenu) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="sm" aria-label="更多">
            <MoreHorizontal size={14} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          {captainContext.length > 0 && (
            <DropdownMenuItem onSelect={() => setContextOpen(true)}>
              <Layers size={14} className="shrink-0 text-muted-foreground" />
              收到的上下文 · {captainContext.length} 段
            </DropdownMenuItem>
          )}
          {message.executionId && conversationId && (
            <DropdownMenuItem onSelect={openInCanvas}>
              <Maximize2 size={14} className="shrink-0 text-muted-foreground" />
              在画布查看此回合
            </DropdownMenuItem>
          )}
          {message.usage && (
            <>
              {(captainContext.length > 0 || message.executionId) && (
                <DropdownMenuSeparator />
              )}
              <DropdownMenuLabel>用量详情</DropdownMenuLabel>
              <UsageDetailPanel usage={message.usage} />
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
          {finishLabel && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>收尾原因</DropdownMenuLabel>
              <p className="px-3 pb-1.5 text-xs text-muted-foreground">
                {finishLabel}
              </p>
            </>
          )}
          {(showTrace || showDiagnosticIds) && (
            <>
              <DropdownMenuSeparator />
              {showTrace && message.traceId && (
                <DropdownMenuItem
                  onSelect={() =>
                    void copyDiagnostic("trace id", message.traceId!)
                  }
                >
                  <Fingerprint
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  复制 trace id
                </DropdownMenuItem>
              )}
              {showDiagnosticIds && (
                <DropdownMenuItem
                  onSelect={() => void copyDiagnostic("message id", message.id)}
                >
                  <Copy size={14} className="shrink-0 text-muted-foreground" />
                  复制 message id
                </DropdownMenuItem>
              )}
              {showDiagnosticIds && message.executionId && (
                <DropdownMenuItem
                  onSelect={() =>
                    void copyDiagnostic("execution id", message.executionId!)
                  }
                >
                  <Copy size={14} className="shrink-0 text-muted-foreground" />
                  复制 execution id
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ReceivedContextDialog
        blocks={captainContext}
        open={contextOpen}
        onOpenChange={setContextOpen}
      />
    </>
  );
}

/** Assistant bubble footer — actions left, usage summary + time right, low-freq in「更多」. */
export function AssistantMessageFooter({
  message,
  captainContext,
  costText,
  finishReason,
  onRegenerate,
}: {
  message: Message;
  captainContext: ContextBlockWire[];
  costText: string | null;
  finishReason: string | undefined;
  onRegenerate: () => void;
}) {
  const usageDetail = useUIStore((s) => s.usageDetail);
  const { copied, onCopy } = useCopyAction(() => message.content);

  return (
    <div className="mt-1 flex items-center justify-between gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <div className="flex min-w-0 items-center gap-0.5">
        <SimpleTooltip label={copied ? "已复制" : "复制"}>
          <IconButton size="sm" aria-label="复制" onClick={() => void onCopy()}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
        </SimpleTooltip>
        <SimpleTooltip label="重新生成">
          <IconButton
            size="sm"
            aria-label="重新生成"
            onClick={onRegenerate}
          >
            <RefreshCw size={14} />
          </IconButton>
        </SimpleTooltip>
        <DeleteMessageAction messageId={message.id} compact />
        <MessageMoreMenu
          message={message}
          captainContext={captainContext}
          finishReason={finishReason}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <MessageUsageSummary
          usage={message.usage}
          usageDetail={usageDetail}
          rounds={message.rounds}
          costText={costText}
        />
        <MessageTime iso={message.createdAt} />
      </div>
    </div>
  );
}
