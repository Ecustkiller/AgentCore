// @vitest-environment jsdom
import { COMPOSER_CONTEXT_COMPACTED_HINT } from "@/lib/composerContextCompactedHint";
import { formatLocalMoment } from "@/lib/recoveryMoment";
import type { Conversation } from "@/stores/conversation";
import { useConversationStore } from "@/stores/conversation";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerContextCompactedHint } from "../ComposerContextCompactedHint";

const useConversationsMock = vi.hoisted(() =>
  vi.fn(() => [] as Conversation[]),
);
vi.mock("@/hooks/useConversations", () => ({
  useConversations: useConversationsMock,
}));

const CID = "c1";

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: CID,
    title: "长对话",
    updatedAt: "2026-08-14T00:00:00Z",
    messageCount: 120,
    lastMessagePreview: null,
    ...over,
  };
}

function open(list: Conversation[], id: string | null = CID): void {
  useConversationsMock.mockReturnValue(list);
  useConversationStore.setState({ currentConversationId: id, byId: {} });
}

beforeEach(() => {
  open([], null);
});

afterEach(() => {
  cleanup();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
});

describe("ComposerContextCompactedHint", () => {
  it("renders nothing when hidden", () => {
    const { container } = render(<ComposerContextCompactedHint show={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the short zh compacted tip when visible", () => {
    render(<ComposerContextCompactedHint show />);
    expect(
      screen.getByTestId("composer-context-compacted-hint").textContent,
    ).toBe(COMPOSER_CONTEXT_COMPACTED_HINT);
  });

  it("压缩没跟上 → 说清丢了多少、原文还在、以及能怎么办", () => {
    open([conv({ contextGap: { droppedMessages: 32 } })]);
    render(<ComposerContextCompactedHint show={false} />);

    const text = screen.getByTestId("composer-context-gap-hint").textContent;
    expect(text).toContain("没能压缩成摘要"); // 什么没做成
    expect(text).toContain("32 条"); // 代价有多大
    expect(text).toContain("原文都在"); // 没丢的东西
    expect(text).toContain("自动重试"); // 不是永久丧失
    expect(text).toContain("再说一遍"); // 用户能怎么办
    // 灰字降级，不是红卡。
    expect(screen.getByTestId("composer-context-gap-hint").className).toContain(
      "text-muted-foreground",
    );
  });

  it("从没压缩成功过也要说 —— 那正是线上整天失败的形状", () => {
    // context_compacted=false → show=false，旧逻辑在这里完全沉默。
    open([
      conv({ contextCompacted: false, contextGap: { droppedMessages: 5 } }),
    ]);
    render(<ComposerContextCompactedHint show={false} />);
    expect(screen.getByTestId("composer-context-gap-hint")).toBeTruthy();
    expect(screen.queryByTestId("composer-context-compacted-hint")).toBeNull();
  });

  it("上游给了日期就按本机时区报出恢复时刻，没给就只说会自动重试", () => {
    // 后端给的是绝对瞬间；用户看到的必须是自己那块表上的时刻，且不标时区名。
    open([
      conv({
        contextGap: {
          droppedMessages: 8,
          recoveryAt: "2026-08-14T16:00:00Z",
        },
      }),
    ]);
    const { unmount } = render(<ComposerContextCompactedHint show />);
    const dated = screen.getByTestId("composer-context-gap-hint").textContent;
    expect(dated).toContain(formatLocalMoment("2026-08-14T16:00:00Z"));
    expect(dated).toContain("恢复，届时自动补上");
    expect(dated).not.toContain("UTC");
    unmount();

    open([conv({ contextGap: { droppedMessages: 8, recoveryAt: null } })]);
    render(<ComposerContextCompactedHint show />);
    const text = screen.getByTestId("composer-context-gap-hint").textContent;
    expect(text).toContain("自动重试");
    expect(text).not.toContain("恢复，届时");
  });

  it("短会话压缩失败不打扰：没有 gap 就回到原来的轻提示", () => {
    open([conv({ contextCompacted: true, messageCount: 12 })]);
    render(<ComposerContextCompactedHint show />);
    expect(
      screen.getByTestId("composer-context-compacted-hint").textContent,
    ).toBe(COMPOSER_CONTEXT_COMPACTED_HINT);
    expect(screen.queryByTestId("composer-context-gap-hint")).toBeNull();
  });

  it("别的会话丢了历史不算这一个的账", () => {
    open([conv({ id: "other", contextGap: { droppedMessages: 99 } })]);
    const { container } = render(<ComposerContextCompactedHint show={false} />);
    expect(container.firstChild).toBeNull();
  });
});
