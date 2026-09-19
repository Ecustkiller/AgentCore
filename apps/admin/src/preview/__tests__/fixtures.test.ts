import { PREVIEW_FIXTURES } from "@/preview/fixtures";
import { describe, expect, it } from "vitest";

describe("PREVIEW_FIXTURES catalog", () => {
  it("keeps live MLR representatives and drops specimen / preview:false names", () => {
    const names = PREVIEW_FIXTURES.map((f) => f.name);
    expect(names).toContain("multi_agent_multi_lens_research");
    expect(names).toContain("multi_agent_mlr_debate_acts");
    expect(names).not.toContain("multi_agent_legal_war_room");
    expect(names.some((n) => n.includes("stage_card"))).toBe(false);
  });
});
