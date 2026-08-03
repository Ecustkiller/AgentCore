// @vitest-environment jsdom
import { TurnFileChangesReview } from "@/components/TurnFileChangesReview";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getTurnFilesDiff, restoreSnapshot } = vi.hoisted(() => ({
  getTurnFilesDiff: vi.fn(),
  restoreSnapshot: vi.fn(),
}));

vi.mock("@/api/turnFilesDiff", () => ({ getTurnFilesDiff }));
vi.mock("@/api/workspace", () => ({ restoreSnapshot }));

describe("TurnFileChangesReview change labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("true diff labels by baseline presence: 新建/更新/删除 (never 写入/编辑)", async () => {
    getTurnFilesDiff.mockResolvedValue({
      messageId: "m1",
      baselineSnapshotId: "snap-1",
      available: true,
      changes: [
        {
          path: "new.ts",
          changeType: "added",
          baseSha: null,
          resultSha: "r1",
          isBinary: false,
          content: "hello",
          sizeBytes: 5,
          baseContent: null,
        },
        {
          path: "old.ts",
          changeType: "modified",
          baseSha: "b",
          resultSha: "r2",
          isBinary: false,
          content: "new",
          sizeBytes: 3,
          baseContent: "old",
        },
        {
          path: "gone.ts",
          changeType: "deleted",
          baseSha: "b",
          resultSha: null,
          isBinary: false,
          content: null,
          sizeBytes: 0,
          baseContent: "x",
        },
      ],
      total: 3,
      added: 1,
      modified: 1,
      deleted: 1,
    });

    render(
      <TurnFileChangesReview
        conversationId="c1"
        messageId="m1"
        artifacts={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("新建")).toBeTruthy();
      expect(screen.getByText("更新")).toBeTruthy();
      expect(screen.getByText("删除")).toBeTruthy();
    });
    expect(screen.queryByText("写入")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
    expect(screen.getByText("1 行")).toBeTruthy();
  });

  it("tool-arg fallback labels write/edit as 更新, never 写入/编辑", async () => {
    getTurnFilesDiff.mockResolvedValue({
      messageId: "m1",
      baselineSnapshotId: null,
      available: false,
      changes: [],
      total: 0,
      added: 0,
      modified: 0,
      deleted: 0,
    });

    render(
      <TurnFileChangesReview
        conversationId="c1"
        messageId="m1"
        artifacts={[
          {
            path: "a.ts",
            name: "a.ts",
            op: "write",
            change: {
              kind: "write",
              content: "body",
              mode: "overwrite",
            },
          },
          {
            path: "b.ts",
            name: "b.ts",
            op: "edit",
            change: { kind: "edit", oldText: "a", newText: "b" },
          },
          {
            path: "c.ts",
            name: "c.ts",
            op: "delete",
            change: { kind: "delete" },
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/工具参数侧预览/)).toBeTruthy();
    });
    expect(screen.getAllByText("更新").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("删除")).toBeTruthy();
    expect(screen.queryByText("写入")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
    expect(screen.queryByLabelText("恢复到本回合开始")).toBeNull();
  });
});

describe("TurnFileChangesReview A2′ rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  it("shows rollback when true diff has baseline, and restores on confirm", async () => {
    getTurnFilesDiff.mockResolvedValue({
      messageId: "m1",
      baselineSnapshotId: "snap-1",
      available: true,
      changes: [
        {
          path: "a.ts",
          changeType: "modified",
          baseSha: "b",
          resultSha: "r",
          isBinary: false,
          content: "new",
          sizeBytes: 3,
          baseContent: "old",
        },
      ],
      total: 1,
      added: 0,
      modified: 1,
      deleted: 0,
    });
    restoreSnapshot.mockResolvedValue(undefined);

    render(
      <TurnFileChangesReview
        conversationId="c1"
        messageId="m1"
        artifacts={[
          {
            path: "a.ts",
            name: "a.ts",
            op: "edit",
            change: { kind: "edit", oldText: "old", newText: "new" },
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("恢复到本回合开始")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("恢复到本回合开始"));
    await waitFor(() => {
      expect(restoreSnapshot).toHaveBeenCalledWith("c1", "snap-1");
      expect(screen.getByText("已尽力恢复到本回合开始")).toBeTruthy();
    });
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("overlay"),
    );
  });

  it("hides rollback when available=false (A1 fallback)", async () => {
    getTurnFilesDiff.mockResolvedValue({
      messageId: "m1",
      baselineSnapshotId: null,
      available: false,
      changes: [],
      total: 0,
      added: 0,
      modified: 0,
      deleted: 0,
    });

    render(
      <TurnFileChangesReview
        conversationId="c1"
        messageId="m1"
        artifacts={[
          {
            path: "a.ts",
            name: "a.ts",
            op: "edit",
            change: { kind: "edit", oldText: "a", newText: "b" },
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/工具参数侧预览/)).toBeTruthy();
    });
    expect(screen.queryByLabelText("恢复到本回合开始")).toBeNull();
  });
});
