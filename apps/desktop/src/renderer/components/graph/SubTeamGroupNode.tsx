import { Handle, type NodeProps, Position } from "@xyflow/react";
import { graphNodeDimClass, useGraphNodeDimmed } from "./graphHover";

interface SubTeamGroupData {
  parentRole: string;
  memberCount: number;
  handleDirection: "horizontal" | "vertical";
  variant?: "debate";
  [key: string]: unknown;
}

export function SubTeamGroupNode({ data }: NodeProps) {
  const d = data as SubTeamGroupData;
  const horizontal = d.handleDirection === "horizontal";
  const dimmed = useGraphNodeDimmed();
  const label =
    d.variant === "debate"
      ? `辩论 · ${d.memberCount} 辩手 run`
      : `${d.parentRole} 子队 · ${d.memberCount} 人`;

  const boxClass =
    d.variant === "debate"
      ? "border-dashed border-primary/40"
      : "border-dashed border-muted-foreground/40 bg-muted/20";
  const labelClass =
    d.variant === "debate" ? "text-primary/80" : "text-muted-foreground";

  return (
    <div
      className={`h-full w-full rounded-xl border ${boxClass} ${graphNodeDimClass(dimmed)}`}
    >
      <div className={`px-2.5 py-1 text-xs font-medium ${labelClass}`}>
        {label}
      </div>
      <Handle
        type="target"
        position={horizontal ? Position.Left : Position.Top}
        className="!bg-transparent"
      />
      <Handle
        type="source"
        position={horizontal ? Position.Right : Position.Bottom}
        className="!bg-transparent"
      />
    </div>
  );
}
