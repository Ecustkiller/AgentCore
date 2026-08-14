import {
  FILE_SORT_OPTIONS,
  fileSortLabel,
} from "@/components/files/fileWorkbench/FileSortMenu";
import { describe, expect, it } from "vitest";

describe("FileSortMenu", () => {
  it("只有名称与修改时间，没有按大小", () => {
    expect(FILE_SORT_OPTIONS.map((o) => o.value)).toEqual(["name", "mtime"]);
    expect(FILE_SORT_OPTIONS.map((o) => o.label)).toEqual([
      "名称",
      "修改时间（新的在前）",
    ]);
    expect(fileSortLabel("name")).toBe("名称");
    expect(fileSortLabel("mtime")).toBe("修改时间（新的在前）");
    expect(FILE_SORT_OPTIONS.some((o) => o.label.includes("大小"))).toBe(false);
  });
});
