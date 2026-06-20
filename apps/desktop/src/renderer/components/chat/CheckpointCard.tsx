import { notifyError } from "@/lib/toast";
import {
  type CheckpointUserDecision,
  decideCheckpoint,
} from "@/services/checkpoint";
import type { CheckpointDisplay } from "@/stores/conversation";
import type {
  AskAssumption,
  AskQuestion,
  AskStyleOption,
} from "@/types/events";
import {
  Check,
  ChevronRight,
  CircleHelp,
  Clock,
  Loader2,
  OctagonX,
  Pencil,
  Rocket,
  SlidersHorizontal,
} from "lucide-react";
import { useState } from "react";

/**
 * Inline ask_user card — the CEO paused the turn to ask the user. This is the ONE
 * asking surface (it absorbed the former kickoff 开工提案卡): the same suspend +
 * resolve card adapts to both an **opening 引导** (a producible-but-underspecified
 * request → 起步计划 assumptions + ≤5 pre-filled 重点问题 + style presets) and a
 * compact **mid-task fork** (one focal A/B / irreversible step). Rendered under the
 * assistant bubble that raised it (会话流内), so it both gates the live turn and
 * replays inline on reload.
 *
 * The interactive body lives in {@link AskUserCard}, shared with the durable
 * 待恢复 resume card (ResumePrompt) so a pause answered live and one answered after a
 * reconnect read identically — one card, one answer model.
 *
 * `interactive` is true only for the live, suspended turn (the owning message is
 * still streaming). A pending card on a finished/reloaded turn renders as a passive
 * record (its actionable resume lives in the 待恢复 paused-turn card); a resolved
 * one always renders its settled state.
 */
export function CheckpointCard({
  checkpoint,
  conversationId,
  interactive,
}: {
  checkpoint: CheckpointDisplay;
  conversationId: string | null;
  interactive: boolean;
}) {
  if (checkpoint.status === "resolved") {
    return <ResolvedCheckpoint checkpoint={checkpoint} />;
  }
  if (!interactive || !conversationId) {
    return <DormantCheckpoint checkpoint={checkpoint} />;
  }
  return (
    <AskUserCard
      content={checkpoint}
      onSubmit={(decision, note) =>
        decideCheckpoint(conversationId, checkpoint.id, decision, note, [])
      }
    />
  );
}

/** The minimal ask_user content both the live card and the durable resume card
 * render. A {@link CheckpointDisplay} (live/replay) and a paused-turn frame both
 * satisfy it, so the one {@link AskUserCard} body serves both surfaces. */
export interface AskUserContent {
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  styleOptions: AskStyleOption[];
}

/** Whether the card leans「开场引导」(ready-to-go, primary) vs「途中拍板」(careful
 * fork, warning): an opening carries 起步计划 / 风格, or pre-fills every question
 * with a default; a mid-task fork carries a bare question with no defaults. */
function isOpeningFlavored(c: AskUserContent): boolean {
  if (c.assumptions.length > 0 || c.styleOptions.length > 0) return true;
  return (
    c.questions.length > 0 && c.questions.every((q) => q.default.length > 0)
  );
}

/** Per-tone class sets — kept as full literal strings so Tailwind keeps them. */
const TONE = {
  primary: {
    wrap: "border-primary/30 bg-primary/5",
    accent: "text-primary",
    badge: "bg-primary/10 text-primary",
    optActive: "border-primary bg-primary/10 text-foreground",
    optIdle:
      "border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-foreground",
    markActive: "border-primary bg-primary text-primary-foreground",
    dot: "bg-primary-foreground",
    focus: "focus:border-primary/60",
    ctaBar: "border-primary/15 bg-primary/10",
    cta: "bg-primary text-primary-foreground hover:bg-primary/90",
  },
  warning: {
    wrap: "border-warning/40 bg-warning/10",
    accent: "text-warning",
    badge: "bg-warning/10 text-warning",
    optActive: "border-warning bg-warning/15 text-foreground",
    optIdle:
      "border-border bg-card text-muted-foreground hover:border-warning/40 hover:bg-accent hover:text-foreground",
    markActive: "border-warning bg-warning text-warning-foreground",
    dot: "bg-warning-foreground",
    focus: "focus:border-warning/60",
    ctaBar: "border-warning/20 bg-warning/10",
    cta: "bg-warning text-warning-foreground hover:bg-warning/90",
  },
} as const;

