import { NODE_WIDTH } from "@/lib/elk-layout";
import type { Execution } from "@/stores/execution";
import { debateBeatLabel } from "@/stores/execution";
import { describe, expect, it } from "vitest";
import {
  type GraphRunLike,
  aggregateDebateRoundStatus,
  buildGraphStructure,
  computeDebateStageBands,
  computeGraphFold,
  computeTopologicalRunWaves,
  computeWaves,
  debateModeratorId,
  debateRoundActiveBeat,
  debateRoundPhaseLabel,
  debateRoundSettledMark,
  pickDebateCrossExamActivateId,
} from "../helpers";

function run(
  id: string,
  deps: string[] = [],
  extra: Partial<GraphRunLike> = {},
): GraphRunLike {
  return { id, dependsOn: deps, ...extra };
}

function minimalExecution(
  runs: GraphRunLike[],
  captainId = "captain",
): Execution {
  return {
    runs: [
      {
        id: captainId,
        kind: "captain",
        dependsOn: [],
      } as unknown as Execution["runs"][0],
      ...runs.map(
        (r) =>
          ({
            id: r.id,
            dependsOn: r.dependsOn,
            parentRunId: r.parentRunId ?? null,
            continuationIndex: r.continuationIndex ?? 0,
            continuesRunId: r.continuesRunId ?? null,
            kind: "agent",
            delegateBatch: r.delegateBatch,
          }) as Execution["runs"][0],
      ),
    ],
  } as Execution;
}

describe("computeTopologicalRunWaves", () => {
  it("layers a linear dep chain", () => {
    const waves = computeTopologicalRunWaves(
      [run("a"), run("b", ["a"]), run("c", ["b"])],
      "captain",
    );
    expect(waves.get("a")).toBe(0);
    expect(waves.get("b")).toBe(1);
    expect(waves.get("c")).toBe(2);
  });

  it("groups parallel roots in wave 0", () => {
    const waves = computeTopologicalRunWaves(
      [run("a"), run("b"), run("c", ["a", "b"])],
      null,
    );
    expect(waves.get("a")).toBe(0);
    expect(waves.get("b")).toBe(0);
    expect(waves.get("c")).toBe(1);
  });

  it("puts delegate sub-tasks in the parent wave", () => {
    const waves = computeTopologicalRunWaves(
      [
        run("lead"),
        run("sub1", [], { parentRunId: "lead" }),
        run("sub2", [], { parentRunId: "lead" }),
        run("downstream", ["lead"]),
      ],
      "captain",
    );
    expect(waves.get("lead")).toBe(0);
    expect(waves.get("sub1")).toBe(0);
    expect(waves.get("sub2")).toBe(0);
    expect(waves.get("downstream")).toBe(1);
  });

  it("rolls sub-task external deps into the parent unit wave", () => {
    const waves = computeTopologicalRunWaves(
      [
        run("a"),
        run("lead", ["a"]),
        run("sub", ["a"], { parentRunId: "lead" }),
      ],
      null,
    );
    expect(waves.get("a")).toBe(0);
    expect(waves.get("lead")).toBe(1);
    expect(waves.get("sub")).toBe(1);
  });
});

