import { CheckpointCard } from "@/components/chat/CheckpointCard";
import { EscalationCards } from "@/components/chat/EscalationCard";
import { InlineTeamGraph } from "@/components/chat/InlineTeamGraph";
import { Markdown } from "@/components/chat/Markdown";
import { NonBlockingAskCard } from "@/components/chat/NonBlockingAskCard";
import { PlanReviewCard } from "@/components/chat/PlanReviewCard";
import {
  ComposingToolLine,
  ToolLine,
  ToolLineGroup,
} from "@/components/chat/ToolLine";
import { groupToolRuns } from "@/lib/processTimeline";
import type {
  CheckpointDisplay,
  NonBlockingAskDisplay,
  PlanReviewDisplay,
} from "@/stores/conversation";
import { useStreamAwareDisclosure } from "@/stores/disclosure";
import type { ExecutionJournal } from "@/stores/execution";
import type { Citation, ProcessStep } from "@/types/events";
import { Fragment } from "react";
import { ThinkingDots, ThinkingHeader } from "./Thinking";

function InlineReasoning({
  text,
  streaming,
  persistKey,
}: {
  text: string;
  streaming: boolean;
  /** 持久化键（`${messageId}:reason:${i}`）：给了才把「思考过程开合」跨卸载/刷新记住；缺省走会话态。 */
  persistKey?: string | null;
}) {
  // 「直播中自动展开、收场后按保存值」（Q3）——不再收场强制收起并遗忘。
  const [expanded, toggle] = useStreamAwareDisclosure(
    persistKey ?? null,
    streaming,
  );

  return (
    <div>
      <ThinkingHeader
        isStreaming={streaming}
        expanded={expanded}
        streamingLabel="正在思考…"
        doneLabel="思考过程"
        onToggle={toggle}
      />
      {expanded && (
        <div className="mt-1.5 pl-3">
          <Markdown content={text} isStreaming={streaming} muted />
        </div>
      )}
    </div>
  );
}

function ProcessRow({
  step,
  streaming,
  citations,
  onCitationClick,
  turnKey,
  rowIndex,
}: {
  step: ProcessStep;
  streaming: boolean;
  citations: Citation[];
  onCitationClick: (n: number) => void;
  /** 回合作用域（= messageId）：给了才持久化本行的折叠态；缺省走会话态。 */
  turnKey?: string;
  /** 本行在时间线的稳定序号（append-only）——推理行按序号做键，工具行按 step.id。 */
  rowIndex: number;
}) {
  if (step.kind === "reasoning") {
    return (
      <InlineReasoning
        text={step.text}
        streaming={streaming}
        persistKey={turnKey ? `${turnKey}:reason:${rowIndex}` : null}
      />
    );
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
  // Positional markers (team/checkpoint/ask/plan_review) are resolved in the timeline
  // map, never routed here — only a `tool` step reaches this tail.
  if (step.kind === "tool") return <ToolLine step={step} turnKey={turnKey} />;
  return null;
}

export function ProcessTimeline({
  process,
  isStreaming,
  citations,
  onCitationClick,
  composingTool,
  fallbackContent,
  executionId,
  messageId,
  journal,
  conversationId,
  checkpoints,
  nonBlockingAsks,
  planReviews,
}: {
  process: ProcessStep[];
  isStreaming: boolean;
  citations: Citation[];
  onCitationClick: (n: number) => void;
  composingTool: { toolName: string; chars: number } | null;
  fallbackContent: string;
  executionId?: string | null;
  messageId?: string;
  journal?: ExecutionJournal;
  conversationId: string | null;
  checkpoints: CheckpointDisplay[];
  nonBlockingAsks: NonBlockingAskDisplay[];
  planReviews: PlanReviewDisplay[];
}) {
  const last = process[process.length - 1];
  const hasContentStep = process.some((s) => s.kind === "content");
  const showThinkingTail =
    isStreaming &&
    !composingTool &&
    last?.kind === "tool" &&
    last.status !== "running";

  const nodes = groupToolRuns(process);
  // The team graph normally rides its inline `team` marker; only legacy turns whose
  // persisted process predates the marker fall back to a bottom-stamped graph.
  const hasTeamMarker = process.some((s) => s.kind === "team");

  return (
    <div className="space-y-2">
      {nodes.map((node, i) => {
        const live = isStreaming && i === nodes.length - 1;
        // Positional markers (统一团队时间线): resolve each marker to its card / graph at
        // its chronological slot, looking the payload up from the turn's side channels.
        if (node.kind === "team") {
          // 统一团队时间线: the collaboration graph rides this slot — and the team's
          // escalations (worker→CEO→你 求决策) ride right with it. They are
          // execution-scoped moments that belong WITH the team, not stamped at the
          // bubble bottom AFTER the final answer; the bottom stack keeps them only for
          // un-anchored legacy turns (no `team` marker). EscalationCards self-hides
          // when the turn raised none.
          return messageId ? (
            <Fragment key={`team-${node.execution_id}`}>
              <InlineTeamGraph
                messageId={messageId}
                executionId={node.execution_id}
                journal={journal}
              />
              <EscalationCards
                messageId={messageId}
                conversationId={conversationId}
                interactive={isStreaming}
              />
            </Fragment>
          ) : null;
        }
        if (node.kind === "checkpoint") {
          const cp = checkpoints.find((c) => c.id === node.checkpoint_id);
          return cp ? <CheckpointCard key={cp.id} checkpoint={cp} /> : null;
        }
        if (node.kind === "ask") {
          const ask = nonBlockingAsks.find((a) => a.id === node.ask_id);
          return ask ? <NonBlockingAskCard key={ask.id} ask={ask} /> : null;
        }
        if (node.kind === "plan_review") {
          const pr = planReviews.find((p) => p.id === node.checkpoint_id);
          return pr ? <PlanReviewCard key={pr.id} review={pr} /> : null;
        }
        if (node.kind === "tool-group") {
          return (
            <ToolLineGroup
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only timeline
              key={i}
              tools={node.tools}
              isStreaming={live}
              turnKey={messageId}
              groupIndex={i}
            />
          );
        }
        const step: ProcessStep = node.kind === "tool" ? node.step : node;
        return (
          <ProcessRow
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only timeline
            key={i}
            step={step}
            streaming={live}
            citations={citations}
            onCitationClick={onCitationClick}
            turnKey={messageId}
            rowIndex={i}
          />
        );
      })}
      {executionId && messageId && !hasTeamMarker && (
        <InlineTeamGraph
          messageId={messageId}
          executionId={executionId}
          journal={journal}
        />
      )}
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

/** Re-export for consumers that imported from ProcessTimeline. */
export { ComposingToolLine } from "@/components/chat/ToolLine";
