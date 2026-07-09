import type { Execution } from "@/stores/execution";
import { describe, expect, it } from "vitest";
import {
  type GraphRunLike,
  buildGraphStructure,
  computeGraphFold,
  computeTopologicalRunWaves,
  computeWaves,
  debateModeratorId,
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
            revision: r.revision,
            revisionOf: r.revisionOf,
            kind: "agent",
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
});

describe("computeGraphFold · debate compound", () => {
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
      group: "debate:debate",
    };
    const revs: GraphRunLike[] = [];
    for (let r = 2; r <= rounds; r++) {
      revs.push({
        id: `mod_r${r}_${prefix}`,
        dependsOn: [],
        parentRunId: original.id,
        revision: r,
        revisionOf: original.id,
        stance,
        group: "debate:debate",
      });
    }
    return [original, ...revs];
  };

  const debateRuns = (rounds: number): GraphRunLike[] => [
    { id: "mod", dependsOn: [], parentRunId: null, kind: "agent" },
    ...side("pro", "pro", rounds),
    ...side("con", "con", rounds),
  ];

  it("folds all debater runs under the moderator unit", () => {
    const runs = debateRuns(4);
    expect(debateModeratorId(runs, null)).toBe("mod");
    const fold = computeGraphFold(runs, null);
    expect(fold.debateUnits.has("mod")).toBe(true);
    expect(fold.folded.size).toBe(8);
    expect(fold.unitOf.get("mod_r1_pro")).toBe("mod");
    expect(fold.unitOf.get("mod_r4_con")).toBe("mod");
  });

  it("collapsed graph exposes only the moderator as a top-level worker node", () => {
    const { nodeIds } = buildGraphStructure(debateRuns(4), "__input__");
    const workers = nodeIds.filter(
      (id) => id !== "__input__" && id !== "captain",
    );
    expect(workers).toEqual(["mod"]);
  });

  it("expanded graph includes all debater versions for drill-in layout", () => {
    const expanded = new Set(["mod"]);
    const { nodeIds } = buildGraphStructure(
      debateRuns(4),
      "__input__",
      expanded,
    );
    expect(nodeIds).toContain("mod_r1_pro");
    expect(nodeIds).toContain("mod_r4_con");
  });
});
