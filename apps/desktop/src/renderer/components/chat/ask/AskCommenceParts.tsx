/**
 * Production-shared chrome for the kickoff 开工提案 card (V2 Brief + Choose).
 * Preview variants import from here so layout A/B does not permanently fork.
 */
import { Button, Textarea } from "@/components/ui";
import { interactiveCheckpointTone } from "@/components/ui/tone-presets";
import { hasLocalFiles } from "@/lib/capabilities";
import type { AskAssumption, AskOption, AskQuestion } from "@/types/events";
import { Check, FolderOpen, Loader2 } from "lucide-react";
import type { AskTone, AskUserContent } from "./AskUserFields";

/** Kickoff option selection uses primary so chosen cards read clearly vs idle. */
export const COMMENCE_TONE = interactiveCheckpointTone.primary;

export type AskAnswerState = {
  answers: Record<string, string[]>;
  otherOn: Record<string, boolean>;
  otherText: Record<string, string>;
  styleId: string | null;
  setStyleId: (id: string | null) => void;
  note: string;
  setNote: (v: string) => void;
  toggleChoice: (q: AskQuestion, opt: string) => void;
  setText: (q: AskQuestion, value: string) => void;
  toggleOther: (q: AskQuestion) => void;
  setOtherValue: (q: AskQuestion, value: string) => void;
  presetCount: number;
};

/**
 * Split context into a short lead + bullet lines for scannable briefs.
 * First non-empty line = conclusion; remaining lines = points (strips leading •/-).
 */
export function splitBriefContext(context: string): {
  lead: string;
  points: string[];
} {
  const lines = context
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { lead: "", points: [] };
  const [lead, ...rest] = lines;
  const points = rest.map((l) => l.replace(/^[-•*]\s*/, ""));
  return { lead: lead ?? "", points };
}

/** Compact plan as secondary chips (label · value). */
export function PlanChips({
  assumptions,
  className = "",
  quiet = false,
}: {
  assumptions: AskAssumption[];
  className?: string;
  /** Quieter surface for secondary placement (brief footer). */
  quiet?: boolean;
}) {
  if (assumptions.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {assumptions.map((a) => (
        <span
          key={a.id}
          className={
            quiet
              ? "inline-flex max-w-full items-baseline gap-1 rounded-lg bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground"
              : "inline-flex max-w-full items-baseline gap-1 rounded-lg border border-border/60 bg-muted/25 px-2 py-0.5 text-xs"
          }
        >
          <span className="shrink-0 text-muted-foreground/80">{a.label}</span>
          <span
            className={`min-w-0 truncate ${quiet ? "text-muted-foreground" : "text-foreground/80"}`}
          >
            {a.value}
          </span>
        </span>
      ))}
    </div>
  );
}

export function StylePills({
  content,
  answer,
  disabled,
  tone = COMMENCE_TONE,
}: {
  content: AskUserContent;
  answer: Pick<AskAnswerState, "styleId" | "setStyleId">;
  disabled: boolean;
  tone?: AskTone;
}) {
  if (content.styleOptions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">风格</span>
      {content.styleOptions.map((s) => {
        const active = s.id === answer.styleId;
        return (
          <Button
            key={s.id}
            variant="ghost"
            disabled={disabled}
            onClick={() => !disabled && answer.setStyleId(active ? null : s.id)}
            className={`h-auto rounded-lg border px-2.5 py-1 text-xs font-normal disabled:opacity-40 ${
              active ? tone.optActive : tone.optIdle
            }`}
          >
            {s.label}
          </Button>
        );
      })}
    </div>
  );
}

export function CommenceNote({
  answer,
  disabled,
  compact = false,
  placeholder = "有补充可以写在这里",
  tone = COMMENCE_TONE,
}: {
  answer: Pick<AskAnswerState, "note" | "setNote">;
  disabled: boolean;
  compact?: boolean;
  placeholder?: string;
  tone?: AskTone;
}) {
  return (
    <Textarea
      value={answer.note}
      onChange={(e) => answer.setNote(e.target.value)}
      disabled={disabled}
      rows={compact ? 1 : 2}
      placeholder={placeholder}
      className={`w-full border-border bg-card placeholder:text-muted-foreground/70 ${tone.focus}`}
    />
  );
}

