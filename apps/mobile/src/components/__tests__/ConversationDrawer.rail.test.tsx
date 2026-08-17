// @vitest-environment jsdom
/**
 * 抽屉三区 / 置顶 / running 灯 / 删除文案 + 撤销条。
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  listConversations,
  listConversationsGrouped,
  listConversationTrash,
  deleteConversation,
  setConversationPinned,
  restoreConversation,
} = vi.hoisted(() => ({
  listConversations: vi.fn(),
  listConversationsGrouped: vi.fn(),
  listConversationTrash: vi.fn(),
  deleteConversation: vi.fn(),
  setConversationPinned: vi.fn(),
  restoreConversation: vi.fn(),
}));

const navigate = vi.fn();

vi.mock("@/api/client", () => ({ getTokens: () => ({ access: "token" }) }));
vi.mock("@/api/conversations", () => ({
  listConversations,
  listConversationsGrouped,
  listConversationTrash,
  deleteConversation,
  renameConversation: vi.fn(),
  setConversationArchived: vi.fn(),
  setConversationPinned,
  restoreConversation,
}));
vi.mock("@/api/search", () => ({ search: vi.fn() }));
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});
/** jsdom 无 showModal；ActionSheet / ConfirmDialog 走同一桩。 */
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
    <dialog className={className} aria-label={label} open>
      {children}
    </dialog>
  ),
}));

import type {
  ConversationSummary,
  FolderGroup,
  GroupedConversations,
} from "@/api/conversations";
import {
  type AiAttentionEvent,
  __resetAiAttentionForTests,
  applyAiAttention,
} from "@/lib/aiAttention";
import {
  __resetAiTurnActivityForTests,
  applyAiTurnActivity,
} from "@/lib/aiTurnActivity";
import {
  DELETE_CONVERSATION_LABEL,
  deleteConversationConfirmLabel,
} from "@/lib/conversationDeleteCopy";
import { resetDrawerGroupExpandForTests } from "@/lib/conversationDrawerExpand";
import { __resetConversationListCacheForTests } from "@/lib/conversationListCache";
import { ConversationDrawer } from "../ConversationDrawer";

