import type { Execution } from "@/stores/execution";
import { Target } from "lucide-react";
import type { DebateRoundModel } from "../model";
import { sidePositionSummary } from "./parseSpeechArguments";

function sideOutput(execution: Execution, side: DebateRoundModel["sides"][number]): string {
  const run = side.run;
  if (!run) return "";
  const agent = execution.agents.find((a) => a.id === run.agentId);
  return agent ? agent.outputChunks.join("") : "";
}

/** 本轮核心争议：焦点 + 各方立场摘要，置于发言区上方。 */
export function RoundFocusCard({
  round,
  topicMotion,
  execution,
}: {
  round: DebateRoundModel;
  topicMotion: string;
  execution: Execution;
}) {
  const focus =
    round.focus?.trim() ||
    topicMotion.trim() ||
    (round.roundNo >= 1 ? `第 ${round.roundNo} 轮交锋` : "");

  const positions = round.sides
    .map((side) => {
      const output = sideOutput(execution, side);
      const streaming = side.run?.status === "running";
      const summary = output
        ? sidePositionSummary(output)
        : streaming
          ? "正在输入…"
          : "";
      return { side, summary };
    })
    .filter((p) => p.summary || p.side.run);

  if (!focus && positions.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-border bg-muted/35 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Target size={13} className="shrink-0" />
        本轮核心争议
      </div>
      {focus && (
        <p className="mt-1.5 text-sm font-medium leading-snug text-foreground">
          {focus}
        </p>
      )}
      {positions.length > 0 && (
        <div
          className={`mt-2.5 grid gap-2 ${positions.length > 1 ? "sm:grid-cols-2" : "grid-cols-1"}`}
        >
          {positions.map(({ side, summary }) => (
            <div
              key={side.key}
              className="rounded-lg bg-background/60 px-2.5 py-2"
              style={{ borderLeft: `3px solid ${side.colorVar}` }}
            >
              <span
                className="text-xs font-semibold"
                style={{ color: side.colorVar }}
              >
                {side.name}
              </span>
              <p className="mt-0.5 text-xs leading-relaxed text-foreground">
                {summary || "—"}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
