import { CheckpointCard } from "@/components/chat/CheckpointCard";
import { EscalationCards } from "@/components/chat/EscalationCard";
import { FileArtifactsCard } from "@/components/chat/FileArtifactsCard";
import { InlineTeamGraph } from "@/components/chat/InlineTeamGraph";
import { Markdown } from "@/components/chat/Markdown";
import { NonBlockingAskCard } from "@/components/chat/NonBlockingAskCard";
import { PlanReviewCard } from "@/components/chat/PlanReviewCard";
import { type CitationFlash, SourceCards } from "@/components/chat/SourceCards";
import { TeamPreviewCard } from "@/components/chat/TeamPreviewCard";
import { TurnWarningBanner } from "@/components/chat/TurnWarningBanner";
import { CollapsibleSpeech } from "@/components/chat/debate/CollapsibleSpeech";
import { Button, IconButton } from "@/components/ui";
import { FinishReasonChip } from "@/components/ui/finish-reason-chip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { referencedCitationNumbers } from "@/lib/citations";
import {
  degradedFinishChipLabel,
  errorActionForCode,
  formatAssistantErrorMessage,
} from "@/lib/errors";
import {
  fileArtifactsFromExecution,
  fileArtifactsFromProcess,
  mergeArtifacts,
} from "@/lib/fileArtifacts";
import { formatCost } from "@/lib/format";
import { notifyError } from "@/lib/toast";
import { continueTurn, runRegenerate } from "@/services/turns";
import {
  type Message,
  assistantProjectionId,
  getActiveRuntime,
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useMessageExecution } from "@/stores/execution";
import { useMessageInteractionCards } from "@/stores/interactions";
import { useUsageStore } from "@/stores/usage";
import type { ProcessStep } from "@/types/events";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  RefreshCw,
  StepForward,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AssistantMessageFooter } from "./AssistantMessageFooter";
import { ComposingToolLine, ProcessTimeline } from "./ProcessTimeline";
import { SyncStatusHint } from "./SyncStatusHint";
import { ThinkingDots, ThinkingPanel } from "./Thinking";
import type { MessageBubbleProps } from "./types";
import { useCopyAction } from "./useCopyAction";

function MultiAgentFileArtifacts({
  messageId,
  process,
}: {
  messageId: string;
  process: ProcessStep[] | undefined;
}) {
  const execution = useMessageExecution(messageId);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const artifacts = useMemo(
    () =>
      mergeArtifacts(
        fileArtifactsFromProcess(process),
        fileArtifactsFromExecution(execution),
      ),
    [process, execution],
  );
  return (
    <FileArtifactsCard artifacts={artifacts} conversationId={conversationId} />
  );
}

/**
 * 续写被截断的回答 (对话基础功能补齐) — when the *latest* reply ended early (用户叫停 =
 * `cancelled`, crash salvage = `interrupted`, or the agent hit its round budget =
 * `max_rounds`), offer a one-click 「继续生成」. It sends a minimal「继续」turn so the
 * model resumes from the transcript. Only the last turn is resumable (continuing a
 * mid-history turn would fork the thread), and never while a turn is already streaming.
 */
