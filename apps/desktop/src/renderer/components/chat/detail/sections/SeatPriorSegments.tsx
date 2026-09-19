import { Markdown } from "@/components/chat/Markdown";
import {
  absorbHandoffBriefContent,
  processHasSuccessfulHandoff,
} from "@/components/chat/handoffBrief";
import { TimelineNodeView } from "@/components/chat/message-bubble/ProcessTimeline";
import { revisionFeedbackSummary } from "@/components/graph/agentNode/shared";
import { groupToolRuns, timelineNodeKeys } from "@/lib/processTimeline";
import type { ContinuationVersion, RunNode } from "@/stores/execution";
import { DebriefSection } from "./RunDebrief";
import { Section } from "./shared";

function instructionOf(run: RunNode): string | null {
  return revisionFeedbackSummary(run.receivedContext);
}

/**
 * 同人续写座位：链尾之前的各版，按时间叠在详情里（像同一条回复往下长）。
 * 已停止的墓碑默认折起；已完成的产出默认展开。
 */
export function SeatPriorSegments({
  versions,
  conversationId,
  messageId,
}: {
  versions: ContinuationVersion[];
  conversationId: string | null;
  messageId: string;
}) {
  if (versions.length === 0) return null;
  return (
    <div className="mb-4 space-y-3">
      {versions.map(({ version, run }) => (
        <PriorVersion
          key={run.id}
          version={version}
          run={run}
          conversationId={conversationId}
          messageId={messageId}
        />
      ))}
    </div>
  );
}

export function SeatInstructionMark({ run }: { run: RunNode }) {
  const text = instructionOf(run);
  if (!text) return null;
  return (
    <p className="mb-3 text-xs leading-snug text-muted-foreground">
      按指示：{text}
    </p>
  );
}

function PriorVersion({
  version,
  run,
  conversationId,
  messageId,
}: {
  version: number;
  run: RunNode;
  conversationId: string | null;
  messageId: string;
}) {
  const label = version === 1 ? "现场" : `续 ×${version - 1}`;
  const instruction = version > 1 ? instructionOf(run) : null;
  const process = run.process;
  const nodes =
    process.length > 0
      ? groupToolRuns(absorbHandoffBriefContent(process, run.debrief))
      : [];
  const nodeKeys = timelineNodeKeys(nodes).map((k) => `${run.id}:${k}`);
  const showDebrief =
    Boolean(run.debrief) && !processHasSuccessfulHandoff(process);
  const showConclusion = Boolean(run.outputSummary) && !run.debrief;
  const emptyCancelled =
    run.status === "cancelled" && nodes.length === 0 && !showConclusion;
  const defaultOpen = run.status === "completed" || run.status === "failed";

  return (
    <details
      className="rounded-lg border border-border px-3 py-2"
      open={defaultOpen}
    >
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        {label}
        {run.status === "cancelled"
          ? " · 已停止"
          : run.status === "failed"
            ? " · 失败"
            : null}
      </summary>
      <div className="mt-2 space-y-2">
        {instruction ? (
          <p className="text-xs leading-snug text-muted-foreground">
            按指示：{instruction}
          </p>
        ) : null}
        {emptyCancelled ? (
          <p className="text-xs text-muted-foreground">这一截已停止。</p>
        ) : null}
        {nodes.map((node, i) => (
          <TimelineNodeView
            key={nodeKeys[i] ?? `${run.id}:${i}`}
            node={node}
            nodeKey={nodeKeys[i] ?? String(i)}
            live={false}
            citations={[]}
            messageId={`${messageId}:${run.id}`}
            conversationId={conversationId}
            checkpoints={[]}
            isStreaming={false}
          />
        ))}
        {showDebrief && run.debrief ? (
          <DebriefSection debrief={run.debrief} />
        ) : showConclusion && run.outputSummary ? (
          <Section title="结论">
            <Markdown content={run.outputSummary} />
          </Section>
        ) : null}
      </div>
    </details>
  );
}
