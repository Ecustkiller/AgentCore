// @vitest-environment jsdom
/**
 * 草稿空态引导：引导要留给「还没跑成过」的人。
 *
 * 曾按「库里有没有对话」判定，于是一次失败 / 中途放弃 / 误触新建之后，示例任务与手册
 * 入口就一起永久消失——第二次回来的人反而更没抓手。现在按「有没有一来一回跑成过」判。
 */

import { DraftEmptyState } from "@/components/onboarding/DraftEmptyState";
import type { Conversation } from "@/stores/conversation";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let conversations: Conversation[] = [];
const fill = vi.fn();

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => conversations,
}));

vi.mock("@/stores/composer", () => ({
  useComposerDraftStore: (select: (s: { fill: unknown }) => unknown) =>
    select({ fill }),
}));

function conversation(messageCount: number, id: string): Conversation {
  return {
    id,
    title: "t",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount,
    lastMessagePreview: null,
  };
}

function renderEmptyState() {
  return render(
    <MemoryRouter>
      <DraftEmptyState />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  conversations = [];
  fill.mockReset();
});

describe("DraftEmptyState", () => {
  it("offers starter tasks and the manual to a brand-new user", () => {
    renderEmptyState();
    expect(screen.getByText(/今天想解决什么问题/)).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("link", { name: /产品手册/ })).toBeTruthy();
  });

  it("keeps the guidance when every earlier attempt failed or was abandoned", () => {
    conversations = [
      conversation(0, "c-misclick"),
      conversation(1, "c-gaveup"),
    ];
    renderEmptyState();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("link", { name: /产品手册/ })).toBeTruthy();
  });

  it("drops to the bare greeting once a conversation actually ran", () => {
    conversations = [conversation(1, "c-gaveup"), conversation(2, "c-worked")];
    renderEmptyState();
    expect(screen.getByText(/今天想解决什么问题/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /产品手册/ })).toBeNull();
  });

  it("fills the composer from a starter task instead of sending it", () => {
    renderEmptyState();
    const [first] = screen.getAllByRole("button");
    first.click();
    expect(fill).toHaveBeenCalledTimes(1);
    expect(String(fill.mock.calls[0][0])).toContain("并行");
  });
});
