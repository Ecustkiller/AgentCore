// @vitest-environment jsdom
/**
 * 抽屉行的「AI 在等你」灯 —— 列表本身是打开即拉的静态快照，灯必须由 firehose
 * `ai_attention` 单独订阅点亮 / 熄灭。
 */
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listConversations } = vi.hoisted(() => ({
  listConversations: vi.fn(),
}));

vi.mock("@/api/client", () => ({ getTokens: () => ({ access: "token" }) }));
vi.mock("@/api/conversations", () => ({
  listConversations,
  deleteConversation: vi.fn(),
  renameConversation: vi.fn(),
  setConversationArchived: vi.fn(),
}));
vi.mock("@/api/search", () => ({ search: vi.fn() }));

import type { ConversationSummary } from "@/api/conversations";
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

async function mountDrawer() {
  render(
    <MemoryRouter>
      <ConversationDrawer open onClose={() => {}} onOpen={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText("部署上线");
}

/** 某一行是否亮着灯（灯挂在该行的对话按钮里）。 */
function lit(title: string): boolean {
  const row = screen.getByText(title).closest("button");
  if (!row) throw new Error(`没有找到「${title}」这一行`);
  return within(row).queryAllByLabelText("等你决策").length > 0;
}

beforeEach(() => {
  listConversations.mockReset();
  listConversations.mockResolvedValue([
    conv(),
    conv({ id: "conv-2", title: "周报汇总" }),
  ]);
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
    expect(lit("部署上线")).toBe(false);
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