describe("computeWaves", () => {
  it("returns no bands for a single wave", () => {
    const execution = minimalExecution([run("a"), run("b")]);
    const bands = computeWaves(
      execution,
      { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } },
      { width: 400, height: 200 },
      "leftright",
      "captain",
    );
    expect(bands).toEqual([]);
  });

  it("labels topological waves with node counts", () => {
    const execution = minimalExecution([run("a"), run("b", ["a"])]);
    const bands = computeWaves(
      execution,
      { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } },
      { width: 500, height: 200 },
      "leftright",
      "captain",
    );
    expect(bands).toHaveLength(2);
    expect(bands[0]?.label).toBe("批次 1（1 节点）");
    expect(bands[1]?.label).toBe("批次 2（1 节点）");
  });

  it("prefers 第 N 次委派 bands over topo waves when ≥2 delegate batches", () => {
    // Disjoint chains: batch1 a→b, batch2 c→d. Topo would group a+c / b+d and
    // mislabel them as「批次」; delegate bands must group a+b / c+d as rows.
    const execution = minimalExecution([
      run("a", [], { delegateBatch: 1 }),
      run("b", ["a"], { delegateBatch: 1 }),
      run("c", [], { delegateBatch: 2 }),
      run("d", ["c"], { delegateBatch: 2 }),
    ]);
    const bands = computeWaves(
      execution,
      {
        a: { x: 0, y: 0 },
        b: { x: 300, y: 0 },
        c: { x: 0, y: 140 },
        d: { x: 300, y: 140 },
      },
      { width: 520, height: 280 },
      "leftright",
      "captain",
    );
    expect(bands).toHaveLength(2);
    expect(bands[0]?.label).toBe("第 1 次委派（2 节点）");
    expect(bands[1]?.label).toBe("第 2 次委派（2 节点）");
    // Cross-axis (row) strips in leftright — not the topo column strips.
    expect(bands[0]?.h).toBeLessThan(bands[0]?.w ?? 0);
    expect(bands[1]?.y).toBeGreaterThan(bands[0]?.y ?? 0);
  });
});

/** Execution 保真构造：保留 stance/group/round/receivedContext（minimalExecution 会剥掉）。 */
function debateStageExecution(
  runs: GraphRunLike[],
  captainId = "captain",
): Execution {
  return {
    runs: [{ id: captainId, kind: "captain", dependsOn: [] }, ...runs],
  } as unknown as Execution;
}

describe("computeDebateStageBands", () => {
  const positions = {
    mod: { x: 0, y: 120 },
    mod_r1_pro: { x: 260, y: 0 },
    mod_r1_con: { x: 260, y: 240 },
    mod_r2_pro: { x: 520, y: 0 },
    mod_r2_con: { x: 520, y: 240 },
    mod_closing_pro: { x: 780, y: 0 },
    mod_closing_con: { x: 780, y: 240 },
  };

  it("returns [] for non-debate executions", () => {
    const exec = debateStageExecution([
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: [] },
    ]);
    expect(
      computeDebateStageBands(
        exec,
        { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } },
        "captain",
      ),
    ).toEqual([]);
  });

  it("partitions multibeat debate into 第1轮/第2轮/结辩 left-to-right", () => {
    const exec = debateStageExecution(debateMultibeatRuns());
    const bands = computeDebateStageBands(exec, positions, "captain");
    expect(bands.map((b) => b.label)).toEqual(["第 1 轮", "第 2 轮", "结辩"]);
    expect(bands[0]?.x).toBeLessThan(bands[1]?.x ?? 0);
    expect(bands[1]?.x).toBeLessThan(bands[2]?.x ?? 0);
  });

  it("anchors 第1轮 label on the debater column (ignores moderator x)", () => {
    const exec = debateStageExecution(debateMultibeatRuns());
    const bands = computeDebateStageBands(exec, positions, "captain");
    const first = bands[0];
    const second = bands[1];
    // 第1轮只含辩手列 x=260，与第2轮同宽；标签居中于辩手列，不因主持(x=0)左偏。
    expect(first?.w).toBe(second?.w);
    expect(first?.labelX).toBe(260 + NODE_WIDTH / 2);
    expect(second?.labelX).toBe(520 + NODE_WIDTH / 2);
  });

  it("never turns cross-exam into its own stage (3 stages only)", () => {
    const exec = debateStageExecution(debateMultibeatRuns());
    const bands = computeDebateStageBands(exec, positions, "captain");
    expect(bands).toHaveLength(3);
  });

  it("labels a single statement round as 第1轮", () => {
    const single: GraphRunLike[] = [
      { id: "mod", dependsOn: [], parentRunId: null },
      {
        id: "mod_r1_pro",
        dependsOn: [],
        parentRunId: "mod",
        continuesRunId: null,
        stance: "pro",
        group: "debate:debate",
        round: 1,
      },
      {
        id: "mod_r1_con",
        dependsOn: [],
        parentRunId: "mod",
        continuesRunId: null,
        stance: "con",
        group: "debate:debate",
        round: 1,
      },
    ];
    const bands = computeDebateStageBands(
      debateStageExecution(single),
      {
        mod: { x: 0, y: 120 },
        mod_r1_pro: { x: 260, y: 0 },
        mod_r1_con: { x: 260, y: 240 },
      },
      "captain",
    );
    expect(bands.map((b) => b.label)).toEqual(["第 1 轮"]);
  });
});

