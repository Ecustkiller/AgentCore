// @vitest-environment jsdom

import { FileTree } from "@/components/files/FileTree";
import { __resetFileClipboardForTests } from "@/components/files/fileClipboard";
import { DRAG_MIME } from "@/components/files/fileTreeDrag";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getFolders } from "@/hooks/useFolders";
import type { FileNode, FileSource } from "@/lib/fileSource";
import { notifyActionError } from "@/lib/toast";
import type { FolderMeta } from "@/services/folders";
import { wsCopyFile, wsListFiles, wsMoveFile } from "@/services/workspaces";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/services/workspaces", () => ({
  wsMoveFile: vi.fn(async () => {}),
  wsCopyFile: vi.fn(async () => {}),
  wsListFiles: vi.fn(async () => ({ files: [], truncated: false })),
}));

function cloudFolder(id: string, relPath: string): FolderMeta {
  return {
    id,
    name: relPath.split("/").pop() ?? relPath,
    mode: "cloud",
    localRootId: null,
    localSubpath: null,
    relPath,
    parentRelPath: null,
  };
}

/** 一棵云文件夹树：`folder:<id>` 源，可传输 / 可改。 */
function makeSource(
  folderId: string,
  children: Record<string, FileNode[]>,
): FileSource & { moved: [string, string][]; wrote: string[] } {
  const moved: [string, string][] = [];
  const wrote: string[] = [];
  return {
    id: `workspace:folder:${folderId}`,
    label: folderId,
    caps: { watch: false, transfer: true, edit: true, snapshots: true },
    listDir: async (dir) => children[dir] ?? [],
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async () => {},
    move: async (src, dst) => {
      moved.push([src, dst]);
    },
    copy: async () => {},
    delete: async () => {},
    writeBytes: async (path) => {
      wrote.push(path);
    },
    moved,
    wrote,
  };
}

function file(name: string): FileNode {
  return { path: name, name, isDir: false };
}

function dir(name: string): FileNode {
  return { path: name, name, isDir: true };
}

/** 一次拖拽的 dataTransfer（`getData` 是 drop 时才读的那份载荷）。 */
function dragData(payload: object) {
  const raw = JSON.stringify(payload);
  return {
    types: [DRAG_MIME],
    getData: (type: string) => (type === DRAG_MIME ? raw : ""),
    files: [],
    items: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFolders).mockReturnValue([
    cloudFolder("design", "设计"),
    cloudFolder("icon", "设计/图标"),
    cloudFolder("docs", "文档"),
  ]);
  vi.mocked(wsListFiles).mockResolvedValue({ files: [], truncated: false });
  __resetFileClipboardForTests();
});

describe("跨源搬运（父文件夹 ↔ 子文件夹在中枢里是两棵树）", () => {
  it("把父文件夹里的文件拖进子文件夹的树，走的是既有 move 端点", async () => {
    const child = makeSource("icon", { "": [dir("线性")] });
    render(
      <TooltipProvider>
        <FileTree source={child} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );

    fireEvent.drop(await screen.findByText("线性"), {
      dataTransfer: dragData({
        sourceId: "workspace:folder:design",
        paths: ["稿件/a.png"],
      }),
    });

    await waitFor(() =>
      expect(wsMoveFile).toHaveBeenCalledWith(
        "folder:design",
        "稿件/a.png",
        "图标/线性/a.png",
      ),
    );
    // 没有退化成「下载再上传」。
    expect(child.wrote).toEqual([]);
  });

  it("拖到子树的空白根处 = 搬进这个子文件夹本身", async () => {
    const child = makeSource("icon", { "": [file("已有.png")] });
    const { container } = render(
      <TooltipProvider>
        <FileTree source={child} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );
    await screen.findByText("已有.png");

    fireEvent.drop(container.firstChild as Element, {
      dataTransfer: dragData({
        sourceId: "workspace:folder:design",
        paths: ["a.png"],
      }),
    });

    await waitFor(() =>
      expect(wsMoveFile).toHaveBeenCalledWith(
        "folder:design",
        "a.png",
        "图标/a.png",
      ),
    );
  });

  it("同源拖拽仍走源自己的 move，不绕 REST", async () => {
    const tree = makeSource("icon", { "": [dir("线性"), file("a.png")] });
    render(
      <TooltipProvider>
        <FileTree source={tree} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );

    fireEvent.drop(await screen.findByText("线性"), {
      dataTransfer: dragData({
        sourceId: "workspace:folder:icon",
        paths: ["a.png"],
      }),
    });

    await waitFor(() => expect(tree.moved).toEqual([["a.png", "线性/a.png"]]));
    expect(wsMoveFile).not.toHaveBeenCalled();
  });

  it("接不上的组合（两个顶层文件夹）诚实说明，而不是静默失败", async () => {
    const target = makeSource("docs", { "": [dir("归档")] });
    render(
      <TooltipProvider>
        <FileTree source={target} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );

    fireEvent.drop(await screen.findByText("归档"), {
      dataTransfer: dragData({
        sourceId: "workspace:folder:design",
        paths: ["a.png"],
      }),
    });

    await waitFor(() => expect(notifyActionError).toHaveBeenCalled());
    const [title, err] = vi.mocked(notifyActionError).mock.calls[0];
    expect(title).toBe("移动失败");
    expect((err as Error).message).toContain("同一个顶层文件夹");
    expect(wsMoveFile).not.toHaveBeenCalled();
  });

  it("复制到另一棵树：走 copy 端点，撞名按「副本」去重", async () => {
    const parent = makeSource("design", { "": [file("a.png")] });
    const child = makeSource("icon", { "": [dir("线性")] });
    vi.mocked(wsListFiles).mockResolvedValue({
      files: [
        { path: "图标/线性/a.png", isDir: false, sizeBytes: 1, mtimeMs: 1 },
      ],
      truncated: false,
    });
    render(
      <TooltipProvider>
        <FileTree source={parent} onOpenFile={vi.fn()} />
        <FileTree source={child} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );

    const row = await screen.findByText("a.png");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "c", ctrlKey: true });

    const target = await screen.findByText("线性");
    fireEvent.click(target);
    fireEvent.keyDown(target, { key: "v", ctrlKey: true });

    await waitFor(() =>
      expect(wsCopyFile).toHaveBeenCalledWith(
        "folder:design",
        "a.png",
        "图标/线性/a 副本.png",
      ),
    );
    expect(wsMoveFile).not.toHaveBeenCalled();
  });

  it("在一棵树里剪切、到另一棵树里粘贴（剪贴板全局一份）", async () => {
    const parent = makeSource("design", { "": [file("a.png")] });
    const child = makeSource("icon", { "": [dir("线性")] });
    render(
      <TooltipProvider>
        <FileTree source={parent} onOpenFile={vi.fn()} />
        <FileTree source={child} onOpenFile={vi.fn()} />
      </TooltipProvider>,
    );

    const row = await screen.findByText("a.png");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "x", ctrlKey: true });

    const target = await screen.findByText("线性");
    fireEvent.click(target);
    fireEvent.keyDown(target, { key: "v", ctrlKey: true });

    await waitFor(() =>
      expect(wsMoveFile).toHaveBeenCalledWith(
        "folder:design",
        "a.png",
        "图标/线性/a.png",
      ),
    );
  });
});