export function OptionButton({
  label,
  detail,
  recommended,
  isDefault,
  active,
  disabled,
  onClick,
  layout = "row",
  size = "md",
  tone = COMMENCE_TONE,
  leadingIcon,
}: {
  label: string;
  detail?: string;
  recommended?: boolean;
  isDefault?: boolean;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  layout?: "row" | "card";
  size?: "md" | "lg";
  tone?: AskTone;
  leadingIcon?: React.ReactNode;
}) {
  const badges = (
    <>
      {recommended && (
        <span className="shrink-0 text-xs font-normal text-muted-foreground">
          推荐
        </span>
      )}
      {isDefault && !recommended && (
        <span className="shrink-0 text-xs font-normal text-muted-foreground/70">
          默认
        </span>
      )}
    </>
  );

  if (layout === "card") {
    const pad = size === "lg" ? "px-3.5 py-3" : "px-3 py-2.5";
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-pressed={active}
        className={`flex w-full items-start gap-2.5 rounded-xl border text-left transition-colors disabled:opacity-40 ${pad} ${
          active
            ? "border-primary bg-primary/10 text-foreground shadow-[inset_0_0_0_1px] shadow-primary/25"
            : "border-border bg-card text-muted-foreground hover:border-foreground/20 hover:bg-accent hover:text-foreground"
        }`}
      >
        <span
          className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
            active
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-transparent"
          }`}
          aria-hidden
        >
          {active && <Check size={10} strokeWidth={3} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {leadingIcon}
            <span className="text-sm font-medium text-foreground">{label}</span>
            {badges}
          </span>
          {detail && (
            <span
              className={`mt-0.5 block text-xs leading-snug ${
                active ? "text-muted-foreground" : "text-muted-foreground/80"
              }`}
            >
              {detail}
            </span>
          )}
        </span>
      </button>
    );
  }

  return (
    <div className="flex w-full flex-col">
      <Button
        variant="ghost"
        disabled={disabled}
        onClick={onClick}
        className={`h-auto w-full justify-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs font-normal disabled:opacity-40 ${
          active ? tone.optActive : tone.optIdle
        }`}
        icon={leadingIcon}
      >
        <span className="whitespace-pre-wrap">{label}</span>
        {recommended && (
          <span className="ml-1.5 shrink-0 text-muted-foreground">推荐</span>
        )}
        {isDefault && !recommended && (
          <span className="ml-1.5 shrink-0 text-muted-foreground/70">默认</span>
        )}
      </Button>
      {detail && (
        <span className="mt-0.5 px-2.5 text-xs text-muted-foreground">
          {detail}
        </span>
      )}
    </div>
  );
}

export function ChoiceQuestion({
  question,
  index,
  numbered,
  answer,
  otherOn,
  otherText,
  disabled,
  onToggle,
  onSetText,
  onToggleOther,
  onSetOther,
  optionLayout = "row",
  emphasizePrompt = false,
  optionSize = "md",
  tone = COMMENCE_TONE,
  conversationId,
  bindBusyLabel,
  onBindOption,
}: {
  question: AskQuestion;
  index: number;
  numbered: boolean;
  answer: string[];
  otherOn: boolean;
  otherText: string;
  disabled: boolean;
  onToggle: (opt: string) => void;
  onSetText?: (v: string) => void;
  onToggleOther: () => void;
  onSetOther: (v: string) => void;
  optionLayout?: "row" | "card";
  emphasizePrompt?: boolean;
  optionSize?: "md" | "lg";
  tone?: AskTone;
  conversationId?: string | null;
  bindBusyLabel?: string | null;
  onBindOption?: (opt: AskOption) => void;
}) {
  const canBindAction =
    !!conversationId && !!onBindOption && hasLocalFiles() && !!window.fsApi;
  return (
    <div className="min-w-0">
      <div className="flex items-start gap-2">
        {numbered && (
          <span
            className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium ${tone.badge}`}
          >
            {index}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p
            className={`whitespace-pre-wrap text-foreground ${
              emphasizePrompt
                ? "text-base font-semibold leading-snug"
                : "text-sm font-medium"
            }`}
          >
            {question.prompt}
          </p>
          {question.kind === "choice" && question.multiple && (
            <span className="mt-1 inline-block text-xs text-muted-foreground">
              可多选
            </span>
          )}
        </div>
      </div>
      <div
        className={`mt-2 ${numbered && !emphasizePrompt ? "pl-7" : ""} ${
          emphasizePrompt ? "mt-3" : ""
        }`}
      >
        {question.kind === "text" ? (
          <input
            type="text"
            value={answer[0] ?? ""}
            onChange={(e) => onSetText?.(e.target.value)}
            disabled={disabled}
            placeholder={question.default || undefined}
            className={`w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-40 ${tone.focus}`}
          />
        ) : (
          <div className="space-y-1.5">
            <div
              className={
                optionLayout === "card"
                  ? `grid ${optionSize === "lg" ? "gap-2" : "gap-1.5"} sm:grid-cols-1`
                  : "flex flex-col gap-1.5"
              }
            >
              {question.options.map((opt) => {
                const isBindAction =
                  canBindAction && opt.action === "bind_local_folder";
                const bindBusy = bindBusyLabel === opt.label;
                return (
                  <OptionButton
                    key={opt.label}
                    label={opt.label}
                    detail={opt.detail}
                    recommended={opt.recommended}
                    isDefault={
                      !!question.default && opt.label === question.default
                    }
                    active={answer.includes(opt.label) || !!bindBusy}
                    disabled={disabled || (!!bindBusyLabel && !bindBusy)}
                    onClick={() =>
                      isBindAction ? onBindOption?.(opt) : onToggle(opt.label)
                    }
                    layout={optionLayout}
                    size={optionSize}
                    tone={tone}
                    leadingIcon={
                      isBindAction ? (
                        bindBusy ? (
                          <Loader2
                            size={14}
                            className="shrink-0 animate-spin text-muted-foreground"
                          />
                        ) : (
                          <FolderOpen
                            size={14}
                            className="shrink-0 text-muted-foreground"
                          />
                        )
                      ) : undefined
                    }
                  />
                );
              })}
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={onToggleOther}
                className={`h-auto w-full justify-start rounded-xl border border-dashed px-3 py-2 text-left text-xs font-normal disabled:opacity-40 ${
                  otherOn
                    ? tone.optActive
                    : "border-border bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                }`}
              >
                其他…
              </Button>
            </div>
            {otherOn && (
              <input
                type="text"
                value={otherText}
                onChange={(e) => onSetOther(e.target.value)}
                disabled={disabled}
                // biome-ignore lint/a11y/noAutofocus: user opened「其他」— focus the new field.
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
