// @vitest-environment jsdom
import { TrashSection } from "@/components/TrashSection";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listTrash, restoreTrash } = vi.hoisted(() => ({
  listTrash: vi.fn(),
  restoreTrash: vi.fn(),
}));

vi.mock("@/api/workspace", () => ({ listTrash, restoreTrash }));

const CONV = "conv-1";
const ENTRY = {
  entryId: "e1",
  originalPath: "docs/a.md",
  name: "a.md",
  isDir: false,
  deletedAt: "2026-08-01T00:00:00Z",
};

afterEach(cleanup);

beforeEach(() => {
  listTrash.mockReset();
  restoreTrash.mockReset();
  listTrash.mockResolvedValue({ entries: [ENTRY], retentionDays: 30 });
  restoreTrash.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("TrashSection · restore", () => {
  it("lists trash entries then restores and refreshes", async () => {
    const onRestored = vi.fn();
    listTrash
      .mockResolvedValueOnce({ entries: [ENTRY], retentionDays: 30 })
      .mockResolvedValueOnce({ entries: [], retentionDays: 30 });

    render(<TrashSection conversationId={CONV} onRestored={onRestored} />);

    await waitFor(() => {
      expect(screen.getByText("a.md")).toBeTruthy();
      expect(screen.getByText("docs/a.md")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "还原 a.md" }));

    await waitFor(() => {
      expect(restoreTrash).toHaveBeenCalledWith(CONV, "e1");
      expect(window.confirm).toHaveBeenCalledWith(
        "还原「docs/a.md」到原路径？",
      );
      expect(onRestored).toHaveBeenCalled();
      expect(screen.getByText("已还原")).toBeTruthy();
      expect(screen.getByText(/软删区为空/)).toBeTruthy();
    });
    expect(listTrash).toHaveBeenCalledTimes(2);
  });

  it("empty state when trash has no entries", async () => {
    listTrash.mockResolvedValue({ entries: [], retentionDays: 14 });
    render(<TrashSection conversationId={CONV} />);
    await waitFor(() => {
      expect(screen.getByText(/软删区为空/)).toBeTruthy();
      expect(screen.getByText(/保留约 14 天/)).toBeTruthy();
    });
  });

  it("error + retry reloads the list", async () => {
    listTrash
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ entries: [ENTRY], retentionDays: 30 });
    render(<TrashSection conversationId={CONV} />);
    await waitFor(() => {
      expect(screen.getByText("加载软删区失败")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("重试"));
    await waitFor(() => {
      expect(screen.getByText("a.md")).toBeTruthy();
    });
  });

  it("cancel confirm skips restore", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TrashSection conversationId={CONV} />);
    await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "还原 a.md" }));
    expect(restoreTrash).not.toHaveBeenCalled();
  });

  it("restore failure shows inline error", async () => {
    restoreTrash.mockRejectedValue(new Error("conflict"));
    render(<TrashSection conversationId={CONV} />);
    await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "还原 a.md" }));
    await waitFor(() => {
      expect(screen.getByText(/还原失败：conflict/)).toBeTruthy();
    });
  });
});