function conv(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv-1",
    title: "部署上线",
    archived: false,
    context_compacted: false,
    created_at: "2026-08-01T00:00:00Z",
    deep_research_auto: false,
    message_count: 3,
    pinned: false,
    updated_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function attention(over: Partial<AiAttentionEvent> = {}): AiAttentionEvent {
  return {
    type: "ai_attention",
    state: "required",
    conversation_id: "conv-1",
    turn_id: "turn-1",
    interaction_id: "ix-1",
    kind: "ask_user",
    title: "要不要继续部署？",
    ...over,
  };
}

function folderGroup(over: Partial<FolderGroup> = {}): FolderGroup {
  return {
    id: "f-cloud",
    name: "设计",
    mode: "cloud",
    conversations: [conv({ id: "c-in-cloud", title: "海报" })],
    ...over,
  };
}

function grouped(
  over: Partial<GroupedConversations> = {},
): GroupedConversations {
  return { folders: [], ungrouped: [], ...over };
}

function renderDrawer(onClose: () => void = () => {}, open = true) {
  return render(
    <MemoryRouter>
      <ConversationDrawer open={open} onClose={onClose} onOpen={() => {}} />
    </MemoryRouter>,
  );
}

function following(earlier: HTMLElement, later: HTMLElement): boolean {
  return Boolean(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest(".conv-row");
  if (!row) throw new Error(`没有找到「${title}」这一行`);
  return row as HTMLElement;
}

function openMenu(title: string) {
  fireEvent.click(within(rowOf(title)).getByLabelText("更多操作"));
}

function lit(title: string, label: string): boolean {
  const btn = screen.getByText(title).closest("button");
  if (!btn) throw new Error(`没有找到「${title}」这一行`);
  return within(btn).queryAllByLabelText(label).length > 0;
}

beforeEach(() => {
  navigate.mockReset();
  listConversations.mockReset();
  listConversationsGrouped.mockReset();
  listConversationTrash.mockReset();
  deleteConversation.mockReset();
  setConversationPinned.mockReset();
  restoreConversation.mockReset();
  listConversations.mockResolvedValue([]);
  listConversationTrash.mockResolvedValue({
    items: [],
    retention_days: 30,
    total: 0,
  });
  listConversationsGrouped.mockResolvedValue(
    grouped({
      ungrouped: [conv(), conv({ id: "conv-2", title: "周报汇总" })],
    }),
  );
  deleteConversation.mockResolvedValue(undefined);
  setConversationPinned.mockImplementation(
    async (id: string, pinned: boolean) =>
      conv({ id, pinned, title: id === "conv-2" ? "周报汇总" : "部署上线" }),
  );
  restoreConversation.mockImplementation(async (id: string) =>
    conv({ id, title: id === "conv-2" ? "周报汇总" : "部署上线" }),
  );
  __resetAiAttentionForTests();
  __resetAiTurnActivityForTests();
  __resetConversationListCacheForTests();
  resetDrawerGroupExpandForTests();
});

afterEach(() => {
  cleanup();
  __resetAiAttentionForTests();
  __resetAiTurnActivityForTests();
  __resetConversationListCacheForTests();
  resetDrawerGroupExpandForTests();
  vi.useRealTimers();
});

describe("ConversationDrawer · 三区", () => {
  it("顶置顶、中组、底裸聊，无区标题，区间有分隔线", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({
        folders: [
          folderGroup({
            conversations: [
              conv({
                id: "c-in-cloud",
                title: "组内聊",
                folder_id: "f-cloud",
              }),
            ],
          }),
        ],
        ungrouped: [
          conv({
            id: "pin-1",
            title: "置顶聊",
            pinned: true,
            updated_at: "2026-08-02T00:00:00Z",
          }),
          conv({ id: "bare", title: "裸聊一条" }),
        ],
      }),
    );
    renderDrawer();
    const pinned = await screen.findByText("置顶聊");
    const group = screen.getByText("设计");
    const inGroup = screen.getByText("组内聊");
    const bare = screen.getByText("裸聊一条");
    expect(following(pinned, group)).toBe(true);
    expect(following(group, inGroup)).toBe(true);
    expect(following(inGroup, bare)).toBe(true);
    expect(screen.queryByText("未分组")).toBeNull();
    expect(document.querySelectorAll(".drawer-rail-zone")).toHaveLength(3);
    expect(screen.queryByRole("heading", { name: "置顶" })).toBeNull();
  });
});

