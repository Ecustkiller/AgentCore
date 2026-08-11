import {
  classifySnapshotLabel,
  groupSnapshotsByKind,
  isSystemSnapshotLabel,
  snapshotDisplayHint,
  snapshotDisplayTitle,
} from "@/components/workspace/snapshotDisplay";
import { describe, expect, it } from "vitest";

describe("snapshotDisplay", () => {
  it("classifies null as auto and plain names as kept", () => {
    expect(classifySnapshotLabel(null)).toBe("auto");
    expect(classifySnapshotLabel("发版前")).toBe("kept");
  });

  it("recognizes system labels", () => {
    expect(isSystemSnapshotLabel("导出")).toBe(true);
    expect(isSystemSnapshotLabel("导出到本地")).toBe(true);
    expect(isSystemSnapshotLabel("浏览器预览")).toBe(true);
    expect(isSystemSnapshotLabel("合回到本机")).toBe(true);
    expect(isSystemSnapshotLabel("turn-baseline:msg-1")).toBe(true);
    expect(isSystemSnapshotLabel("handoff:2026-08-11T12:00:00Z")).toBe(true);
    expect(isSystemSnapshotLabel("发版前")).toBe(false);
    expect(classifySnapshotLabel("导出")).toBe("system");
  });

  it("rewrites opaque system titles and keeps Chinese exact labels", () => {
    expect(snapshotDisplayTitle(null)).toBe("自动备份");
    expect(snapshotDisplayTitle("发版前")).toBe("发版前");
    expect(snapshotDisplayTitle("导出")).toBe("导出");
    expect(snapshotDisplayTitle("turn-baseline:abc")).toBe("回合开始前");
    expect(snapshotDisplayTitle("handoff:2026-01-01T00:00:00Z")).toBe(
      "本机交接",
    );
    expect(snapshotDisplayHint("turn-baseline:abc")).toBe("turn-baseline:abc");
    expect(snapshotDisplayHint("导出")).toBeNull();
  });

  it("groups while preserving input order within each kind", () => {
    const grouped = groupSnapshotsByKind([
      { id: "1", label: "发版前" },
      { id: "2", label: null },
      { id: "3", label: "导出" },
      { id: "4", label: "再留一版" },
      { id: "5", label: null },
      { id: "6", label: "turn-baseline:m1" },
    ]);
    expect(grouped.kept.map((s) => s.id)).toEqual(["1", "4"]);
    expect(grouped.auto.map((s) => s.id)).toEqual(["2", "5"]);
    expect(grouped.system.map((s) => s.id)).toEqual(["3", "6"]);
  });
});
