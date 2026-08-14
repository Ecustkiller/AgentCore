// @vitest-environment jsdom
import { applyMergeLandingDiff } from "@/services/mergeLandingDiff";
import type { MergeLandingReviewSession } from "@/stores/mergeLandingReview";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MergeLandingReviewDialog } from "../MergeLandingReview";

vi.mock("@/services/mergeLandingDiff", () => ({
  applyMergeLandingDiff: vi.fn(),
}));

const applyDiff = vi.mocked(applyMergeLandingDiff);

function session(
  over: Partial<MergeLandingReviewSession> = {},
): MergeLandingReviewSession {
  return {
    conversationId: "c1",
    rootId: "root-1",
    rootName: "本机",
    rows: [
      {
        change: {
          path: "notes.txt",
          changeType: "modified",
          baseSha: "b",
          resultSha: "r",
          isBinary: false,
          content: "cloud",
          sizeBytes: 5,
        },
        localSha: "local",
        verdict: "conflict",
        decision: "local",
      },
    ],
    bytesByPath: {},
    skippedOversized: [],
    skippedUnreadable: [],
    truncated: false,
    ...over,
  };
}

function renderDialog(s = session()) {
  render(
    <MergeLandingReviewDialog
      session={s}
      onOpenChange={() => {}}
      onApplied={() => {}}
      onDismiss={() => {}}
    />,
  );
}

beforeEach(() => {
  applyDiff.mockReset();
});

afterEach(cleanup);

describe("MergeLandingReview · 冲突色", () => {
  it("冲突说明与行壳走 primary；用云端选中态仍红", () => {
    renderDialog();

    const needYou = screen.getByText(/个冲突（默认保留本机）/);
    expect(needYou.className).toContain("text-primary");
    expect(needYou.className).not.toContain("destructive");

    const row = screen.getByText("notes.txt").closest("li");
    expect(row?.className).toContain("primary");
    expect(row?.className).not.toContain("destructive");

    const takeCloud = screen.getByRole("button", { name: "用云端" });
    expect(takeCloud.className).not.toContain("destructive");
    fireEvent.click(takeCloud);
    expect(takeCloud.className).toContain("destructive");
  });

  it("applyError 走 muted，不涂 destructive", async () => {
    applyDiff.mockRejectedValue(new Error("合回失败了"));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "合入所选" }));
    const err = await screen.findByText("合回失败了");
    expect(err.className).toContain("text-muted-foreground");
    expect(err.className).not.toContain("destructive");
  });
});
