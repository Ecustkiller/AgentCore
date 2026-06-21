import { formatCompact } from "@/lib/format";
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
} from "@xyflow/react";

/**
 * Real information handoff carried on a dependency edge (前端UX设计.md §五 信息流边):
 * HOW the upstream teammate's product actually reached this run, read from the target
 * run's `receivedContext` dependency block (resolved by `source_run_id` in GraphView).
 * Turns a bare scheduling arrow into "X 把它的产物（全文/摘要/指针）交给了 Y" — and flags
 * when that product was `truncated` on the way. Null on bookend / delegate / revision
 * edges (no teammate-to-teammate dependency block).
 */
export interface EdgeHandoff {
  fidelity: "" | "pointer" | "summarize" | "pass_through";
  truncated: boolean;
  sourceRole: string;
  chars: number;
}

type StepEdgeData = Edge<{
  animated: boolean;
  kind?: "dep" | "delegate" | "revision";
  handoff?: EdgeHandoff | null;
}>;

/** Fidelity → short edge-label text (only the lossy ones get a label; 全文 stays clean). */
const FIDELITY_SHORT: Record<string, string> = {
  pointer: "指针",
  summarize: "摘要",
};

/** Fidelity → full hover description (native title). */
const FIDELITY_FULL: Record<string, string> = {
  pointer: "递指针（仅给了引用 / 产物清单）",
  summarize: "摘要（压缩后的版本）",
  pass_through: "全文（完整产物）",
};

function handoffTitle(h: EdgeHandoff): string {
  const parts: string[] = [];
  if (h.sourceRole) parts.push(`来自 ${h.sourceRole}`);
  const full = h.fidelity ? FIDELITY_FULL[h.fidelity] : null;
  if (full) parts.push(full);
  if (h.chars > 0) parts.push(`${formatCompact(h.chars)} 字`);
  if (h.truncated) parts.push("已截断");
  return parts.join(" · ");
}

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
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
  });

  const isAnimated = data?.animated ?? false;
  // 信息流边 (1A): surface a small label only on a LOSSY handoff — a summarized /
  // pointer-only product, or one truncated on the way. A 全文 (pass_through) handoff
  // stays a clean line (the common, ideal case), so labels mark exactly where a
  // teammate worked from less than the full product.
  const handoff = data?.handoff ?? null;
  const fidelityShort = handoff?.fidelity
    ? FIDELITY_SHORT[handoff.fidelity]
    : null;
  const showLabel = !!handoff && (!!fidelityShort || handoff.truncated);
  // A delegation edge (captain → nested sub-worker, 阶段2 父子分组) is dashed so
  // a sub-team reads as grouped under its parent, distinct from the solid DAG
  // dependency / bookend flow.
  const isDelegate = data?.kind === "delegate";
  // A revision edge (original → its「修订 vN」续写, 乙 热修 P4) is dotted so a re-do
  // reads as a version of the same node, distinct from both the solid DAG flow and
  // the dashed delegation grouping.
  const isRevision = data?.kind === "revision";

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          ...style,
          stroke: isAnimated ? "var(--primary)" : "var(--muted-foreground)",
          strokeWidth: 2,
          opacity: isAnimated ? 1 : isDelegate || isRevision ? 0.45 : 0.6,
          strokeDasharray: isRevision ? "2 4" : isDelegate ? "5 4" : undefined,
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
      {showLabel && handoff && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-xs shadow-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={handoffTitle(handoff)}
          >
            {fidelityShort && (
              <span className="text-muted-foreground">{fidelityShort}</span>
            )}
            {handoff.truncated && (
              <span className="font-medium text-warning">截断</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
