/**
 * Definition-canvas node views for user workflows.
 * Intentionally separate from collaboration-graph `components/graph/*`.
 */

import { cn } from "@/lib/utils";
import {
  type WorkflowNodeKind,
  splitSlotPlaceholders,
} from "@/services/workflowDefinition";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { Hand, UserRound } from "lucide-react";

export type WorkflowCanvasNodeData = {
  kind: WorkflowNodeKind;
  title: string;
  subtitle?: string;
  /** 槽位 key → 名称：任务里的 `{{key}}` 画成参数名，别让用户读到一串花括号。 */
  slotLabels?: Record<string, string>;
  selected?: boolean;
};

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, "workflowNode">;

/** `Object.hasOwn`：`{{toString}}` 这类 key 直接索引会取到原型链上的函数。 */
function slotLabel(
  labels: Record<string, string> | undefined,
  key: string,
): string {
  return labels && Object.hasOwn(labels, key) ? labels[key] : key;
}

function NodeSubtitle({
  text,
  slotLabels,
}: {
  text: string;
  slotLabels?: Record<string, string>;
}) {
  return (
    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
      {splitSlotPlaceholders(text).map((seg) =>
        seg.kind === "text" ? (
          <span key={seg.start}>{seg.text}</span>
        ) : (
          <span
            key={seg.start}
            className="rounded-lg bg-primary/10 px-1 text-primary"
          >
            {slotLabel(slotLabels, seg.key)}
          </span>
        ),
      )}
    </p>
  );
}

function WorkflowNodeView({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const isGate = data.kind === "human_gate";
  return (
    <div
      className={cn(
        "min-w-[180px] max-w-[240px] rounded-xl border bg-card px-3 py-2.5 shadow-sm",
        selected ? "border-primary ring-1 ring-ring" : "border-border",
        isGate && "border-dashed",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-border !bg-muted-foreground"
      />
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg",
            isGate
              ? "bg-warning/15 text-warning"
              : "bg-primary/10 text-primary",
          )}
        >
          {isGate ? <Hand size={14} /> : <UserRound size={14} />}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {data.title || (isGate ? "等人关卡" : "队员步骤")}
          </p>
          {data.subtitle ? (
            <NodeSubtitle text={data.subtitle} slotLabels={data.slotLabels} />
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isGate ? "步骤后等人确认" : "角色 · 任务"}
            </p>
          )}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-border !bg-muted-foreground"
      />
    </div>
  );
}

export const workflowNodeTypes = {
  workflowNode: WorkflowNodeView,
};
