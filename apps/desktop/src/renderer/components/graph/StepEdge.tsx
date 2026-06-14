import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";

type StepEdgeData = Edge<{ animated: boolean }>;

// Three particles, evenly phased, ride the edge toward a running node to convey
// "data flowing downstream" (replaces the old dashed stroke, whose `dash`
// keyframe was never defined). Pure SVG `animateMotion` — no extra dependency.
const PARTICLE_BEGINS = ["0s", "0.5s", "1s"];
const PARTICLE_DUR = "1.5s";

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
    <>
      <BaseEdge
        path={edgePath}
        style={{
          ...style,
          stroke: isAnimated ? "var(--primary)" : "var(--muted-foreground)",
          strokeWidth: 2,
          opacity: isAnimated ? 1 : 0.6,
        }}
      />
      {isAnimated &&
        PARTICLE_BEGINS.map((begin) => (
          <circle key={begin} r={3} fill="var(--primary)">
            <animateMotion
              dur={PARTICLE_DUR}
              begin={begin}
              repeatCount="indefinite"
              path={edgePath}
            />
          </circle>
        ))}
    </>
  );
}
