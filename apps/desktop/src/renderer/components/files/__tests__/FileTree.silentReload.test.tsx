// @vitest-environment jsdom

import {
  FILE_TREE_SILENT_DEBOUNCE_MS,
  FileTree,
} from "@/components/files/FileTree";
import { notifyFileTreeChanged } from "@/components/files/fileTreeBus";
import type { FileTreeChromeState } from "@/components/files/fileTreeTypes";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileNode, FileSource } from "@/lib/fileSource";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/files/FileTreeRowMenu", () => ({
  FileTreeRowMenu: () => null,
}));

function file(path: string): FileNode {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    isDir: false,
  };
}

function dir(path: string): FileNode {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    isDir: true,
  };
}

function stubSource(
  id: string,
  listDir: FileSource["listDir"],
  extra: Partial<FileSource> = {},
): FileSource {
  return {
    id,
    label: id,
    caps: { watch: false, transfer: false, edit: true, snapshots: false },
    listDir,
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async () => {},
    move: async () => {},
    delete: async () => {},
    ...extra,
  };
}

function renderTree(
  source: FileSource,
  onChromeState?: (state: FileTreeChromeState) => void,
) {
  return render(
    <TooltipProvider>
      <FileTree
        source={source}
        onOpenFile={() => {}}
        onChromeState={onChromeState}
      />
    </TooltipProvider>,
  );
}

function refreshSpinning(): boolean {
  return !!screen.getByLabelText("刷新").querySelector(".animate-spin");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FileTree silent 补丁（AI / watch / focus）", () => {
  it("总线通知不转工具栏；人手刷新仍转", async () => {
    const listing = { current: [file("a.md")] };
    const source = stubSource("workspace:silent-chrome", async () => [
      ...listing.current,
    ]);
    const chrome: FileTreeChromeState[] = [];
    renderTree(source, (s) => chrome.push(s));

    expect(await screen.findByText("a.md")).toBeTruthy();
    const afterReady = chrome.length;
    listing.current = [file("a.md"), file("b.md")];
    act(() => {
      notifyFileTreeChanged({ sourceId: source.id, dir: "" });
    });
    await waitFor(() => expect(screen.getByText("b.md")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(chrome.slice(afterReady).every((s) => !s.loading)).toBe(true);
    expect(refreshSpinning()).toBe(false);

    const hang = {
      resolve: (_nodes: FileNode[]) => {},
      promise: Promise.resolve([] as FileNode[]),
    };
    hang.promise = new Promise<FileNode[]>((r) => {
      hang.resolve = r;
    });
    source.listDir = async () => hang.promise;
    fireEvent.click(screen.getByLabelText("刷新"));
    await waitFor(() => expect(refreshSpinning()).toBe(true));
    expect(chrome.some((s) => s.loading)).toBe(true);

    await act(async () => {
      hang.resolve([file("a.md"), file("b.md")]);
    });
    await waitFor(() => expect(refreshSpinning()).toBe(false));
  });

  it("silent 补丁保持已展开目录", async () => {
    const listing: Record<string, FileNode[]> = {
      "": [dir("docs")],
      docs: [file("docs/a.md")],
    };
    const source = stubSource(
      "workspace:silent-expand",
      async (d) => listing[d] ?? [],
    );
    renderTree(source);
    fireEvent.click(await screen.findByText("docs"));
    expect(await screen.findByText("a.md")).toBeTruthy();

    listing.docs = [file("docs/a.md"), file("docs/b.md")];
    act(() => {
      notifyFileTreeChanged({ sourceId: source.id, dir: "" });
    });
    await waitFor(() => expect(screen.getByText("b.md")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(screen.getByText("a.md")).toBeTruthy();
    expect(refreshSpinning()).toBe(false);
  });

  it("换 source 对象但 id 不变不冲掉树", async () => {
    const listed: string[] = [];
    const make = (): FileSource =>
      stubSource("workspace:same-id", async (d) => {
        listed.push(d);
        return [file("keep.md")];
      });
    const { rerender } = render(
      <TooltipProvider>
        <FileTree source={make()} onOpenFile={() => {}} />
      </TooltipProvider>,
    );
    expect(await screen.findByText("keep.md")).toBeTruthy();
    const afterFirst = listed.length;

    rerender(
      <TooltipProvider>
        <FileTree source={make()} onOpenFile={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByText("keep.md")).toBeTruthy();
    expect(listed.length).toBe(afterFirst);
    expect(refreshSpinning()).toBe(false);
  });

  it("约 200ms 合并连写，只补丁一次", async () => {
    vi.useFakeTimers();
    const listed: string[] = [];
    const source = stubSource("workspace:silent-debounce", async (d) => {
      listed.push(d);
      return [file("a.md")];
    });
    renderTree(source);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listed.filter((d) => d === "").length).toBe(1);

    act(() => {
      notifyFileTreeChanged({ sourceId: source.id, dir: "" });
      notifyFileTreeChanged({ sourceId: source.id, dir: "" });
      notifyFileTreeChanged({ sourceId: source.id, dir: "" });
    });
    expect(listed.filter((d) => d === "").length).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(FILE_TREE_SILENT_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(listed.filter((d) => d === "").length).toBe(2);
  });

  it("本机空→有：silent 根补丁后重挂 watch", async () => {
    const listing = { current: [] as FileNode[] };
    let attaches = 0;
    const rootWatchers: Array<(dir: string) => void> = [];
    const source = stubSource(
      "local:empty-then-has",
      async () => [...listing.current],
      {
        caps: { watch: true, transfer: false, edit: true, snapshots: false },
        watch: (dir, onChange) => {
          attaches += 1;
          if (dir === "") rootWatchers.push(onChange);
          return () => {};
        },
      },
    );
    renderTree(source);
    expect(await screen.findByText("暂无文件")).toBeTruthy();
    const afterEmpty = attaches;
    expect(afterEmpty).toBeGreaterThan(0);

    listing.current = [file("first.md")];
    act(() => {
      rootWatchers[0]?.("");
    });
    await waitFor(() => expect(screen.getByText("first.md")).toBeTruthy(), {
      timeout: 1000,
    });
    await waitFor(() => expect(attaches).toBeGreaterThan(afterEmpty));
  });

  it("无 watch 的云源：focus 走 silent，不转圈", async () => {
    const listing = { current: [file("a.md")] };
    const listed: string[] = [];
    const chrome: FileTreeChromeState[] = [];
    const source = stubSource("workspace:focus-silent", async () => {
      listed.push("");
      return [...listing.current];
    });
    renderTree(source, (s) => chrome.push(s));
    expect(await screen.findByText("a.md")).toBeTruthy();
    const afterReady = chrome.length;
    const afterInit = listed.length;

    listing.current = [file("a.md"), file("from-ai.md")];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByText("from-ai.md")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(listed.length).toBeGreaterThan(afterInit);
    expect(chrome.slice(afterReady).every((s) => !s.loading)).toBe(true);
    expect(refreshSpinning()).toBe(false);
  });
});