function debateSide(
  prefix: string,
  stance: "pro" | "con",
  rounds: number,
): GraphRunLike[] {
  const original: GraphRunLike = {
    id: `mod_r1_${prefix}`,
    dependsOn: [],
    parentRunId: "mod",
    continuationIndex: 0,
    continuesRunId: null,
    stance,
    group: "debate:debate",
  };
  const revs: GraphRunLike[] = [];
  for (let r = 2; r <= rounds; r++) {
    revs.push({
      id: `mod_r${r}_${prefix}`,
      dependsOn: [],
      parentRunId: original.id,
      continuationIndex: r - 1,
      continuesRunId: original.id,
      stance,
      group: "debate:debate",
    });
  }
  return [original, ...revs];
}

/** 多轮对抗 + 每轮质询 + 结辩：钉死协作图列数（每方 轮数+1 结辩）与修订链。 */
function debateMultibeatSide(
  prefix: string,
  stance: "pro" | "con",
): GraphRunLike[] {
  const original: GraphRunLike = {
    id: `mod_r1_${prefix}`,
    dependsOn: [],
    parentRunId: "mod",
    continuationIndex: 0,
    continuesRunId: null,
    stance,
    group: "debate:debate",
    round: 1,
  };
  return [
    original,
    {
      id: `mod_r1_cx_${prefix}`,
      dependsOn: [],
      parentRunId: original.id,
      continuationIndex: 1,
      continuesRunId: original.id,
      stance,
      group: "debate:debate",
      round: 1,
      receivedContext: [{ channel: "cross_exam" }],
    },
    {
      id: `mod_r2_${prefix}`,
      dependsOn: [],
      parentRunId: original.id,
      continuationIndex: 2,
      continuesRunId: original.id,
      stance,
      group: "debate:debate",
      round: 2,
    },
    {
      id: `mod_r2_cx_${prefix}`,
      dependsOn: [],
      parentRunId: original.id,
      continuationIndex: 3,
      continuesRunId: original.id,
      stance,
      group: "debate:debate",
      round: 2,
      receivedContext: [{ channel: "cross_exam" }],
    },
    {
      id: `mod_closing_${prefix}`,
      dependsOn: [],
      parentRunId: original.id,
      continuationIndex: 4,
      continuesRunId: original.id,
      stance,
      group: "debate:debate",
      round: 2,
      receivedContext: [{ channel: "closing" }],
    },
  ];
}

function debateRuns(rounds: number): GraphRunLike[] {
  return [
    { id: "mod", dependsOn: [], parentRunId: null, kind: "agent" },
    ...debateSide("pro", "pro", rounds),
    ...debateSide("con", "con", rounds),
  ];
}

function debateMultibeatRuns(): GraphRunLike[] {
  return [
    { id: "mod", dependsOn: [], parentRunId: null, kind: "agent" },
    ...debateMultibeatSide("pro", "pro"),
    ...debateMultibeatSide("con", "con"),
  ];
}

