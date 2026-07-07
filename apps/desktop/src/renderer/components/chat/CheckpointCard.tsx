import { Button, DecisionCard } from "@/components/ui";
import {
  interactiveCheckpointTone,
  resolvedCheckpointTone,
} from "@/components/ui/tone-presets";
import { notifyError } from "@/lib/toast";
import type { CheckpointUserDecision } from "@/services/checkpoint";
import type { CheckpointDisplay } from "@/stores/conversation";
import type { CheckpointDecision, CheckpointIntent } from "@/types/events";
import {
  Check,
  CircleHelp,
  Clock,
  Loader2,
  OctagonX,
  Pencil,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import {
  AskNoteField,
  AskQuestionFields,
  type AskUserContent,
  useAskAnswer,
} from "./ask/AskUserFields";

/**
 * Inline ask_user card — the CEO paused the turn to ask the user. This is the ONE
 * asking surface (it absorbed the former kickoff 开工提案卡): the same suspend +
 * resolve card adapts to both an **opening 引导** (a producible-but-underspecified
 * request → 起步计划 assumptions + ≤5 pre-filled 重点问题 + style presets) and a
 * compact **mid-task fork** (one focal A/B / irreversible step). Rendered under the
 * assistant bubble that raised it (会话流内), so it both gates the live turn and
 * replays inline on reload.
 *
 * The interactive body lives in {@link AskUserCard}, reused by the durable 待恢复 resume
 * card (ResumePrompt) — one card, one answer model.
 *
 * 挂起即收口 (②, Phase 3): an inline ask_user card is never live-interactive anymore — a
 * CEO checkpoint finalizes the turn (its in-process resolve Future is never parked), so
 * the actionable surface is always the durable resume card. Inline, pending renders nothing
 * (CEO message body stays visible); settled → resolved record card.
 */
export function CheckpointCard({
  checkpoint,
}: {
  checkpoint: CheckpointDisplay;
}) {
  if (checkpoint.status === "resolved") {
    return <ResolvedCheckpoint checkpoint={checkpoint} />;
  }
  return null;
}

const INTENT_CONFIG = {
  kickoff: {
    icon: Rocket,
    activeCaption: "开工提案 · 确认即开做",
    cta: "就这样开做",
    ctaIcon: Rocket,
    showFooterHint: true,
    resolved: {
      continue: { label: "已按方案开做", tone: "success" },
      adjust: { label: "已按你的调整开做", tone: "success" },
      stop: { label: "已停止", tone: "destructive" },
      timeout: { label: "未及时回应，已自行开做", tone: "muted" },
    },
  },
  decision: {
    icon: CircleHelp,
    activeCaption: "需要你拍板",
    cta: "提交",
    ctaIcon: Check,
    showFooterHint: false,
    resolved: {
      continue: { label: "已按你的决定继续", tone: "success" },
      adjust: { label: "已按你的调整继续", tone: "success" },
      stop: { label: "已停止本回合", tone: "destructive" },
      timeout: { label: "未及时回应，已自行收尾", tone: "muted" },
    },
  },
} as const satisfies Record<
  CheckpointIntent,
  {
    icon: LucideIcon;
    activeCaption: string;
    cta: string;
    ctaIcon: LucideIcon;
    showFooterHint: boolean;
    resolved: Record<
      CheckpointDecision,
      { label: string; tone: keyof typeof resolvedCheckpointTone }
    >;
  }
>;

/** Per-tone class sets — from shared tone-presets (Tailwind literal strings). */
const TONE = interactiveCheckpointTone;

const RESOLVED_DECISION_ICON = {
  continue: Check,
  adjust: Pencil,
  stop: OctagonX,
  timeout: Clock,
} as const satisfies Record<CheckpointDecision, LucideIcon>;

/**
 * The live, actionable ask_user card body — the single asking surface, shared by the
 * inline live card ({@link CheckpointCard}) and the durable 待恢复 resume card
 * (ResumePrompt). Renders framing + optional 起步计划 (read-only) + askable questions
 * + 风格 + a free note, settled by 提交 (→ continue) or 停止. The picks are composed
 * into ONE readable note (答复模型 α — the only reader is the CEO), handed to
 * `onSubmit`; the caller wires it to the resolve (live) or resume (durable) endpoint.
 *
 * Tone: 灰壳灰选项（neutral）——内容区低调如配置表单；Footer 主 CTA 仍用品牌蓝承载行动信号。
 * icon + caption + CTA 文案由后端 intent 查表驱动。真·风险审批由 ApprovalPrompt 承载（蓝）。
 */
export function AskUserCard({
  content,
  intent,
  caption,
  onSubmit,
}: {
  content: AskUserContent;
  intent: CheckpointIntent;
  caption?: string;
  onSubmit: (
    decision: CheckpointUserDecision,
    note: string,
  ) => void | Promise<void>;
}) {
  const config = INTENT_CONFIG[intent];
  const tone = TONE.neutral;
  const ans = useAskAnswer(content);
  const [submitting, setSubmitting] = useState<CheckpointUserDecision | null>(
    null,
  );
  const busy = submitting !== null;
  const HeaderIcon = config.icon;
  const CtaIcon = config.ctaIcon;

  const send = (decision: CheckpointUserDecision) => {
    if (busy) return;
    setSubmitting(decision);
    const composed =
      decision === "stop" ? ans.note.trim() : ans.compose(intent);
    Promise.resolve(onSubmit(decision, composed)).catch((err) => {
      notifyError(err, "提交失败");
      setSubmitting(null);
    });
  };

  return (
    <DecisionCard
      tone="neutral"
      animate
      className="flex max-h-[min(50vh,28rem)] flex-col overflow-hidden p-0"
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pt-3">
        <div className="flex items-start gap-1.5">
          <HeaderIcon size={14} className={`mt-0.5 shrink-0 ${tone.accent}`} />
          <div className="min-w-0 flex-1">
            <p className={`text-xs font-medium ${tone.accent}`}>
              {caption ?? config.activeCaption}
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
              {content.question}
            </p>
            {content.context && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {content.context}
              </p>
            )}
          </div>
        </div>

        <AskQuestionFields
          content={content}
          answer={ans}
          tone={tone}
          disabled={busy}
        />

        <AskNoteField
          answer={ans}
          tone={tone}
          disabled={busy}
          placeholder={
            intent === "kickoff" ? "有补充可以写在这里" : "补充说明"
          }
        />
      </div>

      <div className="shrink-0 space-y-2 px-3 pb-3 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="md"
            variant="primary"
            className={tone.cta}
            disabled={busy}
            onClick={() => send("continue")}
            icon={
              submitting === "continue" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <CtaIcon size={14} />
              )
            }
          >
            {config.cta}
          </Button>
          <Button
            size="md"
            variant="danger"
            disabled={busy}
            onClick={() => send("stop")}
            icon={
              submitting === "stop" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <OctagonX size={14} />
              )
            }
          >
            停止
          </Button>
        </div>
        {config.showFooterHint && (
          <span className="block text-xs text-muted-foreground">
            {ans.presetCount > 0
              ? `已预填 ${ans.presetCount} 项，直接开做或按需调整`
              : "也可直接在下方对话框回复"}
          </span>
        )}
      </div>
    </DecisionCard>
  );
}

