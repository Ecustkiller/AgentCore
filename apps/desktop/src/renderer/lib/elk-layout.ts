import type { ElkGraphLayout } from "@/lib/graph-layout-utils";
import type { GraphEdge } from "@/stores/graph";
import ELK from "elkjs/lib/elk.bundled";

const elk = new ELK();

interface ElkGraphNode {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkGraphNode[];
  edges?: Array<{ id: string; sources: string[]; targets: string[] }>;
}

const NODE_WIDTH = 210;
const NODE_HEIGHT = 110;

export type NodeSizeMap = Record<string, { width: number; height: number }>;

/** 内嵌聊天气泡（fit-to-width）：偏紧，包围盒小、缩放更接近 1。 */
export const NODE_SPACING_EMBED = 40;
/** 全屏 / 画布放大态：同层 +8px，改善宽并行列可读性。 */
export const NODE_SPACING_COMFORT = 48;

export function nodeSpacingForFitMode(
  fitMode: "width" | "contain" | "view",
): number {
  return fitMode === "width" ? NODE_SPACING_EMBED : NODE_SPACING_COMFORT;
}

// 子团队 compound 内仍用 EMBED：小队（如 1→3→1 菱形）层距过大四角空、连线长。
// 注意：estimateBbox 的 nodeSpacing 参数须与 computeLayout 传入值对齐。
/**
 * Per-layout ELK options. Padding is shared and applied on top in computeLayout.
 *
 * BRANDES_KOEPF with `fixedAlignment: BALANCED` places each node at the average of
 * four alignment runs, so a binary fork (方案决策 → 产品/技术) comes out symmetric
 * around its parent — the thing NETWORK_SIMPLEX packs lopsided (one wing flush to
 * the spine, the other flung wide). Paired with `considerModelOrder` (set on the
 * root in computeLayout) for deterministic wing order, this lets ELK produce the
 * layout directly instead of a pile of hand post-passes. BK's one weakness — it
 * does NOT center a lone fan bookend (用户输入 / CEO 汇聚点) — is handled by
 * {@link centerLoneEndpoints}, the single surviving cross-axis polish.
 */
const LAYOUT_OPTIONS: Record<ElkGraphLayout, Record<string, string>> = {
  tree: {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.layered.spacing.nodeNodeBetweenLayers": "64",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  },
  leftright: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.layered.spacing.nodeNodeBetweenLayers": "80",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  },
};

function elkRootOptions(
  layout: ElkGraphLayout,
  nodeSpacing: number,
): Record<string, string> {
  return {
    ...LAYOUT_OPTIONS[layout],
    "elk.spacing.nodeNode": String(nodeSpacing),
  };
}

/**
 * Result of an ELK layout pass: node positions plus the graph's natural
 * bounding box (content + ELK padding, in graph coordinates).
 *
 * The bbox is what lets the embedded canvas size its height to each graph's real
 * footprint (方案 D fit-to-width) instead of guessing from node count — a long
 * serial chain and a wide parallel fan have very different heights at the same
 * run count.
 */
export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
  groups: GroupLayout[];
}

