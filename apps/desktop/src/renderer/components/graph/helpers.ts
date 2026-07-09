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

function _isSubRun(r: GraphRunLike, workerIds: Set<string>): boolean {
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
  const foldInfo = computeGraphFold(runs, captainId);

  const unitOf = (runId: string): string => foldInfo.unitOf.get(runId) ?? runId;

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
  group?: string | null;
  kind?: string;
}

const DEBATE_GROUP_PREFIX = "debate:";

/** Display-only signal that a run is a debate participant (辩手 / 续轮 revision). */
export function isDebateParticipantRun(r: GraphRunLike): boolean {
  return (
    r.stance != null || (r.group?.startsWith(DEBATE_GROUP_PREFIX) ?? false)
  );
}

function revisionRootId(
  runId: string,
  runById: Map<string, GraphRunLike>,
  workerIds: Set<string>,
): string {
  let cur = runId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const r = runById.get(cur);
    if (!r?.revisionOf || !workerIds.has(r.revisionOf)) break;
    cur = r.revisionOf;
  }
  return cur;
}

/** Moderator run id inferred from debate participant parent chain. */
export function debateModeratorId(
  runs: GraphRunLike[],
  captainId: string | null,
): string | null {
  const workers = runs.filter((r) => r.id !== captainId);
  const workerIds = new Set(workers.map((r) => r.id));
  const runById = new Map(workers.map((r) => [r.id, r]));
  for (const r of workers) {
    if (!isDebateParticipantRun(r)) continue;
    const root = revisionRootId(r.id, runById, workerIds);
    const rootRun = runById.get(root);
    const parentId = rootRun?.parentRunId;
    if (parentId && workerIds.has(parentId)) return parentId;
  }
  return null;
}

function belongsToDebateUnit(
  r: GraphRunLike,
  moderatorId: string,
  runById: Map<string, GraphRunLike>,
  workerIds: Set<string>,
): boolean {
  if (r.id === moderatorId) return false;
  if (isDebateParticipantRun(r)) return true;
  if ((r.revision ?? 0) > 0 && r.revisionOf && workerIds.has(r.revisionOf)) {
    const root = runById.get(revisionRootId(r.id, runById, workerIds));
    return root != null && isDebateParticipantRun(root);
  }
  return false;
}

/** Run-level fold: which runs collapse under a parent unit on the collaboration graph. */
export interface GraphFoldInfo {
  /** Run ids hidden from the top-level graph (children of a layout unit). */
  folded: Set<string>;
  /** Every worker run id → its visible layout-unit root id. */
  unitOf: Map<string, string>;
  /** Unit roots that render as a debate compound card (not a plain agent node). */
  debateUnits: Set<string>;
  /** Layout unit id → all folded descendant run ids (for drill-in / subTeams). */
  descendants: Map<string, string[]>;
}

export function computeGraphFold(
  runs: GraphRunLike[],
  captainId: string | null,
): GraphFoldInfo {
  const workers = runs.filter((r) => r.id !== captainId);
  const workerIds = new Set(workers.map((r) => r.id));
  const runById = new Map(workers.map((r) => [r.id, r]));
  const modId = debateModeratorId(runs, captainId);
  const debateUnits = modId ? new Set([modId]) : new Set<string>();
  const unitOf = new Map<string, string>();

  const resolveUnit = (runId: string): string => {
    const cached = unitOf.get(runId);
    if (cached) return cached;

    const r = runById.get(runId);
    if (!r) {
      unitOf.set(runId, runId);
      return runId;
    }

    if (modId && belongsToDebateUnit(r, modId, runById, workerIds)) {
      unitOf.set(runId, modId);
      return modId;
    }

    if ((r.revision ?? 0) > 0 && r.revisionOf && workerIds.has(r.revisionOf)) {
      if (modId && belongsToDebateUnit(r, modId, runById, workerIds)) {
        unitOf.set(runId, modId);
        return modId;
      }
      // Non-debate revisions stay individually visible (revision chain on the graph).
      unitOf.set(runId, runId);
      return runId;
    }

    if (
      !((r.revision ?? 0) > 0) &&
      r.parentRunId &&
      r.parentRunId !== r.id &&
      workerIds.has(r.parentRunId)
    ) {
      const u = resolveUnit(r.parentRunId);
      unitOf.set(runId, u);
      return u;
    }

    unitOf.set(runId, runId);
    return runId;
  };

  for (const r of workers) resolveUnit(r.id);

  const folded = new Set<string>();
  for (const r of workers) {
    if (unitOf.get(r.id) !== r.id) folded.add(r.id);
  }

  const descendants = new Map<string, string[]>();
  for (const r of workers) {
    const unit = unitOf.get(r.id) ?? r.id;
    if (unit === r.id) continue;
    const arr = descendants.get(unit) ?? [];
    arr.push(r.id);
    descendants.set(unit, arr);
  }

  return { folded, unitOf, debateUnits, descendants };
}

