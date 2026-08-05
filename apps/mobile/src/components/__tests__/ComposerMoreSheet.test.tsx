// @vitest-environment jsdom
/**
 * Composer「＋」更多选项 sheet — 能力过滤后的三项入口。
 */
import { ComposerMoreSheet } from "@/components/ComposerMoreSheet";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(cleanup);

describe("ComposerMoreSheet", () => {
  it("lists model / permission / attach and no workspace-style stubs", () => {
    const onOpenModel = vi.fn();
    const onOpenPermission = vi.fn();
    const onAttach = vi.fn();
    const onClose = vi.fn();

    render(
      <ComposerMoreSheet
        modelLabel="默认组合"
        permissionLabel="少打断"
        onClose={onClose}
        onOpenModel={onOpenModel}
        onOpenPermission={onOpenPermission}
        onAttach={onAttach}
      />,
    );

    expect(screen.getByLabelText("模型组合：默认组合")).toBeTruthy();
    expect(screen.getByLabelText("权限：少打断")).toBeTruthy();
    expect(screen.getByLabelText("附件")).toBeTruthy();
    expect(screen.queryByText(/工作区/)).toBeNull();
    expect(screen.queryByText(/Git/)).toBeNull();
    expect(screen.queryByText(/后台/)).toBeNull();
    expect(screen.queryByText(/本机/)).toBeNull();

    fireEvent.click(screen.getByTestId("composer-more-model"));
    expect(onOpenModel).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-more-permission"));
    expect(onOpenPermission).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-more-attach"));
    expect(onAttach).toHaveBeenCalled();
  });
});
