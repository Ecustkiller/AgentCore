import {
  AGENTCORE_ROOT,
  AGENTCORE_ROOT_LABEL,
  AGENTCORE_ROOT_TOOLTIP,
  countDescendantFiles,
  isAgentCoreMemoryDirPath,
  isAgentCoreRootDir,
} from "@/lib/stageDirs";
import { describe, expect, it } from "vitest";

describe("stageDirs", () => {
  it("约定根呈现名与磁盘真名分开", () => {
    expect(AGENTCORE_ROOT).toBe("AgentCore");
    expect(AGENTCORE_ROOT_LABEL).toBe(".agentcore");
    expect(isAgentCoreRootDir("AgentCore")).toBe(true);
    expect(isAgentCoreRootDir("AgentCore/文档")).toBe(false);
    expect(isAgentCoreRootDir("src/AgentCore")).toBe(false);
    expect(AGENTCORE_ROOT_TOOLTIP).toContain("规则");
    expect(AGENTCORE_ROOT_TOOLTIP).not.toMatch(/记忆/);
  });

  it("hides the leftover AgentCore/记忆 dir path", () => {
    expect(isAgentCoreMemoryDirPath("AgentCore/记忆")).toBe(true);
    expect(isAgentCoreMemoryDirPath("AgentCore/记忆/画像.md")).toBe(true);
    expect(isAgentCoreMemoryDirPath("AgentCore")).toBe(false);
    expect(isAgentCoreMemoryDirPath("记忆")).toBe(false);
    expect(isAgentCoreMemoryDirPath("docs/记忆")).toBe(false);
  });

  it("统计后代文件数（含子目录内文件）", () => {
    const map = new Map<string, { isDir: boolean; path: string }[]>([
      [
        "AgentCore",
        [
          { isDir: false, path: "AgentCore/a.md" },
          { isDir: true, path: "AgentCore/文档" },
        ],
      ],
      ["AgentCore/文档", [{ isDir: false, path: "AgentCore/文档/b.md" }]],
    ]);
    expect(countDescendantFiles("AgentCore", (d) => map.get(d))).toBe(2);
    expect(countDescendantFiles("missing", (d) => map.get(d))).toBe(0);
  });
});
