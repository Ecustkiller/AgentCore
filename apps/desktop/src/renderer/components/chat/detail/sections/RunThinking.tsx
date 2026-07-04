import { Button } from "@/components/ui";
import { useStreamAwareDisclosure } from "@/stores/disclosure";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * 思考全文 (run-scoped reasoning) — the worker's streamed thinking, folded from
 * `run_reasoning_delta`. Collapsible because a deep-think run's log can be long;
 * opens while the worker is still thinking (so you watch it stream), then folds
 * away for completed runs where 输出/摘要 are the focus. Rendered as raw
 * preformatted text — reasoning is a thought log, not markdown.
 */
export function ThinkingSection({
  reasoning,
  live,
  keyBase,
}: {
  reasoning: string;
  live: boolean;
  keyBase: string;
}) {
  const [expanded, toggleExpanded] = useStreamAwareDisclosure(
    `${keyBase}:reasoning`,
    live,
  );

  return (
    <section className="mb-4 last:mb-0">
      <Button
        variant="ghost"
        onClick={toggleExpanded}
        className="h-auto w-full justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
            思考过程
          </span>
          {live && (
            <span className="shrink-0 text-xs text-primary">思考中…</span>
          )}
        </span>
      </Button>

      {expanded && (
        <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
          {reasoning}
          {live && (
            <span className="ml-0.5 inline-block animate-pulse text-primary">
              ▋
            </span>
          )}
        </div>
      )}
    </section>
  );
}
