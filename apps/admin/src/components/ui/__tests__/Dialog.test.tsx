// @vitest-environment jsdom
/**
 * The shared modal. Six pages hand-rolled this overlay and all six shipped the same
 * gaps — no dialog role, dead Esc key, loose focus, scrollable background. These pin
 * each of those so the next page that needs a modal inherits the fixes.
 */

import { Dialog } from "@/components/ui/Dialog";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

function renderDialog(props: Partial<Parameters<typeof Dialog>[0]> = {}) {
  const onClose = vi.fn();
  const result = render(
    <Dialog open onClose={onClose} title="重置密码" {...props}>
      <input aria-label="新密码" />
      <button type="button">保存</button>
    </Dialog>,
  );
  return { onClose, ...result };
}

/** The overlay is aria-hidden by design, so it can only be reached structurally. */
function overlayOf(dialog: HTMLElement): Element {
  const overlay = dialog.previousElementSibling;
  if (!overlay) throw new Error("dialog overlay missing");
  return overlay;
}

describe("Dialog", () => {
  it("renders nothing while closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exposes itself as a modal dialog labelled by its title", () => {
    renderDialog({ description: "该用户下次登录需改密" });
    const dialog = screen.getByRole("dialog");

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId && document.getElementById(labelId)?.textContent).toBe("重置密码");
    const describedId = dialog.getAttribute("aria-describedby");
    expect(describedId && document.getElementById(describedId)?.textContent).toBe(
      "该用户下次登录需改密",
    );
  });

  it("closes on Escape", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers exactly one close control to assistive tech", () => {
    renderDialog();
    // The overlay is a mouse affordance; announcing it as a second 「关闭」 button
    // would make the two indistinguishable in a screen reader's control list.
    expect(screen.getAllByRole("button", { name: "关闭" })).toHaveLength(1);
  });

  it("refuses every dismissal path while a request is in flight", () => {
    const { onClose } = renderDialog({ busy: true });

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(overlayOf(screen.getByRole("dialog")));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("honours dismissOnOverlay", () => {
    const { onClose, unmount } = renderDialog();
    fireEvent.mouseDown(overlayOf(screen.getByRole("dialog")));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const guarded = renderDialog({ dismissOnOverlay: false });
    fireEvent.mouseDown(overlayOf(screen.getByRole("dialog")));
    expect(guarded.onClose).not.toHaveBeenCalled();
  });

  it("locks background scrolling and restores it on close", () => {
    const { unmount } = renderDialog();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus into the panel and hands it back to the opener", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = renderDialog();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps Tab inside the panel", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("input,button"),
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
