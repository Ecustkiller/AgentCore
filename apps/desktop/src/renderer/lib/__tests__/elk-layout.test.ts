import {
  type GraphRunLike,
  buildGraphStructure,
} from "@/components/graph/helpers";
import type { GraphEdge } from "@/stores/graph";
import { describe, expect, it } from "vitest";
import type { SubTeamInput } from "../elk-layout";
import { computeLayout } from "../elk-layout";

/** Derive compound sub-teams from delegate edges (mirrors buildGraphStructure). */
function subTeamsFromEdges(edges: GraphEdge[]): SubTeamInput[] {
  const subTeamMap = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "delegate") continue;
    const arr = subTeamMap.get(e.source) ?? [];
    arr.push(e.target);
    subTeamMap.set(e.source, arr);
  }
  return [...subTeamMap.entries()].map(([parentId, memberIds]) => ({
    parentId,
    memberIds,
    groupId: `__group__${parentId}`,
  }));
}

async function layout(
  ids: string[],
  edges: GraphEdge[],
  layoutKind: "tree" | "leftright" = "leftright",
  preserveOrder = false,
  bookends: { source?: string; sink?: string } = {},
) {
  return computeLayout(
    ids,
    edges,
    layoutKind,
    preserveOrder,
    bookends,
    subTeamsFromEdges(edges),
  );
}

/**
 * 协作图布局后处理不变量（端点钉层 + ELK compound 子队，见 elk-layout.ts / 前端UX设计 §五）。
 *
 * 用真实 `computeLayout`（含 ELK + layerConstraint + compound 子队 +
 * centerLoneEndpoints）断言几何不变量。含 delegate 的用例以 compound 容器为单元：
 *   1. 末层钉层——CEO 汇聚点恒在最右（最大主轴坐标）。
 *   2. 同 compound 内成员两两不重叠。
 *   3. 多支子树（compound 或顶层节点）互不重叠。
 */
// 镜像 elk-layout 内部常量（NODE_WIDTH 未导出，NODE_HEIGHT 已导出但此处一并固定）。
const NW = 210;
const NH = 110;

const e = (
  source: string,
  target: string,
  kind: "dep" | "delegate" | "revision" = "dep",
): GraphEdge => ({ id: `${source}->${target}`, source, target, kind });

/** 两节点盒（NW×NH）是否相交。 */
const overlaps = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean =>
  a.x < b.x + NW && a.x + NW > b.x && a.y < b.y + NH && a.y + NH > b.y;

/** 任意两两不重叠。 */
const noneOverlap = (
  pos: Record<string, { x: number; y: number }>,
  ids: string[],
): string[] => {
  const hits: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (overlaps(pos[ids[i]], pos[ids[j]])) hits.push(`${ids[i]}×${ids[j]}`);
    }
  }
  return hits;
};

