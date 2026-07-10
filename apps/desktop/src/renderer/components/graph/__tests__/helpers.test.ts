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

function debateSide(
  prefix: string,
  stance: "pro" | "con",
  rounds: number,
): GraphRunLike[] {
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
}

function debateRuns(rounds: number): GraphRunLike[] {
  return [
    { id: "mod", dependsOn: [], parentRunId: null, kind: "agent" },
    ...debateSide("pro", "pro", rounds),
    ...debateSide("con", "con", rounds),
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
});
