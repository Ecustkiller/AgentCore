import type { GraphEdge } from "@/stores/graph";
import { describe, expect, it } from "vitest";
import { computeLayout } from "../elk-layout";

/**
 * 协作图布局后处理不变量（端点钉层 + 子团队下沉，见 elk-layout.ts / 前端UX设计 §五）。
 *
 * 用真实 `computeLayout`（含 ELK + layerConstraint + dropSubTeamsBelowParent +
 * centerLoneEndpoints）断言几何不变量，守住嵌套委派的三条铁律：
 *   1. 末层钉层——CEO 汇聚点恒在最右（最大主轴坐标），不与子 worker 同列。
 *   2. 主干线干净——任何「父→汇聚点」实线所在行不被子孙 worker 横穿。
 *   3. 多支子树不重叠——同波次多个父各自委派时，各「父+子队」整块堆叠互不压盖。
 */
// 镜像 elk-layout 内部常量（NODE_WIDTH 未导出，NODE_HEIGHT 已导出但此处一并固定）。
const NW = 210;
const NH = 110;

const e = (
  source: string,
  target: string,
  kind: "dep" | "delegate" = "dep",
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
  it("2 级嵌套：子树整块落在父主干线下方、主干线干净、汇聚点钉末层", async () => {
    const ids = ["__input__", "mpm", "lead", "eng1", "eng2", "mcap"];
    const edges: GraphEdge[] = [
      e("__input__", "mpm"),
      e("mpm", "lead", "delegate"),
      e("lead", "eng1", "delegate"),
      e("lead", "eng2", "delegate"),
      e("mpm", "mcap"),
    ];
    const { positions } = await computeLayout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "mcap",
    });

    // 汇聚点钉在末层：x 最大。
    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.mcap.x).toBe(maxX);

    // 主干线 mpm→mcap 行不被子孙横穿，且整条子树落在其下方。
    const row = positions.mpm.y;
    for (const id of ["lead", "eng1", "eng2"]) {
      expect(Math.abs(positions[id].y - row)).toBeGreaterThanOrEqual(NH);
      expect(positions[id].y).toBeGreaterThan(row);
    }
    // 子树自身不重叠。
    expect(noneOverlap(positions, ["lead", "eng1", "eng2"])).toEqual([]);
  });

  it("同层双父各带子团队：两支子树各成一带、互不重叠、两条主干线都干净", async () => {
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
    const { positions } = await computeLayout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "dcap",
    });

    // 所有 worker 盒两两不重叠（核心：两支子队不再交叠）。
    expect(
      noneOverlap(positions, ["be", "fe", "be1", "be2", "fe1", "fe2"]),
    ).toEqual([]);

    // 两支子树在交叉轴上成不相交的两带。
    const band = (ids2: string[]) => {
      const ys = ids2.map((id) => positions[id].y);
      return [Math.min(...ys), Math.max(...ys) + NH] as const;
    };
    const [beTop, beBot] = band(["be1", "be2"]);
    const [feTop, feBot] = band(["fe1", "fe2"]);
    expect(beBot <= feTop || feBot <= beTop).toBe(true);

    // 两条「父→汇聚点」主干线行都不被任一子节点横穿。
    for (const parent of ["be", "fe"]) {
      const row = positions[parent].y;
      const onLine = ["be1", "be2", "fe1", "fe2"].filter(
        (id) => Math.abs(positions[id].y - row) < NH,
      );
      expect(onLine).toEqual([]);
    }

    // 汇聚点仍钉末层。
    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.dcap.x).toBe(maxX);
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
    const { positions } = await computeLayout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "cap",
    });

    const xs = ids.map((id) => positions[id].x);
    expect(positions.__input__.x).toBe(Math.min(...xs));
    expect(positions.cap.x).toBe(Math.max(...xs));
    // 三个并行 worker 同列、互不重叠。
    expect(noneOverlap(positions, ["w1", "w2", "w3"])).toEqual([]);
  });

  it("3 父同波次各带子队：N 块整体堆叠、互不重叠、N 条主干线都干净", async () => {
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
    const { positions } = await computeLayout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "cap",
    });

    // 3 支子队 + 3 个父两两不重叠。
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
    // 每条「父→汇聚点」主干线行都不被任一子节点横穿。
    const subs = ["a1", "a2", "b1", "b2", "c1", "c2"];
    for (const parent of ["p1", "p2", "p3"]) {
      const onLine = subs.filter(
        (id) => Math.abs(positions[id].y - positions[parent].y) < NH,
      );
      expect(onLine).toEqual([]);
    }
    // 汇聚点钉末层。
    const maxX = Math.max(...ids.map((id) => positions[id].x));
    expect(positions.cap.x).toBe(maxX);
  });

  it("树形(DOWN) + 委派：交叉轴=x 分支，子队整块让位、竖向主干线干净、汇聚点钉末层", async () => {
    const ids = ["__input__", "tpm", "teng1", "teng2", "tcap"];
    const edges: GraphEdge[] = [
      e("__input__", "tpm"),
      e("tpm", "teng1", "delegate"),
      e("tpm", "teng2", "delegate"),
      e("tpm", "tcap"),
    ];
    const { positions } = await computeLayout(ids, edges, "tree", false, {
      source: "__input__",
      sink: "tcap",
    });

    // 树形主轴=y（DOWN）：汇聚点钉末层 → y 最大。
    const maxY = Math.max(...ids.map((id) => positions[id].y));
    expect(positions.tcap.y).toBe(maxY);
    // 交叉轴=x：竖向主干线 tpm→tcap 所在列不被子队同列横穿（子队整块沿 x 让到旁侧）。
    const col = positions.tpm.x;
    const onCol = ["teng1", "teng2"].filter(
      (id) => Math.abs(positions[id].x - col) < NW,
    );
    expect(onCol).toEqual([]);
    // 子队互不重叠。
    expect(noneOverlap(positions, ["tpm", "teng1", "teng2"])).toEqual([]);
  });

  // B 型回归：更深波次的普通 worker 可能与某父的子队**同层**（同一交叉轴主坐标）。
  // 经实测，下沉的「单调下推」+ ELK「自顶向下打包」使普通节点恒落在子队带之上 → 不
  // 重叠、不压主干线。此处钉死该安全行为（而非给不可复现的碰撞加兜底逻辑）。
  it("B 型回归：深波次普通 worker 与子队同层仍不重叠、主干线干净", async () => {
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
    const { positions } = await computeLayout(ids, edges, "leftright", false, {
      source: "__input__",
      sink: "cap",
    });

    // n 与部分子节点同列（主层坐标相同），但所有盒两两不重叠。
    const sameLayerAsN = ["s1", "s2", "t1", "t2"].filter(
      (id) => Math.abs(positions[id].x - positions.n.x) < 1,
    );
    expect(sameLayerAsN.length).toBeGreaterThan(0);
    expect(
      noneOverlap(positions, ["p1", "p2", "s1", "s2", "t1", "t2", "m", "n"]),
    ).toEqual([]);
    // 两条父主干线行不被任一子节点或普通 worker n 横穿。
    for (const parent of ["p1", "p2"]) {
      const row = positions[parent].y;
      const onLine = ["s1", "s2", "t1", "t2", "n"].filter(
        (id) => Math.abs(positions[id].y - row) < NH,
      );
      expect(onLine).toEqual([]);
    }
  });
});
