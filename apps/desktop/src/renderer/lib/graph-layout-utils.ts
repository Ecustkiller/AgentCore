import type { GraphLayout } from "@/stores/graph";

/** Dependency layouts only — timeline uses {@link computeTimeLayout}. */
export type ElkGraphLayout = Exclude<GraphLayout, "timeline">;

/** Pick the layout algorithm GraphView should actually run. */
export function resolveEffectiveGraphLayout(
  layoutKind: GraphLayout,
  opts: { embedded?: boolean; parallelAvailable?: boolean },
): GraphLayout {
  if (opts.embedded && layoutKind === "timeline") return "leftright";
  if (layoutKind === "timeline" && !opts.parallelAvailable) return "leftright";
  return layoutKind;
}

export function isTimelineLayout(layout: GraphLayout): boolean {
  return layout === "timeline";
}
