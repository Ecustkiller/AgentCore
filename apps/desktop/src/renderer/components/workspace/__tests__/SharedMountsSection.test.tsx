// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mountMutate = vi.fn();
const unmountMutate = vi.fn();

vi.mock("@/hooks/useSharedSpaces", () => ({
  useSharedSpaces: vi.fn(),
  useSharedMounts: vi.fn(),
  useMountSharedSpace: vi.fn(() => ({
    mutate: mountMutate,
    isPending: false,
  })),
  useUnmountSharedSpace: vi.fn(() => ({
    mutate: unmountMutate,
    isPending: false,
  })),
}));

vi.mock("@/components/files/sharedSpaces/CreateSharedSpaceDialog", () => ({
  CreateSharedSpaceDialog: ({
    open,
    onClose,
    onCreated,
  }: {
    open: boolean;
    onClose: () => void;
    onCreated?: (spaceId: string) => void;
  }) =>
    open ? (
      <dialog open aria-label="新建共享空间">
        <button
          type="button"
          onClick={() => {
            onCreated?.("new-space-id");
            onClose();
          }}
        >
          模拟创建成功
        </button>
      </dialog>
    ) : null,
}));

vi.mock("@/lib/toast", () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}));

import { useSharedMounts, useSharedSpaces } from "@/hooks/useSharedSpaces";
import { SharedMountsSection } from "../SharedMountsSection";

const useSharedSpacesMock = vi.mocked(useSharedSpaces);
const useSharedMountsMock = vi.mocked(useSharedMounts);

function mockQuery<T>(
  data: T,
  over: Partial<{ isLoading: boolean; isError: boolean }> = {},
) {
  return {
    data,
    isLoading: over.isLoading ?? false,
    isError: over.isError ?? false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  mountMutate.mockReset();
  unmountMutate.mockReset();
  useSharedSpacesMock.mockReturnValue(
    mockQuery([
      {
        id: "space-a",
        name: "已有空间",
        my_role: "editor",
      },
    ]) as never,
  );
  useSharedMountsMock.mockReturnValue(mockQuery([]) as never);
});

afterEach(() => {
  cleanup();
});

describe("SharedMountsSection", () => {
  it("shows 新建 next to 挂载 and empty copy that mentions creating", () => {
    render(<SharedMountsSection conversationId="conv-1" />);
    expect(screen.getByRole("button", { name: "新建" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "挂载" })).toBeTruthy();
    expect(
      screen.getByText(/尚未挂载。可挂载已有空间，或新建并挂到本对话。/),
    ).toBeTruthy();
  });

  it("opens create dialog from header and mounts new space on success", () => {
    render(<SharedMountsSection conversationId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(screen.getByRole("dialog", { name: "新建共享空间" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "模拟创建成功" }));
    expect(mountMutate).toHaveBeenCalledWith(
      { spaceId: "new-space-id" },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("picker empty state offers 新建共享空间 (兑现「或创建」)", () => {
    useSharedSpacesMock.mockReturnValue(mockQuery([]) as never);
    render(<SharedMountsSection conversationId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: "挂载" }));
    expect(
      screen.getByText(/没有可挂载的共享空间（需先加入或创建）/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建共享空间" }));
    expect(screen.getByRole("dialog", { name: "新建共享空间" })).toBeTruthy();
  });
});
