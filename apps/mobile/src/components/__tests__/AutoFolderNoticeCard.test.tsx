// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
const renameFolder = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("@/api/folders", () => ({
  renameFolder: (...args: unknown[]) => renameFolder(...args),
}));

import {
  AutoFolderNoticeCard,
  AutoFolderNoticeLine,
} from "../AutoFolderNoticeCard";

const notice = { folderId: "f-auto", name: "季度复盘" };

beforeEach(() => {
  navigate.mockClear();
  renameFolder.mockReset();
  renameFolder.mockResolvedValue({ id: "f-auto", name: "新名", mode: "cloud" });
});

describe("AutoFolderNoticeCard", () => {
  it("opens the files tab on the new folder and can rename", async () => {
    render(
      <MemoryRouter>
        <AutoFolderNoticeCard notice={notice} />
      </MemoryRouter>,
    );
    expect(screen.getByText("已为这次对话新建文件夹")).toBeTruthy();
    fireEvent.click(screen.getByText("季度复盘"));
    expect(navigate).toHaveBeenCalledWith(
      `/files/${encodeURIComponent("folder:f-auto")}`,
      { state: { name: "季度复盘" } },
    );

    fireEvent.click(screen.getByText("改名"));
    const input = screen.getByLabelText("文件夹名") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "新名" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(renameFolder).toHaveBeenCalledWith("f-auto", "新名"),
    );
    await waitFor(() => expect(screen.getByText("新名")).toBeTruthy());
  });
});

describe("AutoFolderNoticeLine", () => {
  it("uses the in-card copy when files already landed", () => {
    render(
      <MemoryRouter>
        <AutoFolderNoticeLine notice={notice} />
      </MemoryRouter>,
    );
    expect(screen.getByText("文件已存到新建的文件夹")).toBeTruthy();
  });
});
