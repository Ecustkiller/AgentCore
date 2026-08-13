// @vitest-environment jsdom
/**
 * The CAS half of mobile file editing: a save carries the baseline it read, and a
 * conflict must be **visible and undecided** — never a silent overwrite of whatever
 * the Agent just wrote.
 */
import { FileTextEditor } from "@/components/fileBrowser/FileTextEditor";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(cleanup);

const doc = { text: "老内容", mtimeMs: 1710, eol: "lf" as const };

function renderEditor(ops: {
  readForEdit: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
  onSaved?: ReturnType<typeof vi.fn>;
}) {
  const onSaved = ops.onSaved ?? vi.fn();
  render(
    <FileTextEditor
      path="docs/a.md"
      name="a.md"
      ops={{ readForEdit: ops.readForEdit, writeText: ops.writeText }}
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  );
  return { onSaved };
}

const typeInto = async (value: string) => {
  const area = await screen.findByLabelText("编辑 a.md");
  fireEvent.change(area, { target: { value } });
  return area;
};

describe("FileTextEditor · mtime CAS", () => {
  it("saves with the mtime it read as the baseline", async () => {
    const readForEdit = vi.fn().mockResolvedValue(doc);
    const writeText = vi
      .fn()
      .mockResolvedValue({ ok: true, mtimeMs: 1800, conflict: false });
    const { onSaved } = renderEditor({ readForEdit, writeText });

    await typeInto("新内容");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("docs/a.md", {
        content: "新内容",
        baselineMtimeMs: 1710,
        eol: "lf",
      });
      expect(screen.getByText("已保存")).toBeTruthy();
    });
    expect(onSaved).toHaveBeenCalledWith("新内容");
  });

  it("a conflict says the change was NOT saved and keeps the user's text", async () => {
    const readForEdit = vi.fn().mockResolvedValue(doc);
    const writeText = vi
      .fn()
      .mockResolvedValue({ ok: false, mtimeMs: 1900, conflict: true });
    const { onSaved } = renderEditor({ readForEdit, writeText });

    await typeInto("我的改动");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByText(/还没有保存/)).toBeTruthy();
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText("已保存")).toBeNull();
    expect(
      (screen.getByLabelText("编辑 a.md") as HTMLTextAreaElement).value,
    ).toBe("我的改动");
  });

  it("仍然覆盖 rewrites with the cloud version as the new baseline", async () => {
    const readForEdit = vi.fn().mockResolvedValue(doc);
    const writeText = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, mtimeMs: 1900, conflict: true })
      .mockResolvedValueOnce({ ok: true, mtimeMs: 2000, conflict: false });
    const { onSaved } = renderEditor({ readForEdit, writeText });

    await typeInto("我的改动");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("button", { name: "仍然覆盖" });

    fireEvent.click(screen.getByRole("button", { name: "仍然覆盖" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenLastCalledWith("docs/a.md", {
        content: "我的改动",
        baselineMtimeMs: 1900,
        eol: "lf",
      });
    });
    expect(onSaved).toHaveBeenCalledWith("我的改动");
    expect(screen.queryByText(/还没有保存/)).toBeNull();
  });

  it("载入最新版 drops the local edit and re-reads the cloud copy", async () => {
    const readForEdit = vi
      .fn()
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce({ text: "云端新版", mtimeMs: 1900, eol: "lf" });
    const writeText = vi
      .fn()
      .mockResolvedValue({ ok: false, mtimeMs: 1900, conflict: true });
    renderEditor({ readForEdit, writeText });

    await typeInto("我的改动");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("button", { name: /载入最新版/ });

    fireEvent.click(screen.getByRole("button", { name: /载入最新版/ }));

    await waitFor(() => {
      expect(
        (screen.getByLabelText("编辑 a.md") as HTMLTextAreaElement).value,
      ).toBe("云端新版");
    });
    expect(screen.queryByText(/还没有保存/)).toBeNull();
  });

  it("shows the backend's reason when the file cannot be opened for editing", async () => {
    const readForEdit = vi
      .fn()
      .mockRejectedValue(new Error("文件不是 UTF-8 文本，无法编辑"));
    renderEditor({ readForEdit, writeText: vi.fn() });

    await waitFor(() => {
      expect(screen.getByText("文件不是 UTF-8 文本，无法编辑")).toBeTruthy();
    });
  });
});
