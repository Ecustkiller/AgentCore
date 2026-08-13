// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../confirm-dialog";

function setup(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="删除服务商？"
      description="组合槽位会自动回落到其他服务商。"
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe("ConfirmDialog", () => {
  it("shows the title, description and both actions", () => {
    setup();
    expect(screen.getByText("删除服务商？")).toBeTruthy();
    expect(screen.getByText("组合槽位会自动回落到其他服务商。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确定" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("confirms and cancels through the caller's handlers", () => {
    const { onConfirm, onOpenChange } = setup({ confirmLabel: "删除" });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders a danger confirm for irreversible actions", () => {
    setup({ tone: "danger", confirmLabel: "确认注销" });
    expect(
      screen.getByRole("button", { name: "确认注销" }).className,
    ).toContain("bg-destructive");
  });

  it("gates the confirm button while the body is incomplete", () => {
    const { onConfirm } = setup({ confirmDisabled: true });
    const confirm = screen.getByRole("button", {
      name: "确定",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("locks both buttons and refuses to close while busy", () => {
    const { onConfirm, onOpenChange } = setup({ busy: true });
    const confirm = screen.getByRole("button", {
      name: "确定",
    }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", {
      name: "取消",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders an extra body slot above the footer", () => {
    setup({
      children: <input aria-label="当前密码" type="password" />,
    });
    expect(screen.getByLabelText("当前密码")).toBeTruthy();
  });
});
