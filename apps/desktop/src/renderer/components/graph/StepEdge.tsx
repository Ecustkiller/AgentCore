import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  getSmoothStepPath,
} from "@xyflow/react";

type StepEdgeData = Edge<{ animated: boolean; kind?: "dep" | "delegate" }>;

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

  // Orthogonal rounded-elbow path (mind-map / org-chart look): a horizontal stub
  // out of the node, a rounded turn, the vertical run, then a rounded turn back
  // into the target — far tidier than bezier when many branches fan in/out of a
  // left-right layout. Particles still ride this path unchanged.
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
  });

  const isAnimated = data?.animated ?? false;
  // A delegation edge (captain → nested sub-worker, 阶段2 父子分组) is dashed so
  // a sub-team reads as grouped under its parent, distinct from the solid DAG
  // dependency / bookend flow.
  const isDelegate = data?.kind === "delegate";

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          ...style,
          stroke: isAnimated ? "var(--primary)" : "var(--muted-foreground)",
          strokeWidth: 2,
          opacity: isAnimated ? 1 : isDelegate ? 0.45 : 0.6,
          strokeDasharray: isDelegate ? "5 4" : undefined,
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
