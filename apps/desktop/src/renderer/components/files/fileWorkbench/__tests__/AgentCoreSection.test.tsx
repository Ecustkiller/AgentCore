// @vitest-environment jsdom
/**
 * 条目区标题——显示名与盘上 `AgentCore/`（文件树里的「AI 工作间」）消歧。
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
  it("全局与文件夹两处作用域都显示「记忆」，不再叫 AgentCore", () => {
    const { unmount } = renderSection("global");
    expect(screen.getByText("记忆")).toBeTruthy();
    expect(screen.queryByText("AgentCore")).toBeNull();
    unmount();

    renderSection("folder");
    expect(screen.getByText("记忆")).toBeTruthy();
    expect(screen.queryByText("AgentCore")).toBeNull();
  });
});
