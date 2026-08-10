// @vitest-environment jsdom
/**
 * Soft drop-error lifecycle: auto-dismiss must survive parent re-renders
 * (the old TurnComposer effect cleared the timer whenever `drop` identity changed).
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: vi.fn(() => true),
}));

vi.mock("../resideAttachment", () => ({
  stageDroppedFileAttachment: vi.fn(),
  prepareBrowserFileAttachment: vi.fn(),
}));

import { hasLocalFiles } from "@/lib/capabilities";
import {
  collectClipboardFiles,
  normalizeClipboardFileName,
} from "@/lib/clipboardFiles";
import {
  prepareBrowserFileAttachment,
  stageDroppedFileAttachment,
} from "../resideAttachment";
import { useComposerDrop } from "../useComposerDrop";

const stageMock = vi.mocked(stageDroppedFileAttachment);
const prepareMock = vi.mocked(prepareBrowserFileAttachment);
const hasLocal = vi.mocked(hasLocalFiles);

function fileNamed(name: string): File {
  return new File(["x"], name, { type: "text/plain" });
}

describe("useComposerDrop dropError lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stageMock.mockReset();
    prepareMock.mockReset();
    hasLocal.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses soft drop errors after 4s (not stuck across re-renders)", async () => {
    stageMock.mockResolvedValue({
      ok: false,
      reason: "无法读取该文件，请改用回形针选择",
    });
    const setAttachments = vi.fn();
    const { result, rerender } = renderHook(() =>
      useComposerDrop(false, [], setAttachments, null),
    );

    const dropEvent = {
      dataTransfer: {
        types: ["Files"],
        items: [
          {
            kind: "file",
            webkitGetAsEntry: () => ({ isDirectory: false }),
            getAsFile: () => fileNamed("a.txt"),
          },
        ],
        files: [fileNamed("a.txt")],
      },
      preventDefault: vi.fn(),
    } as unknown as React.DragEvent;

    await act(async () => {
      await result.current.handleDrop(dropEvent);
    });
    expect(result.current.dropError).toBe("无法读取该文件，请改用回形针选择");

    // Simulate parent re-render (new drop object identity) — must NOT cancel timer.
    rerender();
    expect(result.current.dropError).toBe("无法读取该文件，请改用回形针选择");

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.dropError).toBeNull();
  });

  it("clearDropError dismisses immediately", async () => {
    stageMock.mockResolvedValue({ ok: false, reason: "失败" });
    const { result } = renderHook(() =>
      useComposerDrop(false, [], vi.fn(), null),
    );
    const dropEvent = {
      dataTransfer: {
        types: ["Files"],
        items: [],
        files: [fileNamed("b.txt")],
      },
      preventDefault: vi.fn(),
    } as unknown as React.DragEvent;

    await act(async () => {
      await result.current.handleDrop(dropEvent);
    });
    expect(result.current.dropError).toBe("失败");

    act(() => {
      result.current.clearDropError();
    });
    expect(result.current.dropError).toBeNull();
  });

  it("web: attachDroppedFile uses prepareBrowserFileAttachment (binary ok)", async () => {
    hasLocal.mockReturnValue(false);
    const blob = new File([new Uint8Array([0, 1])], "x.bin");
    prepareMock.mockResolvedValue({
      ok: true,
      name: "x.bin",
      path: "x.bin",
      text: "",
      truncated: false,
      binary: true,
      fileBlob: blob,
    });
    const setAttachments = vi.fn();
    const { result } = renderHook(() =>
      useComposerDrop(false, [], setAttachments, null),
    );

    await act(async () => {
      await result.current.attachDroppedFile(blob);
    });

    expect(prepareMock).toHaveBeenCalledWith(null, blob);
    expect(stageMock).not.toHaveBeenCalled();
    expect(setAttachments).toHaveBeenCalled();
    const updater = setAttachments.mock.calls[0][0] as (
      prev: unknown[],
    ) => unknown[];
    const next = updater([]);
    expect(next).toEqual([
      expect.objectContaining({
        name: "x.bin",
        binary: true,
        fileBlob: blob,
      }),
    ]);
  });

  it("web: prepare failure flashes dropError", async () => {
    hasLocal.mockReturnValue(false);
    prepareMock.mockResolvedValue({
      ok: false,
      reason: "文件超过 25MB 上限",
    });
    const { result } = renderHook(() =>
      useComposerDrop(false, [], vi.fn(), "c1"),
    );

    await act(async () => {
      await result.current.attachDroppedFile(
        new File(["x"], "a.png", { type: "image/png" }),
      );
    });
    expect(result.current.dropError).toContain("25MB");
  });

  it("paste: attaches clipboard screenshot via stageDroppedFileAttachment", async () => {
    stageMock.mockResolvedValue({
      ok: true,
      name: "paste-shot.png",
      path: "attachments/paste-shot.png",
      text: "",
      truncated: false,
      binary: true,
      workspacePath: "attachments/paste-shot.png",
    });
    const setAttachments = vi.fn();
    const { result } = renderHook(() =>
      useComposerDrop(false, [], setAttachments, "c1"),
    );

    const png = new File([new Uint8Array([0x89, 0x50])], "image.png", {
      type: "image/png",
    });
    const pasteEvent = {
      clipboardData: {
        files: [png],
        items: [],
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => {
      result.current.handlePaste(pasteEvent);
      // flush async attach loop
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pasteEvent.preventDefault).toHaveBeenCalled();
    expect(stageMock).toHaveBeenCalled();
    const stagedFile = stageMock.mock.calls[0][1] as File;
    expect(stagedFile.name).toMatch(/^paste-\d{8}-\d{6}\.png$/);
    expect(setAttachments).toHaveBeenCalled();
  });

  it("paste: picks up image/* from items when files is empty", async () => {
    stageMock.mockResolvedValue({
      ok: true,
      name: "from-items.png",
      path: "from-items.png",
      text: "",
      truncated: false,
      binary: true,
    });
    const setAttachments = vi.fn();
    const { result } = renderHook(() =>
      useComposerDrop(false, [], setAttachments, null),
    );

    const png = new File([new Uint8Array([1, 2, 3])], "image.png", {
      type: "image/png",
    });
    const pasteEvent = {
      clipboardData: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => png,
          },
        ],
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => {
      result.current.handlePaste(pasteEvent);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stageMock).toHaveBeenCalled();
    expect(pasteEvent.preventDefault).toHaveBeenCalled();
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
