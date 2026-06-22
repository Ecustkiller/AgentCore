import {
  type ToolResultData,
  ToolResultView,
  hasToolResultBody,
  toolResultPeek,
} from "@/components/chat/toolResult/ToolResultView";
import { Badge, Button } from "@/components/ui";
import { formatCompact } from "@/lib/format";
import type { ProcessStep } from "@/types/events";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ThinkingDots } from "./message-bubble/Thinking";
import {
  toolDetail,
  toolGroupSummary,
  toolMeta,
} from "./message-bubble/constants";

/** Live transport line while the model streams tool-call JSON (不持久化). */
export function ComposingToolLine({
  tool,
}: {
  tool: { toolName: string; chars: number };
}) {
  const { Icon, label } = toolMeta(tool.toolName);
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Icon size={14} className="shrink-0 text-primary" />
      <span>
        正在生成 {label}
        {tool.chars > 0 && (
          <span className="text-muted-foreground/70">
            {" · "}
            {formatCompact(tool.chars)} 字
          </span>
        )}
      </span>
      <span className="inline-block animate-pulse text-primary">▋</span>
    </span>
  );
}

function ToolStatusIcon({
  status,
}: {
  status: "running" | "success" | "error";
}) {
  if (status === "running")
    return (
      <span className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
    );
  if (status === "error")
    return <X size={14} className="mt-0.5 shrink-0 text-destructive" />;
  return <Check size={14} className="mt-0.5 shrink-0 text-success" />;
}

/** Single tool invocation row in the process timeline. */
export function ToolLine({
  step,
}: {
  step: Extract<ProcessStep, { kind: "tool" }>;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, label } = toolMeta(step.tool_name);
  const detail = toolDetail(step.arguments);
  const data: ToolResultData = {
    toolName: step.tool_name,
    args: step.arguments,
    result: step.result,
    display: step.display,
    status: step.status,
  };
  const hasBody = hasToolResultBody(data);
  return (
    <div className="min-w-0">
      <Button
        variant="ghost"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`h-auto w-full justify-start gap-2 px-0 py-0 hover:bg-transparent ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="flex w-full items-start gap-2 text-left">
          <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="text-sm text-foreground">
              <span className="font-medium">{label}</span>
              {detail && (
                <span className="ml-1.5 break-all text-muted-foreground">
                  {detail}
                </span>
              )}
            </span>
            {hasBody && !open && (
              <span
                className={`block truncate text-xs ${
                  step.status === "error"
                    ? "text-destructive/80"
                    : "text-muted-foreground/70"
                }`}
              >
                {toolResultPeek(data)}
              </span>
            )}
          </span>
          <ToolStatusIcon status={step.status} />
        </span>
      </Button>
      {open && hasBody && <ToolResultView data={data} />}
    </div>
  );
}

/** Collapsible group of consecutive tool lines (ProcessToolGroup pattern). */
export function ToolLineGroup({
  tools,
  isStreaming,
}: {
  tools: Extract<ProcessStep, { kind: "tool" }>[];
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(isStreaming);
  const prevStreaming = useRef(isStreaming);

  useEffect(() => {
    if (prevStreaming.current && !isStreaming) setExpanded(false);
    prevStreaming.current = isStreaming;
  }, [isStreaming]);

  const summary = toolGroupSummary(tools);
  const errorCount = tools.reduce(
    (n, t) => n + (t.status === "error" ? 1 : 0),
    0,
  );
  const running = tools.some((t) => t.status === "running");

  return (
    <div>
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start gap-2 px-0 py-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        <span className="flex w-full items-center gap-2">
          {running ? (
            <ThinkingDots />
          ) : expanded ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight size={14} className="shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
          {errorCount > 0 && (
            <Badge tone="destructive" className="shrink-0 font-normal">
              {errorCount} 个失败
            </Badge>
          )}
        </span>
      </Button>
      {expanded && (
        <div className="mt-1.5 space-y-2 pl-3">
          {tools.map((t) => (
            <ToolLine key={t.id} step={t} />
          ))}
        </div>
      )}
    </div>
  );
}
