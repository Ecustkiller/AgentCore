import { InlineTeamGraph } from "@/components/chat/InlineTeamGraph";
import { Markdown } from "@/components/chat/Markdown";
import {
  type ToolResultData,
  ToolResultView,
  hasToolResultBody,
  toolResultPeek,
} from "@/components/chat/toolResult/ToolResultView";
import { formatCompact } from "@/lib/format";
import { groupToolRuns, isOrchestrationTool } from "@/lib/processTimeline";
import type { ExecutionJournal } from "@/stores/execution";
import type { Citation, ProcessStep } from "@/types/events";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ThinkingDots, ThinkingHeader } from "./Thinking";
import { toolDetail, toolGroupSummary, toolMeta } from "./constants";

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

function ProcessStatusIcon({
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

function ProcessToolRow({
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
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`flex w-full items-start gap-2 text-left ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
      >
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
        <ProcessStatusIcon status={step.status} />
      </button>
      {open && hasBody && <ToolResultView data={data} />}
    </div>
  );
}

function ProcessToolGroup({
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
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {running ? (
          <ThinkingDots />
        ) : expanded ? (
          <ChevronDown size={14} className="shrink-0" />
        ) : (
          <ChevronRight size={14} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        {errorCount > 0 && (
          <span className="shrink-0 text-destructive">{errorCount} 个失败</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-2 pl-3">
          {tools.map((t) => (
            <ProcessToolRow key={t.id} step={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function InlineReasoning({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(streaming);
  const prevStreaming = useRef(streaming);

  useEffect(() => {
    if (prevStreaming.current && !streaming) setExpanded(false);
    prevStreaming.current = streaming;
  }, [streaming]);

  return (
    <div>
      <ThinkingHeader
        isStreaming={streaming}
        expanded={expanded}
        streamingLabel="正在思考…"
        doneLabel="思考过程"
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div className="mt-1.5 pl-3">
          <Markdown content={text} isStreaming={streaming} muted />
        </div>
      )}
    </div>
  );
}

function ProcessRow({
  step,
  streaming,
  citations,
  onCitationClick,
}: {
  step: ProcessStep;
  streaming: boolean;
  citations: Citation[];
  onCitationClick: (n: number) => void;
}) {
  if (step.kind === "reasoning") {
    return <InlineReasoning text={step.text} streaming={streaming} />;
  }
  if (step.kind === "content") {
    return (
      <Markdown
        content={step.text}
        citations={citations}
        onCitationClick={onCitationClick}
        isStreaming={streaming}
      />
    );
  }
  return <ProcessToolRow step={step} />;
}

export function ProcessTimeline({
  process,
  isStreaming,
  citations,
  onCitationClick,
  composingTool,
  fallbackContent,
  executionId,
  messageId,
  journal,
}: {
  process: ProcessStep[];
  isStreaming: boolean;
  citations: Citation[];
  onCitationClick: (n: number) => void;
  composingTool: { toolName: string; chars: number } | null;
  fallbackContent: string;
  executionId?: string | null;
  messageId?: string;
  journal?: ExecutionJournal;
}) {
  const last = process[process.length - 1];
  const hasContentStep = process.some((s) => s.kind === "content");
  const showThinkingTail =
    isStreaming &&
    !composingTool &&
    last?.kind === "tool" &&
    last.status !== "running";

  const nodes = groupToolRuns(process);
  const teamNodeIdx =
    executionId && messageId
      ? nodes.findIndex(
          (n) => n.kind === "tool" && isOrchestrationTool(n.step.tool_name),
        )
      : -1;

  return (
    <div className="space-y-2">
      {nodes.map((node, i) => {
        const live = isStreaming && i === nodes.length - 1;
        if (i === teamNodeIdx && executionId && messageId) {
          return (
            <InlineTeamGraph
              key={executionId}
              messageId={messageId}
              executionId={executionId}
              journal={journal}
            />
          );
        }
        if (node.kind === "tool-group") {
          return (
            <ProcessToolGroup
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only timeline
              key={i}
              tools={node.tools}
              isStreaming={live}
            />
          );
        }
        const step: ProcessStep = node.kind === "tool" ? node.step : node;
        return (
          <ProcessRow
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only timeline
            key={i}
            step={step}
            streaming={live}
            citations={citations}
            onCitationClick={onCitationClick}
          />
        );
      })}
      {executionId && messageId && teamNodeIdx === -1 && (
        <InlineTeamGraph
          messageId={messageId}
          executionId={executionId}
          journal={journal}
        />
      )}
      {!hasContentStep && fallbackContent && (
        <Markdown
          content={fallbackContent}
          citations={citations}
          onCitationClick={onCitationClick}
          isStreaming={isStreaming}
        />
      )}
      {isStreaming && composingTool && (
        <ComposingToolLine tool={composingTool} />
      )}
      {showThinkingTail && (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <ThinkingDots />
          正在思考…
        </span>
      )}
    </div>
  );
}
