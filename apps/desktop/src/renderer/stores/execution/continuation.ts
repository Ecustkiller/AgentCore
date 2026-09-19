import { isDebateTaggedRun } from "./debate";
import type { Execution, RunNode } from "./types";

/**
 * 同人续写（非辩论）在协作图上折进现场根座位，不另开节点。
 * 辩论续轮 / 质询仍走各自的列与 beat 折叠。
 */
export function isSeatFoldedContinuation(r: {
  continuesRunId?: string | null;
  stance?: string | null;
  group?: string | null;
}): boolean {
  return r.continuesRunId != null && !isDebateTaggedRun(r);
}

/** 座位脸跟链尾：热修 / 再派后看最新一截的状态。辩论续写返回自身。 */
export function seatFaceRun<
  T extends {
    id: string;
    continuesRunId?: string | null;
    continuationIndex?: number;
    stance?: string | null;
    group?: string | null;
  },
>(run: T, all: readonly T[]): T {
  if (isSeatFoldedContinuation(run)) return run;
  const folded = all
    .filter((r) => r.continuesRunId === run.id && isSeatFoldedContinuation(r))
    .sort((a, b) => (a.continuationIndex ?? 0) - (b.continuationIndex ?? 0));
  return folded[folded.length - 1] ?? run;
}

/**
 * 非辩论同人接续链。点座位根或任一续写 run 都返回整链；辩论链返回 null
 *（那边仍走轮次横轨）。
 */
export function hotfixSeatChain(
  execution: Execution,
  runId: string,
): ContinuationChain | null {
  const chain = continuationChains(execution).find((c) =>
    c.versions.some((v) => v.run.id === runId),
  );
  if (!chain) return null;
  if (chain.versions.some((v) => isDebateTaggedRun(v.run))) return null;
  return chain;
}

/** Minimal run shape for walking `continuesRunId` to the chain root. */
export interface ContinuationLink {
  id: string;
  continuesRunId: string | null;
}

/**
 * Walk `continuesRunId` back to the original run id for this continuation chain.
 * Standalone runs (no `continuesRunId`) return themselves. Missing / cyclic links
 * stop at the last reachable id. Wire is star-shaped (always points at the root);
 * the walk also tolerates a linear chain if present.
 */
export function continuationRootId(
  runId: string,
  runs: ReadonlyArray<ContinuationLink>,
): string {
  const byId = new Map(runs.map((r) => [r.id, r]));
  let cur = runId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const r = byId.get(cur);
    if (!r?.continuesRunId || !byId.has(r.continuesRunId)) break;
    cur = r.continuesRunId;
  }
  return cur;
}

/** One version in a continuation chain: the original is `version` 1, each
 * 续写 carries its own `version` (2, 3… = continuationIndex + 1). `run` is the
 * projected node for that version. */
export interface ContinuationVersion {
  version: number;
  run: RunNode;
}

/** A worker's full continuation chain: the original plus every 续写 of it, in
 * version order (v1 first). */
export interface ContinuationChain {
  originalId: string;
  versions: ContinuationVersion[];
}

/** Whether any worker in the turn was 同人接续. */
export function hasContinuations(execution: Execution): boolean {
  return execution.runs.some((r) => r.continuesRunId != null);
}

/**
 * Group the turn's runs into continuation chains, one per continued original
 * (in first-seen original order). Each chain is the original (v1) followed by its
 * 续写 versions in ascending continuationIndex. Originals with no continuation are omitted; a stray
 * continuation whose original is absent is dropped.
 */
export function continuationChains(execution: Execution): ContinuationChain[] {
  const byRoot = new Map<string, RunNode[]>();
  for (const run of execution.runs) {
    if (run.continuesRunId == null) continue;
    const list = byRoot.get(run.continuesRunId) ?? [];
    list.push(run);
    byRoot.set(run.continuesRunId, list);
  }
  const chains: ContinuationChain[] = [];
  for (const run of execution.runs) {
    const continuations = byRoot.get(run.id);
    if (run.continuesRunId != null || !continuations) continue;
    const versions: ContinuationVersion[] = [
      { version: 1, run },
      ...continuations
        .slice()
        .sort((a, b) => a.continuationIndex - b.continuationIndex)
        .map((r) => ({
          version: r.continuationIndex + 1,
          run: r,
        })),
    ];
    chains.push({ originalId: run.id, versions });
  }
  return chains;
}
