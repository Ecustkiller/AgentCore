import { describe, expect, it } from "vitest";
import {
  PLAN_GRAPH_CAPABILITIES,
  type PlanType,
  planCapabilities,
} from "../planCapabilities";

const ALL_TYPES: PlanType[] = ["single_agent", "multi_agent", "debate"];

describe("planCapabilities", () => {
  it("covers every PlanType exactly once in the table", () => {
    expect(Object.keys(PLAN_GRAPH_CAPABILITIES).sort()).toEqual(
      [...ALL_TYPES].sort(),
    );
  });

  it("null / undefined falls back to single_agent (no graph caps)", () => {
    expect(planCapabilities(null)).toEqual(
      PLAN_GRAPH_CAPABILITIES.single_agent,
    );
    expect(planCapabilities(undefined)).toEqual(
      PLAN_GRAPH_CAPABILITIES.single_agent,
    );
  });

  it("debate shares auditInject with multi_agent (bug fix)", () => {
    expect(planCapabilities("multi_agent").auditInject).toBe(true);
    expect(planCapabilities("debate").auditInject).toBe(true);
    expect(planCapabilities("single_agent").auditInject).toBe(false);
  });

  it("team graph visibility", () => {
    expect(planCapabilities("single_agent").showsTeamGraph).toBe(false);
    expect(planCapabilities("multi_agent").showsTeamGraph).toBe(true);
    expect(planCapabilities("debate").showsTeamGraph).toBe(true);
  });

  it("force-expand debate units only for debate", () => {
    expect(planCapabilities("debate").forceExpandDebateUnits).toBe(true);
    expect(planCapabilities("multi_agent").forceExpandDebateUnits).toBe(false);
    expect(planCapabilities("single_agent").forceExpandDebateUnits).toBe(false);
  });

  it("inline default expanded for team turns", () => {
    expect(planCapabilities("multi_agent").inlineDefaultExpanded).toBe(true);
    expect(planCapabilities("debate").inlineDefaultExpanded).toBe(true);
    expect(planCapabilities("single_agent").inlineDefaultExpanded).toBe(false);
  });

  it("revision badge styles", () => {
    expect(planCapabilities("single_agent").revisionBadgeStyle).toBe("none");
    expect(planCapabilities("multi_agent").revisionBadgeStyle).toBe("hotfix");
    expect(planCapabilities("debate").revisionBadgeStyle).toBe("debate");
  });

  it("runRedirect stays multi_agent-only", () => {
    expect(planCapabilities("multi_agent").runRedirect).toBe(true);
    expect(planCapabilities("debate").runRedirect).toBe(false);
    expect(planCapabilities("single_agent").runRedirect).toBe(false);
  });
});
