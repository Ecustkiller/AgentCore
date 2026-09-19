// @vitest-environment jsdom
import { FileTree } from "@/components/files/FileTree";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileNode, FileSource } from "@/lib/fileSource";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/files/FileTreeRowMenu", () => ({
  FileTreeRowMenu: () => null,
}));
vi.mock("@/lib/toast", () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyActionError: vi.fn(),
  notifyWarning: vi.fn(),
  notifyInfo: vi.fn(),
}));
vi.mock("@/hooks/useFolders", () => ({ getFolders: vi.fn(() => []) }));

function makeSource(): FileSource {
  const entries: FileNode[] = [];
  return {
    id: "workspace:mkdir",
    label: "工作区",
    caps: { watch: false, transfer: false, edit: true, snapshots: false },
    listDir: async () => entries,
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async () => {
      throw new Error("mkdir should not be offered from the toolbar");
    },
    move: async () => {},
    delete: async () => {},
  };
}

describe("FileTree toolbar", () => {
  it("offers 新建文件 and not 新建文件夹", async () => {
    render(
      <TooltipProvider>
        <FileTree source={makeSource()} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );
    await screen.findByText("暂无文件");
    expect(screen.getByRole("button", { name: "新建文件" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新建文件夹" })).toBeNull();
  });
});
