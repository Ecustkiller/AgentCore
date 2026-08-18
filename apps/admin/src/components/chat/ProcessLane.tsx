import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import type { ProcessStep } from "@agentcore/protocol-conformance";

const MARKER_LABEL: Record<string, string> = {
  team: "协作图",
  graph_append: "续图",
  checkpoint: "提问",
  ask: "提问",
  plan_review: "计划复核",
  team_preview: "开工卡",
  escalation: "升级",
  approval: "审批",
  delegation_authorization: "委派授权",
  stage_card: "推进卡",
  user_interjection: "插话",
  rework: "已重写",
};

const TOOL_TONE: Record<string, "primary" | "success" | "destructive" | "neutral"> =
  {
    running: "primary",
    success: "success",
    error: "destructive",
  };

function formatValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * CEO process lane: full reasoning text + complete tool cards.
 * Gate markers stay as a one-line label (card faces are degraded).
 */
export function ProcessLane({
  steps,
  className,
}: {
  steps: ProcessStep[];
  className?: string;
}) {
  if (steps.length === 0) return null;
  return (
    <ol
      aria-label="过程"
      className={cn("space-y-2 text-sm text-muted-foreground", className)}
    >
      {steps.map((step, i) => (
        <li key={`${step.kind}-${i}`} className="min-w-0">
          <ProcessRow step={step} />
        </li>
      ))}
    </ol>
  );
}

function ProcessRow({ step }: { step: ProcessStep }) {
  if (step.kind === "reasoning") {
    return (
      <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
        <div className="mb-1 text-xs font-medium text-muted-foreground">思考</div>
        <p className="whitespace-pre-wrap text-foreground">{step.text}</p>
      </div>
    );
  }
  if (step.kind === "content") {
    return (
      <p className="whitespace-pre-wrap text-foreground">
        <span className="mr-1.5 text-muted-foreground text-xs font-medium">
          正文
        </span>
        {step.text}
      </p>
    );
  }
  if (step.kind === "tool") {
    return <ToolCard step={step} />;
  }
  return <p>{MARKER_LABEL[step.kind] ?? step.kind}</p>;
}

function ToolCard({
  step,
}: {
  step: Extract<ProcessStep, { kind: "tool" }>;
}) {
  const name =
    "tool_name" in step && typeof step.tool_name === "string"
      ? step.tool_name
      : "工具";
  const status = "status" in step && typeof step.status === "string" ? step.status : "";
  const args = formatValue("arguments" in step ? step.arguments : undefined);
  const result = formatValue("result" in step ? step.result : undefined);
  const display = formatValue("display" in step ? step.display : undefined);
  const failure =
    "failure" in step && step.failure && typeof step.failure === "object"
      ? step.failure
      : null;
  const failMessage =
    failure && "message" in failure && typeof failure.message === "string"
      ? failure.message
      : null;

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{name}</span>
        {status && (
          <Badge tone={TOOL_TONE[status] ?? "neutral"}>{status}</Badge>
        )}
      </div>
      {failMessage && (
        <p className="mt-1 text-destructive text-xs">{failMessage}</p>
      )}
      {args != null && (
        <pre
          aria-label="工具参数"
          className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
        >
          {args}
        </pre>
      )}
      {result != null && (
        <pre
          aria-label="工具结果"
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
        >
          {result}
        </pre>
      )}
      {display != null && (
        <pre
          aria-label="工具展示"
          className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
        >
          {display}
        </pre>
      )}
    </div>
  );
}
