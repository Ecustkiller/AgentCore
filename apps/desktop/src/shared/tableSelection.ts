/** Matches server `agentcore.table.constants.SELECTION_MAX`. Over-budget lists are truncated, not 422. */
export const TABLE_SELECTION_MAX = 40;

export function capTableSelection(
  ids: readonly string[] | undefined | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids ?? []) {
    const sid = String(raw).trim();
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    out.push(sid);
    if (out.length >= TABLE_SELECTION_MAX) break;
  }
  return out;
}

export function tableSelectionPayload(
  ids: readonly string[] | undefined | null,
): { tableSelection: string[] } | Record<string, never> {
  const tableSelection = capTableSelection(ids);
  return tableSelection.length > 0 ? { tableSelection } : {};
}