export interface GroupLayout {
  groupId: string;
  parentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SubTeamInput {
  parentId: string;
  memberIds: string[];
  groupId: string;
}

/**
 * The two synthetic bookend nodes (前端UX设计 §五): the lone 用户输入 source and the
 * CEO 汇聚点 sink. Passed so {@link computeLayout} can pin each to a dedicated
 * first / last ELK layer via `layerConstraint`.
 *
 * Why the sink pin matters — nested delegation (阶段2): a captain worker's leaf
 * sub-workers hang off it by a lone dashed `delegate` edge and reach nothing
 * downstream, so they tie the 汇聚点's layer (both are one hop past the parent).
 * ELK then drops the sink into the *same* column as the sub-workers instead of
 * after them. Pinning the sink to LAST_SEPARATE forces it past every worker,
 * restoring the 用户输入 → 团队波次 → 子团队 → CEO 汇聚点 reading order. Inert for a
 * flat / debate / DAG turn (the sink is already last there).
 */
export interface LayoutBookends {
  source?: string;
  sink?: string;
}

/**
 * Lay out a DAG with ELK and return positions keyed by node id plus the graph's
 * bounding box.
 *
 * Takes only the graph *shape* (ids + edges) plus the chosen {@link GraphLayout}
 * so callers recompute layout solely on structure / layout change, never on
 * per-token data updates.
 */
export async function computeLayout(
  nodeIds: string[],
  edges: GraphEdge[],
  layout: ElkGraphLayout = "tree",
  bookends: LayoutBookends = {},
  subTeams: SubTeamInput[] = [],
  nodeSpacing: number = NODE_SPACING_EMBED,
  nodeSizes: NodeSizeMap = {},
): Promise<LayoutResult> {
  if (nodeIds.length === 0)
    return { positions: {}, width: 0, height: 0, groups: [] };

  const sizeOf = (id: string): { width: number; height: number } =>
    nodeSizes[id] ?? { width: NODE_WIDTH, height: NODE_HEIGHT };

  const subTeamByParent = new Map(subTeams.map((st) => [st.parentId, st]));

  // Revision chains (原始 → v2 → v3…): a sub-team member's continuation rounds
  // (辩论/圆桌逐轮). They must share the SAME compound as their source so the box
  // wraps the whole debate matrix — otherwise ELK lays each revision out in a
  // top-level layer OUTSIDE the box, drawing a long escape edge and a phantom gap
  // instead of the tight 参与者×轮次 grid the compound gives.
  const revisionSuccessors = new Map<string, string[]>();
  const revisionSourceOf = new Map<string, string>();
  for (const e of edges) {
    if (e.kind !== "revision") continue;
    const arr = revisionSuccessors.get(e.source);
    if (arr) arr.push(e.target);
    else revisionSuccessors.set(e.source, [e.target]);
    revisionSourceOf.set(e.target, e.source);
  }
  const revisionRootOf = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (revisionSourceOf.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = revisionSourceOf.get(cur) as string;
    }
    return cur;
  };
  const revisionDescendantsOf = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    const stack = [id];
    while (stack.length > 0) {
      const n = stack.pop() as string;
      for (const t of revisionSuccessors.get(n) ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        stack.push(t);
      }
    }
    return out;
  };

  const structurallyContainsTeam = (st: SubTeamInput, id: string): boolean => {
    if (id === st.parentId) return true;
    for (const m of st.memberIds) {
      if (id === m) return true;
      const nested = subTeamByParent.get(m);
      if (nested && structurallyContainsTeam(nested, id)) return true;
    }
    return false;
  };
  // A revision belongs to whichever team owns its revision root, so its
  // continuation edges stay internal to the compound and it never escapes the box.
  const containsTeam = (st: SubTeamInput, id: string): boolean =>
    structurallyContainsTeam(st, id) ||
    structurallyContainsTeam(st, revisionRootOf(id));

  const innermostTeamForEdge = (
    source: string,
    target: string,
  ): SubTeamInput | null => {
    const candidates = subTeams.filter(
      (st) => containsTeam(st, source) && containsTeam(st, target),
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((best, st) => {
      if (best === st) return best;
      const stNestedInBest = best.memberIds.includes(st.parentId);
      const bestNestedInSt = st.memberIds.includes(best.parentId);
      if (stNestedInBest) return best;
      if (bestNestedInSt) return st;
      return best;
    });
  };

  const edgesForGroup = (st: SubTeamInput): GraphEdge[] =>
    edges.filter((e) => {
      const team = innermostTeamForEdge(e.source, e.target);
      return team?.groupId === st.groupId;
    });

  const buildGroupElkNode = (st: SubTeamInput): ElkGraphNode => {
    const parentSize = sizeOf(st.parentId);
    const groupChildren: ElkGraphNode[] = [
      { id: st.parentId, width: parentSize.width, height: parentSize.height },
    ];
    for (const rev of revisionDescendantsOf(st.parentId)) {
      const s = sizeOf(rev);
      groupChildren.push({ id: rev, width: s.width, height: s.height });
    }
    for (const memberId of st.memberIds) {
      const nested = subTeamByParent.get(memberId);
      if (nested) {
        groupChildren.push(buildGroupElkNode(nested));
      } else {
        const ms = sizeOf(memberId);
        groupChildren.push({
          id: memberId,
          width: ms.width,
          height: ms.height,
        });
        // A leaf member's continuation rounds live in the same compound; ELK sizes
        // the box around them and internal revision edges lay them out in-column.
        for (const rev of revisionDescendantsOf(memberId)) {
          const rs = sizeOf(rev);
          groupChildren.push({
            id: rev,
            width: rs.width,
            height: rs.height,
          });
        }
      }
    }
    const groupEdges = edgesForGroup(st).map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    }));
    return {
      id: st.groupId,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": layout === "leftright" ? "RIGHT" : "DOWN",
        "elk.padding": "[top=32,left=12,bottom=12,right=12]",
        "elk.spacing.nodeNode": String(NODE_SPACING_EMBED),
        "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      },
      children: groupChildren,
      edges: groupEdges,
    };
  };

  const inAnyTeam = (id: string): boolean =>
    subTeams.some((st) => containsTeam(st, id));

  // Edges fully inside a compound are emitted by buildGroupElkNode; only the
  // cross-team edges belong on the ELK root.
  const externalEdges = edges.filter(
    (e) => !innermostTeamForEdge(e.source, e.target),
  );

  const topLevelChildren: ElkGraphNode[] = [];
  for (const id of nodeIds) {
    if (inAnyTeam(id)) continue;
    const s = sizeOf(id);
    topLevelChildren.push({
      id,
      width: s.width,
      height: s.height,
      ...(id === bookends.source
        ? {
            layoutOptions: {
              "elk.layered.layering.layerConstraint": "FIRST_SEPARATE",
            },
          }
        : id === bookends.sink
          ? {
              layoutOptions: {
                "elk.layered.layering.layerConstraint": "LAST_SEPARATE",
              },
            }
          : {}),
    });
  }

  const rootTeams = subTeams.filter(
    (st) => !subTeams.some((other) => other.memberIds.includes(st.parentId)),
  );
  for (const st of rootTeams) {
    topLevelChildren.push(buildGroupElkNode(st));
  }

  const elkEdges = externalEdges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const graph = {
    id: "root",
    layoutOptions: {
      ...elkRootOptions(layout, nodeSpacing),
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      // Order nodes within a layer by model (declaration) order: gives the debate
      // 正/反 banding and the deterministic first-child-left / second-child-right
      // wing order that BK's symmetric placement alone doesn't fix.
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: topLevelChildren,
    edges: elkEdges,
  };

  const laidOut = await elk.layout(graph);

  const positions: Record<string, { x: number; y: number }> = {};
  const groups: GroupLayout[] = [];

  const extractPositions = (
    children: Array<{
      id?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      children?: typeof children;
    }>,
    offsetX: number,
    offsetY: number,
  ): void => {
    for (const child of children) {
      const cx = offsetX + (child.x ?? 0);
      const cy = offsetY + (child.y ?? 0);
      const st = subTeams.find((s) => s.groupId === child.id);
      if (st) {
        groups.push({
          groupId: st.groupId,
          parentId: st.parentId,
          x: cx,
          y: cy,
          width: child.width ?? 0,
          height: child.height ?? 0,
        });
        extractPositions(child.children ?? [], cx, cy);
      } else if (child.id) {
        positions[child.id] = { x: cx, y: cy };
      }
    }
  };

  extractPositions(laidOut.children ?? [], 0, 0);

  // ELK (BK BALANCED + considerModelOrder + INCLUDE_CHILDREN compounds) lays out
  // layers, minimizes crossings, keeps revision chains straight and boxes sub-teams
  // directly — no hand alignment/overlap/crossing passes. The one thing BK can't do
  // is center a lone fan bookend (用户输入 / CEO 汇聚点) on an even neighbor count, so
  // this single cross-axis polish pulls those onto their neighbors' midline.
  centerLoneEndpoints(positions, edges, layout);

  // Post-processing can push nodes negative on the cross axis; shift the whole
  // graph so the bbox origin stays at ELK padding (keeps promo stills / fit-to-width sane).
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const id of Object.keys(positions)) {
    minX = Math.min(minX, positions[id].x);
    minY = Math.min(minY, positions[id].y);
  }
  const normDx = minX < PADDING ? PADDING - minX : 0;
  const normDy = minY < PADDING ? PADDING - minY : 0;
  if (normDx !== 0 || normDy !== 0) {
    for (const id of Object.keys(positions)) {
      positions[id].x += normDx;
      positions[id].y += normDy;
    }
  }

  // ELK stamps the laid-out root with its total size (content + the padding set
  // above), but the post-processing above can push a sub-team past ELK's bbox, so
  // re-derive the extent from the final positions and keep whichever is larger
  // (also the fallback when a build omits the stamped size).
  let width = laidOut.width ?? 0;
  let height = laidOut.height ?? 0;
  let maxX = 0;
  let maxY = 0;
  for (const id of Object.keys(positions)) {
    const s = sizeOf(id);
    maxX = Math.max(maxX, positions[id].x + s.width);
    maxY = Math.max(maxY, positions[id].y + s.height);
  }
  width = Math.max(width, maxX + PADDING);
  height = Math.max(height, maxY + PADDING);

  const pad = 12;
  const topPad = 32;
  for (const g of groups) {
    const st = subTeams.find((s) => s.groupId === g.groupId);
    if (!st) continue;
    const teamNodes = new Set<string>([st.parentId, ...st.memberIds]);
    for (const base of [st.parentId, ...st.memberIds])
      for (const rev of revisionDescendantsOf(base)) teamNodes.add(rev);
    const memberIds = [...teamNodes];
    let minGX = Number.POSITIVE_INFINITY;
    let minGY = Number.POSITIVE_INFINITY;
    let maxGX = Number.NEGATIVE_INFINITY;
    let maxGY = Number.NEGATIVE_INFINITY;
    for (const id of memberIds) {
      if (!positions[id]) continue;
      const s = sizeOf(id);
      minGX = Math.min(minGX, positions[id].x);
      minGY = Math.min(minGY, positions[id].y);
      maxGX = Math.max(maxGX, positions[id].x + s.width);
      maxGY = Math.max(maxGY, positions[id].y + s.height);
    }
    if (minGX === Number.POSITIVE_INFINITY) continue;
    g.x = minGX - pad;
    g.y = minGY - topPad;
    g.width = maxGX - minGX + pad * 2;
    g.height = maxGY - minGY + topPad + pad;
  }

  return { positions, width, height, groups };
}

