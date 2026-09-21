import { AGENTCORE_ROOT_LABEL } from "@/lib/stageDirs";
import { describe, expect, it } from "vitest";

describe("AGENTCORE_ROOT_LABEL", () => {
  it("呈现名是小写点目录 .agentcore", () => {
    expect(AGENTCORE_ROOT_LABEL).toBe(".agentcore");
  });
});
