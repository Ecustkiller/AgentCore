// @vitest-environment jsdom

import { FileTree } from "@/components/files/FileTree";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileNode, FileSource } from "@/lib/fileSource";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/files/FileTreeRowMenu", () => ({
  FileTreeRowMenu: () => null,
}));

const NOTICE = /条目较多，仅显示前 \d+ 项/;

function node(path: string, isDir: boolean): FileNode {
  return { path, name: path.slice(path.lastIndexOf("/") + 1), isDir };
}

/** A cloud-ish source: lazy per-directory, and it reports its own cap. */
function boundedSource(
  levels: Record<string, { entries: FileNode[]; truncated: boolean }>,
): FileSource {
  return {
    id: "workspace:test",
    label: "工作区",
    caps: { watch: false, transfer: false, edit: false, snapshots: false },
    listDir: async (dir) => levels[dir]?.entries ?? [],
    listDirBounded: async (dir) =>
      levels[dir] ?? { entries: [], truncated: false },
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async () => {},
    move: async () => {},
    delete: async () => {},
  };
}

describe("FileTree 截断提示（诚实优先于容量）", () => {
  it("根层命中上限时说出来，而不是把短清单当作全部", async () => {
    const source = boundedSource({
      "": { entries: [node("a.md", false)], truncated: true },
    });
    render(
      <TooltipProvider>
        <FileTree source={source} onOpenFile={() => {}} />
      </TooltipProvider>,
    );
    expect(await screen.findByText("a.md")).toBeTruthy();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it("未截断的层不出提示；展开后被截断的子目录才出", async () => {
    const source = boundedSource({
      "": { entries: [node("site", true)], truncated: false },
      site: { entries: [node("site/index.html", false)], truncated: true },
    });
    render(
      <TooltipProvider>
        <FileTree source={source} onOpenFile={() => {}} />
      </TooltipProvider>,
    );
    expect(await screen.findByText("site")).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();

    fireEvent.click(screen.getByText("site"));
    await waitFor(() => expect(screen.getByText("index.html")).toBeTruthy());
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });
});
