import { AlertTriangle, MessageSquareText, Play, Square } from "lucide-react";
import { useState } from "react";

interface Props {
  checkpointId: string;
  summary: string;
  reason: string;
  actions: ("approve" | "adjust" | "stop")[];
  onResolve: (action: "approve" | "adjust" | "stop", feedback?: string) => void;
}

export function CheckpointCard({ summary, reason, actions, onResolve }: Props) {
  const [mode, setMode] = useState<"idle" | "adjusting">("idle");
  const [feedback, setFeedback] = useState("");

  const handleAdjust = () => {
    if (mode === "adjusting" && feedback.trim()) {
      onResolve("adjust", feedback.trim());
    } else {
      setMode("adjusting");
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle size={16} className="text-warning" />
        <span className="text-sm font-medium text-foreground">检查点</span>
      </div>

      {/* Summary */}
      <p className="mb-2 text-sm text-foreground">{summary}</p>
      <p className="mb-4 text-xs text-muted-foreground">{reason}</p>

      {/* Feedback input (adjust mode) */}
      {mode === "adjusting" && (
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="输入调整指令…"
          className="mb-3 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          rows={3}
          // biome-ignore lint/a11y/noAutofocus: intentional — focus the adjust textarea as soon as it appears so the user can type the adjustment immediately.
          autoFocus
        />
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {actions.includes("approve") && (
          <button
            type="button"
            onClick={() => onResolve("approve")}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/90"
          >
            <Play size={14} />
            继续
          </button>
        )}
        {actions.includes("adjust") && (
          <button
            type="button"
            onClick={handleAdjust}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-accent"
          >
            <MessageSquareText size={14} />
            {mode === "adjusting" ? "确认调整" : "调整指令"}
          </button>
        )}
        {actions.includes("stop") && (
          <button
            type="button"
            onClick={() => onResolve("stop")}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-destructive hover:bg-destructive/10"
          >
            <Square size={14} />
            停止
          </button>
        )}
      </div>
    </div>
  );
}