/**
 * Pull a lone fan bookend onto the cross-axis midpoint of the nodes it connects
 * to. ELK's BRANDES_KOEPF leaves a node that is the only one in its layer free
 * to sit anywhere in its neighbors' band when their count is even (the aligned
 * position is a range, not a point), so a 1→2 / 2→1 端点 (用户输入 / CEO 汇聚点)
 * can land off-center and draw asymmetric fan edges.
 *
 * Only **pure sources** (no incoming, fan-out root) and **pure sinks** (no
 * outgoing, fan-in 汇聚点) are recentered — a lone *middle* node (one in, one+
 * out) is a chain link ELK already aligns straight, so moving it would re-break
 * that. Recentering is cross-axis only (y for the left-right flow, x for the
 * tree) and stays within the neighbors' existing span, so the bbox is unchanged.
 */
function centerLoneEndpoints(
  positions: Record<string, { x: number; y: number }>,
  edges: GraphEdge[],
  layout: ElkGraphLayout,
): void {
  const ids = Object.keys(positions);
  if (ids.length === 0) return;
  const horizontal = layout === "leftright";
  // Main axis = the layer direction (x for left-right, y for tree); recentering
  // happens on the other (cross) axis.
  const crossSize = horizontal ? NODE_HEIGHT : NODE_WIDTH;
  const mainOf = (id: string) =>
    horizontal ? positions[id].x : positions[id].y;
  const crossCenterOf = (id: string) =>
    (horizontal ? positions[id].y : positions[id].x) + crossSize / 2;

  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    if (!positions[e.source] || !positions[e.target]) continue;
    push(outgoing, e.source, e.target);
    push(incoming, e.target, e.source);
  }

  // Group nodes into layers by their (rounded) main-axis coordinate.
  const layers = new Map<string, string[]>();
  for (const id of ids) push(layers, String(Math.round(mainOf(id))), id);

  for (const members of layers.values()) {
    if (members.length !== 1) continue;
    const id = members[0];
    const outs = outgoing.get(id) ?? [];
    const ins = incoming.get(id) ?? [];
    const refs =
      ins.length === 0 && outs.length > 0
        ? outs // pure source → center on its targets
        : outs.length === 0 && ins.length > 0
          ? ins // pure sink → center on its sources
          : null; // middle node → leave ELK's alignment alone
    if (!refs || refs.length === 0) continue;
    const centers = refs.map(crossCenterOf);
    const mid = (Math.min(...centers) + Math.max(...centers)) / 2;
    const cross = mid - crossSize / 2;
    positions[id] = horizontal
      ? { x: positions[id].x, y: cross }
      : { x: cross, y: positions[id].y };
  }
}

