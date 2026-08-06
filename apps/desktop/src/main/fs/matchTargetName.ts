/**
 * Resolve a `targetName` hint against one level of directory entries under a
 * well-known root. Pure (no Electron / fs) so vitest can cover the rules.
 *
 * Rules:
 * 1. Prefer case-insensitive exact basename match
 * 2. Else unique case-insensitive "contains" match
 * 3. Among multiple matches, prefer a single directory; else ambiguous → null
 * 4. Zero matches → null
 */

export interface MatchTargetEntry {
  name: string;
  isDirectory: boolean;
}

export interface MatchTargetResult {
  name: string;
  isDirectory: boolean;
}

function pickPreferred(matches: MatchTargetEntry[]): MatchTargetResult | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return { name: matches[0].name, isDirectory: matches[0].isDirectory };
  }
  const dirs = matches.filter((e) => e.isDirectory);
  if (dirs.length === 1) {
    return { name: dirs[0].name, isDirectory: true };
  }
  return null;
}

/** Return the unique preferred entry, or null when unresolved / ambiguous. */
export function matchTargetName(
  entries: MatchTargetEntry[],
  targetName: string,
): MatchTargetResult | null {
  const needle = targetName.trim().toLowerCase();
  if (!needle) return null;

  const exact = entries.filter((e) => e.name.toLowerCase() === needle);
  if (exact.length > 0) return pickPreferred(exact);

  const contains = entries.filter((e) => e.name.toLowerCase().includes(needle));
  return pickPreferred(contains);
}
