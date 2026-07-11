/**
 * Production kickoff Ask card — V2 Brief + Choose (Notion AI / product-brief split).
 * Wired by {@link AskUserCard} when intent === "kickoff".
 */
import { Button } from "@/components/ui";
import {
  formatBindLocalFolderAnswer,
  pickAndBindLocalFolder,
} from "@/lib/bindLocalFolder";
import type { CheckpointUserDecision } from "@/services/checkpoint";
import type { AskOption, AskQuestion } from "@/types/events";
import { FileText, Loader2, OctagonX, Rocket } from "lucide-react";
import { useState } from "react";
import {
  ChoiceQuestion,
  CommenceNote,
  PlanChips,
  StylePills,
  splitBriefContext,
} from "./AskCommenceParts";
import type { AskUserContent } from "./AskUserFields";
import type { useAskAnswer } from "./AskUserFields";

export function AskCommenceKickoffBody({
  content,
  answer,
  busy,
  submitting,
  onContinue,
  onStop,
  conversationId,
  onBindResolve,
}: {
  content: AskUserContent;
  answer: ReturnType<typeof useAskAnswer>;
  busy: boolean;
  submitting: CheckpointUserDecision | null;
  onContinue: () => void;
  onStop: () => void;
  conversationId?: string | null;
  onBindResolve?: (composedAnswer: string) => void | Promise<void>;
}) {
  const { lead, points } = splitBriefContext(content.context);
  const [bindBusyLabel, setBindBusyLabel] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);

  const handleBindOption = async (q: AskQuestion, opt: AskOption) => {
    if (!conversationId || !onBindResolve || busy || bindBusyLabel) return;
    setBindBusyLabel(opt.label);
    setBindError(null);
    const result = await pickAndBindLocalFolder(conversationId);
    if (!result.ok) {
      if (result.reason === "error") setBindError(result.message);
      setBindBusyLabel(null);
      return;
    }
    const value = formatBindLocalFolderAnswer(opt.label, result.root.name);
    try {
      await onBindResolve(answer.composeWithAnswer("kickoff", q.id, value));
    } catch {
      setBindBusyLabel(null);
    }
  };

  return (
    <div
      data-ask-commence-variant="v2"
      className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row"
    >
      {/* Brief — scannable summary */}
      <aside className="flex shrink-0 flex-col gap-4 border-b border-border bg-muted/10 px-4 py-4 md:w-[38%] md:min-w-[14rem] md:max-w-[18rem] md:border-b-0 md:border-r md:overflow-y-auto">
        <div>
          <div className="flex items-center gap-1.5">
            <FileText size={14} className="shrink-0 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground">Brief</p>
          </div>
          <p className="mt-2 text-sm font-semibold leading-snug text-foreground">
            {content.question}
          </p>
          {lead && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {lead}
            </p>
          )}
          {points.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {points.map((p) => (
                <li
                  key={p}
                  className="flex gap-2 text-xs leading-snug text-foreground/80"
                >
                  <span
                    className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50"
                    aria-hidden
                  />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {(content.assumptions.length > 0 ||
          content.styleOptions.length > 0) && (
          <div className="mt-auto space-y-2 border-t border-border/60 pt-3">
            {content.assumptions.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground">起步计划</p>
                <PlanChips assumptions={content.assumptions} quiet />
              </>
            )}
            <StylePills content={content} answer={answer} disabled={busy} />
          </div>
        )}
      </aside>

      {/* Choose — decision focus */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div className="flex items-center gap-1.5">
            <Rocket size={14} className="shrink-0 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground">
              对齐后再开做
            </p>
          </div>
          {content.questions.map((q, i) => (
            <ChoiceQuestion
              key={q.id}
              question={q}
              index={i + 1}
              numbered={content.questions.length > 1}
              answer={answer.answers[q.id] ?? []}
              otherOn={answer.otherOn[q.id] ?? false}
              otherText={answer.otherText[q.id] ?? ""}
              disabled={busy || !!bindBusyLabel}
              onToggle={(opt) => answer.toggleChoice(q, opt)}
              onSetText={(v) => answer.setText(q, v)}
              onToggleOther={() => answer.toggleOther(q)}
              onSetOther={(v) => answer.setOtherValue(q, v)}
              optionLayout="card"
              conversationId={conversationId}
              bindBusyLabel={bindBusyLabel}
              onBindOption={(opt) => void handleBindOption(q, opt)}
            />
          ))}
          {bindError && <p className="text-xs text-destructive">{bindError}</p>}
          <CommenceNote answer={answer} disabled={busy} />
        </div>

        <div className="shrink-0 space-y-1.5 border-t border-border bg-card/95 px-3 py-3 backdrop-blur-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="md"
              variant="primary"
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={busy}
              onClick={onContinue}
              icon={
                submitting === "continue" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Rocket size={14} />
                )
              }
            >
              就这样开做
            </Button>
            <Button
              size="md"
              variant="ghost"
              disabled={busy}
              onClick={onStop}
              className="text-muted-foreground hover:text-foreground"
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
          <span className="block text-xs text-muted-foreground">
            {answer.presetCount > 0
              ? `已预填 ${answer.presetCount} 项，直接开做或按需调整`
              : "也可直接在下方对话框回复"}
          </span>
        </div>
      </div>
    </div>
  );
}
