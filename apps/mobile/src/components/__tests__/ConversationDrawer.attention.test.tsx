// @vitest-environment jsdom
/**
 * 抽屉行的「AI 在等你」灯 —— 列表本身是打开即拉的静态快照，灯必须由 firehose
 * `ai_attention` 单独订阅点亮 / 熄灭。
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
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listConversations, listConversationsGrouped } = vi.hoisted(() => ({
  listConversations: vi.fn(),
  listConversationsGrouped: vi.fn(),
}));

const navigate = vi.fn();

vi.mock("@/api/client", () => ({ getTokens: () => ({ access: "token" }) }));
vi.mock("@/api/conversations", () => ({
  listConversations,
  listConversationsGrouped,
  deleteConversation: vi.fn(),
  renameConversation: vi.fn(),
  setConversationArchived: vi.fn(),
}));
vi.mock("@/api/search", () => ({ search: vi.fn() }));
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

import type {
  ConversationSummary,
  FolderGroup,
  GroupedConversations,
} from "@/api/conversations";
import {
  type AiAttentionEvent,
  __resetAiAttentionForTests,
  applyAiAttention,
  clearAiAttentionForConversation,
} from "@/lib/aiAttention";
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

function renderDrawer(onClose: () => void = () => {}) {
  return render(
    <MemoryRouter>
      <ConversationDrawer open onClose={onClose} onOpen={() => {}} />
    </MemoryRouter>,
  );
}

async function mountDrawer() {
  renderDrawer();
  await screen.findByText("部署上线");
}

/** 某一行是否亮着灯（灯挂在该行的对话按钮里）。 */
function lit(title: string): boolean {
  const row = screen.getByText(title).closest("button");
  if (!row) throw new Error(`没有找到「${title}」这一行`);
  return within(row).queryAllByLabelText("等你决策").length > 0;
}

beforeEach(() => {
  navigate.mockReset();
  listConversations.mockReset();
  listConversationsGrouped.mockReset();
  listConversations.mockResolvedValue([]);
  listConversationsGrouped.mockResolvedValue(
    grouped({
      ungrouped: [conv(), conv({ id: "conv-2", title: "周报汇总" })],
    }),
  );
  __resetAiAttentionForTests();
});

afterEach(() => {
  cleanup();
  __resetAiAttentionForTests();
});

describe("ConversationDrawer · 行级「等你」灯", () => {
  it("只有在等的那个对话亮灯", async () => {
    applyAiAttention(attention());
    await mountDrawer();

    expect(lit("部署上线")).toBe(true);
    expect(lit("周报汇总")).toBe(false);
  });

  it("抽屉开着时新到的 required 帧当场点亮那一行", async () => {
    await mountDrawer();
    expect(lit("周报汇总")).toBe(false);

    act(() => {
      applyAiAttention(attention({ conversation_id: "conv-2" }));
    });

    expect(lit("周报汇总")).toBe(true);
    expect(lit("部署上线")).toBe(false);
  });

  it("卡被任一端处理（resolved）后灯自动灭", async () => {
    applyAiAttention(attention());
    await mountDrawer();

    act(() => {
      applyAiAttention(attention({ state: "resolved" }));
    });

    await waitFor(() => expect(lit("部署上线")).toBe(false));
  });

  it("同一对话多条等待只亮一颗，处理完最后一条才灭", async () => {
    applyAiAttention(attention({ interaction_id: "ix-1" }));
    applyAiAttention(attention({ interaction_id: "ix-2" }));
    await mountDrawer();

    const row = screen.getByText("部署上线").closest("button");
    expect(
      within(row as HTMLElement).getAllByLabelText("等你决策"),
    ).toHaveLength(1);

    act(() => {
      applyAiAttention(
        attention({ interaction_id: "ix-1", state: "resolved" }),
      );
    });
    expect(lit("部署上线")).toBe(true);

    act(() => {
      applyAiAttention(
        attention({ interaction_id: "ix-2", state: "resolved" }),
      );
    });
    await waitFor(() => expect(lit("部署上线")).toBe(false));
  });

  it("打开该对话（兜底清理）后灯灭", async () => {
    applyAiAttention(attention());
    await mountDrawer();

    act(() => {
      clearAiAttentionForConversation("conv-1");
    });

    expect(lit("部署上线")).toBe(false);
  });
});

describe("ConversationDrawer · 文件夹分组", () => {
  it("云组头进文件", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({ folders: [folderGroup()] }),
    );
    renderDrawer();
    await screen.findByText("设计");

    fireEvent.click(screen.getByText("设计"));
    expect(navigate).toHaveBeenCalledWith(
      `/files/${encodeURIComponent("folder:f-cloud")}`,
      { state: { name: "设计" } },
    );
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("＋ 带 draftFolder state 去 / 并关抽屉", async () => {
    const onClose = vi.fn();
    listConversationsGrouped.mockResolvedValue(
      grouped({ folders: [folderGroup()] }),
    );
    renderDrawer(onClose);
    await screen.findByText("设计");

    fireEvent.click(screen.getByLabelText("在此新开"));
    expect(navigate).toHaveBeenCalledWith("/", {
      state: { draftFolderId: "f-cloud", draftFolderName: "设计" },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("本机组没有 ＋ / 不进文件", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({
        folders: [
          folderGroup({
            id: "f-local",
            name: "本机仓",
            mode: "local",
            conversations: [conv({ id: "c-local", title: "本机聊" })],
          }),
        ],
      }),
    );
    renderDrawer();
    await screen.findByText("本机仓");

    expect(screen.queryByLabelText("在此新开")).toBeNull();
    expect(screen.getByText("请在桌面端打开")).toBeTruthy();
    fireEvent.click(screen.getByText("本机仓"));
    expect(
      navigate.mock.calls.some((c) => String(c[0]).startsWith("/files")),
    ).toBe(false);
  });

  it("空组不出现", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({
        folders: [
          folderGroup({
            id: "f-empty",
            name: "空文件夹",
            conversations: [],
          }),
          folderGroup({
            id: "f-full",
            name: "有对话的组",
            conversations: [conv({ id: "c-full", title: "组内" })],
          }),
        ],
      }),
    );
    renderDrawer();
    await screen.findByText("有对话的组");
    expect(screen.queryByText("空文件夹")).toBeNull();
  });

  it("裸聊在组后，不造未分组标题", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({
        folders: [folderGroup({ conversations: [conv({ title: "组内聊" })] })],
        ungrouped: [conv({ id: "bare", title: "裸聊一条" })],
      }),
    );
    renderDrawer();
    const groupedTitle = await screen.findByText("设计");
    const bare = screen.getByText("裸聊一条");
    expect(
      groupedTitle.compareDocumentPosition(bare) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("未分组")).toBeNull();
  });

  it("已归档仍走扁平 listConversations(true)", async () => {
    listConversations.mockResolvedValue([
      conv({ id: "arch-1", title: "旧归档", archived: true }),
    ]);
    await mountDrawer();
    fireEvent.click(screen.getByText("已归档"));
    await screen.findByText("旧归档");
    expect(listConversations).toHaveBeenCalledWith(true);
    expect(screen.queryByText("未分组")).toBeNull();
  });
});
