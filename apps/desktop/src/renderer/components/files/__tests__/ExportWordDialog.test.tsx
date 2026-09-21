// @vitest-environment jsdom

import { ExportWordDialog } from "@/components/files/ExportWordDialog";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("ExportWordDialog", () => {
  it("点选即导出对应档位，不经过确认", () => {
    const onPick = vi.fn();
    render(
      <ExportWordDialog
        open
        fileName="起诉状.md"
        onOpenChange={vi.fn()}
        onPick={onPick}
      />,
    );
    expect(screen.getByText("同目录生成 起诉状.docx")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /正式文书/ }));
    expect(onPick).toHaveBeenCalledWith("official");
  });

  it("技术报告走 standard", () => {
    const onPick = vi.fn();
    render(
      <ExportWordDialog
        open
        fileName="方案.md"
        onOpenChange={vi.fn()}
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /技术报告/ }));
    expect(onPick).toHaveBeenCalledWith("standard");
  });

  it("取消只关窗、不导出", () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ExportWordDialog
        open
        fileName="方案.md"
        onOpenChange={onOpenChange}
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).not.toHaveBeenCalled();
  });
});
