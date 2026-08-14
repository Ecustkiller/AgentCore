// @vitest-environment jsdom
/**
 * Composer「＋」更多选项 sheet — 能力过滤后的权限 / @ 引用入口（模型组合已在行内 chip）。
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
  it("lists permission / @ mention and no model row or workspace-style stubs", () => {
    const onOpenPermission = vi.fn();
    const onOpenMention = vi.fn();
    const onClose = vi.fn();

    render(
      <ComposerMoreSheet
        permissionLabel="少打断"
        onClose={onClose}
        onOpenPermission={onOpenPermission}
        onOpenMention={onOpenMention}
      />,
    );

    expect(screen.queryByTestId("composer-more-model")).toBeNull();
    expect(screen.queryByText("模型组合")).toBeNull();
    expect(screen.getByLabelText("权限：少打断")).toBeTruthy();
    expect(screen.getByLabelText("@ 引用")).toBeTruthy();
    expect(screen.queryByLabelText("附件")).toBeNull();
    expect(screen.queryByText(/工作区/)).toBeNull();
    expect(screen.queryByText(/Git/)).toBeNull();
    expect(screen.queryByText(/后台/)).toBeNull();
    expect(screen.queryByText(/本机/)).toBeNull();
    expect(screen.queryByText(/上传/)).toBeNull();

    fireEvent.click(screen.getByTestId("composer-more-permission"));
    expect(onOpenPermission).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-more-mention"));
    expect(onOpenMention).toHaveBeenCalled();
  });
});