// ── Embedded canvas sizing (方案 D) ─────────────────────────────────────────
// One source of truth for the inline graph's fit-to-width height, shared by the
// precise path (GraphView, real ELK bbox) and the first-paint estimate
// (InlineTeamGraph, bbox guessed from DAG shape) so the canvas lands on the same
// height both times and does not jump from estimate → measurement.

export const EMBED_MIN_HEIGHT = 180;
export const EMBED_MAX_HEIGHT = 520;

// First-paint column-width guess for the inline graph canvas, derived from the
// chat reading column (ChatView): max-w-3xl (768) − px-6 both sides (48) − the
// team card's 1px border each side (2) = 718. Used only before the real canvas
// width is measured (ResizeObserver); it narrows when the side panel opens or
// the window is small, but fit-to-width caps zoom at 1 so the brief mismatch is
// tiny and self-corrects on the first measurement.
export const EMBED_DEFAULT_COL_WIDTH = 718;

// Spacing mirrored from elkRootOptions so the size estimate matches what ELK
// actually produces (within-layer node gap, between-layer gap, outer padding).
// MUST stay in lockstep with LAYOUT_OPTIONS + elk.padding above.
const LAYER_SPACING: Record<ElkGraphLayout, number> = {
  tree: 64,
  leftright: 80,
};
const PADDING = 24;