describe("computeLayout · 嵌套委派布局不变量（leftright）", () => {
  it("2 级嵌套：compound 子队不重叠、汇聚点钉末层", async () => {
    const ids = ["__input__", "mpm", "lead", "eng1", "eng2", "mcap"];
    const edges: GraphEdge[] = [
      e("__input__", "mpm"),
      e("mpm", "lead", "delegate"),
      e("lead", "eng1", "delegate"),
      e("lead", "eng2", "delegate"),
      e("mpm", "mcap"),
    ];
    const { positions, groups } = await layout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "mcap",
    });

    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.mcap.x).toBe(maxX);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(noneOverlap(positions, ["lead", "eng1", "eng2"])).toEqual([]);
    expect(
      noneOverlap(
        positions,
        ids.filter((id) => !id.startsWith("__")),
      ),
    ).toEqual([]);
  });

  it("同层双父各带子团队：两支 compound 互不重叠、汇聚点钉末层", async () => {
    const ids = ["__input__", "be", "fe", "be1", "be2", "fe1", "fe2", "dcap"];
    const edges: GraphEdge[] = [
      e("__input__", "be"),
      e("__input__", "fe"),
      e("be", "be1", "delegate"),
      e("be", "be2", "delegate"),
      e("fe", "fe1", "delegate"),
      e("fe", "fe2", "delegate"),
      e("be", "dcap"),
      e("fe", "dcap"),
    ];
    const { positions, groups } = await layout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "dcap",
    });

    expect(groups.length).toBe(2);
    expect(
      noneOverlap(positions, ["be", "fe", "be1", "be2", "fe1", "fe2"]),
    ).toEqual([]);

    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.dcap.x).toBe(maxX);
  });

  it("大扇出 1→8→7→1 DAG + delegate 子队：同层节点无重叠", async () => {
    // 模拟 3 波复杂协作：wave1 四父各带 2 子队（8 subs），wave2 七普通 worker，
    // 子队下沉后可能与同层 dep 节点交叉轴碰撞 — resolveOverlaps 须推开。
    const parents = ["p0", "p1", "p2", "p3"];
    const subs = Array.from({ length: 8 }, (_, i) => `sub_${i}`);
    const w2 = Array.from({ length: 7 }, (_, i) => `w2_${i}`);
    const ids = ["__input__", ...parents, ...subs, ...w2, "cap"];
    const edges: GraphEdge[] = [
      ...parents.map((p) => e("__input__", p)),
      e("p0", "sub_0", "delegate"),
      e("p0", "sub_1", "delegate"),
      e("p1", "sub_2", "delegate"),
      e("p1", "sub_3", "delegate"),
      e("p2", "sub_4", "delegate"),
      e("p2", "sub_5", "delegate"),
      e("p3", "sub_6", "delegate"),
      e("p3", "sub_7", "delegate"),
      ...w2.flatMap((w, i) => [
        e(parents[i % parents.length], w),
        ...(i + 1 < w2.length ? [e(parents[(i + 1) % parents.length], w)] : []),
      ]),
      ...parents.map((p) => e(p, "cap")),
      ...w2.map((w) => e(w, "cap")),
    ];
    const workers = [...parents, ...subs, ...w2];
    const { positions } = await layout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "cap",
    });

    expect(noneOverlap(positions, workers)).toEqual([]);
    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.cap.x).toBe(maxX);
  });

  it("扁平并行（无委派）：下沉为 no-op，端点钉首/末层", async () => {
    const ids = ["__input__", "w1", "w2", "w3", "cap"];
    const edges: GraphEdge[] = [
      e("__input__", "w1"),
      e("__input__", "w2"),
      e("__input__", "w3"),
      e("w1", "cap"),
      e("w2", "cap"),
      e("w3", "cap"),
    ];
    const { positions } = await layout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "cap",
    });

    const xs = ids.map((id) => positions[id].x);
    expect(positions.__input__.x).toBe(Math.min(...xs));
    expect(positions.cap.x).toBe(Math.max(...xs));
    // 三个并行 worker 同列、互不重叠。
    expect(noneOverlap(positions, ["w1", "w2", "w3"])).toEqual([]);
  });

  it("3 父同波次各带子队：compound 互不重叠、汇聚点钉末层", async () => {
    const ids = [
      "__input__",
      "p1",
      "p2",
      "p3",
      "a1",
      "a2",
      "b1",
      "b2",
      "c1",
      "c2",
      "cap",
    ];
    const edges: GraphEdge[] = [
      e("__input__", "p1"),
      e("__input__", "p2"),
      e("__input__", "p3"),
      e("p1", "a1", "delegate"),
      e("p1", "a2", "delegate"),
      e("p2", "b1", "delegate"),
      e("p2", "b2", "delegate"),
      e("p3", "c1", "delegate"),
      e("p3", "c2", "delegate"),
      e("p1", "cap"),
      e("p2", "cap"),
      e("p3", "cap"),
    ];
    const { positions, groups } = await layout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "cap",
    });

    expect(groups.length).toBe(3);
    expect(
      noneOverlap(positions, [
        "p1",
        "p2",
        "p3",
        "a1",
        "a2",
        "b1",
        "b2",
        "c1",
        "c2",
      ]),
    ).toEqual([]);
    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.cap.x).toBe(maxX);
  });

  it("树形(DOWN) + 委派：compound 子队不重叠、汇聚点钉末层", async () => {
    const ids = ["__input__", "tpm", "teng1", "teng2", "tcap"];
    const edges: GraphEdge[] = [
      e("__input__", "tpm"),
      e("tpm", "teng1", "delegate"),
      e("tpm", "teng2", "delegate"),
      e("tpm", "tcap"),
    ];
    const { positions, groups } = await layout(ids, edges, "tree", false, {
      source: "__input__",
      sink: "tcap",
    });

    expect(groups.length).toBe(1);
    const maxY = Math.max(...ids.map((id) => positions[id].y));
    expect(positions.tcap.y).toBe(maxY);
    expect(noneOverlap(positions, ["tpm", "teng1", "teng2"])).toEqual([]);
  });

  it("B 型回归：深波次普通 worker 与 compound 子队不重叠", async () => {
    // input→p1⇢{s1,s2}→cap、input→p2⇢{t1,t2}→cap、input→m→n→cap（n 落到子队所在层）。
    const ids = [
      "__input__",
      "p1",
      "p2",
      "s1",
      "s2",
      "t1",
      "t2",
      "m",
      "n",
      "cap",
    ];
    const edges: GraphEdge[] = [
      e("__input__", "p1"),
      e("p1", "s1", "delegate"),
      e("p1", "s2", "delegate"),
      e("p1", "cap"),
      e("__input__", "p2"),
      e("p2", "t1", "delegate"),
      e("p2", "t2", "delegate"),
      e("p2", "cap"),
      e("__input__", "m"),
      e("m", "n"),
      e("n", "cap"),
    ];
    const { positions } = await layout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "cap",
    });

    expect(
      noneOverlap(positions, ["p1", "p2", "s1", "s2", "t1", "t2", "m", "n"]),
    ).toEqual([]);
    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.cap.x).toBe(maxX);
  });

  // 圆桌逐轮（主持人 ⇢ 三视角 ⇢ 各自修订 v2）：修订节点必须与其源同一交叉轴车道（修订边笔直），
  // 守住「第三波漂移」回归——下沉只搬 delegate 子队、漏掉挂其下的修订，曾把第三波留在源旧车道。
  it("圆桌逐轮·无汇聚点：不下沉、三方修订各与源同车道、互不重叠", async () => {
    const ids = ["mod", "s_a", "s_b", "s_c", "s_a2", "s_b2", "s_c2"];
    const edges: GraphEdge[] = [
      e("mod", "s_a", "delegate"),
      e("mod", "s_b", "delegate"),
      e("mod", "s_c", "delegate"),
      e("s_a", "s_a2", "revision"),
      e("s_b", "s_b2", "revision"),
      e("s_c", "s_c2", "revision"),
    ];
    const { positions } = await layout(ids, edges, "leftright", false, {
      source: "__input__",
    });

    // 每个修订与其源同 y（同车道）——核心不变量，杜绝第三波漂移。
    for (const [src, rev] of [
      ["s_a", "s_a2"],
      ["s_b", "s_b2"],
      ["s_c", "s_c2"],
    ]) {
      expect(positions[rev].y).toBeCloseTo(positions[src].y, 5);
    }
    // 全员两两不重叠。
    expect(noneOverlap(positions, ids)).toEqual([]);
    // 无主干线 → 不下沉：主持人居中于三子队（与首子、末子的 y 中点对齐）。
    const subYs = ["s_a", "s_b", "s_c"].map((id) => positions[id].y);
    const mid = (Math.min(...subYs) + Math.max(...subYs)) / 2;
    expect(positions.mod.y).toBeCloseTo(mid, 0);
  });

  it("圆桌逐轮·带汇聚点：修订与源同车道、汇聚点钉末层", async () => {
    const ids = [
      "__input__",
      "mod",
      "s_a",
      "s_b",
      "s_c",
      "s_a2",
      "s_b2",
      "s_c2",
      "cap",
    ];
    const edges: GraphEdge[] = [
      e("__input__", "mod"),
      e("mod", "s_a", "delegate"),
      e("mod", "s_b", "delegate"),
      e("mod", "s_c", "delegate"),
      e("s_a", "s_a2", "revision"),
      e("s_b", "s_b2", "revision"),
      e("s_c", "s_c2", "revision"),
      e("mod", "cap"),
    ];
    const { positions } = await layout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "cap",
    });

    // 修订与源同车道（下沉搬了源、修订必须跟上）。
    for (const [src, rev] of [
      ["s_a", "s_a2"],
      ["s_b", "s_b2"],
      ["s_c", "s_c2"],
    ]) {
      expect(positions[rev].y).toBeCloseTo(positions[src].y, 5);
    }
    // 汇聚点钉末层。
    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.cap.x).toBe(maxX);
    expect(
      noneOverlap(positions, ["s_a", "s_b", "s_c", "s_a2", "s_b2", "s_c2"]),
    ).toEqual([]);
  });
});

