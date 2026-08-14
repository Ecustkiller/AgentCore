// @vitest-environment jsdom

import { FileTreeBatchDialogs } from "@/components/files/FileTreeBatchDialogs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("FileTreeBatchDialogs failure reason tone", () => {
  it("lists each failure reason in muted, not destructive", () => {
    render(
      <FileTreeBatchDialogs
        confirm={null}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
        failure={{
          title: "部分删除失败",
          failures: [{ path: "a.md", name: "a.md", reason: "没有权限" }],
        }}
        onCloseFailure={() => {}}
      />,
    );
    const reason = screen.getByText("没有权限");
    expect(reason.className).toContain("text-muted-foreground");
    expect(reason.className).not.toContain("destructive");
  });
});
