import { describe, expect, it } from "vitest";
import {
  BOUNDARY_LABELS,
  BOUNDARY_ORDER,
  DEFAULT_PERMISSION_AXES,
  axesEqual,
  boundaryShortLabel,
  needsComputerConfirm,
  normalizeAxes,
  permissionAxesShortLabel,
} from "@/services/permissionAxes";

describe("workspace boundary", () => {
  it("defaults to folder and only accepts the three ids", () => {
    expect(DEFAULT_PERMISSION_AXES).toEqual({ boundary: "folder" });
    expect(BOUNDARY_ORDER).toEqual(["read", "folder", "computer"]);
    expect(normalizeAxes(undefined)).toEqual({ boundary: "folder" });
    expect(normalizeAxes({})).toEqual({ boundary: "folder" });
    expect(
      normalizeAxes({ file_write: "ask", command: "ask", host: "off" }),
    ).toEqual({ boundary: "folder" });
    expect(normalizeAxes({ boundary: "read" })).toEqual({ boundary: "read" });
    expect(normalizeAxes({ boundary: "nope" })).toEqual({ boundary: "folder" });
  });

  it("confirms only when moving onto 这台电脑", () => {
    const read = { boundary: "read" as const };
    const folder = { boundary: "folder" as const };
    const computer = { boundary: "computer" as const };
    expect(needsComputerConfirm(read, folder)).toBe(false);
    expect(needsComputerConfirm(folder, read)).toBe(false);
    expect(needsComputerConfirm(read, computer)).toBe(true);
    expect(needsComputerConfirm(folder, computer)).toBe(true);
    expect(needsComputerConfirm(computer, computer)).toBe(false);
    expect(needsComputerConfirm(computer, folder)).toBe(false);
  });

  it("labels only current boundary ids", () => {
    expect(boundaryShortLabel("read")).toBe("只看");
    expect(boundaryShortLabel("folder")).toBe("这个文件夹");
    expect(boundaryShortLabel("computer")).toBe("这台电脑");
    expect(permissionAxesShortLabel({ boundary: "folder" })).toBe("这个文件夹");
    expect(permissionAxesShortLabel("read")).toBe("只看");
    expect(permissionAxesShortLabel('{"boundary":"computer"}')).toBe("这台电脑");
    expect(permissionAxesShortLabel("less_interrupt")).toBeNull();
    expect(
      permissionAxesShortLabel({
        file_write: "session",
        command: "auto",
        host: "session",
      }),
    ).toBeNull();
    expect(permissionAxesShortLabel("not json")).toBeNull();
  });

  it("keeps short labels and equality", () => {
    for (const id of BOUNDARY_ORDER) {
      expect(BOUNDARY_LABELS[id].short.length).toBeGreaterThan(0);
      expect(axesEqual({ boundary: id }, { boundary: id })).toBe(true);
    }
    expect(axesEqual({ boundary: "read" }, { boundary: "folder" })).toBe(false);
  });
});
