import { Button, Textarea } from "@/components/ui";
import type { interactiveCheckpointTone } from "@/components/ui/tone-presets";
import type {
  AskAssumption,
  AskQuestion,
  AskStyleOption,
} from "@/types/events";
import { Check, ChevronRight, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

/**
 * Shared 结构化问答内核 — the choice/text question UI + answer-state + answer composition
 * reused by BOTH asking surfaces: the CEO's `ask_user` ({@link AskUserCard}) and a worker's
 * blocking `escalate` ({@link EscalationCard}). Extracted here because it is the drift-prone
 * core (the「其他」escape hatch, multi-select toggle, 答复模型 α composition); the two cards
 * only differ in their framing + footer (ask_user: 继续/停止; escalate: 提交/按假设继续), which
 * each owns. 设计: docs/03-AI核心/Agent协作模式.md（向用户发问）.
 */

/** The minimal ask content the shared fields render. A {@link CheckpointDisplay}
 * (live/replay), a paused-turn frame, and a worker escalation all satisfy it. */
export interface AskUserContent {
  question: string;
  context: string;
  assumptions: AskAssumption[];
  questions: AskQuestion[];
  styleOptions: AskStyleOption[];
}

/** Whether the card leans「开场引导」(ready-to-go) vs「途中拍板」(careful fork):
 * an opening carries 起步计划 / 风格, or pre-fills every question with a default;
 * a mid-task fork carries a bare question with no defaults. (Both render 品牌蓝.) */
export function isOpeningFlavored(c: AskUserContent): boolean {
  if (c.assumptions.length > 0 || c.styleOptions.length > 0) return true;
  return (
    c.questions.length > 0 && c.questions.every((q) => q.default.length > 0)
  );
}

export type AskTone =
  (typeof interactiveCheckpointTone)[keyof typeof interactiveCheckpointTone];

/**
 * The answer-state engine for a structured ask: per-question picks (choice → option(s),
 * text → typed value), the per-question「其他」escape hatch, the chosen style, and a free
 * note. Seeds each question from its `default` so a 想省事 user can one-click submit an
 * opening as-is. `compose(opening)` flattens it all into ONE readable answer (答复模型 α —
 * the only reader is the CEO / worker, an LLM). Shared so both cards manage answers
 * identically; each card decides what to do with `compose()` in its own footer.
 */
export function useAskAnswer(content: AskUserContent) {
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const q of content.questions)
      init[q.id] = q.default ? [q.default] : [];
    return init;
  });
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [styleId, setStyleId] = useState<string | null>(
    content.styleOptions[0]?.id ?? null,
  );
  const [note, setNote] = useState("");

  const toggleChoice = (q: AskQuestion, opt: string) => {
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
    setAnswers((cur) => ({ ...cur, [q.id]: value ? [value] : [] }));
  };

  // Toggle a choice question's「其他」field. Single-select: engaging it clears the
  // listed picks (mutually exclusive); multi-select: it coexists with checked options.
  const toggleOther = (q: AskQuestion) => {
    const turningOn = !otherOn[q.id];
    setOtherOn((cur) => ({ ...cur, [q.id]: turningOn }));
    if (turningOn && !q.multiple) setAnswers((cur) => ({ ...cur, [q.id]: [] }));
  };

  const setOtherValue = (q: AskQuestion, value: string) => {
    setOtherText((cur) => ({ ...cur, [q.id]: value }));
  };

  // How many decisions already carry a value — surfaced on the opening CTA so a
  // 想省事 user sees the card is ready to ship as-is.
  const presetCount =
    content.questions.filter(
      (q) =>
        (answers[q.id] ?? []).length > 0 ||
        (otherOn[q.id] && (otherText[q.id] ?? "").trim().length > 0),
    ).length + (styleId ? 1 : 0);

  const compose = (opening: boolean) =>
    composeAnswer(content, answers, otherOn, otherText, styleId, note, opening);

  return {
    answers,
    otherOn,
    otherText,
    styleId,
    setStyleId,
    note,
    setNote,
    toggleChoice,
    setText,
    toggleOther,
    setOtherValue,
    presetCount,
    compose,
  };
}

/**
 * The structured pickers — optional 起步计划 (read-only) + askable questions + 风格 —
 * driven by a {@link useAskAnswer} instance. Renders nothing it has no content for, so a
 * bare one-question escalate shows just that question and the CEO opening shows the full
 * set. The headline, note textarea, and footer live in the consuming card.
 */
