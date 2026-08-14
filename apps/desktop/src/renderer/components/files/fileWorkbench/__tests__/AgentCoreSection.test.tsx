// @vitest-environment jsdom
/**
 * 条目区标题——按作用域「全局设定」/「本文件夹设定」，与盘上 `AgentCore/`（「AI 工作间」）消歧。
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/files/fileWorkbench/EntriesSection", () => ({
  EntriesSection: () => <div data-testid="entries" />,
}));

import { AgentCoreSection } from "../AgentCoreSection";

function renderSection(scope: "global" | "folder") {
  return render(
    <AgentCoreSection
      scope={
        scope === "global"
          ? { kind: "global" }
          : { kind: "folder", folderId: "F1" }
      }
      memoryActivePath={null}
      documentActivePath={null}
      onOpenEntry={() => undefined}
      onEntryDeleted={() => undefined}
      onEntryRenamed={() => undefined}
    />,
  );
}

describe("AgentCoreSection 标题", () => {
  it("全局显示「全局设定」、文件夹显示「本文件夹设定」，不再叫记忆或 AgentCore", () => {
    const { unmount } = renderSection("global");
    expect(screen.getByText("全局设定")).toBeTruthy();
    expect(screen.queryByText("本文件夹设定")).toBeNull();
    expect(screen.queryByText("记忆")).toBeNull();
    expect(screen.queryByText("AgentCore")).toBeNull();
    unmount();

    renderSection("folder");
    expect(screen.getByText("本文件夹设定")).toBeTruthy();
    expect(screen.queryByText("全局设定")).toBeNull();
    expect(screen.queryByText("记忆")).toBeNull();
    expect(screen.queryByText("AgentCore")).toBeNull();
  });
});
