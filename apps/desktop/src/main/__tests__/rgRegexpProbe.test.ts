import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { allocateRgRegexpProbe } from "../fs/workspace/grep";

describe("allocateRgRegexpProbe", () => {
  it("concurrent allocations never share a probe path", async () => {
    const n = 40;
    const allocated = await Promise.all(
      Array.from({ length: n }, () => allocateRgRegexpProbe()),
    );
    try {
      const paths = allocated.map((a) => a.probePath);
      expect(new Set(paths).size).toBe(n);
      await Promise.all(paths.map((p) => access(p)));
    } finally {
      await Promise.all(allocated.map((a) => a.cleanup()));
    }
  });
});
