/** Card-level / per-question free-text note on the live ask_user card. */
import { Textarea } from "@/components/ui";
import { interactiveCheckpointTone } from "@/components/ui/tone-presets";
import { ASK_NOTE_PLACEHOLDER, type AskTone } from "./AskUserFields";

export function AskNote({
  answer,
  questionId,
  disabled,
  compact = false,
  placeholder = ASK_NOTE_PLACEHOLDER,
  tone = interactiveCheckpointTone.primary,
}: {
  answer: {
    note: string;
    setNote: (v: string) => void;
    notes: Record<string, string>;
    setQuestionNote: (id: string, value: string) => void;
  };
  /** 按题绑定；缺省 = 整卡人话（无题卡）。 */
  questionId?: string;
  disabled: boolean;
  compact?: boolean;
  placeholder?: string;
  tone?: AskTone;
}) {
  const value =
    questionId != null ? (answer.notes[questionId] ?? "") : answer.note;
  return (
    <Textarea
      value={value}
      onChange={(e) =>
        questionId != null
          ? answer.setQuestionNote(questionId, e.target.value)
          : answer.setNote(e.target.value)
      }
      disabled={disabled}
      rows={compact ? 1 : 2}
      placeholder={placeholder}
      className={`w-full border-border bg-card placeholder:text-muted-foreground/70 ${tone.focus}`}
    />
  );
}
