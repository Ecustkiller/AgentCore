import { Markdown } from "@/components/chat/Markdown";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Three pulsing dots — the shared「正在思考」liveliness cue (图2 的 ● ● ●). */
export function ThinkingDots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}

/**
 * Borderless disclosure header shared by {@link ThinkingPanel} and
 * {@link ProcessTimeline} (对齐 Cursor 的轻量内联思考样式).
 */
export function ThinkingHeader({
  isStreaming,
  expanded,
  streamingLabel,
  doneLabel,
  onToggle,
}: {
  isStreaming: boolean;
  expanded: boolean;
  streamingLabel: string;
  doneLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {isStreaming ? (
        <>
          <ThinkingDots />
          <span>{streamingLabel}</span>
        </>
      ) : (
        <>
          {expanded ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight size={14} className="shrink-0" />
          )}
          <span>{doneLabel}</span>
        </>
      )}
    </button>
  );
}

/**
 * Collapsible panel showing the model's thinking (reasoning_content).
 * Used by multi-agent turns — the single-agent turn uses ProcessTimeline instead.
 */
export function ThinkingPanel({
  reasoning,
  isStreaming,
}: {
  reasoning: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(isStreaming);
  const prevStreaming = useRef(isStreaming);

  useEffect(() => {
    if (prevStreaming.current && !isStreaming) setExpanded(false);
    prevStreaming.current = isStreaming;
  }, [isStreaming]);

  return (
    <div className="mb-2">
      <ThinkingHeader
        isStreaming={isStreaming}
        expanded={expanded}
        streamingLabel="正在思考…"
        doneLabel="思考过程"
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div className="mt-1.5 pl-3">
          <Markdown content={reasoning} isStreaming={isStreaming} muted />
        </div>
      )}
    </div>
  );
}
