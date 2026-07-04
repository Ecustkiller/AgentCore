import { ViewportPortal } from "@xyflow/react";

export interface TimeBatchDivider {
  x: number;
  label: string;
}

/** Vertical separators between scheduler segments in timeline layout mode. */
export function TimeBatchMarkers({
  dividers,
  height,
}: {
  dividers: TimeBatchDivider[];
  height: number;
}) {
  if (dividers.length === 0) return null;
  return (
    <ViewportPortal>
      {dividers.map((d) => (
        <div key={`${d.x}-${d.label}`}>
          <div
            className="border-l border-dashed border-border/60"
            style={{
              position: "absolute",
              transform: `translate(${d.x}px, 0px)`,
              height,
              top: 0,
              zIndex: -1,
              pointerEvents: "none",
            }}
          />
          {d.label && (
            <div
              className="rounded-full bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground"
              style={{
                position: "absolute",
                transform: `translate(${d.x + 6}px, 8px)`,
                zIndex: 1,
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              {d.label}
            </div>
          )}
        </div>
      ))}
    </ViewportPortal>
  );
}
