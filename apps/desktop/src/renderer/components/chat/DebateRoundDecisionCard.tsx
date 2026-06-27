import {
  Button,
  DecisionCard,
  DecisionCardIcon,
  Textarea,
} from "@/components/ui";
import { notifyError } from "@/lib/toast";
import {
  type DebateRoundUserDecision,
  decideDebateRound,
} from "@/services/debate";
import {
  type DebateRoundDecision,
  useMessageExecution,
} from "@/stores/execution";
import { ArrowRight, Check, Clock, Gavel, Loader2, Plus } from "lucide-react";
import { useState } from "react";

/**
 * 交互式逐轮辩论决策卡 (opt-in, 辩论编排设计.md §逐轮交互): the Moderator paused at a round
 * boundary so the user steers depth instead of the judge auto-converging. One card per
 * {@link DebateRoundDecision}, variant by status — `pending` (live) is the interactive 三选一
 * (继续辩 / 加角度 / 够了出结论); `continued`/`concluded`/`timeout` are settled records. Resolves
 * over the unified bridge (`POST …/interactions/{id}`, kind=`debate_round`) — the settle flips the
 * card from the live `debate_round_decision_resolved` SSE, not from the POST.
 */
export function DebateRoundDecisionCard({
  decision,
  conversationId,
  interactive,
}: {
  decision: DebateRoundDecision;
  conversationId: string | null;
  interactive: boolean;
}) {
  if (decision.status !== "pending") {
    return <ResolvedDebateDecision decision={decision} />;
  }
  if (!interactive) {
    return <DormantDebateDecision decision={decision} />;
  }
  return (
    <PendingDebateDecision
      decision={decision}
      conversationId={conversationId}
    />
  );
}

/** 裁判对本轮的建议（卡片把它作为默认动作高亮）：收敛→建议出结论；未收敛→建议继续。 */
function judgeHint(decision: DebateRoundDecision): string {
  const lead = decision.converged ? "裁判：本轮已收敛" : "裁判：建议再辩";
  return decision.rationale ? `${lead}（${decision.rationale}）` : lead;
}

function PendingDebateDecision({
  decision,
  conversationId,
}: {
  decision: DebateRoundDecision;
  conversationId: string | null;
}) {
  const [angle, setAngle] = useState("");
  // The label of the in-flight action (null = idle), so each button shows its own spinner.
  const [submitting, setSubmitting] = useState<string | null>(null);
  const busy = submitting !== null;

  const send = (label: string, call: DebateRoundUserDecision) => {
    if (busy || !conversationId) return;
    setSubmitting(label);
    decideDebateRound(conversationId, decision.id, call).catch((err) => {
      notifyError(err, "提交失败");
      setSubmitting(null);
    });
  };

  const hasAngle = angle.trim().length > 0;

  return (
    <DecisionCard tone="warning" animate>
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="warning">
          <Gavel size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-warning">
            主持人 · 第 {decision.roundNo} 轮已结束 · 请你掌舵
          </p>
          {decision.focus && (
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
              本轮焦点：{decision.focus}
            </p>
          )}
          {decision.summary && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
              {decision.summary}
            </p>
          )}
          <p className="mt-2 rounded-lg bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground">
            {judgeHint(decision)}
          </p>
          <Textarea
            value={angle}
            onChange={(e) => setAngle(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="（可选）想让下一轮聚焦的角度，填了点「按此角度继续」"
            className="mt-2 w-full border-border bg-card/70 focus:border-warning/60"
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <Button
          variant={decision.converged ? "neutral" : "primary"}
          disabled={busy}
          onClick={() => send("continue", { kind: "continue", focus: "" })}
          icon={
            submitting === "continue" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <ArrowRight size={13} />
            )
          }
        >
          继续辩一轮
        </Button>
        <Button
          variant="neutral"
          disabled={busy || !hasAngle}
          onClick={() =>
            send("continue_focus", { kind: "continue", focus: angle.trim() })
          }
          icon={
            submitting === "continue_focus" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Plus size={13} />
            )
          }
        >
          按此角度继续
        </Button>
        <Button
          variant={decision.converged ? "primary" : "neutral"}
          disabled={busy}
          onClick={() => send("conclude", { kind: "conclude" })}
          icon={
            submitting === "conclude" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Check size={13} />
            )
          }
        >
          够了，出结论
        </Button>
      </div>
    </DecisionCard>
  );
}

function DormantDebateDecision({
  decision,
}: {
  decision: DebateRoundDecision;
}) {
  return (
    <DecisionCard tone="neutral">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="neutral">
          <Gavel size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            主持人曾请你掌舵第 {decision.roundNo} 轮（本回合已结束）
          </p>
          {decision.focus && (
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
              本轮焦点：{decision.focus}
            </p>
          )}
        </div>
      </div>
    </DecisionCard>
  );
}

function ResolvedDebateDecision({
  decision,
}: {
  decision: DebateRoundDecision;
}) {
  const isTimeout = decision.status === "timeout";
  const headline =
    decision.status === "concluded"
      ? "你选择了出结论"
      : isTimeout
        ? "未应答 · 已按裁判判断推进"
        : decision.decisionFocus
          ? "你加了角度 · 继续辩论"
          : "你选择了继续辩论";
  return (
    <DecisionCard tone="neutral" className="bg-card/60">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {isTimeout ? <Clock size={14} /> : <Check size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            主持人 · 第 {decision.roundNo} 轮 · {headline}
          </p>
          {decision.decisionFocus && (
            <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
              下一轮角度：{decision.decisionFocus}
            </p>
          )}
        </div>
      </div>
    </DecisionCard>
  );
}

/** All round-boundary decision cards for one debate turn (opt-in, §逐轮交互). Renders nothing
 * for a non-interactive debate (none accrued). A pending card flips to its settled record from
 * the live `debate_round_decision_resolved` SSE — same single data path as the chat surfaces. */
export function DebateRoundDecisionCards({
  messageId,
  conversationId,
  interactive,
}: {
  messageId: string;
  conversationId: string | null;
  interactive: boolean;
}) {
  const execution = useMessageExecution(messageId);
  if (!execution || execution.debateDecisions.length === 0) return null;

  const pendingCount = execution.debateDecisions.filter(
    (d) => d.status === "pending",
  ).length;

  return (
    <div className="space-y-2">
      {pendingCount > 0 && (
        <p className="text-xs font-medium text-warning">
          主持人有 {pendingCount} 处待你掌舵
        </p>
      )}
      {execution.debateDecisions.map((decision) => (
        <DebateRoundDecisionCard
          key={decision.id}
          decision={decision}
          conversationId={conversationId}
          interactive={interactive}
        />
      ))}
    </div>
  );
}
