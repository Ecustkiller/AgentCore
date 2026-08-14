// @vitest-environment jsdom
/**
 * 「我的文件」的版本面板 —— 列出云端文件夹的留存版本，并能回滚到其中一个。
 *
 * 回滚前的确认必须照实说 overlay 的边界
 * （新建文件不删、未进包的目录不还原），不许加码成「完整还原」。
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/workspaces", () => ({
  wsListSnapshots: vi.fn(),
  wsCreateSnapshot: vi.fn(),
  wsRestoreSnapshot: vi.fn(),
  wsDownloadSnapshot: vi.fn(),
}));

import {
  wsCreateSnapshot,
  wsListSnapshots,
  wsRestoreSnapshot,
} from "@/services/workspaces";
import { WorkspaceVersionsPanel } from "../WorkspaceVersionsPanel";

afterEach(() => vi.restoreAllMocks());

function renderPanel() {
  return render(
    <TooltipProvider>
      <WorkspaceVersionsPanel wsId="folder:f1" name="季度报告" />
    </TooltipProvider>,
  );
}

describe("文件页的版本面板", () => {
  it("列出该工作区的版本，并按诚实口径回滚", async () => {
    vi.mocked(wsListSnapshots).mockResolvedValue([
      {
        snapshotId: "snap-1",
        label: "改前留个版本",
        createdAt: "2026-08-01T03:00:00Z",
        sizeBytes: 2048,
      },
    ]);
    vi.mocked(wsRestoreSnapshot).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel();

    expect(await screen.findByText("改前留个版本")).toBeTruthy();
    expect(wsListSnapshots).toHaveBeenCalledWith("folder:f1");

    fireEvent.click(screen.getByLabelText("恢复到这个版本"));
    // 确认文案照抄现有实现的能力边界，不吹「完整还原」。
    expect(confirm.mock.calls[0][0]).toContain("尽最大努力");
    expect(confirm.mock.calls[0][0]).toContain("新建的文件不会被删除");
    await waitFor(() =>
      expect(wsRestoreSnapshot).toHaveBeenCalledWith("folder:f1", "snap-1"),
    );
  });

  it("没有版本时给出留版本的去处，而不是空白", async () => {
    vi.mocked(wsListSnapshots).mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText("暂无版本")).toBeTruthy();
  });

  it("「留版本」打到 ws-id 版快照接口，并刷新列表", async () => {
    vi.mocked(wsListSnapshots).mockResolvedValue([]);
    vi.mocked(wsCreateSnapshot).mockResolvedValue({
      snapshotId: "snap-2",
      label: "定稿",
      createdAt: "2026-08-05T03:00:00Z",
      sizeBytes: 10,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "留版本" }));
    fireEvent.change(screen.getByLabelText("版本名"), {
      target: { value: "定稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(wsCreateSnapshot).toHaveBeenCalledWith("folder:f1", "定稿"),
    );
    await waitFor(() => expect(wsListSnapshots).toHaveBeenCalledTimes(2));
  });

  it("拉不到版本时说出来并可重试，而不是假装为空", async () => {
    vi.mocked(wsListSnapshots).mockRejectedValue(new Error("boom"));
    renderPanel();

    expect(await screen.findByText("版本没能加载出来。")).toBeTruthy();
    expect(screen.queryByText("暂无版本")).toBeNull();
  });
});
