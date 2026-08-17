// @vitest-environment jsdom
/**
 * 抽屉列表缓存 + 组折叠 persist：开着跟铸题/位次；折组有等你则展开（不写回）；
 * 关再开仍记住折叠。
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
  listConversationTrash: vi.fn().mockResolvedValue({
    items: [],
    retention_days: 30,
    total: 0,
  }),
  deleteConversation: vi.fn(),
  renameConversation: vi.fn(),
  setConversationArchived: vi.fn(),
  setConversationPinned: vi.fn(),
  restoreConversation: vi.fn(),
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
} from "@/lib/aiAttention";
import {
  readDrawerGroupExpand,
  resetDrawerGroupExpandForTests,
  writeDrawerGroupExpand,
} from "@/lib/conversationDrawerExpand";
import {
  __resetConversationListCacheForTests,
  noteConversationStreamEvent,
} from "@/lib/conversationListCache";
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
    conversation_id: "c-in-cloud",
    turn_id: "turn-1",
    interaction_id: "ix-1",
    kind: "ask_user",
    title: "要不要继续？",
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

function renderDrawer(open = true, onClose: () => void = () => {}) {
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

beforeEach(() => {
  navigate.mockReset();
  listConversations.mockReset();
  listConversationsGrouped.mockReset();
  listConversations.mockResolvedValue([]);
  listConversationsGrouped.mockResolvedValue(grouped({ ungrouped: [conv()] }));
  __resetAiAttentionForTests();
  __resetConversationListCacheForTests();
  resetDrawerGroupExpandForTests();
});

afterEach(() => {
  cleanup();
  __resetAiAttentionForTests();
  __resetConversationListCacheForTests();
  resetDrawerGroupExpandForTests();
  vi.useRealTimers();
});

describe("ConversationDrawer · 铸题 / 位次", () => {
  it("铸题改标题不换位", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({
        ungrouped: [
          conv({
            id: "newer",
            title: "较新",
            updated_at: "2026-08-02T00:00:00Z",
          }),
          conv({
            id: "older",
            title: "草稿",
            updated_at: "2026-08-01T00:00:00Z",
          }),
        ],
      }),
    );
    renderDrawer();
    await screen.findByText("较新");
    expect(following(screen.getByText("较新"), screen.getByText("草稿"))).toBe(
      true,
    );

    act(() => {
      noteConversationStreamEvent("older", {
        type: "title_generated",
        payload: { title: "铸出来的标题" },
      });
    });

    expect(screen.getByText("铸出来的标题")).toBeTruthy();
    expect(screen.queryByText("草稿")).toBeNull();
    expect(
      following(screen.getByText("较新"), screen.getByText("铸出来的标题")),
    ).toBe(true);
  });

  it("message_start / bump 顶位次", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({
        ungrouped: [
          conv({
            id: "newer",
            title: "较新",
            updated_at: "2026-08-02T00:00:00Z",
          }),
          conv({
            id: "older",
            title: "草稿",
            updated_at: "2026-08-01T00:00:00Z",
          }),
        ],
      }),
    );
    renderDrawer();
    await screen.findByText("较新");
    expect(following(screen.getByText("较新"), screen.getByText("草稿"))).toBe(
      true,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T04:00:00.000Z"));
    act(() => {
      noteConversationStreamEvent("older", { type: "message_start" });
    });

    expect(following(screen.getByText("草稿"), screen.getByText("较新"))).toBe(
      true,
    );
  });
});

describe("ConversationDrawer · 折组 persist", () => {
  it("折组有等你则展开，且不写回 persist", async () => {
    writeDrawerGroupExpand("f-cloud", false);
    listConversationsGrouped.mockResolvedValue(
      grouped({ folders: [folderGroup()] }),
    );
    renderDrawer();
    await screen.findByText("设计");
    expect(screen.queryByText("海报")).toBeNull();
    expect(readDrawerGroupExpand()["f-cloud"]).toBe(false);

    act(() => {
      applyAiAttention(attention());
    });

    expect(screen.getByText("海报")).toBeTruthy();
    expect(readDrawerGroupExpand()["f-cloud"]).toBe(false);
  });

  it("关再开仍记住折叠", async () => {
    listConversationsGrouped.mockResolvedValue(
      grouped({ folders: [folderGroup()] }),
    );
    const onClose = vi.fn();
    const view = renderDrawer(true, onClose);
    await screen.findByText("海报");

    fireEvent.click(screen.getByLabelText("收起设计"));
    expect(screen.queryByText("海报")).toBeNull();
    expect(readDrawerGroupExpand()["f-cloud"]).toBe(false);

    view.rerender(
      <MemoryRouter>
        <ConversationDrawer open={false} onClose={onClose} onOpen={() => {}} />
      </MemoryRouter>,
    );
    expect(readDrawerGroupExpand()["f-cloud"]).toBe(false);

    cleanup();
    renderDrawer();
    await screen.findByText("设计");
    expect(screen.queryByText("海报")).toBeNull();
    expect(screen.getByLabelText("展开设计")).toBeTruthy();
    expect(readDrawerGroupExpand()["f-cloud"]).toBe(false);
  });
});