/**
 * The live, actionable ask_user card body — the single asking surface, shared by the
 * inline live card ({@link CheckpointCard}) and the durable 待恢复 resume card
 * (ResumePrompt). Renders framing + optional 起步计划 (read-only) + askable questions
 * + 风格 + a free note, settled by 提交 (→ continue) or 停止. The picks are composed
 * into ONE readable note (答复模型 α — the only reader is the CEO), handed to
 * `onSubmit`; the caller wires it to the resolve (live) or resume (durable) endpoint.
 *
 * Tone / icon / CTA are derived from CONTENT, not a separate tool: an opening (起步
 * 计划 / 风格, or every question pre-filled) reads as `primary` (蓝=就绪/确认即开做);
 * a bare high-cost fork reads as `warning` (琥珀=待裁决). `caption` overrides the top
 * status line (the resume card states it reconnected).
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
  const tone = opening ? TONE.primary : TONE.warning;

  // Per-question answer: choice → option(s), text → [typed value]. Seed from each
  // question's default so a 想省事 user can one-click submit an opening as-is.
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const q of content.questions)
      init[q.id] = q.default ? [q.default] : [];
    return init;
  });
  // Per-question「其他」escape hatch (Cursor 式): when a choice question's options
  // don't fit, the user reveals an inline custom field for THAT question instead of
  // dumping into the single global note. `otherOn` is the revealed/selected flag,
  // `otherText` the typed value — folded into that question's answer on submit.
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [styleId, setStyleId] = useState<string | null>(
    content.styleOptions[0]?.id ?? null,
  );
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<CheckpointUserDecision | null>(
    null,
  );
  const busy = submitting !== null;

  const toggleChoice = (q: AskQuestion, opt: string) => {
    if (busy) return;
    setAnswers((cur) => {
      const picked = cur[q.id] ?? [];
      if (q.multiple) {
        return {
          ...cur,
          [q.id]: picked.includes(opt)
            ? picked.filter((o) => o !== opt)
            : [...picked, opt],
        };
      }
      return { ...cur, [q.id]: picked.includes(opt) ? [] : [opt] };
    });
    // Single-select: picking a listed option deselects「其他」(mutually exclusive).
    if (!q.multiple)
      setOtherOn((cur) => (cur[q.id] ? { ...cur, [q.id]: false } : cur));
  };

  const setText = (q: AskQuestion, value: string) => {
    if (busy) return;
    setAnswers((cur) => ({ ...cur, [q.id]: value ? [value] : [] }));
  };

  // Toggle a choice question's「其他」field. Single-select: engaging it clears the
  // listed picks (mutually exclusive); multi-select: it coexists with checked options.
  const toggleOther = (q: AskQuestion) => {
    if (busy) return;
    const turningOn = !otherOn[q.id];
    setOtherOn((cur) => ({ ...cur, [q.id]: turningOn }));
    if (turningOn && !q.multiple) setAnswers((cur) => ({ ...cur, [q.id]: [] }));
  };

  const setOtherValue = (q: AskQuestion, value: string) => {
    if (busy) return;
    setOtherText((cur) => ({ ...cur, [q.id]: value }));
  };

  const send = (decision: CheckpointUserDecision) => {
    if (busy) return;
    setSubmitting(decision);
    // 停止 carries only an optional closing remark; 提交 composes the picks +
    // style + note into one readable answer (selected stays empty — α 答复模型).
    const composed =
      decision === "stop"
        ? note.trim()
        : composeAnswer(
            content,
            answers,
            otherOn,
            otherText,
            styleId,
            note,
            opening,
          );
    // The caller resolves / resumes; on a hard failure (live decide) re-enable so
    // the user can retry (resume unmounts the card, so the reset is a harmless no-op).
    Promise.resolve(onSubmit(decision, composed)).catch((err) => {
      // 硬失败（非 404 的 live decide）会重新点亮卡片；仅靠卡片复活太隐蔽，故 toast
      // （同 ApprovalPrompt）。resume 路径 onSubmit=runResume 自带横幅且不抛，不会在此重复报错。
      notifyError(err, "提交失败");
      setSubmitting(null);
    });
  };

  // How many decisions already carry a value — surfaced on the opening CTA so a
  // 想省事 user sees the card is ready to ship as-is.
  const presetCount =
    content.questions.filter(
      (q) =>
        (answers[q.id] ?? []).length > 0 ||
        (otherOn[q.id] && (otherText[q.id] ?? "").trim().length > 0),
    ).length + (styleId ? 1 : 0);

  return (
    <div
      className={`animate-task-card-enter mt-2 overflow-hidden rounded-xl border ${tone.wrap}`}
    >
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

        {/* 起步计划：可折叠的只读信息块（默认展开；收起后 summary 仍预览各项名）。 */}
        {content.assumptions.length > 0 && (
          <details
            open
            className="group rounded-lg border-l-2 border-primary/30 bg-muted/40"
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={13}
                className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
              />
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                起步计划
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70 group-open:hidden">
                {content.assumptions.map((a) => a.label).join(" · ")}
              </span>
            </summary>
            <div className="space-y-1 px-3 pb-2 pl-8">
              {content.assumptions.map((a) => (
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
          </details>
        )}

        {content.questions.map((q, i) => (
          <QuestionField
            key={q.id}
            index={i + 1}
            numbered={content.questions.length > 1}
            question={q}
            answer={answers[q.id] ?? []}
            otherOn={otherOn[q.id] ?? false}
            otherText={otherText[q.id] ?? ""}
            disabled={busy}
            tone={tone}
            onToggleChoice={(opt) => toggleChoice(q, opt)}
            onSetText={(v) => setText(q, v)}
            onToggleOther={() => toggleOther(q)}
            onSetOther={(v) => setOtherValue(q, v)}
          />
        ))}

        {content.styleOptions.length > 0 && (
          <div>
            <p className="flex items-center gap-1 text-xs font-medium text-foreground">
              <SlidersHorizontal size={13} className="text-muted-foreground" />
              风格基调
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {content.styleOptions.map((s) => {
                const active = s.id === styleId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={busy}
                    onClick={() => !busy && setStyleId(active ? null : s.id)}
                    className={`rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                      active ? tone.optActive : tone.optIdle
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          rows={2}
          placeholder={
            opening
              ? "可选 · 补充或修改任何一处，留空就按上面开做"
              : "可选 · 补充说明或调整方向"
          }
          className={`w-full resize-none rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-40 ${tone.focus}`}
        />
      </div>

      {/* CTA 区：浅分隔 + 略深底，把主路径「提交」摆到最显眼。 */}
      <div
        className={`mt-3 flex flex-wrap items-center gap-2.5 border-t px-3 py-2.5 ${tone.ctaBar}`}
      >
        <button
          type="button"
          onClick={() => send("continue")}
          disabled={busy}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium disabled:opacity-40 ${tone.cta}`}
        >
          {submitting === "continue" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : opening ? (
            <Rocket size={14} />
          ) : (
            <Check size={14} />
          )}
          <span>{opening ? "就这样开做" : "提交"}</span>
        </button>
        <button
          type="button"
          onClick={() => send("stop")}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
        >
          {submitting === "stop" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <OctagonX size={14} />
          )}
          <span>停止</span>
        </button>
        {opening && (
          <span className="min-w-0 text-xs text-muted-foreground">
            {presetCount > 0
              ? `已为你预选 ${presetCount} 项，也可在下方对话框回复`
              : "也可直接在下方对话框回复"}
          </span>
        )}
      </div>
    </div>
  );
}

/** One askable item: a choice (radio / checkbox) or free-form text fill. `numbered`
 * shows a leading step badge (only when there is more than one question, so a lone
 * mid-task fork stays clean). */
function QuestionField({
  index,
  numbered,
  question,
  answer,
  otherOn,
  otherText,
  disabled,
  tone,
  onToggleChoice,
  onSetText,
  onToggleOther,
  onSetOther,
}: {
  index: number;
  numbered: boolean;
  question: AskQuestion;
  answer: string[];
  otherOn: boolean;
  otherText: string;
  disabled: boolean;
  tone: (typeof TONE)[keyof typeof TONE];
  onToggleChoice: (opt: string) => void;
  onSetText: (value: string) => void;
  onToggleOther: () => void;
  onSetOther: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        {numbered && (
          <span
            className={`flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium ${tone.badge}`}
          >
            {index}
          </span>
        )}
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-foreground">
          {question.prompt}
        </p>
        {question.kind === "choice" && question.multiple && (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            可多选
          </span>
        )}
      </div>
      <div className={`mt-1.5 ${numbered ? "pl-7" : ""}`}>
        {question.kind === "text" ? (
          <input
            type="text"
            value={answer[0] ?? ""}
            onChange={(e) => onSetText(e.target.value)}
            disabled={disabled}
            placeholder={question.default || undefined}
            className={`w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-40 ${tone.focus}`}
          />
        ) : (
          <div className="space-y-1">
            {question.options.map((opt) => {
              const active = answer.includes(opt);
              const isDefault = !!question.default && opt === question.default;
              return (
                <button
                  key={opt}
                  type="button"
                  disabled={disabled}
                  onClick={() => onToggleChoice(opt)}
                  className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
                    active ? tone.optActive : tone.optIdle
                  }`}
                >
                  <span
                    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border-2 ${
                      question.multiple ? "rounded-lg" : "rounded-full"
                    } ${active ? tone.markActive : "border-border"}`}
                  >
                    {active &&
                      (question.multiple ? (
                        <Check size={11} strokeWidth={3} />
                      ) : (
                        <span className={`size-2 rounded-full ${tone.dot}`} />
                      ))}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">
                    {opt}
                  </span>
                  {isDefault && (
                    <span
                      className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-xs ${
                        active ? tone.badge : "bg-muted text-muted-foreground"
                      }`}
                    >
                      默认
                    </span>
                  )}
                </button>
              );
            })}
            {/* 「其他」逃生口：选项不合适时就地为这一题填自定义答案，而非塞进全局补充框。 */}
            <button
              type="button"
              disabled={disabled}
              onClick={onToggleOther}
              className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
                otherOn ? tone.optActive : tone.optIdle
              }`}
            >
              <span
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border-2 ${
                  question.multiple ? "rounded-lg" : "rounded-full"
                } ${otherOn ? tone.markActive : "border-border"}`}
              >
                {otherOn &&
                  (question.multiple ? (
                    <Check size={11} strokeWidth={3} />
                  ) : (
                    <span className={`size-2 rounded-full ${tone.dot}`} />
                  ))}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">其他…</span>
            </button>
            {otherOn && (
              <input
                type="text"
                value={otherText}
                onChange={(e) => onSetOther(e.target.value)}
                disabled={disabled}
                // biome-ignore lint/a11y/noAutofocus: 用户点开「其他」才渲染此框，聚焦到刚展开的字段是预期 UX（非页面加载时强夺焦点）。
                autoFocus
                placeholder="填写你的答案"
                className={`w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-40 ${tone.focus}`}
              />
            )}
          </div>
        )}
      </div>
    </div>
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
const RESOLVED_TONE = {
  success: {
    wrap: "border-success/25 bg-success/5",
    badge: "bg-success/10 text-success",
    label: "text-success",
  },
  destructive: {
    wrap: "border-destructive/25 bg-destructive/5",
    badge: "bg-destructive/10 text-destructive",
    label: "text-destructive",
  },
  muted: {
    wrap: "border-border bg-muted/30",
    badge: "bg-muted text-muted-foreground",
    label: "text-muted-foreground",
  },
} as const;

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

/** Compose the user's picks + style + free note into ONE readable answer the CEO
 * can act on (答复模型 α): each answered question, the chosen style, and any note.
 * Plain text — the only reader is the CEO (an LLM), so there is no structured wire
 * payload it would just flatten back to prose. A pure free-text ask (no structured
 * items) sends the raw note. */
function composeAnswer(
  content: AskUserContent,
  answers: Record<string, string[]>,
  otherOn: Record<string, boolean>,
  otherText: Record<string, string>,
  styleId: string | null,
  note: string,
  opening: boolean,
): string {
  const trimmed = note.trim();
  if (content.questions.length === 0 && content.styleOptions.length === 0) {
    return trimmed;
  }
  const lines: string[] = [];
  for (const q of content.questions) {
    const picked = (answers[q.id] ?? []).map((s) => s.trim()).filter(Boolean);
    // 「其他」自定义值并入这一题的答案（多选时与已勾选项并列，单选时即为答案）。
    const custom = otherOn[q.id] ? (otherText[q.id] ?? "").trim() : "";
    const values = custom ? [...picked, custom] : picked;
    if (values.length) lines.push(`· ${q.prompt}：${values.join("、")}`);
    else if (q.default) lines.push(`· ${q.prompt}：（按你的默认）`);
  }
  const style = content.styleOptions.find((s) => s.id === styleId);
  if (style) lines.push(`· 风格：${style.label}`);
  if (trimmed) lines.push(`· 补充：${trimmed}`);
  if (lines.length === 0) return trimmed;
  return [opening ? "就按这个方案开做：" : "我的答复：", ...lines].join("\n");
}
