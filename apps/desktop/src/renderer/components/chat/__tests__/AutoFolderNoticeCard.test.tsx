// @vitest-environment jsdom
import { conversationKeys } from "@/lib/queryKeys";
import type { FolderMeta } from "@/services/folders";
import type { AutoFolderNotice } from "@/stores/conversation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoFolderNoticeCard,
  AutoFolderNoticeLine,
} from "../AutoFolderNoticeCard";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

const updateFolder = vi.fn(
  async (_id: string, _patch: { name?: string; parentId?: string | null }) =>
    folder(),
);
vi.mock("@/services/folders", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/folders")>(
      "@/services/folders",
    );
  return {
    ...actual,
    updateFolder: (id: string, patch: { name?: string }) =>
      updateFolder(id, patch),
  };
});

function folder(over: Partial<FolderMeta> = {}): FolderMeta {
  return {
    id: "f-auto",
    name: "季度复盘",
    mode: "cloud",
    localRootId: null,
    localSubpath: null,
    relPath: "季度复盘",
    parentRelPath: null,
    ...over,
  };
}

type NoticeComponent = (props: { notice: AutoFolderNotice }) => ReactElement;

function renderNotice(Notice: NoticeComponent, folders: FolderMeta[]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  client.setQueryData(conversationKeys.grouped, { folders, conversations: [] });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Notice notice={{ folderId: "f-auto", name: "季度复盘" }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  navigate.mockClear();
  updateFolder.mockClear();
});

// 落点告知有两个落点（产出卡头部一行 / 无产出文件时的独立卡片），能力必须一模一样——
// 所以四条行为断言对两者各跑一遍。
const VARIANTS: { form: string; Notice: NoticeComponent }[] = [
  { form: "产出卡头部一行", Notice: AutoFolderNoticeLine },
  { form: "独立卡片", Notice: AutoFolderNoticeCard },
];

describe.each(VARIANTS)("裸聊落点告知 · $form", ({ Notice }) => {
  it("说出落点，点名字跳到文件页并聚焦该文件夹", () => {
    renderNotice(Notice, [folder()]);

    expect(screen.getByTestId("auto-folder-notice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /季度复盘/ }));

    expect(navigate).toHaveBeenCalledWith("/files", {
      state: { focusWsId: "folder:f-auto" },
    });
  });

  it("当场改名：回车提交改名请求", async () => {
    renderNotice(Notice, [folder()]);

    fireEvent.click(screen.getByRole("button", { name: "改名" }));
    const input = screen.getByLabelText("文件夹名") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Q3 复盘" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(updateFolder).toHaveBeenCalledWith("f-auto", { name: "Q3 复盘" });
    });
  });

  it("Esc 取消不发请求；名字没变也不发", async () => {
    renderNotice(Notice, [folder()]);

    fireEvent.click(screen.getByRole("button", { name: "改名" }));
    const input = screen.getByLabelText("文件夹名") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "别的名字" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(updateFolder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "改名" }));
    fireEvent.blur(screen.getByLabelText("文件夹名"));
    expect(updateFolder).not.toHaveBeenCalled();
  });

  it("以文件夹现名为准：用户改过名后提示跟着变，不停在事件里的旧名", () => {
    renderNotice(Notice, [folder({ name: "Q3 复盘" })]);

    expect(screen.getByRole("button", { name: /Q3 复盘/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /季度复盘/ })).toBeNull();
  });
});

describe("裸聊落点告知 · 措辞随有无产出文件而变", () => {
  it("产出卡头部：文件就在下面列着，说「文件已存到」", () => {
    renderNotice(AutoFolderNoticeLine, [folder()]);

    expect(screen.getByText("文件已存到新建的文件夹")).toBeTruthy();
  });

  it("独立卡片：这条路径下没有产出文件，只说建了文件夹，不冒充已写盘", () => {
    renderNotice(AutoFolderNoticeCard, [folder()]);

    expect(screen.getByText("已为这次对话新建文件夹")).toBeTruthy();
    expect(screen.queryByText("文件已存到新建的文件夹")).toBeNull();
  });
});