describe("computeGraphFold · debate compound", () => {
  it("folds all debater runs under the moderator unit", () => {
    const runs = debateRuns(4);
    expect(debateModeratorId(runs, null)).toBe("mod");
    const fold = computeGraphFold(runs, null);
    expect(fold.debateUnits.has("mod")).toBe(true);
    expect(fold.folded.size).toBe(8);
    expect(fold.unitOf.get("mod_r1_pro")).toBe("mod");
    expect(fold.unitOf.get("mod_r4_con")).toBe("mod");
  });

  it("always expands debate grid without requiring expandedUnits", () => {
    const { nodeIds, subTeams } = buildGraphStructure(
      debateRuns(4),
      "__input__",
    );
    expect(nodeIds).toContain("mod");
    expect(nodeIds).toContain("mod_r1_pro");
    expect(nodeIds).toContain("mod_r4_con");
    const debateTeam = subTeams.find((t) => t.parentId === "mod");
    expect(debateTeam?.memberIds).toEqual(
      expect.arrayContaining([
        "mod_r1_pro",
        "mod_r1_con",
        "mod_r4_pro",
        "mod_r4_con",
      ]),
    );
  });

  it("folds cross-exam into same-round statement; closing stays a column (multibeat)", () => {
    const runs = debateMultibeatRuns();
    const { nodeIds, rawEdges, subTeams } = buildGraphStructure(
      runs,
      "__input__",
    );
    // 每方 3 列：首轮陈词（含折进的质询）+ 第2轮陈词（含质询）+ 结辩。
    const debateTeam = subTeams.find((t) => t.parentId === "mod");
    expect(debateTeam?.memberIds).toHaveLength(6);
    for (const id of [
      "mod_r1_pro",
      "mod_r2_pro",
      "mod_closing_pro",
      "mod_r1_con",
      "mod_r2_con",
      "mod_closing_con",
    ]) {
      expect(nodeIds).toContain(id);
      expect(debateTeam?.memberIds).toContain(id);
    }
    for (const id of [
      "mod_r1_cx_pro",
      "mod_r2_cx_pro",
      "mod_r1_cx_con",
      "mod_r2_cx_con",
    ]) {
      expect(nodeIds).not.toContain(id);
      expect(debateTeam?.memberIds).not.toContain(id);
    }
    // 修订链：轮→轮→结辩，无质询 phantom。
    const revEdges = rawEdges
      .filter((e) => e.kind === "continuation")
      .map((e) => `${e.source}->${e.target}`)
      .sort();
    expect(revEdges).toEqual(
      [
        "mod_r1_con->mod_r2_con",
        "mod_r1_pro->mod_r2_pro",
        "mod_r2_con->mod_closing_con",
        "mod_r2_pro->mod_closing_pro",
      ].sort(),
    );
    // 侧栏仍可辨识 beat 文案；图上质询角标随独立节点消失。
    expect(debateBeatLabel({ round: 1, revision: 2, beat: "cross_exam" })).toBe(
      "第 1 轮·质询",
    );
    expect(debateBeatLabel({ round: 2, revision: 3, beat: "statement" })).toBe(
      "第 2 轮",
    );
    expect(debateBeatLabel({ round: 2, revision: 5, beat: "closing" })).toBe(
      "结辩",
    );
  });
});

describe("debate beat fold helpers", () => {
  it("aggregates status with running/failed over completed", () => {
    expect(aggregateDebateRoundStatus(["completed", "running"])).toBe(
      "running",
    );
    expect(aggregateDebateRoundStatus(["completed", "failed"])).toBe("failed");
    expect(aggregateDebateRoundStatus(["completed", "completed"])).toBe(
      "completed",
    );
  });

  it("labels live phase as 质询作答中 when CX is active", () => {
    expect(debateRoundActiveBeat("completed", ["running"])).toBe("cross_exam");
    expect(debateRoundPhaseLabel("running", "cross_exam", true)).toBe(
      "质询作答中",
    );
    expect(debateRoundPhaseLabel("running", "statement", true)).toBe("立论中");
    expect(debateRoundPhaseLabel("completed", "statement", true)).toBeNull();
  });

  it("settled mark: 含质询 on completed, 质询作答失败 when CX failed", () => {
    expect(debateRoundSettledMark("completed", true, ["completed"])).toEqual({
      label: "含质询",
      mode: "suffix",
    });
    expect(debateRoundSettledMark("failed", true, ["failed"])).toEqual({
      label: "质询作答失败",
      mode: "replace",
    });
    expect(debateRoundSettledMark("failed", true, ["completed"])).toBeNull();
    expect(debateRoundSettledMark("running", true, ["running"])).toBeNull();
    expect(debateRoundSettledMark("completed", false, [])).toBeNull();
  });

  it("picks CX activate id: active > failed > latest", () => {
    expect(
      pickDebateCrossExamActivateId([
        { id: "a", status: "completed" },
        { id: "b", status: "running" },
        { id: "c", status: "failed" },
      ]),
    ).toBe("b");
    expect(
      pickDebateCrossExamActivateId([
        { id: "a", status: "completed" },
        { id: "b", status: "failed" },
        { id: "c", status: "completed" },
      ]),
    ).toBe("b");
    expect(
      pickDebateCrossExamActivateId([
        { id: "a", status: "completed" },
        { id: "b", status: "completed" },
      ]),
    ).toBe("b");
    expect(pickDebateCrossExamActivateId([])).toBeNull();
  });
});

