// @vitest-environment jsdom
import { useRunningElapsed } from "@/hooks/useRunningElapsed";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});

describe("useRunningElapsed", () => {
  it("ticks wall-clock seconds from startedAt", () => {
    vi.useFakeTimers();
    const started = Date.now() - 5_000;
    const { result } = renderHook(() => useRunningElapsed(true, started));
    expect(result.current).toBe(5);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(6);
  });

  it("drops to 0 when not ticking", () => {
    const { result } = renderHook(() =>
      useRunningElapsed(false, Date.now() - 5_000),
    );
    expect(result.current).toBe(0);
  });

  it("freezes the last second when freezeWhenStopped", () => {
    vi.useFakeTimers();
    const started = Date.now() - 40_000;
    const { result, rerender } = renderHook(
      ({ ticking }: { ticking: boolean }) =>
        useRunningElapsed(ticking, started, { freezeWhenStopped: true }),
      { initialProps: { ticking: true } },
    );
    expect(result.current).toBe(40);
    rerender({ ticking: false });
    expect(result.current).toBe(40);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(40);
  });
});
