// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revokeMutate = vi.fn();

vi.mock("@/hooks/useExternalGrants", () => ({
  useExternalGrants: vi.fn(),
  useRevokeExternalGrant: vi.fn(() => ({
    mutate: revokeMutate,
    isPending: false,
  })),
}));

vi.mock("@/lib/toast", () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
}));

import { useExternalGrants } from "@/hooks/useExternalGrants";
import { ExternalMountsSection } from "../ExternalMountsSection";

const useExternalGrantsMock = vi.mocked(useExternalGrants);

function mockQuery(
  data: unknown,
  over: Partial<{ isLoading: boolean; isError: boolean }> = {},
) {
  return {
    data,
    isLoading: over.isLoading ?? false,
    isError: over.isError ?? false,
    refetch: vi.fn(),
  };
}

const SAMPLE = [
  {
    root_id: "root-1",
    alias: "咨询",
    label: "咨询",
    namespace: "external/咨询",
    mode: "readonly" as const,
  },
  {
    root_id: "root-2",
    alias: "报表",
    label: "报表资料",
    namespace: "external/报表",
    mode: "organize" as const,
  },
];

beforeEach(() => {
  revokeMutate.mockReset();
  useExternalGrantsMock.mockReturnValue(mockQuery([]) as never);
});

afterEach(() => {
  cleanup();
});

describe("ExternalMountsSection", () => {
  it("renders nothing when the grant list is empty", () => {
    const { container } = render(
      <ExternalMountsSection conversationId="conv-1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists label / namespace / mode without absolute paths", () => {
    useExternalGrantsMock.mockReturnValue(mockQuery(SAMPLE) as never);
    render(<ExternalMountsSection conversationId="conv-1" />);

    expect(screen.getByText("区外目录挂载")).toBeTruthy();
    expect(screen.getByText("咨询")).toBeTruthy();
    expect(screen.getByText("报表资料")).toBeTruthy();
    expect(screen.getByText(/external\/咨询 · 只读/)).toBeTruthy();
    expect(screen.getByText(/external\/报表 · 整理/)).toBeTruthy();
    expect(screen.queryByText(/^[A-Za-z]:\\/)).toBeNull();
    expect(screen.queryByText(/\/Users\//)).toBeNull();
    expect(screen.queryByText(/\/home\//)).toBeNull();
  });

  it("calls revoke with root_id when 撤销 is clicked", () => {
    useExternalGrantsMock.mockReturnValue(mockQuery(SAMPLE) as never);
    render(<ExternalMountsSection conversationId="conv-1" />);

    const buttons = screen.getAllByRole("button", { name: "撤销" });
    expect(buttons).toHaveLength(2);
    const first = buttons[0];
    expect(first).toBeTruthy();
    fireEvent.click(first);

    expect(revokeMutate).toHaveBeenCalledWith(
      "root-1",
      expect.objectContaining({
        onError: expect.any(Function),
      }),
    );
  });

  it("shows retry affordance on load error", () => {
    useExternalGrantsMock.mockReturnValue(
      mockQuery(undefined, { isError: true }) as never,
    );
    render(<ExternalMountsSection conversationId="conv-1" />);
    const line = screen.getByText(/无法加载区外挂载/);
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).not.toContain("destructive");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});
