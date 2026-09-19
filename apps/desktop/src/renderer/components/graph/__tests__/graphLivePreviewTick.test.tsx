// @vitest-environment jsdom
import {
  GRAPH_LIVE_PREVIEW_MS,
  useGraphLivePreviewTick,
} from "@/components/graph/graphLivePreviewTick";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useGraphLivePreviewTick", () => {
  it("ticks while streaming and stays frozen when idle", () => {
    const live = renderHook(
      ({ active }: { active: boolean }) => useGraphLivePreviewTick(active),
      { initialProps: { active: true } },
    );
    const idle = renderHook(() => useGraphLivePreviewTick(false));
    const start = live.result.current;
    expect(idle.result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(GRAPH_LIVE_PREVIEW_MS);
    });
    expect(live.result.current).toBe(start + 1);
    expect(idle.result.current).toBe(0);

    live.rerender({ active: false });
    expect(live.result.current).toBe(0);
    act(() => {
      vi.advanceTimersByTime(GRAPH_LIVE_PREVIEW_MS * 3);
    });
    expect(live.result.current).toBe(0);

    live.unmount();
    idle.unmount();
  });
});
