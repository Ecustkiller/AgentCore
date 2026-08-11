// @vitest-environment jsdom
/**
 * QueuedTurnsBar：插话升格项可见标注；取消仍可用。
 */
import { cancelQueuedTurn } from "@/api/turn";
import { QueuedTurnsBar } from "@/components/QueuedTurnsBar";
import {
  __resetQueuedTurnsForTests,
  upsertQueuedTurn,
} from "@/lib/queuedTurns";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/turn", () => ({
  cancelQueuedTurn: vi.fn(),
}));

afterEach(() => {
  cleanup();
  __resetQueuedTurnsForTests();
  vi.clearAllMocks();
});

describe("QueuedTurnsBar", () => {
  it("interjectionId 非空 → 显示「来自你的插话」且可取消", () => {
    upsertQueuedTurn({
      queueId: "q-inj",
      conversationId: "c1",
      content: "please stop the worker",
      position: 1,
      queueDepth: 1,
      interjectionId: "inj-1",
    });

    render(<QueuedTurnsBar conversationId="c1" onCancelled={() => {}} />);

    const row = screen.getByTestId("queued-turn-row");
    expect(row.getAttribute("data-from-interjection")).toBe("1");
    expect(row.textContent).toContain("来自你的插话");
    expect(row.textContent).toContain("please stop the worker");
    expect(screen.getByTestId("queued-turn-cancel")).toBeTruthy();
    expect(cancelQueuedTurn).not.toHaveBeenCalled();
  });

  it("普通排队项不标插话来源", () => {
    upsertQueuedTurn({
      queueId: "q-plain",
      conversationId: "c1",
      content: "next turn please",
      position: 1,
      queueDepth: 1,
    });

    render(<QueuedTurnsBar conversationId="c1" onCancelled={() => {}} />);

    const row = screen.getByTestId("queued-turn-row");
    expect(row.getAttribute("data-from-interjection")).toBeNull();
    expect(row.textContent).not.toContain("来自你的插话");
  });
});
