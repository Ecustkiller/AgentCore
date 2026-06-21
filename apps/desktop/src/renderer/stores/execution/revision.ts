import type { Execution, RunNode } from "./types";

/** One version in a revision chain (乙 热修 P4): the original is `version` 1, each
 * 续写 carries its own `version` (2, 3…). `run` is the projected node for that
 * version, so the compare card reads its output / status / role straight off it. */
export interface RevisionVersion {
  version: number;
  run: RunNode;
}

/** A revised worker's full version chain (乙 热修 P4): the original plus every
 *「修订 vN」续写 of it, in version order (v1 first). */
export interface RevisionChain {
  originalId: string;
  versions: RevisionVersion[];
}

/** Whether any worker in the turn was 定向唤回 revised — the single signal that
 * gates the「版本对比」card + the graph's revision styling (mirrors {@link isDebate}
 * for debates). */
export function hasRevisions(execution: Execution): boolean {
  return execution.runs.some((r) => r.revisionOf != null);
}

/**
 * Group the turn's runs into revision chains (乙 热修 P4), one per revised original
 * (in first-seen original order). Each chain is the original (v1) followed by its
 * 续写 versions in ascending version order — the projection the「版本对比」card lays
 * out side by side. Originals with no revision are omitted (a chain needs ≥2
 * versions to compare); a stray revision whose original is absent is dropped.
 */
export function revisionChains(execution: Execution): RevisionChain[] {
  const revisionsByOriginal = new Map<string, RunNode[]>();
  for (const run of execution.runs) {
    if (run.revisionOf == null) continue;
    const list = revisionsByOriginal.get(run.revisionOf) ?? [];
    list.push(run);
    revisionsByOriginal.set(run.revisionOf, list);
  }
  const chains: RevisionChain[] = [];
  for (const run of execution.runs) {
    const revisions = revisionsByOriginal.get(run.id);
    // Iterate originals (revisionOf == null) so each chain is built once, in
    // graph order; a revision node itself is skipped here.
    if (run.revisionOf != null || !revisions) continue;
    const versions: RevisionVersion[] = [
      { version: 1, run },
      ...revisions
        .slice()
        .sort((a, b) => a.revision - b.revision)
        .map((r) => ({ version: r.revision, run: r })),
    ];
    chains.push({ originalId: run.id, versions });
  }
  return chains;
}
