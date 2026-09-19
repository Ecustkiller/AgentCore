import { parseCheckpointIntent } from "../checkpointIntent";
import { describe, expect, it } from "vitest";

describe("parseCheckpointIntent", () => {
  it("folds leftover wire names and unknowns into decision", () => {
    expect(parseCheckpointIntent("decision")).toBe("decision");
    expect(parseCheckpointIntent("kickoff")).toBe("decision");
    expect(parseCheckpointIntent("daily_review")).toBe("decision");
    expect(parseCheckpointIntent("proposal_pick")).toBe("decision");
    expect(parseCheckpointIntent("risk_ack")).toBe("decision");
    expect(parseCheckpointIntent(undefined)).toBe("decision");
    expect(parseCheckpointIntent(null)).toBe("decision");
    expect(parseCheckpointIntent("other")).toBe("decision");
  });
});