describe("ConversationDrawer · 置顶", () => {
  it("活列表 ActionSheet 可置顶，只改 pinned 后 rail 重切", async () => {
    renderDrawer();
    await screen.findByText("周报汇总");
    openMenu("周报汇总");
    fireEvent.click(screen.getByRole("button", { name: "置顶" }));

    await waitFor(() => {
      expect(setConversationPinned).toHaveBeenCalledWith("conv-2", true);
    });
    await waitFor(() => {
      expect(
        following(screen.getByText("周报汇总"), screen.getByText("部署上线")),
      ).toBe(true);
    });
    expect(listConversationsGrouped).toHaveBeenCalledTimes(1);

    openMenu("周报汇总");
    expect(screen.getByRole("button", { name: "取消置顶" })).toBeTruthy();
  });

  it("已归档 ActionSheet 不加置顶", async () => {
    listConversations.mockResolvedValue([
      conv({ id: "arch-1", title: "旧归档", archived: true }),
    ]);
    renderDrawer();
    await screen.findByText("部署上线");
    fireEvent.click(screen.getByText("已归档"));
    await screen.findByText("旧归档");
    openMenu("旧归档");
    expect(screen.queryByRole("button", { name: "置顶" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消置顶" })).toBeNull();
  });
});

describe("ConversationDrawer · running 灯", () => {
  it("云 running 亮脉动灯", async () => {
    applyAiTurnActivity({ conversation_id: "conv-1", state: "running" });
    renderDrawer();
    await screen.findByText("部署上线");
    expect(lit("部署上线", "执行中")).toBe(true);
    expect(lit("周报汇总", "执行中")).toBe(false);
  });

  it("等你光环压过 running", async () => {
    applyAiAttention(attention());
    applyAiTurnActivity({ conversation_id: "conv-1", state: "running" });
    renderDrawer();
    await screen.findByText("部署上线");
    expect(lit("部署上线", "等你决策")).toBe(true);
    expect(lit("部署上线", "执行中")).toBe(false);
  });

  it("本机容器不亮云 running", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({
        ungrouped: [
          conv({
            id: "local-1",
            title: "本机聊",
            local_container_root_id: "root-1",
          }),
        ],
      }),
    );
    applyAiTurnActivity({ conversation_id: "local-1", state: "running" });
    renderDrawer();
    await screen.findByText("本机聊");
    expect(lit("本机聊", "执行中")).toBe(false);
  });
});

describe("ConversationDrawer · 删除文案与撤销", () => {
  async function confirmDelete(title: string) {
    openMenu(title);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByLabelText("对话框");
    expect(dialog.textContent).toContain(DELETE_CONVERSATION_LABEL);
    expect(dialog.textContent).toContain(deleteConversationConfirmLabel());
    expect(dialog.textContent).not.toMatch(/不可撤销/);
    fireEvent.click(
      within(dialog).getByRole("button", { name: DELETE_CONVERSATION_LABEL }),
    );
    await waitFor(() => {
      expect(deleteConversation).toHaveBeenCalled();
    });
  }

  it("确认用删除文案，成功后抽屉内撤销条，点撤销按 folder_id/pinned 插回", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({
        folders: [
          folderGroup({
            conversations: [
              conv({
                id: "c-in-cloud",
                title: "海报",
                folder_id: "f-cloud",
                pinned: true,
              }),
            ],
          }),
        ],
        ungrouped: [conv()],
      }),
    );
    restoreConversation.mockResolvedValue(
      conv({
        id: "c-in-cloud",
        title: "海报",
        folder_id: "f-cloud",
        pinned: true,
      }),
    );
    renderDrawer();
    await screen.findByText("海报");
    await confirmDelete("海报");
    expect(screen.queryByText("海报")).toBeNull();
    expect(screen.getByText("已删除「海报」")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => {
      expect(restoreConversation).toHaveBeenCalledWith("c-in-cloud");
    });
    await screen.findByText("海报");
    expect(following(screen.getByText("海报"), screen.getByText("设计"))).toBe(
      true,
    );
    expect(screen.queryByText("已删除「海报」")).toBeNull();
  });

  it("已归档删除后撤销插回扁平列表", async () => {
    const archived = conv({ id: "arch-1", title: "旧归档", archived: true });
    listConversations.mockResolvedValue([archived]);
    restoreConversation.mockResolvedValue(archived);
    renderDrawer();
    await screen.findByText("部署上线");
    fireEvent.click(screen.getByText("已归档"));
    await screen.findByText("旧归档");
    await confirmDelete("旧归档");
    expect(screen.queryByText("旧归档")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await screen.findByText("旧归档");
  });

  it("关抽屉清撤销条", async () => {
    const onClose = vi.fn();
    const view = renderDrawer(onClose);
    await screen.findByText("部署上线");
    await confirmDelete("部署上线");
    expect(screen.getByText("已删除「部署上线」")).toBeTruthy();

    view.rerender(
      <MemoryRouter>
        <ConversationDrawer open={false} onClose={onClose} onOpen={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("已删除「部署上线」")).toBeNull();
  });

  it("撤销 409 把错误亮出来", async () => {
    restoreConversation.mockRejectedValue(
      new Error("该对话已被清理，无法恢复"),
    );
    renderDrawer();
    await screen.findByText("部署上线");
    await confirmDelete("部署上线");
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await screen.findByText("该对话已被清理，无法恢复");
    expect(screen.queryByText("部署上线")).toBeNull();
  });

  it("撤销条约 8s 后消失", async () => {
    renderDrawer();
    await screen.findByText("部署上线");
    vi.useFakeTimers();
    openMenu("部署上线");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByLabelText("对话框");
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: DELETE_CONVERSATION_LABEL }),
      );
    });
    expect(screen.getByText("已删除「部署上线」")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByText("已删除「部署上线」")).toBeNull();
  });
});