function ContinueTurnButton({
  message,
  finishReason,
}: {
  message: Message;
  finishReason: string | undefined;
}) {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const isGenerating = useActiveGenerating();
  const isLast = useConversationStore((s) => {
    const rt = s.currentConversationId ? s.byId[s.currentConversationId] : null;
    return rt?.messages.at(-1)?.id === message.id;
  });
  const [busy, setBusy] = useState(false);
  const eligible =
    finishReason === "cancelled" ||
    finishReason === "interrupted" ||
    finishReason === "max_rounds";
  if (!conversationId || !isLast || isGenerating || !eligible) {
    return null;
  }
  // Interrupted salvage may have no body — still offer regenerate (P4).
  if (finishReason !== "interrupted" && message.content.length === 0) {
    return null;
  }
  const useRegenerate =
    finishReason === "interrupted" && message.content.length === 0;
  const onContinue = async () => {
    setBusy(true);
    try {
      if (useRegenerate) {
        const msgs = getActiveRuntime().messages;
        const idx = msgs.findIndex((m) => m.id === message.id);
        let userId: string | null = null;
        for (let i = idx - 1; i >= 0; i--) {
          if (msgs[i].role === "user") {
            userId = msgs[i].id;
            break;
          }
        }
        if (userId) await runRegenerate(userId);
      } else {
        await continueTurn(conversationId);
      }
    } catch (err) {
      notifyError(err, useRegenerate ? "重试失败" : "继续生成失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2">
      <Button
        variant="neutral"
        className="border-border/70"
        icon={
          useRegenerate ? <RefreshCw size={13} /> : <StepForward size={13} />
        }
        disabled={busy}
        onClick={() => void onContinue()}
      >
        {busy
          ? useRegenerate
            ? "重试中…"
            : "继续中…"
          : useRegenerate
            ? "重试"
            : "继续生成"}
      </Button>
    </div>
  );
}

export function AssistantMessage({ message }: MessageBubbleProps) {
  const isGenerating = useActiveGenerating();
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const loadMessageCost = useUsageStore((s) => s.loadMessageCost);
  const cachedTotal = useUsageStore(
    (s) => s.messageCosts[message.id]?.cost.total ?? null,
  );
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const navigate = useNavigate();
  const errorAction = message.error
    ? errorActionForCode(message.error.code)
    : null;
  const hasReasoning =
    !!message.reasoning && message.reasoning.trim().length > 0;
  const captainContext = message.captainContext ?? [];
  const hasProcess = (message.process?.length ?? 0) > 0;
  const citations = useMemo(() => message.citations ?? [], [message.citations]);
  const referenced = useMemo(
    () => referencedCitationNumbers(message.content, citations.length),
    [message.content, citations.length],
  );
  const { checkpoints, nonBlockingAsks, planReviews, teamPreviews } =
    useMessageInteractionCards(conversationId, message.id);
  const hideContentForCheckpoint = checkpoints.some(
    (c) => c.status === "resolved",
  );
  // 统一团队时间线: cards whose positional marker rides the inline timeline render there;
  // un-anchored ones (no inline process / markers) still fall back to the bottom stack.
  const procSteps = message.process ?? [];
  const markedCheckpoints = useMemo(
    () =>
      new Set(
        procSteps.flatMap((s) =>
          s.kind === "checkpoint" ? [s.checkpoint_id] : [],
        ),
      ),
    [procSteps],
  );
  const markedAsks = useMemo(
    () =>
      new Set(procSteps.flatMap((s) => (s.kind === "ask" ? [s.ask_id] : []))),
    [procSteps],
  );
  const markedReviews = useMemo(
    () =>
      new Set(
        procSteps.flatMap((s) =>
          s.kind === "plan_review" ? [s.checkpoint_id] : [],
        ),
      ),
    [procSteps],
  );
  const markedPreviews = useMemo(
    () =>
      new Set(
        procSteps.flatMap((s) =>
          s.kind === "team_preview" ? [s.checkpoint_id] : [],
        ),
      ),
    [procSteps],
  );
  // Escalations ride the team execution's inline slot (next to the graph, in
  // ProcessTimeline) whenever the turn carries a `team` marker; un-anchored cards
  // (no inline process / markers) fall back to the bottom stack — never double-render.
  const hasTeamMarker = useMemo(
    () => procSteps.some((s) => s.kind === "team"),
    [procSteps],
  );
  const bottomCheckpoints = checkpoints.filter(
    (c) => !markedCheckpoints.has(c.id),
  );
  const bottomAsks = nonBlockingAsks.filter((a) => !markedAsks.has(a.id));
  const bottomReviews = planReviews.filter((p) => !markedReviews.has(p.id));
  const bottomPreviews = teamPreviews.filter((p) => !markedPreviews.has(p.id));
  const singleAgentArtifacts = useMemo(
    () =>
      message.executionId === null
        ? fileArtifactsFromProcess(message.process)
        : [],
    [message.executionId, message.process],
  );
  const finishReason = !message.isStreaming
    ? (message.finishReason ?? message.runs?.finishReason)
    : undefined;
  const turnTotal = message.cost?.total ?? cachedTotal;
  const costText =
    message.executionId === null && turnTotal != null && turnTotal > 0
      ? formatCost(turnTotal, cnyPerUsd)
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

  // 流式中可复制 (对话基础功能补齐): the full footer is gated until the turn settles (its
  // usage / regenerate actions are meaningless mid-stream), but a long reply is often worth
  // copying before it finishes — so expose a lightweight copy affordance while streaming.
  // The getter reads the latest content each render, so a click copies what's on screen now.
  const { copied: streamCopied, onCopy: onStreamCopy } = useCopyAction(
    () => message.content,
  );

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

  // Execution / graph slot key = server turn id when stamped (pause/resume share it).
  const projectionId = assistantProjectionId(message);

  // 回合正文（时间线或答案）：对话页恒为传统聊天平铺（单 Agent 回合不再退化成 CEO 节点卡——
  // 那条「图主界面化」第一刀已撤，图相关体验只在画布；多 Agent 回合仍在答案上方内嵌
  // 团队协作图）。回合级附件（收到的上下文 / 错误卡 / 产物 / 引用 / 检查点 / 操作行）随后平铺。
  const turnBody = hasProcess ? (
    <ProcessTimeline
      process={message.process ?? []}
      isStreaming={message.isStreaming}
      citations={citations}
      onCitationClick={onCitationClick}
      composingTool={
        message.executionId === null ? (message.composingTool ?? null) : null
      }
      fallbackContent={hideContentForCheckpoint ? "" : message.content}
      executionId={message.executionId}
      messageId={projectionId}
      journal={message.runs}
      conversationId={conversationId}
      checkpoints={checkpoints}
      nonBlockingAsks={nonBlockingAsks}
      planReviews={planReviews}
      teamPreviews={teamPreviews}
    />
  ) : (
    <>
      {hasReasoning && (
        <ThinkingPanel
          reasoning={message.reasoning ?? ""}
          isStreaming={message.isStreaming}
          persistKey={`${message.id}:reasoning`}
        />
      )}
      {message.executionId && (
        <InlineTeamGraph
          messageId={projectionId}
          executionId={message.executionId}
          journal={message.runs}
        />
      )}
      {/* 长回答折叠 (对话基础功能补齐): while streaming, render full so the user watches
          it grow; once settled, cap a truly long answer to a fade + 展开全文 so it doesn't
          dominate the viewport (短/中答案原样全展). */}
      {message.isStreaming && !hideContentForCheckpoint ? (
        <Markdown
          content={message.content}
          citations={citations}
          onCitationClick={onCitationClick}
          isStreaming={message.isStreaming}
        />
      ) : hideContentForCheckpoint ? null : (
        <CollapsibleSpeech
          contentKey={message.content}
          fadeToClass="from-background"
          collapsedMaxHClass="max-h-[40rem]"
          sceneKey={`answer:${message.id}`}
        >
          <Markdown
            content={message.content}
            citations={citations}
            onCitationClick={onCitationClick}
            isStreaming={false}
          />
        </CollapsibleSpeech>
      )}
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
      <FinishReasonChip
        reason={finishReason}
        diagnosisLabel={degradedFinishChipLabel(
          message.error?.context?.empty_diagnosis,
          message.error?.message,
        )}
      />
      {message.turnWarning && (
        <TurnWarningBanner message={message.turnWarning} />
      )}
      {turnBody}
      <ContinueTurnButton message={message} finishReason={finishReason} />
      {message.error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {formatAssistantErrorMessage(message.error)}
          </p>
          {errorAction && (
            <Button
              variant="destructive"
              className="shrink-0"
              icon={<KeyRound size={13} />}
              onClick={() => navigate(errorAction.href)}
            >
              {errorAction.label}
            </Button>
          )}
          <Button
            variant="danger"
            className="shrink-0 border border-destructive/40"
            icon={<RefreshCw size={13} />}
            onClick={handleRegenerate}
          >
            重新生成
          </Button>
        </div>
      )}
      {message.executionId === null ? (
        singleAgentArtifacts.length > 0 && (
          <FileArtifactsCard
            artifacts={singleAgentArtifacts}
            conversationId={conversationId}
          />
        )
      ) : (
        <MultiAgentFileArtifacts
          messageId={projectionId}
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
      {bottomCheckpoints.map((cp) => (
        <CheckpointCard key={cp.id} checkpoint={cp} />
      ))}
      {bottomAsks.map((ask) => (
        <NonBlockingAskCard key={ask.id} ask={ask} />
      ))}
      {bottomReviews.map((pr) => (
        <PlanReviewCard key={pr.id} review={pr} />
      ))}
      {bottomPreviews.map((tp) => (
        <TeamPreviewCard key={tp.id} preview={tp} />
      ))}
      {message.executionId && !hasTeamMarker && (
        <EscalationCards
          messageId={projectionId}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
      )}
      {message.isStreaming && message.content.length > 0 && (
        <div className="mt-1 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <SimpleTooltip label={streamCopied ? "已复制" : "复制"}>
            <IconButton
              size="sm"
              aria-label="复制"
              onClick={() => void onStreamCopy()}
            >
              {streamCopied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          </SimpleTooltip>
        </div>
      )}
      {!message.isStreaming && message.syncStatus && (
        <div className="mt-1">
          <SyncStatusHint syncStatus={message.syncStatus} />
        </div>
      )}
      {!message.isStreaming && !isGenerating && message.content.length > 0 && (
        <AssistantMessageFooter
          message={message}
          captainContext={captainContext}
          costText={costText}
          finishReason={finishReason}
          onRegenerate={handleRegenerate}
        />
      )}
    </div>
  );
}
