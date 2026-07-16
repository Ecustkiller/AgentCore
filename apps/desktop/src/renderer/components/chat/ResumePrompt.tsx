import {
  OrphanedInteractionCard,
  WaitingForDecisionHint,
} from "@/components/chat/OrphanedInteractionCard";
import {
  Badge,
  Button,
  DecisionCard,
  DecisionCardIcon,
  Textarea,
} from "@/components/ui";
import { notifyError } from "@/lib/toast";
import {
  submitInteraction,
  submitInteractionFeedback,
} from "@/services/interactionSubmit";
import type { PlanReviewUserDecision } from "@/services/planReview";
import { runContinueAfterDecision } from "@/services/turns";
import { useConversationStore } from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";
import { useInterruptedAfterDecisionStore } from "@/stores/interruptedAfterDecision";
import { type PendingResume, usePausedTurnStore } from "@/stores/pausedTurns";
import type { InteractionKind } from "@/types/interactionExt";
import type { SidecarInterruptedAfterDecision } from "@shared/sidecar-contract";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  OctagonX,
  Pencil,
  Play,
  Users,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import { AskUserCard } from "./CheckpointCard";

const EMPTY_INTERRUPTED: SidecarInterruptedAfterDecision[] = [];

export function ResumePrompt() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const pending = usePausedTurnStore((s) => s.pending);
  const interrupted = useInterruptedAfterDecisionStore((s) =>
    conversationId
      ? (s.byConversation[conversationId] ?? EMPTY_INTERRUPTED)
      : EMPTY_INTERRUPTED,
  );
  const byId = useInteractionStore((s) => s.byId);
  const visible = pending.filter((p) => p.conversationId === conversationId);
  if (visible.length === 0 && interrupted.length === 0) return null;

  return (
    <div className="mx-4 mb-2 space-y-2">
      {interrupted.map((item) => (
        <InterruptedAfterDecisionCard key={item.messageId} item={item} />
      ))}
      {visible.map((turn) => {
        const entry = byId.get(turn.checkpointId);
        if (entry?.status === "orphaned") {
          return (
            <OrphanedInteractionCard
              key={turn.messageId}
              title="确认已失效"
              detail="该暂停确认已不可答复（服务已重启或回合已结束）。"
            />
          );
        }
        return <ResumeCard key={turn.messageId} turn={turn} />;
      })}
    </div>
  );
}

function InterruptedAfterDecisionCard({
  item,
}: {
  item: SidecarInterruptedAfterDecision;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <DecisionCard tone="neutral" animate className="mx-0">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="neutral">
          <Play size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            已授权 · 执行中断
          </p>
          <p className="mt-0.5 text-sm text-foreground">
            你的决定已保存，执行在中途停下。可一键从决策点继续（将重跑决策之后的步骤）。
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <Button
          variant="primary"
          icon={
            busy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )
          }
          disabled={busy}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            void runContinueAfterDecision(item.messageId)
              .catch((err) => notifyError(err, "继续失败"))
              .finally(() => setBusy(false));
          }}
        >
          一键继续
        </Button>
      </div>
    </DecisionCard>
  );
}

function ResumeCard({ turn }: { turn: PendingResume }) {
  // Cold-path only (`submitPath: "cold"` in INTERACTION_REGISTRY).
  const Card = COLD_RESUME_CARDS[turn.kind];
  return <Card turn={turn} />;
}

function coldKind(turn: PendingResume): InteractionKind {
  return turn.kind;
}

function useColdSubmit(turn: PendingResume) {
  const [submitting, setSubmitting] = useState<PlanReviewUserDecision | null>(
    null,
  );
  const entryStatus = useInteractionStore(
    (s) => s.byId.get(turn.checkpointId)?.status,
  );
  const busy = submitting !== null || entryStatus === "submitting";

  const send = (
    decision: PlanReviewUserDecision,
    selected: string[] = [],
    note = "",
  ) => {
    if (busy) return;
    setSubmitting(decision);
    void submitInteraction({
      id: turn.checkpointId,
      kind: coldKind(turn),
      conversationId: turn.conversationId,
      cold: {
        messageId: turn.messageId,
        decision,
        note,
        selected,
      },
    })
      .then((result) => {
        if (result !== "ok") {
          notifyError(submitInteractionFeedback(result));
          setSubmitting(null);
        }
      })
      .catch((err) => {
        notifyError(err, "提交失败");
        setSubmitting(null);
      });
  };

  return { submitting, busy, send };
}

