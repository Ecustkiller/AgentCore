// @vitest-environment jsdom
import { DeleteFolderDialog } from "@/components/folders/DeleteFolderDialog";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useFolders", () => ({
  useFolderTrash: () => ({ data: { retentionDays: 30 } }),
}));

afterEach(cleanup);

function renderDialog(
  over: Partial<Parameters<typeof DeleteFolderDialog>[0]> = {},
) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    name: "季度报告",
    liveConvCount: 2,
    isLocal: false,
    onConfirm: vi.fn(),
    onPermanentConfirm: vi.fn(),
    ...over,
  };
  render(<DeleteFolderDialog {...props} />);
  return props;
}

describe("DeleteFolderDialog", () => {
  it("默认软删：只承诺可恢复，不讲设定与白板", () => {
    renderDialog({ liveConvCount: 0 });
    expect(screen.getByText("30 天内可在「最近删除」中恢复。")).toBeTruthy();
    expect(screen.getByText("立即永久删除（不可恢复）")).toBeTruthy();
    expect(screen.queryByText(/设定/)).toBeNull();
    expect(screen.queryByText(/白板/)).toBeNull();
    expect(screen.queryByText(/指针/)).toBeNull();
    expect(screen.queryByText(/画像/)).toBeNull();
  });

  it("有对话才写归档；本机才写电脑上的文件", () => {
    renderDialog({ liveConvCount: 2, isLocal: true });
    expect(
      screen.getByText(/其下 2 条对话一并归档，恢复时一起回来/),
    ).toBeTruthy();
    expect(screen.getByText(/电脑上的文件不会被删除/)).toBeTruthy();
  });

  it("勾永久删除：清单只在描述里出现一次", () => {
    const props = renderDialog();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /立即永久删除（不可恢复）/ }),
    );
    expect(
      screen.getByText(
        "将永久删除全部对话、云端文件与这张桌的设定，不可恢复。",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "彻底删除" }));
    expect(props.onPermanentConfirm).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
});
