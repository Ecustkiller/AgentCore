import { Markdown } from "@/components/chat/Markdown";
import { ReceivedContextSection } from "@/components/chat/ReceivedContext";
import { Button } from "@/components/ui";
import { formatCompact } from "@/lib/format";
import { detectReviewConcern } from "@/lib/reviewConcern";
import { submitRunRedirect } from "@/services/runRedirect";
import { useComposerDraftStore } from "@/stores/composer";
import { activeRuntime, useConversationStore } from "@/stores/conversation";
import {
  type RunNode,
  revisionChains,
  toolLabel,
  useMessageExecution,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import { Pencil, RotateCcw, Square, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AuditSection } from "./sections/RunAudit";
import { DebriefSection } from "./sections/RunDebrief";
import { DiagnosticSection } from "./sections/RunDiagnostics";
import { EscalationSection } from "./sections/RunEscalations";
import {
  RunRefGroup,
  SubtaskTree,
  countDescendants,
} from "./sections/RunRelations";
import { ResourceSection } from "./sections/RunResources";
import {
  RevisionChainSection,
  revisionComparePair,
} from "./sections/RunRevisionChain";
import { ThinkingSection } from "./sections/RunThinking";
import { ToolCallsSection } from "./sections/RunToolCalls";
import { Section, StatusBadge } from "./sections/shared";

export { SchedulingDiag } from "./sections/RunDiagnostics";

/**
 * Single-run detail content (task / status / model+reasoning / tools / output /
 * summary), read from the live-or-replayed execution projection by run id.
 *
 * Bound to a specific message's execution slot (§9.3) via `messageId`, so the
 * conversation's right-side detail panel can pin a run from any turn (live or
 * historical) — the single home for run detail, reached from both the embedded
 * graph and the full-screen overlay. Chrome-free on purpose, so the drill-down
 * view is identical wherever it appears.
 */
export function RunDetailBody({
  messageId,
  runId,
}: {
  messageId: string;
  runId: string;
}) {
  const execution = useMessageExecution(messageId);
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const diagnosticMode = useUIStore((s) => s.diagnosticMode);
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const requestCanvasFocus = useUIStore((s) => s.requestCanvasFocus);
  const setConversationView = useUIStore((s) => s.setConversationView);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const traceId = useConversationStore(
    (s) =>
      activeRuntime(s).messages.find((m) => m.id === messageId)?.traceId ??
      null,
  );
  const turnInteractive = useConversationStore(
    (s) =>
      activeRuntime(s).messages.find((m) => m.id === messageId)?.isStreaming ??
      false,
  );

  const [redirectOpen, setRedirectOpen] = useState(false);
  const [redirectFeedback, setRedirectFeedback] = useState("");
  const [redirectSubmitting, setRedirectSubmitting] = useState(false);

  const run = execution?.runs.find((s) => s.id === runId);
  const agent = run
    ? execution?.agents.find((a) => a.id === run.agentId)
    : null;

  if (!execution || !run || !agent) return null;

  const output = agent.outputChunks.join("");
  const reasoning = agent.reasoningChunks.join("");
  const canRedirect =
    turnInteractive &&
    agent.status === "working" &&
    execution.planType === "multi_agent" &&
    conversationId != null;
  const thinkingLive =
    agent.status === "working" && output.length === 0 && !agent.toolProgress;
  const upstream = run.dependsOn
    .map((id) => execution.runs.find((r) => r.id === id))
    .filter((r): r is RunNode => r != null);
  const downstream = execution.runs.filter((r) => r.dependsOn.includes(run.id));
  const parent =
    run.parentRunId != null && run.revisionOf == null
      ? (execution.runs.find((r) => r.id === run.parentRunId) ?? null)
      : null;
  const childCount = countDescendants(execution.runs, run.id);
  const chain =
    revisionChains(execution).find((c) =>
      c.versions.some((v) => v.run.id === run.id),
    ) ?? null;
  const roundFocus =
    run.revisionOf != null
      ? run.receivedContext.find((b) => b.channel === "round_focus")?.body
      : undefined;

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {agent.role}
        </span>
        <StatusBadge status={run.status} />
        {run.durationMs != null && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {(run.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {agent.status === "working" && (
        <div className="mb-4 space-y-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs">
          <p className="text-sm text-foreground">
            正在实时输出——下方内容会边写边更新。
          </p>
          <div className="flex flex-wrap gap-2">
            {canRedirect && (
              <Button
                variant="ghost"
                className="h-7 text-primary hover:bg-primary/10"
                icon={<RotateCcw size={13} />}
                onClick={() => {
                  const concern = detectReviewConcern(output);
                  setRedirectFeedback(
                    concern != null
                      ? "请按以下方向调整："
                      : `请按以下方向调整「${agent.role}」的产出：`,
                  );
                  setRedirectOpen(true);
                }}
              >
                立即改此人
              </Button>
            )}
            <Button
              variant="ghost"
              className="h-7 text-primary hover:bg-primary/10"
              icon={<Pencil size={13} />}
              onClick={() => {
                useComposerDraftStore
                  .getState()
                  .fill(`【协作中调整】关于「${agent.role}」：`, "append");
              }}
            >
              记下改法（跑完后发送）
            </Button>
            <Button
              variant="ghost"
              className="h-7 text-destructive hover:bg-destructive/10"
              icon={<Square size={13} />}
              onClick={() => useConversationStore.getState().stopGeneration()}
            >
              停止整轮
            </Button>
          </div>
          {redirectOpen && canRedirect && (
            <div className="space-y-2 border-t border-primary/15 pt-2">
              <textarea
                className="min-h-[4.5rem] w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground outline-none ring-primary/30 focus:ring-2"
                value={redirectFeedback}
                onChange={(e) => setRedirectFeedback(e.target.value)}
                placeholder="具体、可执行的修改方向…"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  className="h-7"
                  disabled={redirectSubmitting || !redirectFeedback.trim()}
                  onClick={async () => {
                    if (!conversationId || !redirectFeedback.trim()) return;
                    setRedirectSubmitting(true);
                    try {
                      await submitRunRedirect(conversationId, {
                        executionId: execution.id,
                        runId: run.id,
                        feedback: redirectFeedback.trim(),
                      });
                      toast.success("已提交改方向请求", {
                        description: "调度器将在下一步接管（当前为排队阶段）。",
                      });
                      setRedirectOpen(false);
                    } catch {
                      toast.error("提交失败，请稍后重试");
                    } finally {
                      setRedirectSubmitting(false);
                    }
                  }}
                >
                  提交改方向
                </Button>
                <Button
                  variant="ghost"
                  className="h-7"
                  onClick={() => setRedirectOpen(false)}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <Section title={roundFocus != null ? "本轮焦点" : "任务"}>
        <Markdown content={roundFocus ?? run.task} />
      </Section>

      {chain && (
        <RevisionChainSection
          chain={chain}
          currentRunId={run.id}
          agents={execution.agents}
          execution={execution}
          onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
          onCompare={
            conversationId
              ? () => {
                  requestCanvasFocus(
                    messageId,
                    false,
                    "compare",
                    revisionComparePair(chain, run.id),
                  );
                  setConversationView(conversationId, "canvas");
                }
              : undefined
          }
        />
      )}

      {run.escalations.length > 0 && (
        <EscalationSection
          run={run}
          role={agent.role}
          conversationId={conversationId}
          interactive={turnInteractive}
        />
      )}

      {run.receivedContext.length > 0 && (
        <ReceivedContextSection
          blocks={run.receivedContext}
          defaultExpanded={false}
          keyBase={`run:${runId}`}
          onNavigate={(rid) => {
            const target = execution.runs.find((r) => r.id === rid);
            if (!target) return;
            const role = execution.agents.find(
              (a) => a.id === target.agentId,
            )?.role;
            showRunDetail(messageId, rid, role);
          }}
        />
      )}

      {(reasoning || thinkingLive) && (
        <ThinkingSection
          reasoning={reasoning}
          live={thinkingLive}
          keyBase={`run:${runId}`}
        />
      )}

      {run.error && (
        <Section title="错误">
          <p className="whitespace-pre-wrap break-words text-xs text-destructive">
            {run.error}
          </p>
        </Section>
      )}

      {agent.toolProgress && agent.status === "working" && (
        <Section title="正在生成">
          <div className="flex items-center gap-2 rounded-lg bg-primary/5 px-2.5 py-1.5 text-xs">
            <Wrench size={12} className="shrink-0 text-primary" />
            <span className="flex-1 truncate text-foreground">
              {toolLabel(agent.toolProgress.toolName)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {agent.toolProgress.chars > 0
                ? `${formatCompact(agent.toolProgress.chars)} 字`
                : "…"}
            </span>
            <span className="inline-block animate-pulse text-primary">▋</span>
          </div>
        </Section>
      )}

      {agent.toolCalls.length > 0 && (
        <ToolCallsSection
          toolCalls={agent.toolCalls}
          live={
            run.status === "running" &&
            agent.toolCalls.some((t) => t.status === "running")
          }
          keyBase={`run:${runId}`}
        />
      )}

      {output && (
        <Section title="输出">
          <div className="rounded-lg bg-muted p-3">
            <Markdown
              content={output}
              isStreaming={agent.status === "working"}
            />
          </div>
        </Section>
      )}

      {run.debrief ? (
        <DebriefSection debrief={run.debrief} />
      ) : run.outputSummary ? (
        <Section title="结论">
          <Markdown content={run.outputSummary} />
        </Section>
      ) : null}

      {(upstream.length > 0 ||
        downstream.length > 0 ||
        parent ||
        childCount > 0) && (
        <Section title="关系">
          <div className="space-y-3">
            {upstream.length > 0 && (
              <RunRefGroup
                label="依赖"
                runs={upstream}
                agents={execution.agents}
                onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
              />
            )}
            {downstream.length > 0 && (
              <RunRefGroup
                label="后续"
                runs={downstream}
                agents={execution.agents}
                onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
              />
            )}
            {parent && (
              <RunRefGroup
                label="上级"
                runs={[parent]}
                agents={execution.agents}
                onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
              />
            )}
            {childCount > 0 && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">
                  子任务（{childCount}）
                </p>
                <SubtaskTree
                  parentId={run.id}
                  runs={execution.runs}
                  agents={execution.agents}
                  depth={0}
                  onSelect={(rid, role) => showRunDetail(messageId, rid, role)}
                />
              </div>
            )}
          </div>
        </Section>
      )}

      {(run.usage || run.cost) && (
        <ResourceSection
          run={run}
          agent={agent}
          cnyPerUsd={cnyPerUsd}
          defaultExpanded
        />
      )}

      {diagnosticMode && (
        <DiagnosticSection
          run={run}
          executionId={execution.id}
          traceId={traceId}
          batches={execution.batches}
          keyBase={`run:${runId}`}
        />
      )}

      {conversationId != null && (
        <AuditSection
          conversationId={conversationId}
          messageId={messageId}
          runId={runId}
        />
      )}
    </div>
  );
}
