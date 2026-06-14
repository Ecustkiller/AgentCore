import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";

type StepEdgeData = Edge<{ animated: boolean }>;

export function StepEdge(props: EdgeProps<StepEdgeData>) {
  const {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    data,
  } = props;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const isAnimated = data?.animated ?? false;

  return (
    <BaseEdge
      path={edgePath}
      style={{
        ...style,
        stroke: isAnimated
          ? "var(--primary)"
          : "var(--muted-foreground)",
        strokeWidth: 2,
        strokeDasharray: isAnimated ? "5 5" : undefined,
        animation: isAnimated ? "dash 1.5s linear infinite" : undefined,
      }}
    />
  );
}
