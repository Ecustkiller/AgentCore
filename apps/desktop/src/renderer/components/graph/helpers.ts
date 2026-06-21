/** Pure graph derivation helpers (status, handoffs, artifacts, wave lanes). */

import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/elk-layout";
import type { Execution, RunStatus } from "@/stores/execution";
import type { GraphEdge, GraphLayout } from "@/stores/graph";
import type { EdgeHandoff } from "./StepEdge";

const PRODUCING_TOOLS = new Set(["file_write", "str_replace"]);
const WAVE_PAD = 8;

export interface WaveBand {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  labelX: number;
  labelY: number;
}

export function deriveCaptainStatus(
  execution: Execution,
  captainId: string,
): RunStatus {
  if (execution.status === "failed") return "failed";
  if (execution.status === "cancelled") return "cancelled";
  if (execution.status === "completed") return "completed";
  const workers = execution.runs.filter((r) => r.id !== captainId);
  const allDone =
    workers.length > 0 && workers.every((r) => r.status === "completed");
  return allDone ? "running" : "pending";
}

export function resolveHandoff(
  execution: Execution,
  source: string,
  target: string,
): EdgeHandoff | null {
  const targetRun = execution.runs.find((r) => r.id === target);
  if (!targetRun) return null;
  const block = targetRun.receivedContext.find(
    (b) => b.channel === "dependency" && b.source_run_id === source,
  );
  if (!block) return null;
  return {
    fidelity: block.fidelity,
    truncated: block.truncated,
    sourceRole: block.source_role,
    chars: block.chars,
  };
}

export function deriveArtifacts(
  toolCalls: {
    toolName: string;
    arguments: Record<string, unknown>;
    status: string;
  }[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tc of toolCalls) {
    if (tc.status !== "success") continue;
    if (!PRODUCING_TOOLS.has(tc.toolName)) continue;
    const path = tc.arguments.path;
    if (typeof path !== "string" || path.length === 0) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export function computeWaves(
  execution: Execution,
  positions: Record<string, { x: number; y: number }>,
  bbox: { width: number; height: number },
  layoutKind: GraphLayout,
  captainId: string | null,
): WaveBand[] {
  const horizontal = layoutKind === "leftright";
  const slots: { x: number; y: number }[] = [];
  for (const r of execution.runs) {
    if (r.id === captainId) continue;
    const p = positions[r.id];
    if (p) slots.push({ x: p.x, y: p.y });
  }
  if (slots.length === 0) return [];
  const groups = new Map<number, { x: number; y: number }[]>();
  for (const s of slots) {
    const key = Math.round(horizontal ? s.x : s.y);
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  if (keys.length < 2) return [];
  return keys.map((key, i) => {
    const members = groups.get(key) as { x: number; y: number }[];
    if (horizontal) {
      const x0 = Math.min(...members.map((m) => m.x));
      const x1 = Math.max(...members.map((m) => m.x + NODE_WIDTH));
      return {
        id: `wave-${i}`,
        label: `第 ${i + 1} 波`,
        x: x0 - WAVE_PAD,
        y: -WAVE_PAD,
        w: x1 - x0 + WAVE_PAD * 2,
        h: bbox.height + WAVE_PAD * 2,
        labelX: x0 - WAVE_PAD + 6,
        labelY: -WAVE_PAD + 6,
      };
    }
    const y0 = Math.min(...members.map((m) => m.y));
    const y1 = Math.max(...members.map((m) => m.y + NODE_HEIGHT));
    return {
      id: `wave-${i}`,
      label: `第 ${i + 1} 波`,
      x: -WAVE_PAD,
      y: y0 - WAVE_PAD,
      w: bbox.width + WAVE_PAD * 2,
      h: y1 - y0 + WAVE_PAD * 2,
      labelX: -WAVE_PAD + 6,
      labelY: y0 - WAVE_PAD + 6,
    };
  });
}

export interface GraphRunLike {
  id: string;
  dependsOn: string[];
  parentRunId?: string | null;
  revision?: number;
  revisionOf?: string | null;
  stance?: string | null;
  kind?: string;
}

/** Build ELK node ids + graph edges from projected runs (plan + revisions). */
export function buildGraphStructure(
  runs: GraphRunLike[],
  inputId: string,
): { nodeIds: string[]; rawEdges: GraphEdge[] } {
  const captainId = runs.find((r) => r.kind === "captain")?.id ?? null;
  const workerRuns = runs.filter((r) => r.id !== captainId);
  const workerIds = new Set(workerRuns.map((r) => r.id));
  const isRevision = (r: GraphRunLike): boolean => (r.revision ?? 0) > 0;
  const isSub = (r: GraphRunLike): boolean =>
    !isRevision(r) &&
    !!r.parentRunId &&
    r.parentRunId !== r.id &&
    workerIds.has(r.parentRunId);
  const topWorkers = workerRuns.filter((r) => !isSub(r) && !isRevision(r));
  const nodeIds = workerRuns.map((s) => s.id);
  const debate = workerRuns.some((r) => r.stance != null);
  if (debate) {
    const rank = (id: string) => {
      const st = workerRuns.find((r) => r.id === id)?.stance;
      return st === "pro" ? 0 : st === "con" ? 2 : 1;
    };
    nodeIds.sort((a, b) => rank(a) - rank(b));
  }
  const rawEdges: GraphEdge[] = workerRuns.flatMap((run) =>
    run.dependsOn.map((depId) => ({
      id: `${depId}->${run.id}`,
      source: depId,
      target: run.id,
      kind: "dep" as const,
    })),
  );
  for (const r of workerRuns) {
    if (isSub(r)) {
      rawEdges.push({
        id: `${r.parentRunId}=>${r.id}`,
        source: r.parentRunId as string,
        target: r.id,
        kind: "delegate",
      });
    }
  }
  for (const r of workerRuns) {
    if (isRevision(r) && r.revisionOf) {
      rawEdges.push({
        id: `${r.revisionOf}~>${r.id}`,
        source: r.revisionOf,
        target: r.id,
        kind: "revision",
      });
    }
  }
  if (topWorkers.length > 0 && captainId) {
    const dependedOn = new Set<string>();
    for (const r of topWorkers)
      for (const dep of r.dependsOn) dependedOn.add(dep);
    nodeIds.push(inputId, captainId);
    for (const r of topWorkers) {
      if (r.dependsOn.length === 0) {
        rawEdges.push({
          id: `${inputId}->${r.id}`,
          source: inputId,
          target: r.id,
          kind: "dep",
        });
      }
      if (!dependedOn.has(r.id)) {
        rawEdges.push({
          id: `${r.id}->${captainId}`,
          source: r.id,
          target: captainId,
          kind: "dep",
        });
      }
    }
  }
  return { nodeIds, rawEdges };
}
