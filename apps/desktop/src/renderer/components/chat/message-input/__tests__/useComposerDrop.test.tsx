// @vitest-environment jsdom
/**
 * 附加即上传：chip 必须在用户拖入 / 粘贴的那一刻就出现（带上传中态），驻留在后台跑；
 * 多文件并行不串行。外加软 drop 错误的自动消失生命周期（旧回归：父组件重渲染曾把
 * 定时器清掉，红条卡住不走）。
 */

import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../resideAttachment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../resideAttachment")>();
  return {
    ...actual,
    describeFileAttachment: vi.fn(),
    residentAttachmentForFile: vi.fn(),
  };
});

import {
  collectClipboardFiles,
  normalizeClipboardFileName,
} from "@/lib/clipboardFiles";
import { __clearAttachmentUploadsForTests } from "../attachmentUploads";
import type { PendingAttachment } from "../composerAttachments";
import {
  type ResideResult,
  describeFileAttachment,
  residentAttachmentForFile,
} from "../resideAttachment";
import { useComposerDrop } from "../useComposerDrop";

const describeMock = vi.mocked(describeFileAttachment);
const residentMock = vi.mocked(residentAttachmentForFile);

function fileNamed(name: string, type = "text/plain"): File {
  return new File(["x"], name, { type });
}

function deferred() {
  let resolve!: (r: ResideResult) => void;
  const promise = new Promise<ResideResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 真 React state，这样 chip 的 patch（函数式更新）能被观察到。 */
function useDropHarness(conversationId: string | null) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const drop = useComposerDrop(
    false,
    attachments,
    setAttachments,
    conversationId,
  );
  return { attachments, drop };
}

function dropEventFor(...files: File[]): React.DragEvent {
  return {
    dataTransfer: {
      types: ["Files"],
      items: files.map((f) => ({
        kind: "file",
        webkitGetAsEntry: () => ({ isDirectory: false }),
        getAsFile: () => f,
      })),
      files,
    },
    preventDefault: vi.fn(),
  } as unknown as React.DragEvent;
}

beforeEach(() => {
  __clearAttachmentUploadsForTests();
  describeMock.mockReset();
  residentMock.mockReset();
  describeMock.mockImplementation(async (file: File) => ({
    name: file.name,
    text: "x",
    truncated: false,
    binary: false,
  }));
});

