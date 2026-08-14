// @vitest-environment jsdom

import { FileTree } from "@/components/files/FileTree";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileSource } from "@/lib/fileSource";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/files/FileTreeRowMenu", () => ({
  FileTreeRowMenu: () => null,
}));

function failingSource(): FileSource {
  return {
    id: "workspace:load-error",
    label: "工作区",
    caps: { watch: false, transfer: false, edit: false, snapshots: false },
    listDir: async () => {
      throw new Error("boom");
    },
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async () => {},
    move: async () => {},
    delete: async () => {},
  };
}

describe("FileTree load error tone", () => {
  it("embedded row 加载失败 is muted, not destructive", async () => {
    render(
      <TooltipProvider>
        <FileTree
          source={failingSource()}
          onOpenFile={() => {}}
          chrome={false}
        />
      </TooltipProvider>,
    );
    const line = await screen.findByText(/加载失败/);
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).not.toContain("destructive");
  });

  it("chrome InlineError 加载失败 is muted, not destructive", async () => {
    render(
      <TooltipProvider>
        <FileTree source={failingSource()} onOpenFile={() => {}} />
      </TooltipProvider>,
    );
    const line = await screen.findByText("加载失败");
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).not.toContain("destructive");
  });
});
