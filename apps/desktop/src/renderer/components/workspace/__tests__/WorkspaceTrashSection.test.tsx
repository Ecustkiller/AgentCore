// @vitest-environment jsdom
/**
 * 「我的文件」的软删区 —— 云端工作区的可逆删除按 ws id 列出并一键还原。
 *
 * 与右坞同一块面板、同一套文案：保留天数取服务端的数，且必须继续说清「系统回收站里的
 * 删除不在此列」——这块面板从来只管工作区软删区那一条轨。
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/workspaces", () => ({
  wsListTrash: vi.fn(),
  wsRestoreTrash: vi.fn(),
}));

vi.mock("@/services/workspace", () => ({
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
}));

import { wsListTrash, wsRestoreTrash } from "@/services/workspaces";
import { WorkspaceTrashSection } from "../TrashSection";

afterEach(() => vi.restoreAllMocks());

describe("文件页的软删区", () => {
  it("按 ws id 列出条目、照实说保留期，并能还原回原路径", async () => {
    vi.mocked(wsListTrash).mockResolvedValue({
      entries: [
        {
          entryId: "t1",
          originalPath: "报告/终稿.md",
          name: "终稿.md",
          isDir: false,
          deletedAt: "2026-08-04T00:00:00Z",
        },
      ],
      retentionDays: 30,
    });
    vi.mocked(wsRestoreTrash).mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <TooltipProvider>
        <WorkspaceTrashSection wsId="folder:f1" />
      </TooltipProvider>,
    );

    expect(await screen.findByText("终稿.md")).toBeTruthy();
    expect(wsListTrash).toHaveBeenCalledWith("folder:f1");
    expect(screen.getByText(/保留约 30 天/)).toBeTruthy();
    // 系统回收站是另一条轨，面板不得冒充能一键找回。
    expect(screen.getByText(/本地系统回收站删除不在此列/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("还原"));
    await waitFor(() =>
      expect(wsRestoreTrash).toHaveBeenCalledWith("folder:f1", "t1"),
    );
    // 还原后重新拉一次，列表不留幻影。
    await waitFor(() => expect(wsListTrash).toHaveBeenCalledTimes(2));
  });

  it("空的时候说清什么会进来", async () => {
    vi.mocked(wsListTrash).mockResolvedValue({
      entries: [],
      retentionDays: 30,
    });

    render(
      <TooltipProvider>
        <WorkspaceTrashSection wsId="folder:f1" />
      </TooltipProvider>,
    );

    expect(await screen.findByText("软删区为空")).toBeTruthy();
  });
});
