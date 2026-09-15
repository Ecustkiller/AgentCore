// @vitest-environment jsdom
import { FileTree } from "@/components/files/FileTree";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileNode, FileSource } from "@/lib/fileSource";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  let entries: FileNode[] = [];
  return {
    id: "workspace:mkdir",
    label: "工作区",
    caps: { watch: false, transfer: false, edit: true, snapshots: false },
    listDir: async () => entries,
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async (path) => {
      const name = path.split("/").pop() ?? path;
      entries = [...entries, { path, name, isDir: true }];
    },
    move: async () => {},
    delete: async () => {},
  };
}

describe("FileTree mkdir", () => {
  it("toolbar 新建文件夹 creates 未命名文件夹 then enters rename", async () => {
    render(
      <TooltipProvider>
        <FileTree source={makeSource()} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );
    await screen.findByText("暂无文件");
    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    await waitFor(() => {
      expect(screen.getByDisplayValue("未命名文件夹")).toBeTruthy();
    });
  });

  it("a second 新建文件夹 increments the default name", async () => {
    const source = makeSource();
    render(
      <TooltipProvider>
        <FileTree source={source} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );
    await screen.findByText("暂无文件");
    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    await waitFor(() => {
      expect(screen.getByDisplayValue("未命名文件夹")).toBeTruthy();
    });
    fireEvent.blur(screen.getByDisplayValue("未命名文件夹"));
    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
    await waitFor(() => {
      expect(screen.getByDisplayValue("未命名文件夹 (2)")).toBeTruthy();
    });
  });
});
