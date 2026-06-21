import { CheckpointCard } from "@/components/chat/CheckpointCard";
import { EscalationCards } from "@/components/chat/EscalationCard";
import { FileArtifactsCard } from "@/components/chat/FileArtifactsCard";
import { InlineTeamGraph } from "@/components/chat/InlineTeamGraph";
import { Markdown } from "@/components/chat/Markdown";
import { NonBlockingAskCard } from "@/components/chat/NonBlockingAskCard";
import { PlanReviewCard } from "@/components/chat/PlanReviewCard";
import { ReceivedContextSection } from "@/components/chat/ReceivedContext";
import { type CitationFlash, SourceCards } from "@/components/chat/SourceCards";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { referencedCitationNumbers } from "@/lib/citations";
import { errorActionForCode } from "@/lib/errors";
import {
  fileArtifactsFromExecution,
  fileArtifactsFromProcess,
  mergeArtifacts,
} from "@/lib/fileArtifacts";
import { formatCompact, formatCost } from "@/lib/format";
import { runRegenerate } from "@/services/turns";
import {
  getActiveRuntime,
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useMessageExecution } from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import type { ProcessStep } from "@/types/events";
import {
  AlertTriangle,
  Check,
  CircleOff,
  CircleSlash,
  Copy,
  Fingerprint,
  KeyRound,
  type LucideIcon,
  RefreshCw,
  Repeat,
  TrendingDown,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CeoNodeCard, type SoloStatus } from "./CeoNodeCard";
import {
  DeleteMessageAction,
  MessageAction,
  MessageTime,
  ViewPromptAction,
} from "./MessageActions";
import { ComposingToolLine, ProcessTimeline } from "./ProcessTimeline";
import { ThinkingDots, ThinkingPanel } from "./Thinking";
import type { MessageBubbleProps } from "./types";
import { useCopyAction } from "./useCopyAction";

function finishReasonChip(
  reason: string | undefined,
): { label: string; Icon: LucideIcon; tone: "muted" | "warning" } | null {
  switch (reason) {
    case "cancelled":
      return {
        label: "已中断 · 已保存完成的部分",
        Icon: CircleSlash,
        tone: "muted",
      };
    case "max_rounds":
      return {
        label: "已达最大轮次 · 提前收尾",
        Icon: Repeat,
        tone: "warning",
      };
    case "degraded":
      return {
        label: "降级完成 · 模型多次空响应",
        Icon: TrendingDown,
        tone: "warning",
      };
    case "unproductive":
      return {
        label: "无有效进展 · 提前收尾",
        Icon: CircleOff,
        tone: "warning",
      };
    default:
      return null;
  }
}

const FINISH_CHIP_TONE: Record<"muted" | "warning", string> = {
  muted: "bg-muted text-muted-foreground",
  warning: "bg-warning/10 text-warning",
};

function MultiAgentFileArtifacts({
  messageId,
  process,
}: {
  messageId: string;
  process: ProcessStep[] | undefined;
}) {
  const execution = useMessageExecution(messageId);
  const artifacts = useMemo(
    () =>
      mergeArtifacts(
        fileArtifactsFromProcess(process),
        fileArtifactsFromExecution(execution),
      ),
    [process, execution],
  );
  return <FileArtifactsCard artifacts={artifacts} />;
}