describe("useComposerDrop 附加即上传", () => {
  it("chip 在上传落地前就出现，并标为上传中", async () => {
    const gate = deferred();
    residentMock.mockReturnValue(gate.promise);
    const { result } = renderHook(() => useDropHarness("c1"));

    let attaching!: Promise<void>;
    await act(async () => {
      attaching = result.current.drop.attachDroppedFile(fileNamed("a.txt"));
      // 只放行同步那一拍：驻留仍未完成。
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]).toMatchObject({
      name: "a.txt",
      uploadState: "uploading",
    });
    expect(result.current.attachments[0].workspacePath).toBeUndefined();

    await act(async () => {
      gate.resolve({
        ok: true,
        name: "a.txt",
        path: "attachments/a.txt",
        text: "x",
        truncated: false,
        binary: false,
        workspacePath: "attachments/a.txt",
      });
      await attaching;
    });

    expect(result.current.attachments[0]).toMatchObject({
      path: "attachments/a.txt",
      workspacePath: "attachments/a.txt",
    });
    expect(result.current.attachments[0].uploadState).toBeUndefined();
    // 已落地就放掉 File，别把几 MB 挂在草稿上。
    expect(result.current.attachments[0].fileBlob).toBeUndefined();
  });

  it("上传失败：chip 留在草稿里并标失败，同时闪软错误", async () => {
    residentMock.mockResolvedValue({
      ok: false,
      reason: "上传附件到云端工作区失败",
    });
    const { result } = renderHook(() => useDropHarness("c1"));

    await act(async () => {
      await result.current.drop.attachDroppedFile(fileNamed("a.txt"));
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]).toMatchObject({
      uploadState: "error",
      uploadError: "上传附件到云端工作区失败",
    });
    // 发送时要靠它重试，不能顺手丢掉。
    expect(result.current.attachments[0].fileBlob).toBeInstanceOf(File);
    expect(result.current.drop.dropError).toBe("上传附件到云端工作区失败");
  });

  it("超过大小上限：不建 chip，只给中文提示", async () => {
    const big = fileNamed("big.bin");
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    const { result } = renderHook(() => useDropHarness("c1"));

    await act(async () => {
      await result.current.drop.attachDroppedFile(big);
    });

    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.drop.dropError).toContain("25MB");
    expect(residentMock).not.toHaveBeenCalled();
  });

  it("多文件并行：两个 chip 同时出现，不等前一个传完", async () => {
    const first = deferred();
    const second = deferred();
    residentMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useDropHarness("c1"));

    let dropping!: Promise<void>;
    await act(async () => {
      dropping = result.current.drop.handleDrop(
        dropEventFor(fileNamed("a.txt"), fileNamed("b.txt")),
      );
    });

    expect(result.current.attachments.map((a) => a.name)).toEqual([
      "a.txt",
      "b.txt",
    ]);
    expect(residentMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve({
        ok: true,
        name: "a.txt",
        path: "attachments/a.txt",
        text: "",
        truncated: false,
        binary: false,
        workspacePath: "attachments/a.txt",
      });
      second.resolve({
        ok: true,
        name: "b.txt",
        path: "attachments/b.txt",
        text: "",
        truncated: false,
        binary: false,
        workspacePath: "attachments/b.txt",
      });
      await dropping;
    });

    expect(
      result.current.attachments.every((a) => a.uploadState === undefined),
    ).toBe(true);
  });

  it("粘贴截图：走同一条驻留链，文件名已规范化", async () => {
    residentMock.mockResolvedValue({
      ok: true,
      name: "paste-shot.png",
      path: "attachments/paste-shot.png",
      text: "",
      truncated: false,
      binary: true,
      workspacePath: "attachments/paste-shot.png",
    });
    const { result } = renderHook(() => useDropHarness("c1"));

    const png = new File([new Uint8Array([0x89, 0x50])], "image.png", {
      type: "image/png",
    });
    const pasteEvent = {
      clipboardData: { files: [png], items: [] },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => {
      result.current.drop.handlePaste(pasteEvent);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pasteEvent.preventDefault).toHaveBeenCalled();
    expect(residentMock).toHaveBeenCalled();
    const pastedFile = residentMock.mock.calls[0][1] as File;
    expect(pastedFile.name).toMatch(/^paste-\d{8}-\d{6}\.png$/);
  });
});

describe("useComposerDrop dropError lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    residentMock.mockResolvedValue({
      ok: false,
      reason: "无法读取该文件，请改用回形针选择",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses soft drop errors after 4s (not stuck across re-renders)", async () => {
    const { result, rerender } = renderHook(() => useDropHarness(null));

    await act(async () => {
      await result.current.drop.handleDrop(dropEventFor(fileNamed("a.txt")));
    });
    expect(result.current.drop.dropError).toBe(
      "无法读取该文件，请改用回形针选择",
    );

    // Simulate parent re-render (new drop object identity) — must NOT cancel timer.
    rerender();
    expect(result.current.drop.dropError).toBe(
      "无法读取该文件，请改用回形针选择",
    );

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.drop.dropError).toBeNull();
  });

  it("clearDropError dismisses immediately", async () => {
    residentMock.mockResolvedValue({ ok: false, reason: "失败" });
    const { result } = renderHook(() => useDropHarness(null));

    await act(async () => {
      await result.current.drop.handleDrop(dropEventFor(fileNamed("b.txt")));
    });
    expect(result.current.drop.dropError).toBe("失败");

    act(() => {
      result.current.drop.clearDropError();
    });
    expect(result.current.drop.dropError).toBeNull();
  });
});

describe("collectClipboardFiles / normalizeClipboardFileName", () => {
  it("renames generic clipboard image.png", () => {
    const f = new File([new Uint8Array([1])], "image.png", {
      type: "image/png",
    });
    const n = normalizeClipboardFileName(f);
    expect(n.name).toMatch(/^paste-\d{8}-\d{6}\.png$/);
    expect(n.type).toBe("image/png");
  });

  it("keeps real filenames", () => {
    const f = new File(["hi"], "notes.txt", { type: "text/plain" });
    expect(normalizeClipboardFileName(f).name).toBe("notes.txt");
  });

  it("dedupes files + items referring to the same image", () => {
    const png = new File([new Uint8Array([1, 2])], "image.png", {
      type: "image/png",
      lastModified: 42,
    });
    const collected = collectClipboardFiles({
      files: [png] as unknown as FileList,
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => png,
        },
      ],
    } as unknown as DataTransfer);
    expect(collected).toHaveLength(1);
  });
});