describe("computeLayout · 树形分叉对称", () => {
  it("1→2 双父 + 各自子队：两支镜像等距、汇聚点钉末层", async () => {
    const ids = [
      "__input__",
      "decide",
      "pd",
      "arch",
      "ix",
      "vd",
      "be",
      "dm",
      "cap",
    ];
    const edges: GraphEdge[] = [
      e("__input__", "decide"),
      e("decide", "pd"),
      e("decide", "arch"),
      e("pd", "ix", "delegate"),
      e("pd", "vd", "delegate"),
      e("arch", "be", "delegate"),
      e("arch", "dm", "delegate"),
      e("pd", "cap"),
      e("arch", "cap"),
    ];
    const { positions, groups } = await layout(ids, edges, "tree", false, {
      source: "__input__",
      sink: "cap",
    });

    const cx = (id: string) => positions[id].x + NW / 2;
    const decideC = cx("decide");
    const pdDist = decideC - cx("pd");
    const archDist = cx("arch") - decideC;
    expect(pdDist).toBeCloseTo(archDist, 0);
    expect(pdDist).toBeGreaterThan(NW * 0.5);
    expect(groups.length).toBe(2);
    expect(
      noneOverlap(positions, ["pd", "arch", "ix", "vd", "be", "dm"]),
    ).toEqual([]);
    const maxY = Math.max(...ids.map((id) => positions[id].y));
    expect(positions.cap.y).toBe(maxY);
  });
});

