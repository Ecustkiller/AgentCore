import { InteractionLane } from "@/components/chat/InteractionLane";
import { ProcessLane } from "@/components/chat/ProcessLane";
import { SourceCards } from "@/components/chat/SourceCards";
import { TeamLane } from "@/components/chat/TeamLane";
import {
  type ChatTurnInput,
  resolveChatTurn,
} from "@/components/chat/chatTurn";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<
  string,
  "neutral" | "primary" | "success" | "warning" | "destructive"
> = {
  running: "primary",
  paused: "warning",
  completed: "success",
  failed: "destructive",
  cancelled: "warning",
};

/**
 * Admin AI-chat final-state shell. Eats a replay assistant row's combination:
 * content + `runs_payload` + nullable `projected` — not a client fold.
 *
 * `/replay/:id` mounts this via {@link chatTurnFromReplay}.
 */
export function ChatView({
  content,
  runsPayload,
  projected,
  className,
  selectedRunId,
  onSelectRun,
}: ChatTurnInput & {
  className?: string;
  selectedRunId?: string | null;
  onSelectRun?: (runId: string) => void;
}) {
  const turn = resolveChatTurn({ content, runsPayload, projected });
  const hasReasoningStep = turn.process.some((s) => s.kind === "reasoning");

  return (
    <div
      aria-label="对话终态"
      className={cn("flex flex-col gap-4", className)}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {turn.status && (
          <Badge tone={STATUS_TONE[turn.status] ?? "neutral"}>
            {turn.status}
          </Badge>
        )}
        {turn.outcome && <span>outcome {turn.outcome}</span>}
        {turn.finishReason && <span>finish {turn.finishReason}</span>}
      </div>

      {turn.turnWarning && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          {turn.turnWarning}
        </p>
      )}

      {turn.error && (
        <p className="rounded-lg bg-destructive-tint px-3 py-2 text-destructive text-sm">
          {turn.error.message || turn.error.code}
        </p>
      )}

      <article className="max-w-[min(100%,48rem)] space-y-3">
        <div className="text-sm font-medium text-foreground">助手</div>
        {!hasReasoningStep && turn.reasoning && (
          <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              思考
            </div>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {turn.reasoning}
            </p>
          </div>
        )}
        <ProcessLane steps={turn.process} />
        <TeamLane
          runs={turn.runs}
          progress={turn.progress}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
        />
        {turn.content ? (
          <Markdown content={turn.content} />
        ) : (
          <p className="text-muted-foreground text-sm italic">（无正文）</p>
        )}
        <SourceCards citations={turn.citations} />
        {turn.debate && (
          <p className="text-sm text-muted-foreground">
            辩论
            {turn.debate.form ? ` · ${turn.debate.form}` : ""}
            {turn.debate.motion ? ` · ${turn.debate.motion}` : ""}
          </p>
        )}
        {turn.deliveryStatus?.state && (
          <p className="text-xs text-muted-foreground">
            交付 {turn.deliveryStatus.state}
          </p>
        )}
        <InteractionLane interactions={turn.interactions} />
      </article>
    </div>
  );
}