/** Outcome tone for a settled card — a calm, semantic identity for the record (per
 * color-tokens): 继续/调整 = success (顺利推进), 停止 = destructive, 超时 = muted. */
const RESOLVED_TONE = resolvedCheckpointTone;

/** The settled record of an ask_user card: how it was decided, plus the user's
 * answer note. Carries its outcome's tone (calm) so a glance down the history reads
 * the verdict without expanding. */
function ResolvedCheckpoint({ checkpoint }: { checkpoint: CheckpointDisplay }) {
  const decision = checkpoint.decision ?? "timeout";
  const resolved = INTENT_CONFIG[checkpoint.intent].resolved[decision];
  const tone = RESOLVED_TONE[resolved.tone];
  const DecisionIcon = RESOLVED_DECISION_ICON[decision];

  return (
    <div className={`mt-2 rounded-xl border p-3 ${tone.wrap}`}>
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${tone.badge}`}
        >
          <DecisionIcon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {checkpoint.question}
          </p>
          {checkpoint.selected.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {checkpoint.selected.map((s) => (
                <span
                  key={s}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
                >
                  {s}
                </span>
              ))}
            </div>
          )}
          <p className={`mt-1.5 text-xs font-medium ${tone.label}`}>
            {resolved.label}
          </p>
          {checkpoint.note && (
            <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
              {checkpoint.note}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
