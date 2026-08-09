import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Edge-hugging disclosure for unit drill-in — belongs to the parent card, not
 * the connector wire. Absolute overflow only; must not enlarge ELK footprint.
 */
export function SubTeamFoldChip({
  count,
  expanded,
  horizontal,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  horizontal: boolean;
  onToggle?: () => void;
}) {
  const label = expanded ? `收起子队（${count}）` : `展开子队（${count}）`;
  // Straddle the child-facing edge, slightly off the Handle / connector mid-point.
  const position = horizontal
    ? "right-0 top-[72%] translate-x-1/2 -translate-y-1/2"
    : "bottom-0 left-[72%] translate-y-1/2 -translate-x-1/2";

  return (
    <button
      type="button"
      className={`nodrag nopan absolute z-10 flex h-5 items-center gap-px rounded-full border border-border/50 bg-card px-1 text-xs tabular-nums text-muted-foreground ring-2 ring-card transition-colors hover:border-border hover:bg-muted hover:text-foreground ${position}`}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      <span>{count}</span>
    </button>
  );
}