describe("buildGraphStructure · bookend sink edges", () => {
  const captain = (): GraphRunLike => ({
    id: "captain",
    dependsOn: [],
    kind: "captain",
  });

  const sinkTargets = (edges: { source: string; target: string }[]) =>
    edges
      .filter((e) => e.target === "captain")
      .map((e) => e.source)
      .sort();

  it("fans parallel leaves into the CEO", () => {
    const { rawEdges } = buildGraphStructure(
      [captain(), run("w1"), run("w2"), run("w3")],
      "__input__",
    );
    expect(sinkTargets(rawEdges)).toEqual(["w1", "w2", "w3"]);
    expect(
      rawEdges.filter((e) => e.source === "__input__").map((e) => e.target),
    ).toEqual(expect.arrayContaining(["w1", "w2", "w3"]));
  });

  it("connects only the serial chain tip to the CEO", () => {
    const { rawEdges } = buildGraphStructure(
      [captain(), run("s1"), run("s2", ["s1"]), run("s3", ["s2"])],
      "__input__",
    );
    expect(sinkTargets(rawEdges)).toEqual(["s3"]);
    expect(
      rawEdges.some((e) => e.source === "__input__" && e.target === "s1"),
    ).toBe(true);
  });

  it("connects the debate moderator unit to the CEO", () => {
    const { rawEdges } = buildGraphStructure(
      [captain(), ...debateRuns(2)],
      "__input__",
    );
    expect(sinkTargets(rawEdges)).toEqual(["mod"]);
  });

  it("补派 replaces_run_id：接替边 + 失败节点不再汇入 CEO + 补派不挂 input", () => {
    const { rawEdges } = buildGraphStructure(
      [
        captain(),
        run("w1"),
        run("w2"),
        run("w1b", [], { replacesRunId: "w1" }),
      ],
      "__input__",
    );
    expect(
      rawEdges.some(
        (e) => e.kind === "handoff" && e.source === "w1" && e.target === "w1b",
      ),
    ).toBe(true);
    expect(sinkTargets(rawEdges)).toEqual(["w1b", "w2"]);
    expect(
      rawEdges.some((e) => e.source === "__input__" && e.target === "w1b"),
    ).toBe(false);
    expect(
      rawEdges.some((e) => e.source === "__input__" && e.target === "w1"),
    ).toBe(true);
  });

  it("补派后下游 depends_on 改写指向新 run：主干依赖边自然成立", () => {
    const { rawEdges } = buildGraphStructure(
      [
        captain(),
        run("w1"),
        run("w1b", [], { replacesRunId: "w1" }),
        run("w2", ["w1b"]),
      ],
      "__input__",
    );
    expect(
      rawEdges.some(
        (e) => e.kind === "dep" && e.source === "w1b" && e.target === "w2",
      ),
    ).toBe(true);
    expect(sinkTargets(rawEdges)).toEqual(["w2"]);
    expect(
      rawEdges.some((e) => e.source === "w1" && e.target === "captain"),
    ).toBe(false);
  });
});
