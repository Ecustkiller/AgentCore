// @vitest-environment jsdom

import { useFileUpload } from "@/components/files/useFileUpload";
import type { FileNode, FileSource } from "@/lib/fileSource";
import type { DropUploadCapture } from "@/lib/folderUpload";
import { notifySuccess, notifyWarning } from "@/lib/toast";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
  notifyActionError: vi.fn(),
}));

type Tree = { [name: string]: Tree | number };

function fileEntry(name: string, size: number): FileSystemEntry {
  return {
    name,
    isDirectory: false,
    isFile: true,
    file: (ok: (f: File) => void) => ok(new File([new Uint8Array(size)], name)),
  } as unknown as FileSystemEntry;
}

function dirEntry(name: string, tree: Tree): FileSystemEntry {
  const children = Object.entries(tree).map(([child, value]) =>
    typeof value === "number"
      ? fileEntry(child, value)
      : dirEntry(child, value),
  );
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let served = false;
      return {
        readEntries: (ok: (batch: FileSystemEntry[]) => void) => {
          ok(served ? [] : children);
          served = true;
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function drop(entry: FileSystemEntry): DropUploadCapture {
  return { entries: [entry], looseFiles: [] };
}

function makeSource(): FileSource & { wrote: string[]; dirs: string[] } {
  const wrote: string[] = [];
  const dirs: string[] = [];
  return {
    id: "workspace:folder:design",
    label: "设计",
    caps: { watch: false, transfer: true, edit: true, snapshots: true },
    listDir: async () => [] as FileNode[],
    read: async () => ({ kind: "text", text: "", truncated: false }),
    createFile: async () => {},
    mkdir: async (path) => {
      dirs.push(path);
    },
    move: async () => {},
    delete: async () => {},
    writeBytes: async (path) => {
      wrote.push(path);
    },
    wrote,
    dirs,
  };
}

/** 微任务 + 一个宏任务：确认「什么都没发生」得先让整条链跑完。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("上传收尾：该做的做，该闭嘴的闭嘴", () => {
  it("只有空目录的一棵树照样建出来，不静默返回", async () => {
    const source = makeSource();
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useFileUpload(source, onUploaded));

    act(() =>
      result.current.uploadDropped(drop(dirEntry("空的", { 更空: {} })), "dst"),
    );

    await waitFor(() =>
      expect(source.dirs).toEqual(["dst/空的", "dst/空的/更空"]),
    );
    // 目录建完还得刷新树 + 给回话，否则用户只看见「点了没反应」。
    expect(onUploaded).toHaveBeenCalledWith("dst");
    expect(notifySuccess).toHaveBeenCalledTimes(1);
    expect(source.wrote).toEqual([]);
  });

  it("忽略项撑起的空选择也要交代，不能当没发生", async () => {
    const source = makeSource();
    const { result } = renderHook(() => useFileUpload(source, vi.fn()));

    act(() =>
      result.current.uploadDropped(
        drop(dirEntry("p", { node_modules: { "x.js": 4 } })),
        "",
      ),
    );

    await waitFor(() => expect(notifyWarning).toHaveBeenCalledTimes(1));
    const [message, opts] = vi.mocked(notifyWarning).mock.calls[0];
    expect(message).toBe("没有可上传的文件");
    expect(opts?.description).toContain("跳过 1 个忽略项");
  });

  it("确实什么都没选到时才短路：不建目录、不刷新、不弹提示", async () => {
    const source = makeSource();
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useFileUpload(source, onUploaded));

    act(() => result.current.uploadFiles(null, ""));
    await settle();

    expect(source.dirs).toEqual([]);
    expect(onUploaded).not.toHaveBeenCalled();
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(notifyWarning).not.toHaveBeenCalled();
    expect(result.current.uploading).toBe(false);
  });
});
