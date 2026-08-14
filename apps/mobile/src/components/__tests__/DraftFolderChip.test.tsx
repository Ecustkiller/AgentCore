// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** jsdom 无 showModal；与 StageCard / ModelPicker 同桩。 */
vi.mock("@/components/Modal", () => ({
  Modal: ({
    children,
    className,
    label,
  }: {
    children: ReactNode;
    className?: string;
    label?: string;
  }) => (
    <dialog className={className} aria-label={label}>
      {children}
    </dialog>
  ),
}));

const listCloudFolders = vi.fn();

vi.mock("@/api/folders", () => ({
  listCloudFolders: (...args: unknown[]) => listCloudFolders(...args),
}));

import { DraftFolderChip } from "../DraftFolderChip";

beforeEach(() => {
  listCloudFolders.mockReset();
  listCloudFolders.mockResolvedValue([
    { id: "f1", name: "设计", mode: "cloud", rel_path: "设计" },
  ]);
});

describe("DraftFolderChip", () => {
  it("defaults to 快速对话 and can pick an existing cloud folder", async () => {
    const onChange = vi.fn();
    render(<DraftFolderChip value={null} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("draft-folder-chip"));
    await screen.findByText("设计");
    fireEvent.click(screen.getByText("设计"));
    expect(onChange).toHaveBeenCalledWith({ id: "f1", name: "设计" });
  });

  it("can switch back to 快速对话", async () => {
    const onChange = vi.fn();
    render(
      <DraftFolderChip
        value={{ id: "f1", name: "设计" }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("draft-folder-chip"));
    await waitFor(() => expect(listCloudFolders).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("draft-folder-bare"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
