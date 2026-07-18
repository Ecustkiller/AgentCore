/** Pure graph derivation helpers (status, handoffs, artifacts, wave lanes). */

import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/elk-layout";
import type { DebateBeat, Execution, RunStatus } from "@/stores/execution";
import {
  debateBeatFromContext,
  isDebateStatementBeat,
} from "@/stores/execution";
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

function isContinuationRun(r: GraphRunLike): boolean {
  return r.continuesRunId != null;
}

function _isSubRun(r: GraphRunLike, workerIds: Set<string>): boolean {
  return (
    !isContinuationRun(r) &&
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
      for (const depId of r.dependsOn ?? []) {
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

/**
 * Top-level worker runs that participate in lane banding (exclude captain +
 * folded nested sub-workers — those live inside a sub-team box).
 */
function laneEligibleRunIds(
  runs: GraphRunLike[],
  captainId: string | null,
  positioned: ReadonlySet<string>,
): string[] {
  const fold = computeGraphFold(runs, captainId);
  const out: string[] = [];
  for (const r of runs) {
    if (r.id === captainId) continue;
    if (!positioned.has(r.id)) continue;
    if (fold.folded.has(r.id)) continue;
    if (fold.unitOf.get(r.id) !== r.id) continue;
    out.push(r.id);
  }
  return out;
}

/**
 * Distinct delegate-batch indexes among lane-eligible workers. Empty when the
 * turn has only one ingest batch (or no stamps) — callers fall back to topo waves.
 */
export function distinctDelegateBatches(
  runs: GraphRunLike[],
  captainId: string | null,
  positioned: ReadonlySet<string>,
): number[] {
  const batches = new Set<number>();
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const id of laneEligibleRunIds(runs, captainId, positioned)) {
    batches.add(byId.get(id)?.delegateBatch ?? 1);
  }
  return [...batches].sort((a, b) => a - b);
}

function bandFromMembers(
  id: string,
  label: string,
  members: { x: number; y: number }[],
  bbox: { width: number; height: number },
  /** When true, band spans the flow axis (topo wave column/row). When false,
   * band spans the cross axis (delegate-batch strip — each 委派 is a chain that
   * already advances along the flow, so we band the sibling stacks). */
  alongFlow: boolean,
  horizontal: boolean,
): WaveBand {
  if (alongFlow === horizontal) {
    // leftright + alongFlow → vertical strip; tree + !alongFlow → vertical strip
    const x0 = Math.min(...members.map((m) => m.x));
    const x1 = Math.max(...members.map((m) => m.x + NODE_WIDTH));
    return {
      id,
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
    id,
    label,
    x: -WAVE_PAD,
    y: y0 - WAVE_PAD,
    w: bbox.width + WAVE_PAD * 2,
    h: y1 - y0 + WAVE_PAD * 2,
    labelX: -WAVE_PAD + 6,
    labelY: y0 - WAVE_PAD + 6,
  };
}

const STAGE_PAD = 16;

/**
 * 辩论阶段标签（协作图）：为每一阶段（第 N 轮 / 结辩）算一枚标签锚点。
 * 只含辩手可见列（陈词/结辩）；主持人开场不参与锚点，避免第 1 轮标签悬在主持与辩手之间。
 * 质询折进轮节点，不单独成段。无阶段填充框——仅标签。
 * 坐标同 {@link WaveBand}（flow 坐标，经 ViewportPortal 渲染）；标签锚点取辩手列顶居中。
 * 非辩论 / 无坐标 → 空数组（调用方不渲染）。
 */
export function computeDebateStageBands(
  execution: Execution,
  positions: Record<string, { x: number; y: number }>,
  _captainId: string | null,
): WaveBand[] {
  const runs = execution.runs;
  const CLOSING_ORDER = Number.MAX_SAFE_INTEGER;
  const stages = new Map<number, { label: string; ids: string[] }>();
  const ensure = (order: number, label: string) => {
    let s = stages.get(order);
    if (!s) {
      s = { label, ids: [] };
      stages.set(order, s);
    }
    return s;
  };
  for (const r of runs) {
    if (!isDebateParticipantRun(r)) continue;
    if (isDebateCrossExamRun(r)) continue; // 质询折进轮节点，不独立成段
    if (isDebateClosingRun(r)) {
      ensure(CLOSING_ORDER, "结辩").ids.push(r.id);
      continue;
    }
    const round =
      r.continuesRunId == null ? 1 : r.round && r.round > 1 ? r.round : 2;
    ensure(round, `第 ${round} 轮`).ids.push(r.id);
  }
  if (stages.size === 0) return [];

  const bands: WaveBand[] = [];
  for (const order of [...stages.keys()].sort((a, b) => a - b)) {
    const s = stages.get(order);
    if (!s) continue;
    const pts = s.ids
      .map((id) => positions[id])
      .filter((p): p is { x: number; y: number } => p != null);
    if (pts.length === 0) continue;
    const x0 = Math.min(...pts.map((p) => p.x));
    const y0 = Math.min(...pts.map((p) => p.y));
    const x1 = Math.max(...pts.map((p) => p.x + NODE_WIDTH));
    const y1 = Math.max(...pts.map((p) => p.y + NODE_HEIGHT));
    bands.push({
      id: `debate-stage-${order}`,
      label: s.label,
      x: x0 - STAGE_PAD,
      y: y0 - STAGE_PAD,
      w: x1 - x0 + STAGE_PAD * 2,
      h: y1 - y0 + STAGE_PAD * 2,
      labelX: (x0 + x1) / 2,
      labelY: y0 - STAGE_PAD,
    });
  }
  return bands;
}

/**
 * Wave / batch lanes behind the collaboration graph.
 *
 * Prefer「第 N 次委派」when the turn merged ≥2 same-execution `run_plan`s whose
 * top-level workers are visible — topo waves would otherwise group roots from
 * *different* delegates into one「批次」column and erase the追加 narrative.
 * Otherwise keep the WaveScheduler topo bands（批次 N）.
 */
export function computeWaves(
  execution: Execution,
  positions: Record<string, { x: number; y: number }>,
  bbox: { width: number; height: number },
  layoutKind: GraphLayout,
  captainId: string | null,
): WaveBand[] {
  const horizontal = layoutKind === "leftright";
  const positioned = new Set(Object.keys(positions));
  const byId = new Map(execution.runs.map((r) => [r.id, r]));
  const delegateKeys = distinctDelegateBatches(
    execution.runs,
    captainId,
    positioned,
  );

  if (delegateKeys.length >= 2) {
    const bands: WaveBand[] = [];
    for (let i = 0; i < delegateKeys.length; i++) {
      const batchKey = delegateKeys[i];
      const runIds = laneEligibleRunIds(
        execution.runs,
        captainId,
        positioned,
      ).filter((id) => (byId.get(id)?.delegateBatch ?? 1) === batchKey);
      const members = runIds
        .map((id) => positions[id])
        .filter((p): p is { x: number; y: number } => p != null);
      if (members.length === 0) continue;
      bands.push(
        bandFromMembers(
          `delegate-${batchKey}`,
          `第 ${i + 1} 次委派（${runIds.length} 节点）`,
          members,
          bbox,
          false,
          horizontal,
        ),
      );
    }
    return bands.length >= 2 ? bands : [];
  }

  const waveByRun = computeTopologicalRunWaves(execution.runs, captainId);
  const groups = new Map<number, string[]>();
  for (const id of laneEligibleRunIds(execution.runs, captainId, positioned)) {
    const wave = waveByRun.get(id);
    if (wave === undefined) continue;
    const arr = groups.get(wave);
    if (arr) arr.push(id);
    else groups.set(wave, [id]);
  }

  const keys = [...groups.keys()].sort((a, b) => a - b);
  if (keys.length < 2) return [];

  return keys.map((waveKey, i) => {
    const runIds = groups.get(waveKey) as string[];
    const members = runIds
      .map((id) => positions[id])
      .filter((p): p is { x: number; y: number } => p != null);
    const count = runIds.length;
    return bandFromMembers(
      `wave-${i}`,
      `批次 ${i + 1}（${count} 节点）`,
      members,
      bbox,
      true,
      horizontal,
    );
  });
}

export interface GraphRunLike {
  id: string;
  dependsOn: string[];
  parentRunId?: string | null;
  continuationIndex?: number;
  continuesRunId?: string | null;
  replacesRunId?: string | null;
  stance?: string | null;
  group?: string | null;
  round?: number;
  kind?: string;
  /** 同回合第几次 delegate 追加（呈现层；测试可省略 → 视为单批）。 */
  delegateBatch?: number;
  /** 辩论 continue_run 的 `run_context`（读 channel 得 beat）；测试可省略。 */
  receivedContext?: ReadonlyArray<{ channel: string }> | null;
  status?: RunStatus;
  durationMs?: number | null;
}

const DEBATE_GROUP_PREFIX = "debate:";

/** Display-only signal that a run is a debate participant (辩手 / 续轮 revision). */
export function isDebateParticipantRun(r: GraphRunLike): boolean {
  return (
    r.stance != null || (r.group?.startsWith(DEBATE_GROUP_PREFIX) ?? false)
  );
}

/** 协作图可见列用的 beat：质询折进同轮陈词，结辩仍独立。与 arena 分桶共用 {@link debateBeatFromContext}。 */
export function graphDebateBeat(r: GraphRunLike): DebateBeat {
  return debateBeatFromContext(r.receivedContext);
}

/** 陈词宿主 / 发言列：与 {@link isDebateStatementBeat} 同口径。 */
export function isDebateStatementRun(r: GraphRunLike): boolean {
  return isDebateParticipantRun(r) && isDebateStatementBeat(r.receivedContext);
}

/** 质询作答：同辩手同轮的 continue_run，协作图不独立成列。 */
export function isDebateCrossExamRun(r: GraphRunLike): boolean {
  return isDebateParticipantRun(r) && graphDebateBeat(r) === "cross_exam";
}

/** 结辩：独立列 +「结辩」角标。 */
export function isDebateClosingRun(r: GraphRunLike): boolean {
  return isDebateParticipantRun(r) && graphDebateBeat(r) === "closing";
}

/**
 * 同辩手同轮的陈词宿主：质询折进此节点。首轮与续轮陈词均算陈词。
 */
export function debateStatementHostId(
  cx: GraphRunLike,
  runs: GraphRunLike[],
  workerIds?: Set<string>,
): string | null {
  if (!isDebateCrossExamRun(cx)) return null;
  const ids = workerIds ?? new Set(runs.map((r) => r.id));
  const byId = new Map(runs.map((r) => [r.id, r]));
  const root = continuationRootId(cx.id, byId, ids);
  const round = cx.round ?? 0;
  for (const r of runs) {
    if (!ids.has(r.id)) continue;
    if (continuationRootId(r.id, byId, ids) !== root) continue;
    if ((r.round ?? 0) !== round) continue;
    if (isDebateCrossExamRun(r) || isDebateClosingRun(r)) continue;
    return r.id;
  }
  return null;
}

/** 运行中 / 失败优先于完成（轮节点聚合质询后的可见状态）。 */
export function aggregateDebateRoundStatus(
  statuses: readonly RunStatus[],
): RunStatus {
  if (statuses.length === 0) return "pending";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.some((s) => s === "cancelled")) return "cancelled";
  if (statuses.every((s) => s === "completed")) return "completed";
  if (statuses.every((s) => s === "skipped")) return "skipped";
  return "pending";
}

/** 轮内活跃 beat：质询在跑 / 待答 → cross_exam；否则立论。 */
export function debateRoundActiveBeat(
  statementStatus: RunStatus,
  cxStatuses: readonly RunStatus[],
): "statement" | "cross_exam" {
  if (cxStatuses.some((s) => s === "running")) {
    return "cross_exam";
  }
  if (
    (statementStatus === "completed" || statementStatus === "cancelled") &&
    cxStatuses.some((s) => s === "pending")
  ) {
    return "cross_exam";
  }
  return "statement";
}

/** 直播态轮节点状态条文案后缀（立论中 / 质询作答中）。 */
export function debateRoundPhaseLabel(
  aggregated: RunStatus,
  activeBeat: "statement" | "cross_exam",
  hasCrossExam: boolean,
): string | null {
  if (!hasCrossExam || aggregated !== "running") return null;
  return activeBeat === "cross_exam" ? "质询作答中" : "立论中";
}

/**
 * 收场态轮节点质询标记：完成「含质询」后缀，或质询失败时整行归因「质询作答失败」。
 * 立论失败（质询未败）不挂标记，沿用默认「失败」。
 */
export type DebateCrossExamMark = {
  label: string;
  mode: "suffix" | "replace";
};

export function debateRoundSettledMark(
  aggregated: RunStatus,
  hasCrossExam: boolean,
  cxStatuses: readonly RunStatus[],
): DebateCrossExamMark | null {
  if (!hasCrossExam) return null;
  if (aggregated === "failed" && cxStatuses.some((s) => s === "failed")) {
    return { label: "质询作答失败", mode: "replace" };
  }
  if (aggregated === "completed") {
    return { label: "含质询", mode: "suffix" };
  }
  return null;
}

/**
 * 质询直达 runId：活跃 running > 失败 > 最新。
 * 与直播 faceRun / activateId 选取同构，供收场「含质询」点击入口。
 */
export function pickDebateCrossExamActivateId(
  cxRuns: ReadonlyArray<{ id: string; status: RunStatus }>,
): string | null {
  if (cxRuns.length === 0) return null;
  const active = cxRuns.find((r) => r.status === "running");
  if (active) return active.id;
  for (let i = cxRuns.length - 1; i >= 0; i--) {
    if (cxRuns[i].status === "failed") return cxRuns[i].id;
  }
  return cxRuns[cxRuns.length - 1].id;
}

function continuationRootId(
  runId: string,
  runById: Map<string, GraphRunLike>,
  workerIds: Set<string>,
): string {
  let cur = runId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const r = runById.get(cur);
    if (!r?.continuesRunId || !workerIds.has(r.continuesRunId)) break;
    cur = r.continuesRunId;
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
    const root = continuationRootId(r.id, runById, workerIds);
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
  if (r.continuesRunId && workerIds.has(r.continuesRunId)) {
    const root = runById.get(continuationRootId(r.id, runById, workerIds));
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
  /** Debate moderator unit roots — always layout-expanded (参与者×轮次 grid). */
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

    if (r.continuesRunId && workerIds.has(r.continuesRunId)) {
      if (modId && belongsToDebateUnit(r, modId, runById, workerIds)) {
        unitOf.set(runId, modId);
        return modId;
      }
      // Non-debate continuations stay individually visible (continuation chain on the graph).
      unitOf.set(runId, runId);
      return runId;
    }

    if (
      !r.continuesRunId &&
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

/** Build ELK node ids + graph edges from projected runs (plan + continuations). */
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
  const { folded, unitOf, descendants, debateUnits } = foldInfo;
  const isContinuation = (r: GraphRunLike): boolean => r.continuesRunId != null;
  const isSub = (r: GraphRunLike): boolean =>
    !isContinuation(r) &&
    !!r.parentRunId &&
    r.parentRunId !== r.id &&
    workerIds.has(r.parentRunId);

  /** 质询作答不进协作图列（折进同轮陈词）；结辩仍可见。 */
  const beatHidden = new Set(
    workerRuns.filter(isDebateCrossExamRun).map((r) => r.id),
  );

  /** Debate units are always expanded; other units follow user toggle. */
  const isUnitExpanded = (unit: string): boolean =>
    debateUnits.has(unit) || expandedUnits.has(unit);

  const isLayoutVisible = (runId: string): boolean => {
    if (beatHidden.has(runId)) return false;
    if (!folded.has(runId)) return true;
    const unit = unitOf.get(runId) ?? runId;
    return isUnitExpanded(unit);
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
    if (beatHidden.has(src) || beatHidden.has(tgt)) return;
    if (!isLayoutVisible(src) && folded.has(src)) return;
    if (!isLayoutVisible(tgt) && folded.has(tgt)) return;
    const lifted = lift ? liftEdgeEndpoints(e.source, e.target, unitOf) : null;
    const finalSrc = lifted?.source ?? src;
    const finalTgt = lifted?.target ?? tgt;
    if (finalSrc === finalTgt) return;
    if (beatHidden.has(finalSrc) || beatHidden.has(finalTgt)) return;
    const key = edgeKey({ ...e, source: finalSrc, target: finalTgt });
    if (edgeSet.has(key)) return;
    edgeSet.set(key, { ...e, id: e.id, source: finalSrc, target: finalTgt });
  };

  for (const run of workerRuns) {
    if (beatHidden.has(run.id)) continue;
    for (const depId of run.dependsOn) {
      const collapsed =
        folded.has(run.id) && !isUnitExpanded(unitOf.get(run.id) ?? run.id);
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

  // Debate units are always expanded: one flat sub-team holds visible debate
  // descendants (辩手 + 轮次陈词 + 结辩；质询已折进轮节点) so ELK lays 参与者×轮次.
  const modId = debateModeratorId(runs, captainId);
  if (modId) {
    const members = (descendants.get(modId) ?? []).filter(
      (id) => id !== modId && !beatHidden.has(id),
    );
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

  // 接续链只连可见节点（轮→轮→结辩），跳过已折进的质询，避免悬空边 / phantom 列。
  // 星型 continuesRunId 铺成链（历史教训：勿照星型画平行边）。
  const continuationsByOriginal = new Map<string, GraphRunLike[]>();
  for (const r of layoutWorkers) {
    if (
      isContinuation(r) &&
      r.continuesRunId &&
      workerIds.has(r.continuesRunId)
    ) {
      const list = continuationsByOriginal.get(r.continuesRunId) ?? [];
      list.push(r);
      continuationsByOriginal.set(r.continuesRunId, list);
    }
  }
  for (const [originalId, continuations] of continuationsByOriginal) {
    if (beatHidden.has(originalId) || !isLayoutVisible(originalId)) continue;
    const ordered = continuations
      .slice()
      .sort((a, b) => (a.continuationIndex ?? 0) - (b.continuationIndex ?? 0));
    let prev = originalId;
    for (const cont of ordered) {
      addEdge({
        id: `${prev}~>${cont.id}`,
        source: prev,
        target: cont.id,
        kind: "continuation",
      });
      prev = cont.id;
    }
  }

  // 回落换人：replaces_run_id → new worker「接替」边（与接续链正交）。
  for (const r of layoutWorkers) {
    const from = r.replacesRunId;
    if (!from || !workerIds.has(from) || !isLayoutVisible(r.id)) continue;
    addEdge({
      id: `${from}=>handoff=>${r.id}`,
      source: from,
      target: r.id,
      kind: "handoff",
    });
  }

  const topWorkers = workerRuns.filter(
    (r) => unitOf.get(r.id) === r.id && !folded.has(r.id),
  );
  if (topWorkers.length > 0 && captainId) {
    // Units that another top-level worker depends on (i.e. have a downstream
    // peer). Leaves = not in this set → bookend edge into the CEO sink.
    const dependedOn = new Set<string>();
    for (const r of topWorkers) {
      for (const dep of r.dependsOn) dependedOn.add(unitOf.get(dep) ?? dep);
    }
    // 补派/接手：被 replaces_run_id 指向的失败节点不再作 CEO 汇入；补派节点本身
    // 也不是从用户输入扇出的新根（depends_on=[] 时勿画 input→补派）。
    const replacedUnits = new Set<string>();
    for (const r of topWorkers) {
      const from = r.replacesRunId;
      if (!from) continue;
      replacedUnits.add(unitOf.get(from) ?? from);
    }
    nodeIds.push(inputId, captainId);
    for (const r of topWorkers) {
      const unit = unitOf.get(r.id) ?? r.id;
      if (r.dependsOn.length === 0 && !r.replacesRunId) {
        addEdge({
          id: `${inputId}->${unit}`,
          source: inputId,
          target: unit,
          kind: "dep",
        });
      }
      if (!dependedOn.has(unit) && !replacedUnits.has(unit)) {
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
