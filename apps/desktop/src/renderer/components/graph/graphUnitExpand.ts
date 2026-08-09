/**
 * Resolve which collaboration-graph units render expanded (nested sub-teams visible).
 * Defaults to expand every non-debate unit that has folded descendants; user override
 * only applies after an explicit toggle (`touched`).
 */
export function resolveGraphExpandedUnits(opts: {
  defaults: ReadonlySet<string>;
  touched: boolean;
  /** Comma-joined unit ids the user left expanded (empty = collapsed all after touch). */
  storedFingerprint: string;
  /** Session override for non-persisted hosts; null = use defaults. */
  sessionOverride: ReadonlySet<string> | null;
  persist: boolean;
}): Set<string> {
  const { defaults, touched, storedFingerprint, sessionOverride, persist } =
    opts;
  if (!persist) {
    return new Set(sessionOverride ?? defaults);
  }
  if (!touched) return new Set(defaults);
  if (!storedFingerprint) return new Set();
  return new Set(
    storedFingerprint
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0 && id !== "__touched"),
  );
}

/** Disclosure / session key suffix marking that the user toggled expand at least once. */
export const GRAPH_UNIT_EXPAND_TOUCHED = "__touched";
