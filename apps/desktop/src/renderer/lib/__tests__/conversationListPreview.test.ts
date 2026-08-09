import {
  getConversations,
  syncConversationListPreview,
} from "@/hooks/useConversations";
import { queryClient } from "@/lib/queryClient";
import { conversationKeys } from "@/lib/queryKeys";
import type { Conversation, Message } from "@/stores/conversation";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { previewFromOpenedWindow } from "../conversationListPreview";

const STALE = "上次成功回复的摘要内容";

function listed(id: string, preview: string | null): Conversation {
  return {
    id,
    title: "对话",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount: 2,
    lastMessagePreview: preview,
    folderId: null,
    localContainerRootId: null,
    localRootId: null,
    pinned: false,
    archived: false,
  };
}

function msg(
  id: string,
  role: "user" | "assistant",
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    role,
    content,
    createdAt: "2026-01-01T00:00:00Z",
    executionId: null,
    isStreaming: false,
    ...extra,
  };
}

function seedList(conversations: Conversation[]): void {
  queryClient.setQueryData(conversationKeys.grouped, {
    folders: [],
    conversations,
  });
}

beforeEach(() => {
  queryClient.clear();
  useConversationStore.setState({
    currentConversationId: null,
    byId: {},
    sliceLruOrder: [],
  });
});

describe("previewFromOpenedWindow", () => {
  it("slices visible assistant text", () => {
    const long = "可见正文".repeat(40);
    expect(
      previewFromOpenedWindow(
        [msg("u1", "user", "你好"), msg("a1", "assistant", long)],
        STALE,
      ),
    ).toBe(long.slice(0, 80));
  });

  it("does not keep stale list preview on empty failure", () => {
    expect(
      previewFromOpenedWindow(
        [
          msg("u1", "user", "你好"),
          msg("a1", "assistant", "", { finishReason: "error" }),
        ],
        STALE,
      ),
    ).toBe("模型调用失败，请重试。");
  });

  it("keeps listed preview when the window is empty", () => {
    expect(previewFromOpenedWindow([], STALE)).toBe(STALE);
  });
});

describe("syncConversationListPreview", () => {
  it("patches the sidebar lastMessagePreview from the in-memory window", () => {
    seedList([listed("c1", STALE)]);
    useConversationStore.setState({
      currentConversationId: "c1",
      byId: {
        c1: {
          ...EMPTY_RUNTIME,
          messages: [
            msg("u1", "user", "新问题"),
            msg("a1", "assistant", "这是本回合的新回复摘要内容"),
          ],
          turnPhase: "completed",
        },
      },
    });

    syncConversationListPreview("c1");

    expect(getConversations()[0].lastMessagePreview).toBe(
      "这是本回合的新回复摘要内容",
    );
    expect(getConversations()[0].lastMessagePreview).not.toBe(STALE);
  });

  it("is a no-op when the conversation is not in the list cache", () => {
    seedList([listed("other", STALE)]);
    useConversationStore.setState({
      currentConversationId: "c1",
      byId: {
        c1: {
          ...EMPTY_RUNTIME,
          messages: [msg("a1", "assistant", "新回复")],
          turnPhase: "completed",
        },
      },
    });

    syncConversationListPreview("c1");

    expect(getConversations()[0].lastMessagePreview).toBe(STALE);
  });
});
