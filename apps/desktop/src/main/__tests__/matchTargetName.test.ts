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
      status: "matched",
      name: "Reports",
      isDirectory: true,
    });
  });

  it("uses unique contains match when no exact", () => {
    expect(matchTargetName(entries, "photo")).toEqual({
      status: "matched",
      name: "Photos",
      isDirectory: true,
    });
  });

  it("prefers the unique dir among multiple contains matches", () => {
    expect(matchTargetName(entries, "report")).toEqual({
      status: "matched",
      name: "Reports",
      isDirectory: true,
    });
  });

  it("returns ambiguous when contains is ambiguous across dirs", () => {
    const multi = [
      { name: "June Reports", isDirectory: true },
      { name: "July Reports", isDirectory: true },
    ];
    expect(matchTargetName(multi, "Reports")).toEqual({
      status: "ambiguous",
    });
  });

  it("returns none for zero matches", () => {
    expect(matchTargetName(entries, "nowhere")).toEqual({ status: "none" });
  });

  it("returns none for blank target", () => {
    expect(matchTargetName(entries, "  ")).toEqual({ status: "none" });
  });

  it("can uniquely match a file when no dir competes", () => {
    expect(matchTargetName(entries, "notes")).toEqual({
      status: "matched",
      name: "notes.txt",
      isDirectory: false,
    });
  });
});
