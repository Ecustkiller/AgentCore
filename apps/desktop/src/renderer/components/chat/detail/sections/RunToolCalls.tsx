import {
  type ToolResultData,
  ToolResultView,
  hasToolResultBody,
  toolResultPeek,
} from "@/components/chat/toolResult/ToolResultView";
import {
  baseName,
  toolDetail,
  toolMeta,
} from "@/components/chat/message-bubble/constants";
import { Badge, Button } from "@/components/ui";
import { usePersistentDisclosure, useStreamAwareDisclosure } from "@/stores/disclosure";
import { type ToolCallState, toolLabel } from "@/stores/execution";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";

/** One tool call in a worker's run detail: a click-to-expand row that reveals the
 * rich result (工具结果富渲染) — a search's cards, a code run's terminal, an edit's
 * diff — or the text result, via the shared {@link ToolResultView}. */
function RunToolRow({ tc, keyBase }: { tc: ToolCallState; keyBase: string }) {
  const [open, setOpen] = usePersistentDisclosure(`${keyBase}:tool:${tc.id}`, false);
  const data: ToolResultData = {
    toolName: tc.toolName,
    args: tc.arguments,
    result: tc.result,
    display: tc.display,
    status: tc.status,
  };
  const hasBody = hasToolResultBody(data);
  const statusClass =
    tc.status === "error"
      ? "text-destructive"
      : tc.status === "running"
        ? "text-primary"
        : "text-muted-foreground";
  return (
    <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs">
      <Button
        variant="ghost"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`h-auto w-full justify-start gap-2 px-0 py-0 hover:bg-transparent ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="flex w-full items-center gap-2 text-left">
          <Wrench size={12} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-foreground">
              {toolLabel(tc.toolName)}
            </span>
            {hasBody && !open && (
              <span
                className={`block truncate ${
                  tc.status === "error"
                    ? "text-destructive/80"
                    : "text-muted-foreground/70"
                }`}
              >
                {toolResultPeek(data)}
              </span>
            )}
          </span>
          <span className={`shrink-0 ${statusClass}`}>
            {tc.status === "running"
              ? "执行中"
              : tc.status === "error"
                ? "失败"
                : "完成"}
          </span>
        </span>
      </Button>
      {open && hasBody && <ToolResultView data={data} />}
    </div>
  );
}

/** Category summary for a run's tool list — mirrors {@link toolGroupSummary} on process
 * steps so the collapsed section header reads like the main-chat tool group. */
function runToolCallsSummary(toolCalls: ToolCallState[]): string {
  const sameKind = toolCalls.every((t) => t.toolName === toolCalls[0].toolName);
  if (sameKind && toolCalls.length <= 3) {
    const { label } = toolMeta(toolCalls[0].toolName);
    const names = toolCalls.map((t) => baseName(toolDetail(t.arguments)));
    if (names.every(Boolean)) return `${label} ${names.join(" · ")}`;
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const t of toolCalls) {
    const { label } = toolMeta(t.toolName);
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order.map((l) => `${l} ${counts.get(l)}`).join(" · ");
}

/**
 * Run-detail tool IO — section-level fold like 思考过程 / 资源消耗: collapsed by default
 * once the run settles, auto-expands while a tool is actively running so you can watch
 * progress without scrolling past a long list.
 */
export function ToolCallsSection({
  toolCalls,
  live,
  keyBase,
}: {
  toolCalls: ToolCallState[];
  live: boolean;
  keyBase: string;
}) {
  const [expanded, toggleExpanded] = useStreamAwareDisclosure(
    `${keyBase}:tools`,
    live,
  );

  const summary = runToolCallsSummary(toolCalls);
  const errorCount = toolCalls.filter((t) => t.status === "error").length;

  return (
    <section className="mb-4 last:mb-0">
      <Button
        variant="ghost"
        onClick={toggleExpanded}
        className="h-auto w-full justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-start gap-1.5">
          {expanded ? (
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
          )}
          <span className="min-w-0 flex-1 text-left">
            <span className="text-xs font-medium text-muted-foreground">
              工具调用 ({toolCalls.length})
            </span>
            {!expanded && (
              <span className="block truncate text-xs text-muted-foreground/70">
                {summary}
              </span>
            )}
          </span>
          {errorCount > 0 && (
            <Badge tone="destructive" className="shrink-0 font-normal">
              {errorCount} 个失败
            </Badge>
          )}
          {live && (
            <span className="shrink-0 text-xs text-primary">执行中…</span>
          )}
        </span>
      </Button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {toolCalls.map((tc) => (
            <RunToolRow key={tc.id} tc={tc} keyBase={keyBase} />
          ))}
        </div>
      )}
    </section>
  );
}
