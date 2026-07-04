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
const LAYOUT_OPTIONS: Record<ElkGraphLayout, Record<string, string>> = {
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
  preserveOrder = false,
  bookends: LayoutBookends = {},
  subTeams: SubTeamInput[] = [],
): Promise<LayoutResult> {
  if (nodeIds.length === 0)
    return { positions: {}, width: 0, height: 0, groups: [] };

  const subTeamByParent = new Map(subTeams.map((st) => [st.parentId, st]));
  const subTeamMemberSet = new Set<string>();
  const subTeamParentSet = new Set<string>();
  for (const st of subTeams) {
    subTeamParentSet.add(st.parentId);
    for (const m of st.memberIds) subTeamMemberSet.add(m);
  }

  const containsTeam = (st: SubTeamInput, id: string): boolean => {
    if (id === st.parentId) return true;
    for (const m of st.memberIds) {
      if (id === m) return true;
      const nested = subTeamByParent.get(m);
      if (nested && containsTeam(nested, id)) return true;
    }
    return false;
  };

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
    const groupChildren: ElkGraphNode[] = [
      { id: st.parentId, width: NODE_WIDTH, height: NODE_HEIGHT },
    ];
    for (const memberId of st.memberIds) {
      const nested = subTeamByParent.get(memberId);
      if (nested) {
        groupChildren.push(buildGroupElkNode(nested));
      } else {
        groupChildren.push({
          id: memberId,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        });
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
        "elk.spacing.nodeNode": "40",
        "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      },
      children: groupChildren,
      edges: groupEdges,
    };
  };

  const inAnyTeam = (id: string): boolean =>
    subTeams.some((st) => containsTeam(st, id));

  const internalEdges: GraphEdge[] = [];
  const externalEdges: GraphEdge[] = [];
  for (const e of edges) {
    const team = innermostTeamForEdge(e.source, e.target);
    if (team) internalEdges.push(e);
    else externalEdges.push(e);
  }
  void internalEdges;

  const topLevelChildren: ElkGraphNode[] = [];
  for (const id of nodeIds) {
    if (inAnyTeam(id)) continue;
    topLevelChildren.push({
      id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
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
      ...LAYOUT_OPTIONS[layout],
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      ...(preserveOrder
        ? { "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES" }
        : {}),
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

  const subTeamNodeSet = new Set<string>();
  for (const st of subTeams) {
    subTeamNodeSet.add(st.parentId);
    for (const m of st.memberIds) subTeamNodeSet.add(m);
  }

  balanceBinaryForks(positions, edges, layout, subTeamMemberSet);

  // 端点居中后处理：ELK 的 NETWORK_SIMPLEX 在子节点为偶数时，把独占一层的纯源/纯汇
  // 节点（用户输入 / CEO 汇聚点）的「中位数」当成一整段区间而非一点 → 它会贴到上/下边、
  // 偏离正中，使其扇形边一长一短。这里把这类节点在交叉轴上拉到所连节点的正中（仅交叉轴、
  // 不动层坐标）。放在下沉之后：多父下沉会把靠下的父下推，端点须按父的**最终**跨度居中。
  centerLoneEndpoints(positions, edges, layout);

  alignRevisionChains(positions, edges, layout);

  resolveOverlaps(positions, layout, subTeams, containsTeam);

  minimizeCrossings(positions, edges, layout, subTeamNodeSet);

  alignRevisionChains(positions, edges, layout);
  resolveOverlaps(positions, layout, subTeams, containsTeam);
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

  const pad = 12;
  const topPad = 32;
  for (const g of groups) {
    const st = subTeams.find((s) => s.groupId === g.groupId);
    if (!st) continue;
    const memberIds = [st.parentId, ...st.memberIds];
    let minGX = Number.POSITIVE_INFINITY;
    let minGY = Number.POSITIVE_INFINITY;
    let maxGX = Number.NEGATIVE_INFINITY;
    let maxGY = Number.NEGATIVE_INFINITY;
    for (const id of memberIds) {
      if (!positions[id]) continue;
      minGX = Math.min(minGX, positions[id].x);
      minGY = Math.min(minGY, positions[id].y);
      maxGX = Math.max(maxGX, positions[id].x + NODE_WIDTH);
      maxGY = Math.max(maxGY, positions[id].y + NODE_HEIGHT);
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
  layout: ElkGraphLayout,
  subTeamMemberSet: Set<string> = new Set(),
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
    if (subTeamMemberSet.has(left) || subTeamMemberSet.has(right)) continue;
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
 * Push apart nodes whose AABBs overlap on both axes (same main-axis band + cross-axis
 * collision). Post-processing — especially {@link dropSubTeamsBelowParent} — can land
 * a dropped sub-team on the same layer as unrelated dep nodes without checking their
 * cross-axis positions. Scans in cross-axis order within each main-axis band and
 * enforces at least {@link NODE_SPACING} between boxes; repeats until stable.
 *
 * Cross-axis only: main-axis (layer) coordinates are left untouched so ELK's layer
 * assignment and bookend pinning stay intact.
 */
function resolveOverlaps(
  positions: Record<string, { x: number; y: number }>,
  layout: ElkGraphLayout,
  subTeams: SubTeamInput[] = [],
  containsTeam: (st: SubTeamInput, id: string) => boolean = () => false,
): void {
  const ids = Object.keys(positions);
  if (ids.length < 2) return;

  const horizontal = layout === "leftright";
  const crossSize = horizontal ? NODE_HEIGHT : NODE_WIDTH;
  const mainSize = horizontal ? NODE_WIDTH : NODE_HEIGHT;

  const mainOf = (id: string) =>
    horizontal ? positions[id].x : positions[id].y;
  const crossOf = (id: string) =>
    horizontal ? positions[id].y : positions[id].x;
  const setCross = (id: string, v: number) => {
    if (horizontal) positions[id].y = v;
    else positions[id].x = v;
  };

  const mainOverlap = (a: string, b: string) =>
    mainOf(a) < mainOf(b) + mainSize && mainOf(a) + mainSize > mainOf(b);

  const boxesOverlap = (a: string, b: string) => {
    if (!mainOverlap(a, b)) return false;
    return (
      crossOf(a) + crossSize + NODE_SPACING > crossOf(b) &&
      crossOf(b) + crossSize + NODE_SPACING > crossOf(a)
    );
  };

  const sameSubTeam = (a: string, b: string): boolean =>
    subTeams.some((st) => containsTeam(st, a) && containsTeam(st, b));

  const maxRounds = ids.length * 2;
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;

    // Group by rounded main-axis layer so we only compare nodes that could collide.
    const byLayer = new Map<string, string[]>();
    for (const id of ids) {
      const key = String(Math.round(mainOf(id)));
      const arr = byLayer.get(key);
      if (arr) arr.push(id);
      else byLayer.set(key, [id]);
    }

    for (const members of byLayer.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => crossOf(a) - crossOf(b));

      for (let i = 1; i < members.length; i++) {
        const prev = members[i - 1];
        const curr = members[i];
        if (sameSubTeam(prev, curr)) continue;
        if (!boxesOverlap(prev, curr)) continue;
        const minCross = crossOf(prev) + crossSize + NODE_SPACING;
        if (crossOf(curr) < minCross) {
          setCross(curr, minCross);
          changed = true;
        }
      }
    }

    if (!changed) break;
  }
}

/**
 * Reorder nodes within each main-axis layer using the barycenter heuristic to
 * reduce edge crossings. Runs after {@link resolveOverlaps} so spacing is sane,
 * then redistributes cross-axis coordinates with {@link NODE_SPACING}.
 *
 * Cross-axis only — main-axis (layer) coordinates stay untouched.
 */
function minimizeCrossings(
  positions: Record<string, { x: number; y: number }>,
  edges: GraphEdge[],
  layout: ElkGraphLayout,
  subTeamNodeSet: Set<string> = new Set(),
  iterations = 3,
): void {
  const ids = Object.keys(positions);
  if (ids.length < 2) return;

  const horizontal = layout === "leftright";
  const crossSize = horizontal ? NODE_HEIGHT : NODE_WIDTH;
  const mainOf = (id: string) =>
    horizontal ? positions[id].x : positions[id].y;
  const crossOf = (id: string) =>
    horizontal ? positions[id].y : positions[id].x;
  const setCross = (id: string, v: number) => {
    if (horizontal) positions[id].y = v;
    else positions[id].x = v;
  };
  const crossCenterOf = (id: string) => crossOf(id) + crossSize / 2;

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

  // Compound sub-teams are positioned by ELK inside their container — leave them put.
  const immovable = new Set<string>(subTeamNodeSet);
  const delegateChildren = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "delegate") continue;
    push(delegateChildren, e.source, e.target);
  }
  for (const roots of delegateChildren.values()) {
    const stack = [...roots];
    while (stack.length > 0) {
      const n = stack.pop() as string;
      if (immovable.has(n)) continue;
      immovable.add(n);
      for (const c of delegateChildren.get(n) ?? []) stack.push(c);
    }
  }
  for (const parent of delegateChildren.keys()) immovable.add(parent);

  const layersOf = (): Map<number, string[]> => {
    const layers = new Map<number, string[]>();
    for (const id of ids) {
      const key = Math.round(mainOf(id));
      const arr = layers.get(key);
      if (arr) arr.push(id);
      else layers.set(key, [id]);
    }
    return layers;
  };

  const redistributeLayer = (members: string[], sorted: string[]): void => {
    const n = sorted.length;
    if (n < 2) return;
    const totalSpan = n * crossSize + (n - 1) * NODE_SPACING;
    const originalCenter =
      members.reduce((s, id) => s + crossCenterOf(id), 0) / n;
    const startCross = originalCenter - totalSpan / 2;
    for (let i = 0; i < n; i++) {
      setCross(sorted[i], startCross + i * (crossSize + NODE_SPACING));
    }
  };

  for (let iter = 0; iter < iterations; iter++) {
    const layers = layersOf();
    const layerKeys = [...layers.keys()].sort((a, b) => a - b);

    for (const key of layerKeys) {
      const members = layers.get(key);
      if (!members || members.length < 2) continue;
      if (members.some((id) => immovable.has(id))) continue;

      const paired = members.map((id) => {
        const neighborIds = [
          ...(incoming.get(id) ?? []),
          ...(outgoing.get(id) ?? []),
        ];
        const valid = neighborIds.filter((n) => positions[n]);
        const bc =
          valid.length > 0
            ? valid.reduce((s, n) => s + crossCenterOf(n), 0) / valid.length
            : crossCenterOf(id);
        return { id, bc };
      });

      paired.sort((a, b) => a.bc - b.bc || crossOf(a.id) - crossOf(b.id));
      redistributeLayer(
        members,
        paired.map((p) => p.id),
      );
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
  layout: ElkGraphLayout,
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
