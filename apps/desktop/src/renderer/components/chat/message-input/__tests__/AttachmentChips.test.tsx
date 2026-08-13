// @vitest-environment jsdom
/**
 * 附件 chip 的上传态：附加后立刻可见「上传中」，失败留在草稿里并标出中文原因，
 * 落地后回到普通样式。
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentChips } from "../AttachmentChips";
import type { PendingAttachment } from "../composerAttachments";

function chip(over: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    id: "a1",
    key: "dropped:shot.png:1",
    name: "shot.png",
    path: "shot.png",
    text: "",
    truncated: false,
    kind: "file",
    binary: true,
    ...over,
  };
}

function renderChips(attachments: PendingAttachment[]) {
  return render(
    <TooltipProvider>
      <AttachmentChips attachments={attachments} onRemove={vi.fn()} />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("AttachmentChips 上传态", () => {
  it("上传中：标「上传中」而不是文件类型", () => {
    const { container } = renderChips([chip({ uploadState: "uploading" })]);
    expect(screen.getByText("上传中")).toBeTruthy();
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.queryByText("文件")).toBeNull();
    expect(
      container.querySelector('[data-upload-state="uploading"]'),
    ).toBeTruthy();
  });

  it("失败：chip 仍在，标「上传失败」", () => {
    const { container } = renderChips([
      chip({ uploadState: "error", uploadError: "上传附件到云端工作区失败" }),
    ]);
    expect(screen.getByText("上传失败")).toBeTruthy();
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(container.querySelector('[data-upload-state="error"]')).toBeTruthy();
  });

  it("落地后回到普通 chip", () => {
    const { container } = renderChips([
      chip({ workspacePath: "attachments/shot.png" }),
    ]);
    expect(screen.getByText("文件")).toBeTruthy();
    expect(screen.queryByText("上传中")).toBeNull();
    expect(container.querySelector("[data-upload-state]")).toBeNull();
  });
});
