// @vitest-environment jsdom

import { FilePreviewBody } from "@/components/files/FilePreviewBody";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("FilePreviewBody", () => {
  it("image: shows mime·size, zoom controls, and opens lightbox on click", () => {
    render(
      <FilePreviewBody
        name="shot.png"
        result={{
          kind: "image",
          dataUrl: "data:image/png;base64,AAAA",
          mime: "image/png",
          size: 1280,
        }}
      />,
    );

    expect(screen.getByText(/image\/png/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "放大" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "缩小" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "放大预览 shot.png" }));
    expect(screen.getByRole("dialog", { name: "shot.png" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "shot.png" })).toBeNull();
  });

  it("pdf: renders iframe with data URL and footer meta", () => {
    const { container } = render(
      <FilePreviewBody
        name="doc.pdf"
        result={{
          kind: "pdf",
          dataUrl: "data:application/pdf;base64,JVBERg==",
          mime: "application/pdf",
          size: 4096,
        }}
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("src")).toBe(
      "data:application/pdf;base64,JVBERg==",
    );
    expect(iframe?.getAttribute("title")).toBe("doc.pdf");
    expect(screen.getByText(/application\/pdf/)).toBeTruthy();
  });

  it("too-large / binary: clearer download-or-open copy", () => {
    const { rerender } = render(
      <FilePreviewBody name="big.bin" result={{ kind: "too-large" }} />,
    );
    expect(
      screen.getByText(
        "文件过大，不在面板内预览，请下载或用系统默认程序打开。",
      ),
    ).toBeTruthy();

    rerender(
      <FilePreviewBody
        name="sheet.xlsx"
        result={{
          kind: "binary",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 2048,
          reason: "无法在面板内预览，请下载或用系统默认程序打开",
        }}
      />,
    );
    expect(screen.getByText("无法预览此文件")).toBeTruthy();
    expect(
      screen.getByText("无法在面板内预览，请下载或用系统默认程序打开"),
    ).toBeTruthy();
  });

  it("兜底面：两条出路都给可点主按钮（binary / too-large 同款）", () => {
    const onOpenWithOsDefaultApp = vi.fn();
    const onDownload = vi.fn();
    const { rerender } = render(
      <FilePreviewBody
        name="sheet.xlsx"
        result={{ kind: "binary", mime: "application/vnd.ms-excel", size: 20 }}
        onOpenWithOsDefaultApp={onOpenWithOsDefaultApp}
        onDownload={onDownload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "用默认程序打开" }));
    expect(onOpenWithOsDefaultApp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(onDownload).toHaveBeenCalledTimes(1);

    // 不能外部打开（web / 白名单外）时只剩下载，且它接手主按钮位。
    rerender(
      <FilePreviewBody
        name="big.bin"
        result={{ kind: "too-large" }}
        onDownload={onDownload}
      />,
    );
    expect(screen.queryByRole("button", { name: "用默认程序打开" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(onDownload).toHaveBeenCalledTimes(2);
  });

  it("兜底面：两个出口都不可用 → 只留说明，不渲染空按钮", () => {
    render(<FilePreviewBody name="big.bin" result={{ kind: "too-large" }} />);
    expect(screen.getByText("文件过大")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