// 多轮辩论版本链（原始 + 修订 v2…v5 全部 revisionOf==原始 的「星型」数据）必须铺成一条可见的链，
// 而非全部堆叠在原始的唯一后继槽里——回归「5 轮辩论协作图只显 2 个版本」bug（修订 v3/v4 被 v5 压盖）。
describe("buildGraphStructure · 多修订版本链（辩论逐轮）", () => {
  const side = (
    prefix: string,
    stance: "pro" | "con",
    rounds: number,
  ): GraphRunLike[] => {
    const original: GraphRunLike = {
      id: `mod_r1_${prefix}`,
      dependsOn: [],
      parentRunId: "mod",
      revision: 0,
      revisionOf: null,
      stance,
    };
    // 后续每一轮都是首轮的续写 revision——真实投影里 revisionOf 恒指向【原始】(r1)，形成星型。
    // 乙 wire 携 round/stance 后每个修订也继承本方 stance（fold 投上去），故这里也带 stance——
    // 它改变 nodeId 的 stance 排序（同方版本聚拢），链式修订边仍须成立、布局仍不叠。
    const revs: GraphRunLike[] = [];
    for (let r = 2; r <= rounds; r++) {
      revs.push({
        id: `mod_r${r}_${prefix}`,
        dependsOn: [],
        parentRunId: original.id,
        revision: r,
        revisionOf: original.id,
        stance,
      });
    }
    return [original, ...revs];
  };

  const debateRuns = (rounds: number): GraphRunLike[] => [
    { id: "mod", dependsOn: [], parentRunId: null, kind: "agent" },
    ...side("pro", "pro", rounds),
    ...side("con", "con", rounds),
  ];

  it("星型 revisionOf 被铺成链式修订边（原始→v2→v3→…），不是从原始发散的星", () => {
    const { rawEdges } = buildGraphStructure(debateRuns(5), "__input__");
    const revEdges = rawEdges
      .filter((e) => e.kind === "revision")
      .map((e) => `${e.source}->${e.target}`)
      .sort();
    expect(revEdges).toEqual(
      [
        "mod_r1_pro->mod_r2_pro",
        "mod_r2_pro->mod_r3_pro",
        "mod_r3_pro->mod_r4_pro",
        "mod_r4_pro->mod_r5_pro",
        "mod_r1_con->mod_r2_con",
        "mod_r2_con->mod_r3_con",
        "mod_r3_con->mod_r4_con",
        "mod_r4_con->mod_r5_con",
      ].sort(),
    );
    // 没有从原始直接连到 v3/v4/v5 的星型边（那正是导致堆叠的形状）。
    expect(revEdges).not.toContain("mod_r1_pro->mod_r3_pro");
    expect(revEdges).not.toContain("mod_r1_pro->mod_r5_pro");
  });

  it("布局后 5 个版本全部落在各自图元、两两不重叠（不再折叠成 2 个）", async () => {
    const { nodeIds, rawEdges, subTeams } = buildGraphStructure(
      debateRuns(5),
      "__input__",
    );
    const { positions } = await computeLayout(
      nodeIds,
      rawEdges,
      "leftright",
      true,
      { source: "__input__" },
      subTeams,
    );
    const proVersions = [
      "mod_r1_pro",
      "mod_r2_pro",
      "mod_r3_pro",
      "mod_r4_pro",
      "mod_r5_pro",
    ];
    const conVersions = [
      "mod_r1_con",
      "mod_r2_con",
      "mod_r3_con",
      "mod_r4_con",
      "mod_r5_con",
    ];
    // 每个版本都被 ELK 放置（有坐标）。
    for (const id of [...proVersions, ...conVersions]) {
      expect(positions[id]).toBeDefined();
    }
    // 同一辩手的 5 个版本两两不重叠（旧星型下 v2…v5 会叠在同一坐标 → 只看得到 v5）。
    expect(noneOverlap(positions, proVersions)).toEqual([]);
    expect(noneOverlap(positions, conVersions)).toEqual([]);
  });
});
