// @vitest-environment jsdom
import { UploadMenu } from "@/components/files/UploadMenu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => {
  cleanup();
});

describe("UploadMenu", () => {
  it("one toolbar control; menu splits file vs folder pickers", () => {
    const onUploadFiles = vi.fn();
    const onUploadFolder = vi.fn();
    render(
      <TooltipProvider>
        <UploadMenu
          uploading={false}
          onUploadFiles={onUploadFiles}
          onUploadFolder={onUploadFolder}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByRole("menuitem", { name: "上传文件" })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "上传" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "上传文件" }));
    expect(onUploadFiles).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByRole("button", { name: "上传" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "上传文件夹" }));
    expect(onUploadFolder).toHaveBeenCalledTimes(1);
  });
});
