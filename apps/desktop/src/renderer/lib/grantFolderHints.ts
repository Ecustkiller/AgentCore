import type { GrantSessionWellKnown } from "@shared/ipc-contract";

/** Optional hints forwarded to `fs:grantSessionReadonlyRoot`. */
export type GrantFolderHints = {
  wellKnown?: GrantSessionWellKnown;
  targetName?: string;
};

const WELL_KNOWN = new Set<GrantSessionWellKnown>([
  "desktop",
  "downloads",
  "documents",
]);

/**
 * Map AskOption wire fields (`well_known` / `target_name`) to IPC camelCase hints.
 * Returns undefined when neither hint is present (legacy blank-picker path).
 */
export function grantHintsFromAskOption(opt: {
  well_known?: string;
  target_name?: string;
}): GrantFolderHints | undefined {
  const wellKnown = WELL_KNOWN.has(opt.well_known as GrantSessionWellKnown)
    ? (opt.well_known as GrantSessionWellKnown)
    : undefined;
  const trimmed =
    typeof opt.target_name === "string" ? opt.target_name.trim() : "";
  const targetName = trimmed || undefined;
  if (!wellKnown && !targetName) return undefined;
  return {
    ...(wellKnown ? { wellKnown } : {}),
    ...(targetName ? { targetName } : {}),
  };
}
