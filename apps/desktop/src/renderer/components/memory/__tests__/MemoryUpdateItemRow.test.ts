import { describe, expect, it, vi } from "vitest";
import {
  memoryScopeOverview,
  memoryScopePillLabel,
} from "../MemoryUpdateItemRow";

vi.mock("@/hooks/useFolders", () => ({
  getFolders: () => [{ id: "F1", name: "AgentCore" }],
}));

describe("memory scope labels", () => {
  it("labels global and named folder", () => {
    expect(memoryScopePillLabel("global")).toBe("全局");
    expect(memoryScopePillLabel("project", "F1")).toBe("本文件夹 · AgentCore");
    expect(memoryScopePillLabel("project", "missing")).toBe("本文件夹");
  });

  it("builds card scope overview across layers", () => {
    expect(
      memoryScopeOverview([
        { scope: "global" },
        { scope: "project", projectId: "F1" },
      ]),
    ).toBe("全局 + 本文件夹 · AgentCore");
  });
});
