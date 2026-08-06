import {
  type DetailTab,
  MAX_TABS,
  type SidePanelFloat,
  WORKSPACE_TAB_ID,
} from "./types";

/** After the last closable detail tab closes → 工作区. */
export function homeTabAfterDetailClose(): string {
  return WORKSPACE_TAB_ID;
}

export function floatingIdSet(floats: readonly SidePanelFloat[]): Set<string> {
  return new Set(floats.map((f) => f.tabId));
}

export function maxFloatZ(floats: readonly SidePanelFloat[]): number {
  return floats.reduce((m, f) => Math.max(m, f.layout.zIndex), 0);
}

export function withFloatFocused(
  floats: SidePanelFloat[],
  tabId: string,
): SidePanelFloat[] {
  const z = maxFloatZ(floats) + 1;
  return floats.map((f) =>
    f.tabId === tabId ? { ...f, layout: { ...f.layout, zIndex: z } } : f,
  );
}

/** Drop oldest *docked* closable tabs until ≤ MAX_TABS; never evict floating ones. */
export function capTabsProtectingFloats(
  tabs: DetailTab[],
  floatingIds: ReadonlySet<string>,
): DetailTab[] {
  if (tabs.length <= MAX_TABS) return tabs;
  const next = [...tabs];
  while (next.length > MAX_TABS) {
    const idx = next.findIndex((t) => !floatingIds.has(t.id));
    if (idx === -1) break;
    next.splice(idx, 1);
  }
  return next;
}

export function browserStillInDock(tabs: readonly DetailTab[]): boolean {
  return tabs.some((t) => t.kind === "browser");
}
