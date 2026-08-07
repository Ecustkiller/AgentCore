/**
 * Resolve a `targetName` hint against one level of directory entries under a
 * well-known root. Pure (no Electron / fs) so vitest can cover the rules.
 *
 * Rules:
 * 1. Prefer case-insensitive exact basename match
 * 2. Else unique case-insensitive "contains" match
 * 3. Among multiple matches, prefer a single directory; else ambiguous
 * 4. Zero matches → none
 */

export interface MatchTargetEntry {
  name: string;
  isDirectory: boolean;
}

export type MatchTargetResult =
  | { status: "matched"; name: string; isDirectory: boolean }
  | { status: "none" }
  | { status: "ambiguous" };

function pickPreferred(matches: MatchTargetEntry[]): MatchTargetResult {
  if (matches.length === 0) return { status: "none" };
  if (matches.length === 1) {
    return {
      status: "matched",
      name: matches[0].name,
      isDirectory: matches[0].isDirectory,
    };
  }
  const dirs = matches.filter((e) => e.isDirectory);
  if (dirs.length === 1) {
    return { status: "matched", name: dirs[0].name, isDirectory: true };
  }
  return { status: "ambiguous" };
}

/** Classify the unique preferred entry, or none / ambiguous. */
export function matchTargetName(
  entries: MatchTargetEntry[],
  targetName: string,
): MatchTargetResult {
  const needle = targetName.trim().toLowerCase();
  if (!needle) return { status: "none" };

  const exact = entries.filter((e) => e.name.toLowerCase() === needle);
  if (exact.length > 0) return pickPreferred(exact);

  const contains = entries.filter((e) => e.name.toLowerCase().includes(needle));
  return pickPreferred(contains);
}
