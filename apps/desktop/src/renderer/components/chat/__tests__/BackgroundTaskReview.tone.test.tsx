// @vitest-environment jsdom
import { BackgroundTaskReview } from "@/components/chat/BackgroundTaskReview";
import type { HandoffFileChange } from "@/lib/handoff-review";
import {
  applyHandoffJob,
  getHandoffDiff,
  readLocalShas,
} from "@/services/handoff";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/handoff", () => ({
  getHandoffDiff: vi.fn(),
  readLocalShas: vi.fn(),
  applyHandoffJob: vi.fn(),
}));

const getDiff = vi.mocked(getHandoffDiff);
const readShas = vi.mocked(readLocalShas);
const applyJob = vi.mocked(applyHandoffJob);

function change(
  over: Partial<HandoffFileChange> & { path: string },
): HandoffFileChange {
  return {
    path: over.path,
    changeType: over.changeType ?? "modified",
    baseSha: over.baseSha ?? "base",
    resultSha: over.resultSha ?? "result",
    isBinary: over.isBinary ?? false,
    content: over.content ?? "cloud body",
    sizeBytes: over.sizeBytes ?? 10,
  };
}

async function renderReview() {
  getDiff.mockResolvedValue({
    jobId: "job-1",
    changes: [
      change({ path: "notes.txt", baseSha: "b", resultSha: "r" }),
      change({
        path: "old.txt",
        changeType: "deleted",
        baseSha: "b2",
        resultSha: null,
        content: null,
      }),
    ],
    total: 2,
    added: 0,
    modified: 1,
    deleted: 1,
  });
  readShas.mockResolvedValue(
    new Map<string, string | null>([
      ["notes.txt", "local-divergent"],
      ["old.txt", "b2"],
    ]),
  );
  render(
    <BackgroundTaskReview
      conversationId="c1"
      jobId="job-1"
      rootId="root-1"
      onClose={() => {}}
    />,
  );
  await screen.findByText(/需你选择/);
}

beforeEach(() => {
  getDiff.mockReset();
  readShas.mockReset();
  applyJob.mockReset();
});

afterEach(cleanup);

describe("BackgroundTaskReview · 冲突色", () => {
  it("需你选择与冲突行壳走 primary；deleted 计数与用云端选中态仍红", async () => {
    await renderReview();

    const needYou = screen.getByText(/需你选择/);
    expect(needYou.className).toContain("text-primary");
    expect(needYou.className).not.toContain("destructive");

    const deleted = screen.getByText("-1");
    expect(deleted.className).toContain("text-destructive");

    const row = screen.getByText("notes.txt").closest("li");
    expect(row?.className).toContain("primary");
    expect(row?.className).not.toContain("destructive");

    const takeCloud = screen.getByRole("button", {
      name: "用云端拷贝（覆盖本机）",
    });
    expect(takeCloud.className).not.toContain("destructive");
    fireEvent.click(takeCloud);
    expect(takeCloud.className).toContain("destructive");
  });

  it("applyError 走 muted，不涂 destructive", async () => {
    applyJob.mockRejectedValue(new Error("磁盘写失败"));
    await renderReview();

    fireEvent.click(screen.getByRole("button", { name: "合回所选改动到本机" }));
    const err = await screen.findByText("磁盘写失败");
    expect(err.className).toContain("text-muted-foreground");
    expect(err.className).not.toContain("destructive");
  });
});
