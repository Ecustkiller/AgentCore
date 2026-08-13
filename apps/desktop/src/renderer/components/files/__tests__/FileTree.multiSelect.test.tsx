// @vitest-environment jsdom

import { FileTree } from "@/components/files/FileTree";
import { __resetFileClipboardForTests } from "@/components/files/fileClipboard";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileNode, FileSource } from "@/lib/fileSource";
import { notifySuccess } from "@/lib/toast";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

function file(name: string): FileNode {
  return { path: name, name, isDir: false };
}

/** 云端工作区那一档能力：可传输（下载）、可改（删除 / 移动）、有软删区。 */
function makeSource(
  fail: { on: string; reason: string } | null = null,
): FileSource & {
  deleted: string[];
  downloaded: string[];
  moved: [string, string][];
} {
  const deleted: string[] = [];
  const downloaded: string[] = [];
  const moved: [string, string][] = [];
  const reject = (path: string) => {
    if (fail && path === fail.on) throw new Error(fail.reason);
  };
  return {
    id: "workspace:multi",
    label: "工作区",
    caps: { watch: false, transfer: true, edit: true, snapshots: true },
    listDir: async (dir) =>
      dir === "" ? [dirNode(), file("a.md"), file("b.md"), file("c.md")] : [],
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async () => {},
    move: async (src, dst) => {
      reject(src);
      moved.push([src, dst]);
    },
    delete: async (path) => {
      reject(path);
      deleted.push(path);
    },
    download: async (path) => {
      reject(path);
      downloaded.push(path);
    },
    deleted,
    downloaded,
    moved,
  };
}

function dirNode(): FileNode {
  return { path: "docs", name: "docs", isDir: true };
}

function renderTree(source: FileSource, onOpenFile = vi.fn()) {
  render(
    <TooltipProvider>
      <FileTree source={source} onOpenFile={onOpenFile} />
    </TooltipProvider>,
  );
  return { onOpenFile };
}

/** 选中若干行：首个普通点击（= 单选并打开），其余 Ctrl 加选。 */
async function select(...names: string[]) {
  const first = await screen.findByText(names[0]);
  fireEvent.click(first);
  for (const name of names.slice(1)) {
    fireEvent.click(screen.getByText(name), { ctrlKey: true });
  }
}

beforeEach(() => {
  vi.mocked(notifySuccess).mockClear();
  // 剪贴板是全局一份，别让上一条用例剪下的东西漏进下一条。
  __resetFileClipboardForTests();
});

describe("文件树多选（对齐桌面文件管理器）", () => {
  it("Ctrl 加减选、Shift 连选、Esc 清空；带修饰键的点击不换预览", async () => {
    const { onOpenFile } = renderTree(makeSource());

    fireEvent.click(await screen.findByText("a.md"));
    expect(onOpenFile).toHaveBeenCalledWith("a.md", "a.md");
    // 单选不挂操作条：一项用不着批量。
    expect(screen.queryByText(/已选择/)).toBeNull();

    fireEvent.click(screen.getByText("c.md"), { ctrlKey: true });
    expect(screen.getByText("已选择 2 项")).toBeTruthy();
    // 加选没有把预览换成 c.md。
    expect(onOpenFile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("c.md"), { ctrlKey: true });
    expect(screen.queryByText(/已选择/)).toBeNull();

    // 锚点仍是 a.md：Shift 连到 c.md 即 a → b → c 三项。
    fireEvent.click(screen.getByText("a.md"));
    fireEvent.click(screen.getByText("c.md"), { shiftKey: true });
    expect(screen.getByText("已选择 3 项")).toBeTruthy();

    fireEvent.keyDown(screen.getByText("a.md"), { key: "Escape" });
    expect(screen.queryByText(/已选择/)).toBeNull();
  });

  it("批量删除逐项报账：失败项不中断整批，且列出是哪一项、为什么", async () => {
    const source = makeSource({ on: "b.md", reason: "目标被占用" });
    renderTree(source);
    await select("a.md", "b.md", "c.md");

    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("删除选中的 3 项？")).toBeTruthy();
    // 软删承诺与单项删除同一句。
    expect(within(confirm).getByText(/可从软删区还原/)).toBeTruthy();
    expect(within(confirm).getByText("b.md")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));

    const report = await screen.findByText("已删除 2 项，1 项失败");
    expect(report).toBeTruthy();
    expect(screen.getByText("目标被占用")).toBeTruthy();
    // 一项失败没有把后面的项吞掉。
    expect(source.deleted).toEqual(["a.md", "c.md"]);
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it("全部成功时只报一条成功，不弹清单", async () => {
    const source = makeSource();
    renderTree(source);
    await select("a.md", "b.md");

    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(source.deleted).toEqual(["a.md", "b.md"]));
    expect(notifySuccess).toHaveBeenCalledWith("已删除 2 项");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("批量下载：文件夹说清为什么下不了，而不是静默跳过", async () => {
    const source = makeSource();
    renderTree(source);
    fireEvent.click(await screen.findByText("docs"));
    await screen.findByText("空文件夹"); // 等展开这一层落定，免得懒加载在断言之后才回来
    fireEvent.click(screen.getByText("a.md"), { ctrlKey: true });

    fireEvent.click(screen.getByRole("button", { name: /下载/ }));

    expect(await screen.findByText("已下载 1 项，1 项失败")).toBeTruthy();
    expect(
      screen.getByText("文件夹不能整个下载，请展开后选择其中的文件"),
    ).toBeTruthy();
    expect(source.downloaded).toEqual(["a.md"]);
  });

  it("批量移动 = 剪切多项后粘贴到目标文件夹，部分失败照样逐项报", async () => {
    const source = makeSource({ on: "b.md", reason: "文件被占用" });
    renderTree(source);
    await select("a.md", "b.md");

    fireEvent.keyDown(screen.getByText("a.md"), { key: "x", ctrlKey: true });
    // 落点 = 当前锚点行（目录本身）。
    fireEvent.click(screen.getByText("docs"));
    fireEvent.keyDown(screen.getByText("docs"), { key: "v", ctrlKey: true });

    expect(await screen.findByText("已移动 1 项，1 项失败")).toBeTruthy();
    expect(screen.getByText("文件被占用")).toBeTruthy();
    expect(source.moved).toEqual([["a.md", "docs/a.md"]]);
  });
});
