import { describe, expect, it } from "vitest";
import { revisionVersionBadge, statusFaceLabel } from "../shared";

describe("statusFaceLabel", () => {
  it("shows 排队中 for pending and ready", () => {
    expect(statusFaceLabel("pending", null).text).toBe("排队中");
    expect(statusFaceLabel("ready", null).text).toBe("排队中");
  });

  it("shows live elapsed for running workers", () => {
    const face = statusFaceLabel("running", null, 45);
    expect(face.text).toBe("执行中 · 45s");
    expect(face.tickElapsed).toBe(true);
  });

  it("omits elapsed suffix before 1 second", () => {
    expect(statusFaceLabel("running", null, 0).text).toBe("执行中");
  });

  it("shows completion duration for finished runs", () => {
    expect(statusFaceLabel("completed", 45_000).text).toBe("已完成 · 45s");
    expect(statusFaceLabel("completed", null).text).toBe("已完成");
  });

  it("shows failure and cancelled states", () => {
    expect(statusFaceLabel("failed", null).text).toBe("失败");
    expect(statusFaceLabel("cancelled", null).text).toBe("已停止");
  });
});

describe("revisionVersionBadge", () => {
  it("returns vN for hot-fix revision nodes only", () => {
    expect(revisionVersionBadge(0)).toBeNull();
    expect(revisionVersionBadge(1)).toBeNull();
    expect(revisionVersionBadge(2)).toBe("v2");
    expect(revisionVersionBadge(3)).toBe("v3");
  });
});
