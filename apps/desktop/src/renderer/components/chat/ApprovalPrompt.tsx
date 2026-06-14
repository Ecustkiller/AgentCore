import { decideApproval } from "@/services/approvals";
import { type PendingApproval, useApprovalStore } from "@/stores/approvals";
import type { ApprovalDecision } from "@/types/events";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";
import { useState } from "react";

/** Friendly zh label for the GRANTABLE built-ins; falls back to the raw name so
 * any future grantable tool still renders sensibly. */
const TOOL_LABELS: Record<string, string> = {
  file_write: "写入文件",
  str_replace: "修改文件",
  code_execute: "执行代码",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** The single most relevant argument to headline on the card, if recognisable
 * (path of a write, command/code of an exec). */
function primaryArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "command", "code"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Inline approval prompt for paused GRANTABLE tool calls (CEO chat path).
 *
 * Rendered above the composer, where it is always visible while the turn is
 * blocked (the composer is disabled mid-generation, so acting on the card is the
 * user's only move). One card per pending call; resolving any settles it via the
 * resolve endpoint and the backend resumes the tool. Renders nothing when idle.
 */
export function ApprovalPrompt() {
  const pending = useApprovalStore((s) => s.pending);
  if (pending.length === 0) return null;

  return (
    <div className="mx-4 mb-2 space-y-2">
      {pending.map((approval) => (
        <ApprovalCard key={approval.approvalId} approval={approval} />
      ))}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const [expanded, setExpanded] = useState(false);
  // Which button was clicked, so its spinner shows while the resolve is in flight
  // (a transient failure re-enables the card and `resolving` returns to false).
  const [clicked, setClicked] = useState<ApprovalDecision | null>(null);

  const headline = primaryArg(approval.arguments);
  const argEntries = Object.entries(approval.arguments);
  const busy = approval.resolving;

  const onDecide = (decision: ApprovalDecision) => {
    setClicked(decision);
    void decideApproval(approval, decision).catch(() => {
      /* settleOne re-enables the card on a transient failure; let the user retry */
    });
  };

  const spinnerOr = (decision: ApprovalDecision, icon: React.ReactNode) =>
    busy && clicked === decision ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  return (
    <div className="animate-task-card-enter rounded-xl border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            <span className="font-medium">Agent 请求执行</span>
            <span className="text-muted-foreground"> · </span>
            <span className="font-medium">{toolLabel(approval.toolName)}</span>
          </p>
          {headline && (
            <p
              className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
              title={headline}
            >
              {headline}
            </p>
          )}
          {argEntries.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
              {expanded ? "收起参数" : "查看参数"}
            </button>
          )}
          {expanded && argEntries.length > 0 && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-card/70 p-2 font-mono text-xs text-foreground">
              {JSON.stringify(approval.arguments, null, 2)}
            </pre>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <DecisionButton
          icon={spinnerOr("approve", <Check size={13} />)}
          label="允许一次"
          tone="primary"
          disabled={busy}
          onClick={() => onDecide("approve")}
        />
        <DecisionButton
          icon={spinnerOr("approve_always", <CheckCheck size={13} />)}
          label="本轮内都允许"
          tone="neutral"
          disabled={busy}
          onClick={() => onDecide("approve_always")}
        />
        <DecisionButton
          icon={spinnerOr("deny", <X size={13} />)}
          label="拒绝"
          tone="danger"
          disabled={busy}
          onClick={() => onDecide("deny")}
        />
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
