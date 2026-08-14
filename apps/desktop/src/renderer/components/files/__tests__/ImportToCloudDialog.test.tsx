// @vitest-environment jsdom

import { ImportToCloudDialog } from "@/components/files/ImportToCloudDialog";
import { pickLocalFolderRoot } from "@/lib/bindLocalFolder";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/bindLocalFolder", () => ({
  pickLocalFolderRoot: vi.fn(),
}));
vi.mock("@/lib/importToCloudJob", () => ({
  isImportToCloudJobRunning: () => false,
  startImportToCloudJob: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
}));

describe("ImportToCloudDialog submit failure tone", () => {
  it("picker failure is muted, not destructive", async () => {
    vi.mocked(pickLocalFolderRoot).mockResolvedValue({
      ok: false,
      reason: "unavailable",
      message: "当前环境不能选本机文件夹",
    });
    render(<ImportToCloudDialog open onOpenChange={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByText("选择文件夹…"));
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("当前环境不能选本机文件夹");
    expect(alert.className).toContain("text-muted-foreground");
    expect(alert.className).not.toContain("destructive");
  });
});
