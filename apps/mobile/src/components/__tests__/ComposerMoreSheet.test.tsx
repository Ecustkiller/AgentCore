// @vitest-environment jsdom
/**
 * Composer「＋」更多选项 sheet — 能力过滤后的模型组合 / 权限 / @ 引用入口。
 */
import { ComposerMoreSheet } from "@/components/ComposerMoreSheet";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

afterEach(cleanup);

function renderSheet(
  overrides: Partial<Parameters<typeof ComposerMoreSheet>[0]> = {},
) {
  const onOpenModel = vi.fn();
  const onOpenPermission = vi.fn();
  const onOpenMention = vi.fn();
  const onClose = vi.fn();
  render(
    <ComposerMoreSheet
      modelLabel="GLM-5.2"
      modelPreset={false}
      permissionLabel="少打断"
      onClose={onClose}
      onOpenModel={onOpenModel}
      onOpenPermission={onOpenPermission}
      onOpenMention={onOpenMention}
      {...overrides}
    />,
  );
  return { onOpenModel, onOpenPermission, onOpenMention, onClose };
}

describe("ComposerMoreSheet", () => {
  it("lists model / permission / @ mention and no workspace-style stubs", () => {
    const { onOpenModel, onOpenPermission, onOpenMention } = renderSheet();

    expect(screen.getByTestId("composer-more-model")).toBeTruthy();
    expect(screen.getByText("模型组合")).toBeTruthy();
    expect(screen.getByLabelText("模型组合：GLM-5.2")).toBeTruthy();
    expect(screen.getByLabelText("权限：少打断")).toBeTruthy();
    expect(screen.getByLabelText("@ 引用")).toBeTruthy();
    expect(screen.queryByLabelText("附件")).toBeNull();
    expect(screen.queryByText(/工作区/)).toBeNull();
    expect(screen.queryByText(/Git/)).toBeNull();
    expect(screen.queryByText(/后台/)).toBeNull();
    expect(screen.queryByText(/本机/)).toBeNull();
    expect(screen.queryByText(/上传/)).toBeNull();

    fireEvent.click(screen.getByTestId("composer-more-model"));
    expect(onOpenModel).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-more-permission"));
    expect(onOpenPermission).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-more-mention"));
    expect(onOpenMention).toHaveBeenCalled();
  });

  it("shows the current combination name and marks system presets", () => {
    renderSheet({ modelLabel: "GLM-5.2", modelPreset: true });
    expect(screen.getByText("GLM-5.2")).toBeTruthy();
    expect(screen.getByText("预置")).toBeTruthy();
    expect(screen.getByLabelText("模型组合：GLM-5.2（系统预置）")).toBeTruthy();
  });

  it("omits the preset badge for user-built combinations", () => {
    renderSheet({ modelLabel: "写作强档", modelPreset: false });
    expect(screen.getByText("写作强档")).toBeTruthy();
    expect(screen.queryByText("预置")).toBeNull();
    expect(screen.getByLabelText("模型组合：写作强档")).toBeTruthy();
  });

  it("exposes the full name on aria-label when the subtitle truncates", () => {
    renderSheet({
      modelLabel: "很长的用户自建写作组合名称",
      modelPreset: false,
    });
    expect(
      screen.getByLabelText("模型组合：很长的用户自建写作组合名称"),
    ).toBeTruthy();
  });

  it("goes inert while the composer is locked", () => {
    const { onOpenModel } = renderSheet({ disabled: true });
    const row = screen.getByTestId("composer-more-model");
    expect((row as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row);
    expect(onOpenModel).not.toHaveBeenCalled();
  });
});
