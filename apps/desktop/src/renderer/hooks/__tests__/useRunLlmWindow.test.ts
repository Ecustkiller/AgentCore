// @vitest-environment jsdom

import {
  resetRunLlmWindowCacheForTests,
  useRunLlmWindow,
} from "@/hooks/useRunLlmWindow";
import { ApiError, NetworkError } from "@/services/api";
import { fetchRunLlmWindow } from "@/services/llmWindow";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/preview", () => ({ isWebPreview: vi.fn(() => false) }));
vi.mock("@/services/llmWindow", () => ({ fetchRunLlmWindow: vi.fn() }));

beforeEach(() => {
  resetRunLlmWindowCacheForTests();
  vi.mocked(fetchRunLlmWindow).mockReset();
});

describe("useRunLlmWindow", () => {
  it("loads llm-window once per conversation/message/run", async () => {
    vi.mocked(fetchRunLlmWindow).mockResolvedValue({
      run_id: "run-1",
      available: true,
      messages: [],
    });
    const { result } = renderHook(() =>
      useRunLlmWindow("conv-1", "msg-1", "run-1", true),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchRunLlmWindow).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.data?.available).toBe(true);
  });

  it("types 404 as 加载失败（未找到）", async () => {
    vi.mocked(fetchRunLlmWindow).mockRejectedValue(
      new ApiError(404, "missing"),
    );
    const { result } = renderHook(() =>
      useRunLlmWindow("conv-1", "msg-1", "run-1", true),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe("加载失败（未找到）");
  });

  it("types NetworkError as 加载失败（网络异常）", async () => {
    vi.mocked(fetchRunLlmWindow).mockRejectedValue(new NetworkError());
    const { result } = renderHook(() =>
      useRunLlmWindow("conv-1", "msg-1", "run-1", true),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe("加载失败（网络异常）");
  });

  it("does not fetch when disabled", async () => {
    renderHook(() => useRunLlmWindow("conv-1", "msg-1", "run-1", false));
    await waitFor(() => {
      expect(fetchRunLlmWindow).not.toHaveBeenCalled();
    });
  });
});