/** Lift an edge endpoint to its layout unit (dedupe after lifting). */
function liftEdgeEndpoints(
  source: string,
  target: string,
  unitOf: Map<string, string>,
): { source: string; target: string } | null {
  const src = unitOf.get(source) ?? source;
  const tgt = unitOf.get(target) ?? target;
  if (src === tgt) return null;
  return { source: src, target: tgt };
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
  expandedUnits: ReadonlySet<string> = new Set(),
): {
  nodeIds: string[];
  rawEdges: GraphEdge[];
  subTeams: SubTeam[];
  foldInfo: GraphFoldInfo;
} {
  const captainId = runs.find((r) => r.kind === "captain")?.id ?? null;
  const workerRuns = runs.filter((r) => r.id !== captainId);
  const workerIds = new Set(workerRuns.map((r) => r.id));
  const foldInfo = computeGraphFold(runs, captainId);
  const { folded, unitOf, descendants } = foldInfo;
  const isRevision = (r: GraphRunLike): boolean => (r.revision ?? 0) > 0;
  const isSub = (r: GraphRunLike): boolean =>
    !isRevision(r) &&
    !!r.parentRunId &&
    r.parentRunId !== r.id &&
    workerIds.has(r.parentRunId);

  const isLayoutVisible = (runId: string): boolean => {
    if (!folded.has(runId)) return true;
    const unit = unitOf.get(runId) ?? runId;
    return expandedUnits.has(unit);
  };

  const layoutWorkers = workerRuns.filter((r) => isLayoutVisible(r.id));
  const nodeIds = layoutWorkers.map((s) => s.id);
  const debate = workerRuns.some((r) => r.stance != null);
  if (debate) {
    const rank = (id: string) => {
      const st = workerRuns.find((r) => r.id === id)?.stance;
      return st === "pro" ? 0 : st === "con" ? 2 : 1;
    };
    nodeIds.sort((a, b) => rank(a) - rank(b));
  }

  const edgeKey = (e: Pick<GraphEdge, "source" | "target" | "kind">) =>
    `${e.kind ?? "dep"}:${e.source}->${e.target}`;
  const edgeSet = new Map<string, GraphEdge>();

  const addEdge = (e: GraphEdge, lift = false) => {
    const src = lift ? (unitOf.get(e.source) ?? e.source) : e.source;
    const tgt = lift ? (unitOf.get(e.target) ?? e.target) : e.target;
    if (src === tgt) return;
    if (!isLayoutVisible(src) && folded.has(src)) return;
    if (!isLayoutVisible(tgt) && folded.has(tgt)) return;
    const lifted = lift ? liftEdgeEndpoints(e.source, e.target, unitOf) : null;
    const finalSrc = lifted?.source ?? src;
    const finalTgt = lifted?.target ?? tgt;
    if (finalSrc === finalTgt) return;
    const key = edgeKey({ ...e, source: finalSrc, target: finalTgt });
    if (edgeSet.has(key)) return;
    edgeSet.set(key, { ...e, id: e.id, source: finalSrc, target: finalTgt });
  };

  for (const run of workerRuns) {
    for (const depId of run.dependsOn) {
      const collapsed =
        folded.has(run.id) && !expandedUnits.has(unitOf.get(run.id) ?? run.id);
      addEdge(
        {
          id: `${depId}->${run.id}`,
          source: depId,
          target: run.id,
          kind: "dep",
        },
        collapsed,
      );
    }
  }

  const subTeamMap = new Map<string, string[]>();
  for (const r of layoutWorkers) {
    if (!isSub(r)) continue;
    const parentId = r.parentRunId as string;
    if (!isLayoutVisible(parentId)) continue;
    const arr = subTeamMap.get(parentId) ?? [];
    arr.push(r.id);
    subTeamMap.set(parentId, arr);
    addEdge({
      id: `${parentId}=>${r.id}`,
      source: parentId,
      target: r.id,
      kind: "delegate",
    });
  }

  // Debate drill-in: when the moderator unit is expanded, one flat sub-team holds all
  // debate descendants (辩手 + 续轮 revisions) so ELK lays the full 参与者×轮次 grid.
  const modId = debateModeratorId(runs, captainId);
  if (modId && expandedUnits.has(modId)) {
    const members = (descendants.get(modId) ?? []).filter((id) => id !== modId);
    if (members.length > 0) {
      subTeamMap.set(modId, members);
    }
  }

  const subTeams: SubTeam[] = [...subTeamMap.entries()].map(
    ([parentId, memberIds]) => ({
      parentId,
      memberIds,
      groupId: `__group__${parentId}`,
    }),
  );

  const revisionsByOriginal = new Map<string, GraphRunLike[]>();
  for (const r of layoutWorkers) {
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
      addEdge({
        id: `${prev}~>${rev.id}`,
        source: prev,
        target: rev.id,
        kind: "revision",
      });
      prev = rev.id;
    }
  }

  const topWorkers = workerRuns.filter(
    (r) => unitOf.get(r.id) === r.id && !folded.has(r.id),
  );
  if (topWorkers.length > 0 && captainId) {
    const dependedOn = new Set<string>();
    for (const r of topWorkers) {
      const unit = unitOf.get(r.id) ?? r.id;
      for (const dep of r.dependsOn) dependedOn.add(unitOf.get(dep) ?? dep);
      dependedOn.add(unit);
    }
    nodeIds.push(inputId, captainId);
    for (const r of topWorkers) {
      const unit = unitOf.get(r.id) ?? r.id;
      if (r.dependsOn.length === 0) {
        addEdge({
          id: `${inputId}->${unit}`,
          source: inputId,
          target: unit,
          kind: "dep",
        });
      }
      if (!dependedOn.has(unit)) {
        addEdge({
          id: `${unit}->${captainId}`,
          source: unit,
          target: captainId,
          kind: "dep",
        });
      }
    }
  }

  return {
    nodeIds,
    rawEdges: [...edgeSet.values()],
    subTeams,
    foldInfo,
  };
}
