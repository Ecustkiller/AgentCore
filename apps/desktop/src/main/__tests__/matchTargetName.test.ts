/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { matchTargetName } from "../fs/matchTargetName";

const entries = [
  { name: "Reports", isDirectory: true },
  { name: "reports-archive.zip", isDirectory: false },
  { name: "Photos", isDirectory: true },
  { name: "notes.txt", isDirectory: false },
];

describe("matchTargetName", () => {
  it("prefers case-insensitive exact basename", () => {
    expect(matchTargetName(entries, "reports")).toEqual({
      name: "Reports",
      isDirectory: true,
    });
  });

  it("uses unique contains match when no exact", () => {
    expect(matchTargetName(entries, "photo")).toEqual({
      name: "Photos",
      isDirectory: true,
    });
  });

  it("prefers the unique dir among multiple contains matches", () => {
    expect(matchTargetName(entries, "report")).toEqual({
      name: "Reports",
      isDirectory: true,
    });
  });

  it("returns null when contains is ambiguous across dirs", () => {
    const multi = [
      { name: "June Reports", isDirectory: true },
      { name: "July Reports", isDirectory: true },
    ];
    expect(matchTargetName(multi, "Reports")).toBeNull();
  });

  it("returns null for zero matches", () => {
    expect(matchTargetName(entries, "nowhere")).toBeNull();
  });

  it("returns null for blank target", () => {
    expect(matchTargetName(entries, "  ")).toBeNull();
  });

  it("can uniquely match a file when no dir competes", () => {
    expect(matchTargetName(entries, "notes")).toEqual({
      name: "notes.txt",
      isDirectory: false,
    });
  });
});
