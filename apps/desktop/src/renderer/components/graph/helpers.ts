/** Pure graph derivation helpers (status, handoffs, artifacts, wave lanes). */

import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/elk-layout";
import type { Execution, RunStatus } from "@/stores/execution";
import type { GraphEdge, GraphLayout } from "@/stores/graph";
import type { EdgeHandoff } from "./StepEdge";

const PRODUCING_TOOLS = new Set(["file_write", "file_append", "str_replace"]);
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

function isRevisionRun(r: GraphRunLike): boolean {
  return (r.revision ?? 0) > 0;
}

function isSubRun(r: GraphRunLike, workerIds: Set<string>): boolean {
  return (
    !isRevisionRun(r) &&
    !!r.parentRunId &&
    r.parentRunId !== r.id &&
    workerIds.has(r.parentRunId)
  );
}

/** Kahn-style topological wave index per run (mirrors backend RunPlan.waves). */
export function computeTopologicalRunWaves(
  runs: GraphRunLike[],
  captainId: string | null,
): Map<string, number> {
  const workerRuns = runs.filter((r) => r.id !== captainId);
  if (workerRuns.length === 0) return new Map();

  const workerIds = new Set(workerRuns.map((r) => r.id));
  const runById = new Map(workerRuns.map((r) => [r.id, r]));

  const unitOf = (runId: string): string => {
    const r = runById.get(runId);
    if (!r) return runId;
    if (isSubRun(r, workerIds)) return r.parentRunId as string;
    if (isRevisionRun(r) && r.revisionOf && workerIds.has(r.revisionOf)) {
      return unitOf(r.revisionOf);
    }
    return runId;
  };

  const unitMembers = new Map<string, Set<string>>();
  for (const r of workerRuns) {
    const unitId = unitOf(r.id);
    const members = unitMembers.get(unitId) ?? new Set<string>();
    members.add(r.id);
    unitMembers.set(unitId, members);
  }

  const unitIds: string[] = [];
  const seenUnits = new Set<string>();
  for (const r of workerRuns) {
    const unitId = unitOf(r.id);
    if (seenUnits.has(unitId)) continue;
    seenUnits.add(unitId);
    unitIds.push(unitId);
  }

  const unitDeps = new Map<string, Set<string>>();
  for (const unitId of unitIds) {
    const deps = new Set<string>();
    const members = unitMembers.get(unitId);
    if (!members) continue;
    for (const memberId of members) {
      const r = runById.get(memberId);
      if (!r) continue;
      for (const depId of r.dependsOn) {
        if (!workerIds.has(depId)) continue;
        const depUnit = unitOf(depId);
        if (depUnit === unitId) continue;
        deps.add(depUnit);
      }
    }
    unitDeps.set(unitId, deps);
  }

  const waveByUnit = new Map<string, number>();
  const resolved = new Set<string>();
  let waveIndex = 0;
  let remaining = unitIds.filter((u) => !resolved.has(u));

  while (remaining.length > 0) {
    const wave = remaining.filter((u) => {
      const deps = unitDeps.get(u) ?? new Set<string>();
      return [...deps].every((d) => resolved.has(d));
    });
    if (wave.length === 0) {
      for (const u of remaining) waveByUnit.set(u, waveIndex);
      break;
    }
    for (const u of wave) {
      waveByUnit.set(u, waveIndex);
      resolved.add(u);
    }
    remaining = remaining.filter((u) => !resolved.has(u));
    waveIndex++;
  }

  const waveByRun = new Map<string, number>();
  for (const r of workerRuns) {
    waveByRun.set(r.id, waveByUnit.get(unitOf(r.id)) ?? 0);
  }
  return waveByRun;
}

export function computeWaves(
  execution: Execution,
  positions: Record<string, { x: number; y: number }>,
  bbox: { width: number; height: number },
  layoutKind: GraphLayout,
  captainId: string | null,
): WaveBand[] {
  if (layoutKind === "timeline") return [];
  const horizontal = layoutKind === "leftright";
  const waveByRun = computeTopologicalRunWaves(execution.runs, captainId);

  const groups = new Map<number, string[]>();
  for (const r of execution.runs) {
    if (r.id === captainId) continue;
    const p = positions[r.id];
    if (!p) continue;
    const wave = waveByRun.get(r.id);
    if (wave === undefined) continue;
    const arr = groups.get(wave);
    if (arr) arr.push(r.id);
    else groups.set(wave, [r.id]);
  }

  const keys = [...groups.keys()].sort((a, b) => a - b);
  if (keys.length < 2) return [];

  return keys.map((waveKey, i) => {
    const runIds = groups.get(waveKey) as string[];
    const members = runIds
      .map((id) => positions[id])
      .filter((p): p is { x: number; y: number } => p != null);
    const count = runIds.length;
    const label = `批次 ${i + 1}（${count} 节点）`;

    if (horizontal) {
      const x0 = Math.min(...members.map((m) => m.x));
      const x1 = Math.max(...members.map((m) => m.x + NODE_WIDTH));
      return {
        id: `wave-${i}`,
        label,
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
      label,
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

export interface SubTeam {
  parentId: string;
  memberIds: string[];
  groupId: string;
}

/** Build ELK node ids + graph edges from projected runs (plan + revisions). */
export function buildGraphStructure(
  runs: GraphRunLike[],
  inputId: string,
): { nodeIds: string[]; rawEdges: GraphEdge[]; subTeams: SubTeam[] } {
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
  const subTeamMap = new Map<string, string[]>();
  for (const r of workerRuns) {
    if (isSub(r)) {
      const parentId = r.parentRunId as string;
      const arr = subTeamMap.get(parentId) ?? [];
      arr.push(r.id);
      subTeamMap.set(parentId, arr);
      rawEdges.push({
        id: `${parentId}=>${r.id}`,
        source: parentId,
        target: r.id,
        kind: "delegate",
      });
    }
  }
  const subTeams: SubTeam[] = [...subTeamMap.entries()].map(
    ([parentId, memberIds]) => ({
      parentId,
      memberIds,
      groupId: `__group__${parentId}`,
    }),
  );
  // A revised worker's versions all point at the SAME original (revisionOf ==
  // 原始 run) — a star, the data model the debate room / 版本对比 card read (乙 热修
  // P4). But the graph must lay them out as a version CHAIN (原始 → v2 → v3 …): if
  // we drew one edge per revision straight off the original, ELK would place every
  // revision in the original's single successor slot AND alignRevisionChains would
  // snap them all onto its one lane — v2…vN stack at identical coordinates, so only
  // the latest stays visible (a 5-轮辩论 collapsed to「原始 + 修订 vN」= 2 版本). Group
  // each original's revisions, order by version, and link consecutive ones so each
  // gets its own layer/lane. Display-only: revisionOf is untouched.
  const revisionsByOriginal = new Map<string, GraphRunLike[]>();
  for (const r of workerRuns) {
    if (isRevision(r) && r.revisionOf && workerIds.has(r.revisionOf)) {
      const list = revisionsByOriginal.get(r.revisionOf) ?? [];
      list.push(r);
      revisionsByOriginal.set(r.revisionOf, list);
    }
  }
  for (const [originalId, revisions] of revisionsByOriginal) {
    const ordered = revisions
      .slice()
      .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
    let prev = originalId;
    for (const rev of ordered) {
      rawEdges.push({
        id: `${prev}~>${rev.id}`,
        source: prev,
        target: rev.id,
        kind: "revision",
      });
      prev = rev.id;
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
  return { nodeIds, rawEdges, subTeams };
}
