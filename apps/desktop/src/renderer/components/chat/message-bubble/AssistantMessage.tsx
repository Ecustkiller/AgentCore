import { CheckpointCard } from "@/components/chat/CheckpointCard";
import { EscalationCards } from "@/components/chat/EscalationCard";
import { FileArtifactsCard } from "@/components/chat/FileArtifactsCard";
import { InlineTeamGraph } from "@/components/chat/InlineTeamGraph";
import { Markdown } from "@/components/chat/Markdown";
import { NonBlockingAskCard } from "@/components/chat/NonBlockingAskCard";
import { PlanReviewCard } from "@/components/chat/PlanReviewCard";
import { type CitationFlash, SourceCards } from "@/components/chat/SourceCards";
import { Button } from "@/components/ui";
import { FinishReasonChip } from "@/components/ui/finish-reason-chip";
import { referencedCitationNumbers } from "@/lib/citations";
import { errorActionForCode } from "@/lib/errors";
import {
  fileArtifactsFromExecution,
  fileArtifactsFromProcess,
  mergeArtifacts,
} from "@/lib/fileArtifacts";
import { formatCost } from "@/lib/format";
import { runRegenerate } from "@/services/turns";
import {
  getActiveRuntime,
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useMessageExecution } from "@/stores/execution";
import { useUsageStore } from "@/stores/usage";
import type { ProcessStep } from "@/types/events";
import {
  AlertTriangle,
  FolderUp,
  KeyRound,
  RefreshCw,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AssistantMessageFooter } from "./AssistantMessageFooter";
import { ComposingToolLine, ProcessTimeline } from "./ProcessTimeline";
import { ThinkingDots, ThinkingPanel } from "./Thinking";
import type { MessageBubbleProps } from "./types";

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

/**
 * P2 工作区升级提示 (前端UX设计.md §九) — a lightweight, live-only inline notice
 * stamped onto the turn whose first file write promoted a bare chat into a
 * folder-backed workspace (`workspace_promoted`). Explains WHY a 工作区/文件夹 just
 * appeared, so the jump from「随手聊」to「有文件的工作区」isn't silent. Not persisted:
 * on reload the folder is simply there, no longer news.
 */
function WorkspacePromotionNotice({ name }: { name: string }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm text-foreground">
      <FolderUp size={15} className="mt-0.5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">
        本对话已升级为工作区
        <span className="font-medium">「{name}」</span>
        ，之后生成的文件都会保存在这里。
      </p>
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
  const checkpoints = message.checkpoints ?? [];
  const nonBlockingAsks = message.nonBlockingAsks ?? [];
  const planReviews = message.planReviews ?? [];
  // 统一团队时间线: cards whose positional marker rides the inline timeline render there;
  // only un-anchored ones (no-process turns, or legacy rows whose process predates the
  // markers) still fall back to the bottom stack — never double-render.
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
  // Escalations ride the team execution's inline slot (next to the graph, in
  // ProcessTimeline) whenever the turn carries a `team` marker; only un-anchored
  // legacy turns (graph re-folded at the bottom / no-process) fall back to the
  // bottom stack here — never double-render.
  const hasTeamMarker = useMemo(
    () => procSteps.some((s) => s.kind === "team"),
    [procSteps],
  );
  const bottomCheckpoints = checkpoints.filter(
    (c) => !markedCheckpoints.has(c.id),
  );
  const bottomAsks = nonBlockingAsks.filter((a) => !markedAsks.has(a.id));
  const bottomReviews = planReviews.filter((p) => !markedReviews.has(p.id));
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
      fallbackContent={message.content}
      executionId={message.executionId}
      messageId={message.id}
      journal={message.runs}
      conversationId={conversationId}
      checkpoints={checkpoints}
      nonBlockingAsks={nonBlockingAsks}
      planReviews={planReviews}
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
      <FinishReasonChip reason={finishReason} />
      {turnBody}
      {message.error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {message.error.message}
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
          <FileArtifactsCard artifacts={singleAgentArtifacts} />
        )
      ) : (
        <MultiAgentFileArtifacts
          messageId={message.id}
          process={message.process}
        />
      )}
      {message.workspacePromotion && (
        <WorkspacePromotionNotice name={message.workspacePromotion.name} />
      )}
      {citations.length > 0 && (
        <SourceCards
          citations={citations}
          flash={citeFlash}
          referenced={referenced}
        />
      )}
      {bottomCheckpoints.map((cp) => (
        <CheckpointCard
          key={cp.id}
          checkpoint={cp}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
      ))}
      {bottomAsks.map((ask) => (
        <NonBlockingAskCard key={ask.id} ask={ask} />
      ))}
      {bottomReviews.map((pr) => (
        <PlanReviewCard
          key={pr.id}
          review={pr}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
      ))}
      {message.executionId && !hasTeamMarker && (
        <EscalationCards
          messageId={message.id}
          conversationId={conversationId}
          interactive={message.isStreaming}
        />
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
