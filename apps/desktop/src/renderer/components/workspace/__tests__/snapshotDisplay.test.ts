import {
  classifySnapshotLabel,
  snapshotDisplayHint,
  snapshotDisplayTitle,
  visibleSnapshots,
} from "@/components/workspace/snapshotDisplay";
import { describe, expect, it } from "vitest";

describe("snapshotDisplay", () => {
  it("classifies null as auto and plain names as kept", () => {
    expect(classifySnapshotLabel(null)).toBe("auto");
    expect(classifySnapshotLabel("发版前")).toBe("kept");
  });

  it("recognizes system labels", () => {
    expect(classifySnapshotLabel("导出")).toBe("system");
    expect(classifySnapshotLabel("导出到本地")).toBe("system");
    expect(classifySnapshotLabel("浏览器预览")).toBe("system");
    expect(classifySnapshotLabel("合回到本机")).toBe("system");
    expect(classifySnapshotLabel("turn-baseline:msg-1")).toBe("system");
    expect(classifySnapshotLabel("handoff:2026-08-11T12:00:00Z")).toBe(
      "system",
    );
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

  it("hides turn baselines and transport byproducts, keeps handoff", () => {
    const visible = visibleSnapshots([
      { id: "1", label: "发版前" },
      { id: "2", label: null },
      { id: "3", label: "导出" },
      { id: "4", label: "turn-baseline:m1" },
      { id: "5", label: "handoff:2026-01-01T00:00:00Z" },
      { id: "6", label: "导出到本地" },
      { id: "7", label: "浏览器预览" },
      { id: "8", label: "合回到本机" },
    ]);
    expect(visible.map((s) => s.id)).toEqual(["1", "2", "5"]);
  });
});