function ReviewedSteps({ turn }: { turn: PendingResume }) {
  return (
    <div className="mt-2 space-y-1.5">
      {turn.steps.map((s) => (
        <div
          key={s.run_id}
          className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
        >
          <p className="text-xs font-medium text-foreground">{s.role}</p>
          {s.summary && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
              {s.summary}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function PendingPreview({ turn }: { turn: PendingResume }) {
  if (turn.pending.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <ArrowRight size={13} className="shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">继续后将运行</span>
      {turn.pending.map((n) => (
        <Badge key={n.run_id} tone="muted">
          {n.role}
        </Badge>
      ))}
    </div>
  );
}

function PlanReviewResumeCard({ turn }: { turn: PendingResume }) {
  const [note, setNote] = useState("");
  const { submitting, busy, send } = useColdSubmit(turn);

  const spinnerOr = (
    decision: PlanReviewUserDecision,
    icon: React.ReactNode,
  ) =>
    submitting === decision ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  return (
    <DecisionCard tone="primary" animate className="mx-0">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="primary">
          <GitBranch size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-primary">
            已暂停 · 待你决定是否继续
          </p>
          <WaitingForDecisionHint />
          <p className="mt-0.5 text-sm text-foreground">
            这一步已完成，请过目：
          </p>
          <ReviewedSteps turn={turn} />
          <PendingPreview turn={turn} />

          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="可选 · 备注（调整时作为对下游的指示；停止时作为收尾备注）"
            className="mt-2 w-full border-border bg-card/70 focus:border-primary/60"
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <Button
          variant="primary"
          icon={spinnerOr("continue", <Check size={13} />)}
          disabled={busy}
          onClick={() => send("continue", [], note.trim())}
        >
          继续
        </Button>
        <Button
          variant="neutral"
          icon={spinnerOr("adjust", <Pencil size={13} />)}
          disabled={busy || !note.trim()}
          onClick={() => send("adjust", [], note.trim())}
        >
          调整
        </Button>
        <Button
          variant="danger"
          icon={spinnerOr("stop", <OctagonX size={13} />)}
          disabled={busy}
          onClick={() => send("stop", [], note.trim())}
        >
          停止
        </Button>
      </div>
    </DecisionCard>
  );
}

function TeamPreviewWorkers({ turn }: { turn: PendingResume }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggle = (runId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  return (
    <div className="mt-2 space-y-1.5">
      {turn.workers.map((w) => {
        const open = expanded.has(w.run_id);
        const meta = (
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="min-w-0 text-xs font-medium text-foreground">
              {w.role}
            </p>
            {w.debate && (
              <span className="text-xs text-muted-foreground">辩论</span>
            )}
            {w.depends_on.length > 0 && (
              <span className="text-xs text-muted-foreground">
                依赖 {w.depends_on.length} 步
              </span>
            )}
          </div>
        );

        if (!w.task) {
          return (
            <div
              key={w.run_id}
              className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
            >
              {meta}
            </div>
          );
        }

        return (
          <div
            key={w.run_id}
            className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
          >
            <button
              type="button"
              onClick={() => toggle(w.run_id)}
              aria-expanded={open}
              aria-label={open ? `收起 ${w.role} 任务` : `展开 ${w.role} 任务`}
              className="w-full text-left"
            >
              <div className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1">{meta}</div>
                {open ? (
                  <ChevronDown
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <ChevronRight
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                )}
              </div>
              <p
                className={
                  open
                    ? "mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground"
                    : "mt-0.5 line-clamp-1 text-xs text-muted-foreground"
                }
              >
                {w.task}
              </p>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function TeamPreviewDebateBody({ turn }: { turn: PendingResume }) {
  return (
    <div className="mt-2 space-y-1.5">
      {turn.motion && (
        <p className="whitespace-pre-wrap text-sm text-foreground">
          {turn.motion}
        </p>
      )}
      {turn.sides.map((s) => (
        <div
          key={s.key}
          className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-medium text-foreground">{s.name}</p>
            {s.is_subject && (
              <span className="text-xs text-muted-foreground">方案方</span>
            )}
          </div>
          {s.stance && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
              {s.stance}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function TeamPreviewResumeCard({ turn }: { turn: PendingResume }) {
  const [note, setNote] = useState("");
  const { submitting, busy, send } = useColdSubmit(turn);
  const isDebate = turn.primitive === "debate";
  const showCapabilities = !isDebate && turn.tools.length > 0;
  const debateBudget = isDebate
    ? turn.maxRounds > 0
      ? turn.thorough
        ? `认真辩透 · ${turn.maxRounds} 轮`
        : `快速对碰 · ${turn.maxRounds} 轮`
      : turn.thorough
        ? "认真辩透"
        : "快速对碰"
    : null;

  const spinnerOr = (
    decision: PlanReviewUserDecision,
    icon: React.ReactNode,
  ) =>
    submitting === decision ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  const toolLabel = (name: string) =>
    (
      ({
        file_write: "写入文件",
        file_append: "追加文件",
        str_replace: "修改文件",
        file_delete: "删除文件",
        file_move: "移动文件",
        file_copy: "复制文件",
        mkdir: "创建目录",
        file_batch: "批量文件操作",
        code_execute: "执行代码",
        test_run: "运行测试",
        git: "Git 写入",
      }) as Record<string, string>
    )[name] ?? name;

  return (
    <DecisionCard
      tone="primary"
      animate
      className="mx-0 flex max-h-[min(78vh,42rem)] flex-col overflow-hidden p-0"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="flex items-start gap-2">
            <DecisionCardIcon tone="primary">
              <Users size={16} />
            </DecisionCardIcon>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-primary">
                  {isDebate ? "开工卡 · 辩论计划" : "开工卡 · 计划与授权"}
                </p>
                {debateBudget && (
                  <Badge tone="muted" className="font-normal">
                    {debateBudget}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-sm text-foreground">
                {isDebate
                  ? "即将开赛的辩题与各方立场，请过目后授权开赛："
                  : "即将上场的队员，请过目后授权开工："}
              </p>
              {isDebate ? (
                <TeamPreviewDebateBody turn={turn} />
              ) : (
                <TeamPreviewWorkers turn={turn} />
              )}

              {showCapabilities && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-foreground">
                    将授权的能力范围
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {turn.tools.map((tool) => (
                      <Badge key={tool} tone="muted" className="font-normal">
                        {toolLabel(tool)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="shrink-0 space-y-2 border-t border-border bg-card/95 px-3 py-3 backdrop-blur-sm">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder={
              isDebate
                ? "可选 · 开赛嘱咐（如你最关心的争议点），授权开赛时注入"
                : "可选 · 对全体队员的嘱咐（授权开工时注入）"
            }
            className="w-full border-border bg-card/70 focus:border-primary/60"
          />
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <Button
              variant="primary"
              icon={spinnerOr("continue", <CheckCheck size={13} />)}
              disabled={busy}
              onClick={() => send("continue", [], note.trim())}
            >
              {isDebate ? "授权开赛" : showCapabilities ? "授权并开工" : "开做"}
            </Button>
            <Button
              variant="danger"
              icon={spinnerOr("stop", <OctagonX size={13} />)}
              disabled={busy}
              onClick={() => send("stop", [], note.trim())}
            >
              停止
            </Button>
          </div>
        </div>
      </div>
    </DecisionCard>
  );
}

function AskUserResumeCard({ turn }: { turn: PendingResume }) {
  return (
    <AskUserCard
      content={turn}
      intent={turn.intent}
      disclosureKey={turn.checkpointId}
      conversationId={turn.conversationId}
      onSubmit={async (decision, note, selected = []) => {
        const result = await submitInteraction({
          id: turn.checkpointId,
          kind: "ask_user",
          conversationId: turn.conversationId,
          cold: {
            messageId: turn.messageId,
            decision: decision as PlanReviewUserDecision,
            note,
            selected,
          },
        });
        if (result !== "ok") {
          throw new Error(submitInteractionFeedback(result));
        }
      }}
    />
  );
}

/** Cold-path resume cards — keyed by registry `submitPath: "cold"` kinds. */
const COLD_RESUME_CARDS: Record<
  "ask_user" | "plan_review" | "team_preview",
  ComponentType<{ turn: PendingResume }>
> = {
  ask_user: AskUserResumeCard,
  plan_review: PlanReviewResumeCard,
  team_preview: TeamPreviewResumeCard,
};