export function AssistantMessage({ message }: MessageBubbleProps) {
  const isGenerating = useActiveGenerating();
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const loadMessageCost = useUsageStore((s) => s.loadMessageCost);
  const cachedTotal = useUsageStore(
    (s) => s.messageCosts[message.id]?.cost.total ?? null,
  );
  const { copied, onCopy } = useCopyAction(() => message.content);
  const { copied: traceCopied, onCopy: onCopyTrace } = useCopyAction(
    () => message.traceId ?? "",
  );
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const navigate = useNavigate();
  const errorAction = message.error
    ? errorActionForCode(message.error.code)
    : null;
  const hasReasoning =
    !!message.reasoning && message.reasoning.trim().length > 0;
  const usageDetail = useUIStore((s) => s.usageDetail);
  // 「图主界面化」实验（前端UX设计.md §6.1）：单 Agent「1 节点图」是它的第一刀——仅对单
  // Agent 回合（`executionId === null`）生效（多 Agent 回合已有团队协作图）。开启时把整段回合
  // 正文（时间线 / 答案）包进一张 CEO 节点卡（退化形态）。默认关 → 零回归。
  const graphPrimary = useUIStore((s) => s.graphPrimary);
  const captainContext = message.captainContext ?? [];
  const hasProcess = (message.process?.length ?? 0) > 0;
  const citations = useMemo(() => message.citations ?? [], [message.citations]);
  const referenced = useMemo(
    () => referencedCitationNumbers(message.content, citations.length),
    [message.content, citations.length],
  );
  const checkpoints = message.checkpoints ?? [];
  const nonBlockingAsks = message.nonBlockingAsks ?? [];
  const planReviews = message.planReviews ?? [];
  const singleAgentArtifacts = useMemo(
    () =>
      message.executionId === null
        ? fileArtifactsFromProcess(message.process)
        : [],
    [message.executionId, message.process],
  );
  const finishChip = !message.isStreaming
    ? finishReasonChip(message.finishReason ?? message.runs?.finishReason)
    : null;
  // 单 Agent「1 节点图」退化渲染（§九）：CEO 节点的状态由回合态派生——流式中=执行中、
  // 报错=失败、`cancelled` 收尾=已停止、其余=已完成（与团队图 captain 节点同口径）。
  const isSoloGraph = graphPrimary && message.executionId === null;
  const soloStatus: SoloStatus = message.isStreaming
    ? "running"
    : message.error
      ? "failed"
      : (message.finishReason ?? message.runs?.finishReason) === "cancelled"
        ? "cancelled"
        : "completed";
  const turnTotal = message.cost?.total ?? cachedTotal;
  const costText =
    message.executionId === null && turnTotal != null && turnTotal > 0
      ? formatCost(turnTotal, cnyPerUsd)
      : null;
  const usage = message.usage;
  const usageText = usage
    ? usageDetail
      ? `↑${formatCompact(usage.input)}（缓存 ${formatCompact(
          usage.cache_hit,
        )}） ↓${formatCompact(usage.output)}（思考 ${formatCompact(
          usage.reasoning,
        )}）`
      : `↑${formatCompact(usage.input)} ↓${formatCompact(usage.output)}`
    : null;
  const roundsText =
    message.rounds != null && message.rounds > 1
      ? `${message.rounds} 轮`
      : null;

  const onPeekCost = () => {
    if (!message.isStreaming && message.cost == null) {
      void loadMessageCost(message.id);
    }
  };

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

  // 回合正文（时间线或答案）。单 Agent「1 节点图」开启时整段包进 CEO 节点卡（见 §九），
  // 否则原样平铺。回合级附件（收到的上下文 / 错误卡 / 产物 / 引用 / 检查点 / 操作行）始终在
  // 节点卡之外——它们是回合 chrome，不属于 CEO 节点本身。
  const turnBody = hasProcess ? (
    <ProcessTimeline
      process={message.process ?? []}
      isStreaming={message.isStreaming}
      citations={citations}
      onCitationClick={onCitationClick}
      composingTool={
        message.executionId === null ? (message.composingTool ?? null) : null
      }
      fallbackContent={message.content}
      executionId={message.executionId}
      messageId={message.id}
      journal={message.runs}
    />
  ) : (
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
      <Markdown
        content={message.content}
        citations={citations}
        onCitationClick={onCitationClick}
        isStreaming={message.isStreaming}
      />
      {message.isStreaming &&
        (message.composingTool && message.executionId === null ? (
          <ComposingToolLine tool={message.composingTool} />
        ) : message.content.length === 0 && !hasReasoning ? (
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
  );

  return (
    <div className="group min-w-0" onMouseEnter={onPeekCost}>
      {finishChip && (
        <div
          className={`mb-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${FINISH_CHIP_TONE[finishChip.tone]}`}
        >
          <finishChip.Icon size={14} />
          {finishChip.label}
        </div>
      )}
      {isSoloGraph ? (
        <CeoNodeCard status={soloStatus}>{turnBody}</CeoNodeCard>
      ) : (
        turnBody
      )}
      {captainContext.length > 0 && (
        <div className="mt-3">
          <ReceivedContextSection
            blocks={captainContext}
            defaultExpanded={usageDetail}
            powerMode={usageDetail}
          />
        </div>
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
      {message.executionId === null ? (
        singleAgentArtifacts.length > 0 && (
          <FileArtifactsCard artifacts={singleAgentArtifacts} />
        )
      ) : (
        <MultiAgentFileArtifacts
          messageId={message.id}
          process={message.process}
        />
      )}
      {citations.length > 0 && (
        <SourceCards
          citations={citations}
          flash={citeFlash}
          referenced={referenced}
        />
      )}
      {checkpoints.map((cp) => (
        <CheckpointCard
          key={cp.id}
          checkpoint={cp}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
      ))}
      {nonBlockingAsks.map((ask) => (
        <NonBlockingAskCard key={ask.id} ask={ask} />
      ))}
      {planReviews.map((pr) => (
        <PlanReviewCard
          key={pr.id}
          review={pr}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
      ))}
      {message.executionId && (
        <EscalationCards
          messageId={message.id}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
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
          <DeleteMessageAction messageId={message.id} />
          {conversationId && (
            <ViewPromptAction
              conversationId={conversationId}
              messageId={message.id}
            />
          )}
          {import.meta.env.DEV && message.traceId && (
            <MessageAction
              icon={
                traceCopied ? <Check size={13} /> : <Fingerprint size={13} />
              }
              label={traceCopied ? "已复制 trace id" : "复制 trace id"}
              onClick={onCopyTrace}
            />
          )}
          {usageText && (
            <SimpleTooltip label="本回合 token 用量（输入 ↑ / 输出 ↓）">
              <span className="ml-1 text-xs tabular-nums text-muted-foreground/70">
                {usageText}
              </span>
            </SimpleTooltip>
          )}
          {roundsText && (
            <SimpleTooltip label="本回合 ReAct 思考→行动轮次">
              <span className="text-xs tabular-nums text-muted-foreground/70">
                {roundsText}
              </span>
            </SimpleTooltip>
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
