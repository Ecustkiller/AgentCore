import {
  type CheckpointUserDecision,
  decideCheckpoint,
} from "@/services/checkpoint";
import type { CheckpointDisplay } from "@/stores/conversation";
import {
  Check,
  CircleHelp,
  Clock,
  Loader2,
  OctagonX,
  Pencil,
} from "lucide-react";
import { useState } from "react";

/**
 * Inline checkpoint card — the CEO paused the turn to ask the user a decision
 * (ask_user). Rendered under the assistant bubble that raised it (会话流内，not the
 * status strip), so it both gates the live turn and replays inline on reload.
 *
 * `interactive` is true only for the live, suspended turn (the owning message is
 * still streaming). A pending checkpoint on a finished/reloaded turn renders as a
 * passive, un-actionable record; a resolved one always renders its settled state.
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
  if (!interactive) {
    return <DormantCheckpoint checkpoint={checkpoint} />;
  }
  return (
    <PendingCheckpoint
      checkpoint={checkpoint}
      conversationId={conversationId}
    />
  );
}

/** The live, actionable card: question + optional choices + a note, settled by
 * one of 继续 / 调整 / 停止. */
function PendingCheckpoint({
  checkpoint,
  conversationId,
}: {
  checkpoint: CheckpointDisplay;
  conversationId: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState<CheckpointUserDecision | null>(
    null,
  );
  const busy = submitting !== null;

  const send = (decision: CheckpointUserDecision) => {
    if (busy || !conversationId) return;
    // 调整 carries the steer: the picked option and any free-form note, combined.
    const steer = [decision === "adjust" ? selected : null, note.trim()]
      .filter((s): s is string => !!s && s.length > 0)
      .join("\n");
    setSubmitting(decision);
    decideCheckpoint(conversationId, checkpoint.id, decision, steer).catch(
      () => {
        // A transient (non-404) failure re-enables the card so the user retries;
        // a successful or stale settle flips the card via its resolved state.
        setSubmitting(null);
      },
    );
  };

  const spinnerOr = (
    decision: CheckpointUserDecision,
    icon: React.ReactNode,
  ) =>
    submitting === decision ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  return (
    <div className="animate-task-card-enter mt-2 rounded-xl border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <CircleHelp size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-warning">需要你拍板</p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
            {checkpoint.question}
          </p>
          {checkpoint.context && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
              {checkpoint.context}
            </p>
          )}

          {checkpoint.options.length > 0 && (
            <div className="mt-2 space-y-1">
              {checkpoint.options.map((opt) => {
                const active = selected === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={busy}
                    onClick={() => setSelected(active ? null : opt)}
                    className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
                      active
                        ? "border-warning bg-warning/15 text-foreground"
                        : "border-border bg-card/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <span
                      className={`mt-0.5 size-3 shrink-0 rounded-full border ${
                        active ? "border-warning bg-warning" : "border-border"
                      }`}
                    />
                    <span className="min-w-0 whitespace-pre-wrap">{opt}</span>
                  </button>
                );
              })}
            </div>
          )}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="可选 · 补充说明或调整方向（用于「调整」）"
            className="mt-2 w-full resize-none rounded-lg border border-border bg-card/70 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-warning/60 focus:outline-none disabled:opacity-40"
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <DecisionButton
          icon={spinnerOr("continue", <Check size={13} />)}
          label="继续"
          tone="primary"
          disabled={busy}
          onClick={() => send("continue")}
        />
        <DecisionButton
          icon={spinnerOr("adjust", <Pencil size={13} />)}
          label="调整"
          tone="neutral"
          disabled={busy}
          onClick={() => send("adjust")}
        />
        <DecisionButton
          icon={spinnerOr("stop", <OctagonX size={13} />)}
          label="停止"
          tone="danger"
          disabled={busy}
          onClick={() => send("stop")}
        />
      </div>
    </div>
  );
}

/** A pending checkpoint on a turn that is no longer live (reloaded, or the turn
 * ended without an answer): shown as a record, not actionable. */
function DormantCheckpoint({ checkpoint }: { checkpoint: CheckpointDisplay }) {
  return (
    <div className="mt-2 rounded-xl border border-border bg-muted/40 p-3">
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
    </div>
  );
}

/** The settled record of a checkpoint: how it was decided, plus any note. */
function ResolvedCheckpoint({ checkpoint }: { checkpoint: CheckpointDisplay }) {
  const meta = {
    continue: { icon: <Check size={14} />, label: "已继续" },
    adjust: { icon: <Pencil size={14} />, label: "已按你的调整继续" },
    stop: { icon: <OctagonX size={14} />, label: "已停止本回合" },
    timeout: { icon: <Clock size={14} />, label: "未及时回应，已自行收尾" },
  }[checkpoint.decision ?? "timeout"];

  return (
    <div className="mt-2 rounded-xl border border-border bg-card/60 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {checkpoint.question}
          </p>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {meta.label}
          </p>
          {checkpoint.note && (
            <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
              {checkpoint.note}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DecisionButton({
  icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "primary" | "neutral" | "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneClass = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    neutral: "text-muted-foreground hover:bg-accent hover:text-foreground",
    danger: "text-destructive hover:bg-destructive/10",
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium disabled:opacity-40 ${toneClass}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