export interface GraphShape {
  /** Longest dependency chain in node layers, incl. the input/captain bookends
   * the real graph brackets the worker DAG with. */
  depth: number;
  /** Widest layer — the count of nodes laid out across the flow (what actually
   * drives height in the left-right default). */
  parallelism: number;
}

/**
 * Derive the worker DAG's {depth, parallelism} from run dependencies — the two
 * numbers that drive the laid-out graph's size — without running ELK, for the
 * first-paint height estimate. Mirrors {@link GraphView}'s graph build closely
 * enough for an estimate: workers only (the captain is the sink bookend), a
 * parent link counts as a dependency so a sub-team sits a layer deeper, and +2
 * layers stand in for the synthetic input root + CEO captain sink.
 */
export function workerGraphShape(
  runs: {
    id: string;
    dependsOn: string[];
    parentRunId?: string | null;
    kind?: string;
  }[],
): GraphShape {
  const workers = runs.filter((r) => r.kind !== "captain");
  if (workers.length === 0) return { depth: 1, parallelism: 1 };
  const ids = new Set(workers.map((r) => r.id));
  const byId = new Map(workers.map((r) => [r.id, r]));

  const subTeamRoots = new Set<string>();
  const subTeamMembers = new Set<string>();
  for (const w of workers) {
    if (w.parentRunId && w.parentRunId !== w.id && ids.has(w.parentRunId)) {
      subTeamMembers.add(w.id);
      subTeamRoots.add(w.parentRunId);
    }
  }
  const compoundUnit = (id: string): string => {
    for (const root of subTeamRoots) {
      if (id === root || subTeamMembers.has(id)) {
        const isMemberOfRoot = (memberId: string): boolean => {
          if (memberId === root) return true;
          const r = byId.get(memberId);
          if (!r?.parentRunId || r.parentRunId === memberId) return false;
          if (r.parentRunId === root) return true;
          return isMemberOfRoot(r.parentRunId);
        };
        if (isMemberOfRoot(id)) return `__group__${root}`;
      }
    }
    return id;
  };
  const depthCache = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depthCache.get(id);
    if (cached != null) return cached;
    if (seen.has(id)) return 1; // cycle guard (a real plan is a DAG)
    seen.add(id);
    const r = byId.get(id);
    const parents = [
      ...(r?.dependsOn ?? []),
      ...(r?.parentRunId && r.parentRunId !== id ? [r.parentRunId] : []),
    ].filter((p) => ids.has(p));
    const d =
      parents.length === 0
        ? 1
        : 1 + Math.max(...parents.map((p) => depthOf(p, seen)));
    seen.delete(id);
    depthCache.set(id, d);
    return d;
  };
  const layerCounts = new Map<number, Set<string>>();
  let maxDepth = 1;
  for (const w of workers) {
    const d = depthOf(w.id, new Set());
    maxDepth = Math.max(maxDepth, d);
    const unit = compoundUnit(w.id);
    const set = layerCounts.get(d) ?? new Set<string>();
    set.add(unit);
    layerCounts.set(d, set);
  }
  const parallelism = Math.max(
    1,
    ...[...layerCounts.values()].map((s) => s.size),
  );

  return { depth: maxDepth + 2, parallelism };
}

