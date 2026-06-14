import type { StepCheckpoint } from "@/stores/execution";
import { Flag, Play, SlidersHorizontal, Square } from "lucide-react";

/**
 * Visualises an orchestrator checkpoint on a step. `continue` / `adjust` are the
 * orchestrator's own auto-decisions; `escalate` hands the call to the user, so it
 * shows 待裁决 until resolved, then the user's choice (继续 / 调整 / 停止).
 */
export function CheckpointBadge({
  checkpoint,
}: {
  checkpoint: StepCheckpoint;
}) {
  const meta = checkpointMeta(checkpoint);
  return (
    <span
      className={`flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-xs ${meta.className}`}
      title={checkpoint.reason}
    >
      {meta.icon}
      {meta.label}
    </span>
  );
}

function checkpointMeta(checkpoint: StepCheckpoint): {
  icon: React.ReactNode;
  label: string;
  className: string;
} {
  const ATTENTION = "bg-warning/10 text-warning";
  const CONTINUE = "bg-success/10 text-success";
  const STOP = "bg-destructive/10 text-destructive";

  if (checkpoint.decision === "continue") {
    return {
      icon: <Play size={11} />,
      label: "编排器继续",
      className: CONTINUE,
    };
  }
  if (checkpoint.decision === "adjust") {
    return {
      icon: <SlidersHorizontal size={11} />,
      label: "编排器调整",
      className: ATTENTION,
    };
  }

  // escalate → user verdict (or awaiting one)
  switch (checkpoint.action) {
    case null:
      return { icon: <Flag size={11} />, label: "待裁决", className: ATTENTION };
    case "adjust":
      return {
        icon: <SlidersHorizontal size={11} />,
        label: "用户调整",
        className: ATTENTION,
      };
    case "stop":
      return { icon: <Square size={11} />, label: "用户停止", className: STOP };
    default:
      return {
        icon: <Play size={11} />,
        label: "用户继续",
        className: CONTINUE,
      };
  }
}
