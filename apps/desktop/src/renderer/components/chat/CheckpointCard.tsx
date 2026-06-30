import { Button, DecisionCard, DecisionCardFooter } from "@/components/ui";
import {
  interactiveCheckpointTone,
  resolvedCheckpointTone,
} from "@/components/ui/tone-presets";
import { notifyError } from "@/lib/toast";
import type { CheckpointUserDecision } from "@/services/checkpoint";
import type { CheckpointDisplay } from "@/stores/conversation";
import {
  Check,
  CircleHelp,
  Clock,
  Loader2,
  OctagonX,
  Pencil,
  Rocket,
} from "lucide-react";
import { useState } from "react";
import {
  AskNoteField,
  AskQuestionFields,
  type AskUserContent,
  isOpeningFlavored,
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
 * the actionable surface is always the durable resume card. Inline, this renders only as a
 * passive record (pending → dormant; settled → its resolved state).
 */
export function CheckpointCard({
  checkpoint,
}: {
  checkpoint: CheckpointDisplay;
}) {
  if (checkpoint.status === "resolved") {
    return <ResolvedCheckpoint checkpoint={checkpoint} />;
  }
  return <DormantCheckpoint checkpoint={checkpoint} />;
}

/** Per-tone class sets — from shared tone-presets (Tailwind literal strings). */
const TONE = interactiveCheckpointTone;

/**
 * The live, actionable ask_user card body — the single asking surface, shared by the
 * inline live card ({@link CheckpointCard}) and the durable 待恢复 resume card
 * (ResumePrompt). Renders framing + optional 起步计划 (read-only) + askable questions
 * + 风格 + a free note, settled by 提交 (→ continue) or 停止. The picks are composed
 * into ONE readable note (答复模型 α — the only reader is the CEO), handed to
 * `onSubmit`; the caller wires it to the resolve (live) or resume (durable) endpoint.
 *
 * Tone / icon / CTA are derived from CONTENT, not a separate tool: both an opening
 * (起步计划 / 风格, or every question pre-filled) and a mid-task fork read as `primary`
 * (蓝 = 需要你拍板 / 邀请你决定，而非警告)；icon + caption + CTA 文案区分提案 vs 决策叉。
 * 真·风险审批（写文件 / 执行代码）由 ApprovalPrompt 承载（极简中性下亦为品牌蓝）。`caption` overrides
 * the top status line (the resume card states it reconnected).
 */
export function AskUserCard({
  content,
  caption,
  onSubmit,
}: {
  content: AskUserContent;
  caption?: string;
  onSubmit: (
    decision: CheckpointUserDecision,
    note: string,
  ) => void | Promise<void>;
}) {
  const opening = isOpeningFlavored(content);
  // ask_user 是邀请你拍板/决定（非警告）→ 统一品牌蓝；提案 vs 决策叉靠 icon/caption/CTA 区分。
  const tone = TONE.primary;
  const ans = useAskAnswer(content);
  const [submitting, setSubmitting] = useState<CheckpointUserDecision | null>(
    null,
  );
  const busy = submitting !== null;

  const send = (decision: CheckpointUserDecision) => {
    if (busy) return;
    setSubmitting(decision);
    // 停止 carries only an optional closing remark; 提交 composes the picks +
    // style + note into one readable answer (selected stays empty — α 答复模型).
    const composed =
      decision === "stop" ? ans.note.trim() : ans.compose(opening);
    // The caller resolves / resumes; on a hard failure (live decide) re-enable so
    // the user can retry (resume unmounts the card, so the reset is a harmless no-op).
    Promise.resolve(onSubmit(decision, composed)).catch((err) => {
      // 硬失败（非 404 的 live decide）会重新点亮卡片；仅靠卡片复活太隐蔽，故 toast
      // （同 ApprovalPrompt）。resume 路径 onSubmit=runResume 自带横幅且不抛，不会在此重复报错。
      notifyError(err, "提交失败");
      setSubmitting(null);
    });
  };

  return (
    <DecisionCard tone="primary" animate className="overflow-hidden p-0">
      <div className="space-y-3 px-3 pt-3">
        <div className="flex items-start gap-2">
          {opening ? (
            <Rocket size={16} className={`mt-0.5 shrink-0 ${tone.accent}`} />
          ) : (
            <CircleHelp
              size={16}
              className={`mt-0.5 shrink-0 ${tone.accent}`}
            />
          )}
          <div className="min-w-0 flex-1">
            <p className={`text-xs font-medium ${tone.accent}`}>
              {caption ?? (opening ? "开工提案 · 确认即开做" : "需要你拍板")}
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
            opening
              ? "可选 · 补充或修改任何一处，留空就按上面开做"
              : "可选 · 补充说明或调整方向"
          }
        />
      </div>

      <DecisionCardFooter tone="primary">
        <Button
          size="md"
          variant="primary"
          className={tone.cta}
          disabled={busy}
          onClick={() => send("continue")}
          icon={
            submitting === "continue" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : opening ? (
              <Rocket size={14} />
            ) : (
              <Check size={14} />
            )
          }
        >
          {opening ? "就这样开做" : "提交"}
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
        {opening && (
          <span className="min-w-0 text-xs text-muted-foreground">
            {ans.presetCount > 0
              ? `已为你预选 ${ans.presetCount} 项，也可在下方对话框回复`
              : "也可直接在下方对话框回复"}
          </span>
        )}
      </DecisionCardFooter>
    </DecisionCard>
  );
}