/**
 * Estimate the ELK bounding box for a shape + layout using the same node sizes
 * and spacing ELK uses, so the first-paint height estimate matches the real
 * measurement. In the left-right flow layers run along x and a layer's nodes
 * stack along y; the tree flow is the transpose.
 */
export function estimateBbox(
  shape: GraphShape,
  layout: ElkGraphLayout,
  nodeSpacing: number = NODE_SPACING_EMBED,
): { width: number; height: number } {
  const { depth, parallelism } = shape;
  const within = (n: number, size: number) =>
    n * size + (n - 1) * nodeSpacing + 2 * PADDING;
  const across = (n: number, size: number) =>
    n * size + (n - 1) * LAYER_SPACING[layout] + 2 * PADDING;
  if (layout === "leftright") {
    return {
      width: across(depth, NODE_WIDTH),
      height: within(parallelism, NODE_HEIGHT),
    };
  }
  return {
    width: within(parallelism, NODE_WIDTH),
    height: across(depth, NODE_HEIGHT),
  };
}

export interface FitWidthBox {
  zoom: number;
  renderedWidth: number;
  renderedHeight: number;
  height: number;
  overflowing: boolean;
}

/**
 * The embedded fit-to-width box (方案 D): zoom only shrinks when the graph is
 * wider than the column (never upscales, so node size stays consistent across
 * messages), and the box height follows the graph's real footprint at that zoom,
 * clamped to [{@link EMBED_MIN_HEIGHT}, {@link EMBED_MAX_HEIGHT}]. Both GraphView
 * (real bbox) and the InlineTeamGraph estimate (guessed bbox) compute through it.
 */
export function fitWidthBox(
  bboxWidth: number,
  bboxHeight: number,
  colWidth: number,
): FitWidthBox {
  const zoom = bboxWidth > 0 ? Math.min(1, colWidth / bboxWidth) : 1;
  const renderedWidth = bboxWidth * zoom;
  const renderedHeight = bboxHeight * zoom;
  const height = Math.min(
    EMBED_MAX_HEIGHT,
    Math.max(EMBED_MIN_HEIGHT, renderedHeight),
  );
  return {
    zoom,
    renderedWidth,
    renderedHeight,
    height,
    overflowing: renderedHeight > height + 1,
  };
}

export { NODE_WIDTH, NODE_HEIGHT };
