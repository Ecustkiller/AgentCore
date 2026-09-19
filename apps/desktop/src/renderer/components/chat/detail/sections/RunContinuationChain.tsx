import { Button } from "@/components/ui";
import type {
  AgentState,
  ContinuationChain,
  Execution,
  RunNode,
} from "@/stores/execution";
import {
  debateBeatFromContext,
  debateBeatLabel,
  isDebateTaggedRun,
} from "@/stores/execution";
import { RunStatusDot, Section } from "./shared";

function outputOf(execution: Execution, run: RunNode): string {
  const agent = execution.agents.find((a) => a.id === run.agentId);
  return agent ? agent.outputChunks.join("") : "";
}

function charCount(s: string): number {
  return s.replace(/\s+/g, "").length;
}

/**
 * 轮次 / 版本导航（辩论逐轮 / 同人接续「续 ×N」）：本 run 的版本链横轨。
 * 当前版高亮，点其它版在右坞换人（不离开详情）。热修帧旁标 Δ 字。
 */
export function ContinuationChainSection({
  chain,
  currentRunId,
  agents,
  execution,
  onSelect,
}: {
  chain: ContinuationChain;
  currentRunId: string;
  agents: AgentState[];
  execution: Execution;
  onSelect: (runId: string, role?: string) => void;
}) {
  const isDebate = chain.versions.some((v) => isDebateTaggedRun(v.run));
  return (
    <Section title={isDebate ? "轮次" : "接续"}>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {chain.versions.map(({ version, run }, idx) => {
          const current = run.id === currentRunId;
          const role =
            agents.find((a) => a.id === run.agentId)?.role ?? run.agentId;
          const label = isDebate
            ? run.continuesRunId == null
              ? `第 ${run.round || version} 轮`
              : debateBeatLabel({
                  round: run.round,
                  continuationIndex: run.continuationIndex,
                  beat: debateBeatFromContext(run.receivedContext),
                })
            : version === 1
              ? "现场"
              : `续 ×${version - 1}`;
          const prevRun = idx > 0 ? chain.versions[idx - 1].run : null;
          const delta =
            !isDebate && prevRun
              ? charCount(outputOf(execution, run)) -
                charCount(outputOf(execution, prevRun))
              : 0;
          return (
            <Button
              key={run.id}
              variant="ghost"
              disabled={current}
              onClick={() => onSelect(run.id, role)}
              className={`h-auto shrink-0 gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
                current
                  ? "border-primary bg-primary/5"
                  : "border-border bg-muted hover:bg-accent"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <RunStatusDot status={run.status} />
                <span className="font-medium text-foreground">{label}</span>
                {delta !== 0 && (
                  <span
                    className={delta > 0 ? "text-success" : "text-destructive"}
                  >
                    {delta > 0 ? `+${delta}` : delta}
                  </span>
                )}
                {current && <span className="text-muted-foreground">当前</span>}
              </span>
            </Button>
          );
        })}
      </div>
    </Section>
  );
}