/** A pending ask_user card on a turn that is no longer live (reloaded, or the turn
 * ended without an answer): a static record of what the CEO asked, not actionable
 * (the resume happens via the 待恢复 paused-turn card). */
function DormantCheckpoint({ checkpoint }: { checkpoint: CheckpointDisplay }) {
  return (
    <div className="mt-2 space-y-2.5 rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-2">
        <CircleHelp
          size={16}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            曾请你拍板（本回合已结束）
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
            {checkpoint.question}
          </p>
        </div>
      </div>

      {checkpoint.assumptions.length > 0 && (
        <div className="rounded-lg border-l-2 border-border bg-muted/50 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">起步计划</p>
          <div className="mt-1.5 space-y-1">
            {checkpoint.assumptions.map((a) => (
              <div key={a.id} className="flex gap-2 text-xs">
                <span className="w-16 shrink-0 text-muted-foreground">
                  {a.label}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">
                  {a.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {checkpoint.questions.length > 0 && (
        <div className="space-y-1.5 pl-6">
          {checkpoint.questions.map((q) => (
            <div key={q.id} className="text-xs">
              <p className="whitespace-pre-wrap text-foreground">{q.prompt}</p>
              {q.default && (
                <p className="mt-0.5 text-muted-foreground">
                  建议：{q.default}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Outcome tone for a settled card — a calm, semantic identity for the record (per
 * color-tokens): 继续/调整 = success (顺利推进), 停止 = destructive, 超时 = muted. */
const RESOLVED_TONE = resolvedCheckpointTone;

/** The settled record of an ask_user card: how it was decided, plus the user's
 * answer note. Carries its outcome's tone (calm) so a glance down the history reads
 * the verdict without expanding. */
function ResolvedCheckpoint({ checkpoint }: { checkpoint: CheckpointDisplay }) {
  const meta = {
    continue: { icon: <Check size={14} />, label: "已继续", tone: "success" },
    adjust: {
      icon: <Pencil size={14} />,
      label: "已按你的调整继续",
      tone: "success",
    },
    stop: {
      icon: <OctagonX size={14} />,
      label: "已停止本回合",
      tone: "destructive",
    },
    timeout: {
      icon: <Clock size={14} />,
      label: "未及时回应，已自行收尾",
      tone: "muted",
    },
  }[checkpoint.decision ?? "timeout"] as {
    icon: React.ReactNode;
    label: string;
    tone: keyof typeof RESOLVED_TONE;
  };
  const tone = RESOLVED_TONE[meta.tone];

  return (
    <div className={`mt-2 rounded-xl border p-3 ${tone.wrap}`}>
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${tone.badge}`}
        >
          {meta.icon}
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
            {meta.label}
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
