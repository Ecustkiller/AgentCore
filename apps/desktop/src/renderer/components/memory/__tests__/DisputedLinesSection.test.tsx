// @vitest-environment jsdom
/**
 * 已移走的记忆 — the recovery surface for line-level rejections.
 *
 * A rejected line is gone from its entry body, so「放回」must name the record it means
 * (an id, never a position) and「清空」must say out loud that it is one-way.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listDisputedMemoryLines = vi.fn();
const restoreMemoryLine = vi.fn();
const clearDisputedMemoryLines = vi.fn();

vi.mock("@/services/memory", () => ({
  MEMORY_DISPUTED_LINES_KEY: ["memory-disputed-lines"],
  listDisputedMemoryLines: () => listDisputedMemoryLines(),
  restoreMemoryLine: (...args: unknown[]) => restoreMemoryLine(...args),
  clearDisputedMemoryLines: () => clearDisputedMemoryLines(),
}));

vi.mock("@/lib/toast", () => ({
  notifyInfo: vi.fn(),
  notifyActionError: vi.fn(),
}));

vi.mock("@/hooks/useFolders", () => ({ getFolders: () => [] }));

import { DisputedLinesSection } from "../DisputedLinesSection";

const line = (id: string, text: string) => ({
  id,
  kind: "profile" as const,
  topicSlug: null,
  folderId: null,
  section: "关于用户的事实",
  text,
  disputedAt: "2026-08-13T10:00:00",
});

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DisputedLinesSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listDisputedMemoryLines.mockResolvedValue({
    lines: [line("rec-a", "用户在腾讯工作"), line("rec-b", "用户住在深圳")],
    maxPerEntry: 50,
  });
  restoreMemoryLine.mockResolvedValue({
    ok: true,
    conflict: false,
    version: "v2",
    lineId: "",
  });
  clearDisputedMemoryLines.mockResolvedValue(1);
});

afterEach(cleanup);

describe("DisputedLinesSection", () => {
  it("puts back the record the user pointed at, by id", async () => {
    renderSection();
    fireEvent.click(await screen.findByText("已移走的记忆"));

    fireEvent.click(screen.getAllByText("放回")[1]);

    await waitFor(() =>
      expect(restoreMemoryLine).toHaveBeenCalledWith({
        id: "rec-b",
        kind: "profile",
        topicSlug: null,
        folderId: null,
      }),
    );
  });

  it("states the per-entry bound rather than letting it expire quietly", async () => {
    renderSection();
    fireEvent.click(await screen.findByText("已移走的记忆"));
    expect(screen.getByText(/最多保留最近\s*50/)).toBeTruthy();
  });

  it("clears only after the user confirms", async () => {
    renderSection();
    fireEvent.click(await screen.findByText("清空"));
    expect(clearDisputedMemoryLines).not.toHaveBeenCalled();

    // The dialog names the cost: these lines stop being restorable.
    expect(screen.getByText(/这 2 条将不再能放回/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));

    await waitFor(() => expect(clearDisputedMemoryLines).toHaveBeenCalled());
  });
});
