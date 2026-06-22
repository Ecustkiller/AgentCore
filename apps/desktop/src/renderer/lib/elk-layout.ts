import type { GraphEdge, GraphLayout } from "@/stores/graph";
import ELK from "elkjs/lib/elk.bundled";

const elk = new ELK();

const NODE_WIDTH = 210;
const NODE_HEIGHT = 110;

/**
 * Per-layout ELK options. Padding is shared and applied on top in computeLayout.
 *
 * NETWORK_SIMPLEX node placement centers a lone source/sink node on its branch
 * midline, so a 1→N fan-out (用户输入) and an N→1 fan-in (CEO 汇聚点) stay
 * symmetric. The ELK default (BRANDES_KOEPF) packs the lone node onto the topmost
 * branch instead — that is why the input endpoint used to sit above center.
 */
// 间距偏紧：小队（如 1→3→1 的菱形）下层间距/堆叠距过大会让四角空旷、连线过长。
// 收紧后包围盒变小，内嵌 fit-to-width 缩放更接近 1（节点反而更大、连线更短）。
// 注意：下方「首屏估算」镜像常量必须与这里逐一对齐。
const LAYOUT_OPTIONS: Record<GraphLayout, Record<string, string>> = {
  tree: {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.spacing.nodeNode": "40",
    "elk.layered.spacing.nodeNodeBetweenLayers": "64",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  },
  leftright: {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.spacing.nodeNode": "40",
    "elk.layered.spacing.nodeNodeBetweenLayers": "80",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  },
};

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
  layout: GraphLayout = "tree",
  preserveOrder = false,
  bookends: LayoutBookends = {},
): Promise<LayoutResult> {
  if (nodeIds.length === 0) return { positions: {}, width: 0, height: 0 };

  const graph = {
    id: "root",
    layoutOptions: {
      ...LAYOUT_OPTIONS[layout],
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      // 辩论/审查 分列对置 (前端UX设计.md §四): bias ELK toward the caller's node
      // order within a layer so a正→反 sorted batch bands by side (正方 above,
      // 反方 below) instead of being freely reordered by crossing-minimization.
      // Only requested for a debate; an unknown value is ignored by ELK, so the
      // default (non-debate) layout is untouched.
      ...(preserveOrder
        ? { "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES" }
        : {}),
    },
    children: nodeIds.map((id) => ({
      id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      // Pin the bookends to dedicated first / last layers so the 汇聚点 always
      // sits past every worker — incl. a nested sub-team's leaf sub-workers that
      // would otherwise tie its layer (see {@link LayoutBookends}).
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
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const laidOut = await elk.layout(graph);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const child of laidOut.children ?? []) {
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  }

  // 二叉分叉对称：ELK 在同层双子女（如 方案决策→产品设计/技术架构）上常把一侧贴
  // 中轴、另一侧甩远；在子队下沉之前把两支刚体分支镜像到父节点交叉轴两侧等距。
  balanceBinaryForks(positions, edges, layout);

  // 子团队下沉后处理 (阶段2 嵌套委派): drop each delegated sub-team onto the cross
  // axis *beside* its parent so the parent's solid 父→CEO 汇聚点 main edge is not
  // occluded, stacking multiple same-wave parent blocks so their sub-teams never
  // collide. Tree 布局按父相对汇聚点的左右选择 -X / +X 让位。See its doc.
  dropSubTeamsBelowParent(positions, edges, layout);

  // 端点居中后处理：ELK 的 NETWORK_SIMPLEX 在子节点为偶数时，把独占一层的纯源/纯汇
  // 节点（用户输入 / CEO 汇聚点）的「中位数」当成一整段区间而非一点 → 它会贴到上/下边、
  // 偏离正中，使其扇形边一长一短。这里把这类节点在交叉轴上拉到所连节点的正中（仅交叉轴、
  // 不动层坐标）。放在下沉之后：多父下沉会把靠下的父下推，端点须按父的**最终**跨度居中。
  centerLoneEndpoints(positions, edges, layout);

  // 修订对齐后处理：把每个续写/修订节点拉回其「源」所在的交叉轴车道，恢复「修订边笔直」不变
  // 量（圆桌逐轮 / 热修版本链都读作「同一发言人·下一轮」一条车道）。放在所有位移之后：下沉
  // 只搬了 delegate 子队、漏掉挂在子 worker 下游的修订节点（它们不在 delegate 子树里），于是
  // 修订被留在源的**旧**车道上 → 第三波漂移。在此统一对齐，不管是谁移动了源都能复位。
  alignRevisionChains(positions, edges, layout);

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
    maxX = Math.max(maxX, positions[id].x + NODE_WIDTH);
    maxY = Math.max(maxY, positions[id].y + NODE_HEIGHT);
  }
  width = Math.max(width, maxX + PADDING);
  height = Math.max(height, maxY + PADDING);

  return { positions, width, height };
}

/**
 * Pull a lone fan bookend onto the cross-axis midpoint of the nodes it connects
 * to. ELK's NETWORK_SIMPLEX leaves a node that is the only one in its layer free
 * to sit anywhere in its neighbors' band when their count is even (the median is
 * a range, not a point), so a 1→2 / 2→1 端点 (用户输入 / CEO 汇聚点) can land
 * off-center and draw asymmetric fan edges.
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
  layout: GraphLayout,
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

/**
 * Mirror a parent's two same-layer `dep` children symmetrically around the parent's
 * cross-axis center — fixes ELK packing one fork flush to the spine and the other
 * flung wide (tree 方案决策→左产品/右技术 reads as a Y, not an L).
 *
 * Wing assignment follows **edge declaration order**: first `dep` child → left,
 * second → right (so `decide→pd` then `decide→arch` always reads 产品左/技术右).
 *
 * Only exactly-two-child forks; 1→N fans and debate 1→4 are left to ELK /
 * `preserveOrder`. Each child moves as a rigid branch (all descendants) so
 * delegate sub-teams stay attached. Cross-axis only; main-axis layers untouched.
 */
function balanceBinaryForks(
  positions: Record<string, { x: number; y: number }>,
  edges: GraphEdge[],
  layout: GraphLayout,
): void {
  const horizontal = layout === "leftright";
  const crossSize = horizontal ? NODE_HEIGHT : NODE_WIDTH;
  const mainOf = (id: string) =>
    horizontal ? positions[id].x : positions[id].y;
  const crossCenterOf = (id: string) =>
    (horizontal ? positions[id].y : positions[id].x) + crossSize / 2;
  const moveCross = (id: string, delta: number) => {
    if (horizontal) positions[id].y += delta;
    else positions[id].x += delta;
  };

  const outgoingDep = new Map<string, string[]>();
  for (const e of edges) {
    if ((e.kind ?? "dep") !== "dep") continue;
    if (!positions[e.source] || !positions[e.target]) continue;
    const arr = outgoingDep.get(e.source);
    if (arr) {
      if (!arr.includes(e.target)) arr.push(e.target);
    } else outgoingDep.set(e.source, [e.target]);
  }

  const branchOf = (root: string, forkParent: string): string[] => {
    const inBranch = new Set([forkParent, root]);
    const out = [root];
    const stack = [root];
    while (stack.length > 0) {
      const n = stack.pop() as string;
      for (const e of edges) {
        if (e.source !== n) continue;
        const t = e.target;
        if (!positions[t] || inBranch.has(t)) continue;
        // Fan-in merge (e.g. both parents → CEO 汇聚点): never absorb into one side.
        const externalIn = edges.some(
          (ei) =>
            ei.target === t && ei.source !== n && !inBranch.has(ei.source),
        );
        if (externalIn) continue;
        inBranch.add(t);
        out.push(t);
        stack.push(t);
      }
    }
    return out;
  };

  for (const [parent, children] of outgoingDep) {
    if (children.length !== 2 || !positions[parent]) continue;
    const [left, right] = children;
    if (!positions[left] || !positions[right]) continue;
    if (Math.round(mainOf(left)) !== Math.round(mainOf(right))) continue;

    const parentCenter = crossCenterOf(parent);
    const leftCenter = crossCenterOf(left);
    const rightCenter = crossCenterOf(right);
    // First `dep` child → left wing, second → right wing (edge declaration order).
    const spread = Math.max(
      Math.abs(parentCenter - leftCenter),
      Math.abs(parentCenter - rightCenter),
    );
    if (spread <= 1) continue;

    const leftDelta = parentCenter - spread - leftCenter;
    const rightDelta = parentCenter + spread - rightCenter;
    if (Math.abs(leftDelta) > 0.01) {
      for (const id of branchOf(left, parent)) moveCross(id, leftDelta);
    }
    if (Math.abs(rightDelta) > 0.01) {
      for (const id of branchOf(right, parent)) moveCross(id, rightDelta);
    }
  }
}

/**
 * Drop each delegated sub-team (阶段2 嵌套委派) onto the cross axis *beside* its
 * parent worker, so the parent's solid 父→CEO 汇聚点 main edge stays clear.
 *
 * Why: a captain worker links its sub-workers by a lone dashed `delegate` edge
 * and also links the CEO 汇聚点 sink by a solid edge. ELK lays the sub-workers in
 * the layer *between* the parent and the (LAST_SEPARATE-pinned) sink, and the
 * sink is recentered onto the parent's row — so the straight 父→汇聚点 edge runs
 * right through a sub-worker that sits on the parent's row, reading as a false
 * `父 → 子任务 → 汇聚点` chain. ELK edge-priority tweaks don't dislodge it.
 *
 * Fix: shift each parent's whole delegate subtree along the cross axis until it
 * clears the parent's column on the **outward** side — tree 布局里父在汇聚点左侧
 * 则子队往 -X 挂，右侧则往 +X；leftright 仍一律往 +Y。The sub-team then reads as a
 * dashed branch hanging beside its parent and the main line is unobstructed.
 *
 * Multiple same-wave parents (后端组长 + 前端组长 both sub-delegating): dropping
 * each subtree below its *own* parent independently makes the two dropped bands
 * collide (an upper parent's team lands on the lower parent and its team). So the
 * top-level parents are processed in cross-axis (reading) order as stacked blocks
 * — each block is `parent row + its subtree` — tracking a running floor: a lower
 * parent (and hence its whole block) is pushed further down until it clears the
 * previous block. A single delegating parent has one block and never moves, so the
 * earlier flat/1-level/2-level cases are unchanged. Cross-axis only; the bbox grows
 * on the cross axis (handled by the caller) and the bookends recenter afterwards.
 *
 * 主干线门控：只对**确有非 delegate 主干出边**（父→汇聚点 / 父→其它 worker）的父下沉；父若只
 * 委派、无主干线（无 CEO 汇聚点的圆桌）则不动。子队下游的修订节点不在此函数职责内，由随后的
 * {@link alignRevisionChains} 统一拉回源车道。
 */
function dropSubTeamsBelowParent(
  positions: Record<string, { x: number; y: number }>,
  edges: GraphEdge[],
  layout: GraphLayout,
): void {
  const horizontal = layout === "leftright";
  const crossSize = horizontal ? NODE_HEIGHT : NODE_WIDTH;
  const crossOf = (id: string) =>
    horizontal ? positions[id].y : positions[id].x;
  const moveCross = (id: string, delta: number) => {
    if (horizontal) positions[id].y += delta;
    else positions[id].x += delta;
  };

  // Delegate tree: parent → its direct sub-workers (only the dashed edges).
  const childrenOf = new Map<string, string[]>();
  const isSub = new Set<string>();
  for (const e of edges) {
    if (e.kind !== "delegate") continue;
    if (!positions[e.source] || !positions[e.target]) continue;
    const arr = childrenOf.get(e.source);
    if (arr) arr.push(e.target);
    else childrenOf.set(e.source, [e.target]);
    isSub.add(e.target);
  }
  if (childrenOf.size === 0) return;

  // Full delegate subtree (direct + nested) under a node, so a >1-level sub-team
  // (rare, but kept robust) moves as one rigid block and stays attached.
  const subtreeOf = (root: string): string[] => {
    const out: string[] = [];
    const stack = [...(childrenOf.get(root) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop() as string;
      out.push(n);
      for (const c of childrenOf.get(n) ?? []) stack.push(c);
    }
    return out;
  };

  // 主干线门控：下沉的唯一目的是让「父→汇聚点」实线不被子队横穿。只有当父确有一条会被横穿
  // 的**非 delegate 出边**（父→CEO 汇聚点 / 父→其它 worker）时才下沉；若父的出边全是 delegate
  // （典型：无 CEO 汇聚点的圆桌——主持人只委派辩手、没有要保护的主干线），下沉只会把图摊开并把
  // 修订节点甩出车道，故跳过，让 ELK 的自然居中（主持人居中于子队、修订与源齐平）直接成立。
  const hasMainLine = new Set<string>();
  for (const e of edges) {
    if (e.kind === "delegate") continue;
    if (positions[e.source]) hasMainLine.add(e.source);
  }

  // Top-level delegating parents (a parent that is not itself a sub-worker):
  // dropping a root subtree carries its nested teams with it, so roots suffice.
  const roots = [...childrenOf.keys()].filter(
    (p) =>
      !isSub.has(p) &&
      (childrenOf.get(p)?.length ?? 0) > 0 &&
      hasMainLine.has(p),
  );
  if (roots.length === 0) return;

  /** Tree: -1 = hang subteam on the left (-X), +1 = right (+X). Leftright: +1 = down (+Y). */
  const dropSignOf = (parent: string): number => {
    if (horizontal) return 1;
    const parentCenter = crossOf(parent) + crossSize / 2;
    const mains = edges
      .filter((e) => e.source === parent && e.kind !== "delegate")
      .map((e) => e.target)
      .filter((t) => positions[t]);
    if (mains.length === 0) return 1;
    const sink = mains.reduce((a, b) =>
      positions[a].y > positions[b].y ? a : b,
    );
    const sinkCenter = crossOf(sink) + crossSize / 2;
    return parentCenter <= sinkCenter ? -1 : 1;
  };

  const shiftSubtree = (
    subtree: string[],
    parent: string,
    sign: number,
  ): void => {
    if (subtree.length === 0) return;
    if (sign > 0) {
      const parentBottom = crossOf(parent) + crossSize;
      const bandTop = Math.min(...subtree.map(crossOf));
      const subShift = parentBottom + NODE_SPACING - bandTop;
      if (subShift > 0) for (const id of subtree) moveCross(id, subShift);
    } else {
      const parentTop = crossOf(parent);
      const bandRight = Math.max(
        ...subtree.map((id) => crossOf(id) + crossSize),
      );
      const subShift = bandRight + NODE_SPACING - parentTop;
      if (subShift > 0) for (const id of subtree) moveCross(id, -subShift);
    }
  };

  // Process +sign and -sign blocks separately so opposite-flank parents don't
  // share a one-sided floor (pd left / arch right in tree).
  for (const sign of [1, -1] as const) {
    const signed = roots.filter((p) => dropSignOf(p) === sign);
    if (signed.length === 0) continue;
    signed.sort((a, b) =>
      sign > 0 ? crossOf(a) - crossOf(b) : crossOf(b) - crossOf(a),
    );

    let floor = sign > 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (const parent of signed) {
      const subtree = subtreeOf(parent);
      if (sign > 0) {
        const parentShift = floor + NODE_SPACING - crossOf(parent);
        if (parentShift > 0) moveCross(parent, parentShift);
      } else {
        const parentShift =
          floor - NODE_SPACING - (crossOf(parent) + crossSize);
        if (parentShift < 0) moveCross(parent, parentShift);
      }
      shiftSubtree(subtree, parent, sign);

      const parentBottom = crossOf(parent) + crossSize;
      let blockBottom = parentBottom;
      for (const id of subtree) {
        blockBottom = Math.max(blockBottom, crossOf(id) + crossSize);
      }
      if (sign > 0) {
        floor = blockBottom;
      } else {
        const blockTop = Math.min(crossOf(parent), ...subtree.map(crossOf));
        floor = blockTop;
      }
    }
  }
}

/**
 * Snap each 修订/续写 revision node onto its source's cross-axis lane so the
 * `原始 → 修订 vN` edge stays straight — the invariant that makes a 圆桌逐轮 /
 * 热修版本链 read as「同一发言人·下一轮」in one lane.
 *
 * ELK already aligns a revision with its source (a revision edge is a normal edge
 * it keeps short), but {@link dropSubTeamsBelowParent} can move the SOURCE (a
 * delegated sub-worker) without its revisions — they hang off the sub-worker by a
 * `revision` edge, not the `delegate` subtree it moves — leaving the revision
 * stranded in the source's OLD lane（第三波漂移 bug）. Re-establishing the invariant
 * here, after every prior move, fixes it no matter what shifted the source.
 *
 * Cross-axis only (y for the left-right flow, x for the tree). A chain (v2→v3…)
 * is processed shallow-first so each link inherits its parent's already-settled
 * lane. Inert when there are no revision edges (the flat / nested-delegate cases).
 */
function alignRevisionChains(
  positions: Record<string, { x: number; y: number }>,
  edges: GraphEdge[],
  layout: GraphLayout,
): void {
  const horizontal = layout === "leftright";
  const sourceOf = new Map<string, string>();
  for (const e of edges) {
    if (e.kind !== "revision") continue;
    if (!positions[e.source] || !positions[e.target]) continue;
    sourceOf.set(e.target, e.source);
  }
  if (sourceOf.size === 0) return;

  // Revision-chain depth from a non-revision origin, so v2 settles before v3
  // reads it (a cycle guard keeps a malformed chain from looping forever).
  const depthOf = (id: string, seen: Set<string>): number => {
    const src = sourceOf.get(id);
    if (src == null || seen.has(id)) return 0;
    seen.add(id);
    return 1 + depthOf(src, seen);
  };
  const targets = [...sourceOf.keys()].sort(
    (a, b) => depthOf(a, new Set()) - depthOf(b, new Set()),
  );
  for (const target of targets) {
    const src = sourceOf.get(target) as string;
    if (horizontal) positions[target].y = positions[src].y;
    else positions[target].x = positions[src].x;
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

// Spacing mirrored from LAYOUT_OPTIONS so the size estimate matches what ELK
// actually produces (within-layer node gap, between-layer gap, outer padding).
// MUST stay in lockstep with LAYOUT_OPTIONS + elk.padding above.
const NODE_SPACING = 40;
const LAYER_SPACING: Record<GraphLayout, number> = { tree: 64, leftright: 80 };
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
  const layerCounts = new Map<number, number>();
  let maxDepth = 1;
  for (const w of workers) {
    const d = depthOf(w.id, new Set());
    maxDepth = Math.max(maxDepth, d);
    layerCounts.set(d, (layerCounts.get(d) ?? 0) + 1);
  }
  const parallelism = Math.max(1, ...layerCounts.values());
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
  layout: GraphLayout,
): { width: number; height: number } {
  const { depth, parallelism } = shape;
  const within = (n: number, size: number) =>
    n * size + (n - 1) * NODE_SPACING + 2 * PADDING;
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