export function AskQuestionFields({
  content,
  answer,
  tone,
  disabled,
}: {
  content: AskUserContent;
  answer: ReturnType<typeof useAskAnswer>;
  tone: AskTone;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2.5">
      {/* 起步计划：可折叠的只读信息块（默认收起；summary 预览各项名）。 */}
      {content.assumptions.length > 0 && (
        <details className="group rounded-lg border-l-2 border-border bg-muted/30">
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
          answer={answer.answers[q.id] ?? []}
          otherOn={answer.otherOn[q.id] ?? false}
          otherText={answer.otherText[q.id] ?? ""}
          disabled={disabled}
          tone={tone}
          onToggleChoice={(opt) => answer.toggleChoice(q, opt)}
          onSetText={(v) => answer.setText(q, v)}
          onToggleOther={() => answer.toggleOther(q)}
          onSetOther={(v) => answer.setOtherValue(q, v)}
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
              const active = s.id === answer.styleId;
              return (
                <Button
                  key={s.id}
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    !disabled && answer.setStyleId(active ? null : s.id)
                  }
                  className={`h-auto rounded-lg border px-2.5 py-1 font-normal disabled:opacity-40 ${
                    active ? tone.optActive : tone.optIdle
                  }`}
                >
                  {s.label}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** A shared note textarea bound to a {@link useAskAnswer} instance, so a card's free-form
 * 补充 box stays consistent. `placeholder` differs per surface (opening / fork / escalate). */
export function AskNoteField({
  answer,
  tone,
  disabled,
  placeholder,
}: {
  answer: ReturnType<typeof useAskAnswer>;
  tone: AskTone;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <Textarea
      value={answer.note}
      onChange={(e) => answer.setNote(e.target.value)}
      disabled={disabled}
      rows={2}
      placeholder={placeholder}
      className={`w-full border-border bg-card placeholder:text-muted-foreground/70 ${tone.focus}`}
    />
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
  tone: AskTone;
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
          <div
            className={
              question.options.length >= 3
                ? "grid grid-cols-1 gap-1 sm:grid-cols-2"
                : "space-y-1"
            }
          >
            {question.options.map((opt) => {
              const active = answer.includes(opt.label);
              const isDefault =
                !!question.default && opt.label === question.default;
              return (
                <Button
                  key={opt.label}
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onToggleChoice(opt.label)}
                  className={`h-auto w-full justify-start gap-2 rounded-lg border px-2.5 py-1 text-left font-normal disabled:opacity-40 ${
                    active ? tone.optActive : tone.optIdle
                  }`}
                >
                  <span className="flex w-full items-start gap-2">
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
                    {/* label + 权衡说明(detail) + 推荐/默认徽标；detail 仅在选中时展开以控高。 */}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start gap-1.5">
                        <span className="min-w-0 flex-1 whitespace-pre-wrap text-xs">
                          {opt.label}
                        </span>
                        {opt.recommended && (
                          <span
                            className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-xs ${tone.badge}`}
                          >
                            推荐
                          </span>
                        )}
                        {isDefault && (
                          <span
                            className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-xs ${
                              active
                                ? tone.badge
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            默认
                          </span>
                        )}
                      </span>
                      {opt.detail && active && (
                        <span className="mt-0.5 block whitespace-pre-wrap text-xs text-muted-foreground">
                          {opt.detail}
                        </span>
                      )}
                    </span>
                  </span>
                </Button>
              );
            })}
            {/* 「其他」逃生口：选项不合适时就地为这一题填自定义答案，而非塞进全局补充框。 */}
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={onToggleOther}
              className={`h-auto w-full justify-start gap-2 rounded-lg border px-2.5 py-1 text-left font-normal disabled:opacity-40 ${
                question.options.length >= 3 ? "sm:col-span-2" : ""
              } ${otherOn ? tone.optActive : tone.optIdle}`}
            >
              <span className="flex w-full items-start gap-2">
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
                <span className="min-w-0 flex-1 whitespace-pre-wrap">
                  其他…
                </span>
              </span>
            </Button>
            {otherOn && (
              <input
                type="text"
                value={otherText}
                onChange={(e) => onSetOther(e.target.value)}
                disabled={disabled}
                // biome-ignore lint/a11y/noAutofocus: 用户点开「其他」才渲染此框，聚焦到刚展开的字段是预期 UX（非页面加载时强夺焦点）。
                autoFocus
                placeholder="填写你的答案"
                className={`w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-40 ${
                  question.options.length >= 3 ? "sm:col-span-2" : ""
                } ${tone.focus}`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Compose the user's picks + style + free note into ONE readable answer the CEO / worker
 * can act on (答复模型 α): each answered question, the chosen style, and any note. Plain
 * text — the only reader is an LLM, so there is no structured wire payload it would just
 * flatten back to prose. A pure free-text ask (no structured items) sends the raw note. */
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
