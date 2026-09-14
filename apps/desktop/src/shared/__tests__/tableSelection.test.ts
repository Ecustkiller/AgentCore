import { describe, expect, it } from "vitest";
import { TABLE_SELECTION_MAX, capTableSelection } from "../tableSelection";

describe("capTableSelection", () => {
  it("keeps unique ids and truncates to the prompt budget", () => {
    const ids = Array.from({ length: 50 }, (_, i) => ` r${i} `);
    ids.push("r0", "");
    const out = capTableSelection(ids);
    expect(out).toHaveLength(TABLE_SELECTION_MAX);
    expect(out[0]).toBe("r0");
    expect(out[39]).toBe("r39");
  });
});
