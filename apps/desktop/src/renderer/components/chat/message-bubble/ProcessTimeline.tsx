import { InlineTeamGraph } from "@/components/chat/InlineTeamGraph";
import { Markdown } from "@/components/chat/Markdown";
import {
  ComposingToolLine,
  ToolLine,
  ToolLineGroup,
} from "@/components/chat/ToolLine";
import { groupToolRuns, isOrchestrationTool } from "@/lib/processTimeline";
import type { ExecutionJournal } from "@/stores/execution";
import type { Citation, ProcessStep } from "@/types/events";
import { useEffect, useRef, useState } from "react";
import { ThinkingDots, ThinkingHeader } from "./Thinking";

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
  return <ToolLine step={step} />;
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
            <ToolLineGroup
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

/** Re-export for consumers that imported from ProcessTimeline. */
export { ComposingToolLine } from "@/components/chat/ToolLine";
