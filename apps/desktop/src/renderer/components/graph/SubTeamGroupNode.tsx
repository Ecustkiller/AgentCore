import { Handle, type NodeProps, Position } from "@xyflow/react";

interface SubTeamGroupData {
  parentRole: string;
  memberCount: number;
  handleDirection: "horizontal" | "vertical";
  [key: string]: unknown;
}

export function SubTeamGroupNode({ data }: NodeProps) {
  const d = data as SubTeamGroupData;
  const horizontal = d.handleDirection === "horizontal";

  return (
    <div className="h-full w-full rounded-xl border border-dashed border-muted-foreground/25 bg-muted/5">
      <div className="px-2.5 py-1 text-xs font-medium text-muted-foreground/60">
        {d.parentRole} 子队 · {d.memberCount} 人
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
