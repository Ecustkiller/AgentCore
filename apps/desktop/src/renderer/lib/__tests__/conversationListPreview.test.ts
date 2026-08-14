import {
  getConversations,
  syncConversationListPreview,
} from "@/hooks/useConversations";
import {
  TURN_CANCELLED_EMPTY_MESSAGE,
  TURN_INTERRUPTED_EMPTY_MESSAGE,
} from "@/lib/errors";
import { queryClient } from "@/lib/queryClient";
import { conversationKeys } from "@/lib/queryKeys";
import type { Conversation, Message } from "@/stores/conversation";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildMessagePreview,
  previewFromOpenedWindow,
} from "../conversationListPreview";

const STALE = "上次成功回复的摘要内容";
const USER = "你好，把用户句当摘要";
const PRIOR_ASSISTANT = "先前助手回复的摘要";

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
        [msg("u1", "user", USER), msg("a1", "assistant", long)],
        STALE,
      ),
    ).toBe(long.slice(0, 80));
  });

  it("does not keep stale list preview on empty failure", () => {
    expect(
      previewFromOpenedWindow(
        [
          msg("u1", "user", USER),
          msg("a1", "assistant", "", { finishReason: "error" }),
        ],
        STALE,
      ),
    ).toBe("模型调用失败，请重试。");
  });

  it("keeps listed preview when the window is empty", () => {
    expect(previewFromOpenedWindow([], STALE)).toBe(STALE);
  });

  it("walks back to the previous visible assistant past empty cancelled", () => {
    expect(
      previewFromOpenedWindow(
        [
          msg("a0", "assistant", PRIOR_ASSISTANT),
          msg("u1", "user", USER),
          msg("a1", "assistant", "", { finishReason: "cancelled" }),
        ],
        STALE,
      ),
    ).toBe(PRIOR_ASSISTANT);
  });

  it("does not use the user sentence as stop-turn preview", () => {
    const preview = previewFromOpenedWindow(
      [
        msg("u1", "user", USER),
        msg("a1", "assistant", "", { finishReason: "cancelled" }),
      ],
      STALE,
    );
    expect(preview).not.toBe(USER);
    expect(preview).not.toBe(TURN_CANCELLED_EMPTY_MESSAGE);
    expect(preview).toBe(STALE);
  });

  it("walks back past empty paused assistant instead of incomplete-failure copy", () => {
    const preview = previewFromOpenedWindow(
      [
        msg("a0", "assistant", PRIOR_ASSISTANT),
        msg("u1", "user", USER),
        msg("a1", "assistant", "", { finishReason: "paused" }),
      ],
      STALE,
    );
    expect(preview).toBe(PRIOR_ASSISTANT);
    expect(preview).not.toBe(USER);
    expect(preview).not.toBe("本轮未能完成，请重试。");
    expect(preview).not.toContain("本轮未能完成");
  });

  it("walks back empty paused when finishReason is only on runs", () => {
    const preview = previewFromOpenedWindow(
      [
        msg("a0", "assistant", PRIOR_ASSISTANT),
        msg("u1", "user", USER),
        msg("a1", "assistant", "", {
          runs: { events: [], finishReason: "paused" },
        }),
      ],
      STALE,
    );
    expect(preview).toBe(PRIOR_ASSISTANT);
    expect(preview).not.toBe(USER);
    expect(preview).not.toContain("本轮未能完成");
  });

  it("skips interrupt-copy and walks to the prior assistant, not the user", () => {
    const preview = previewFromOpenedWindow(
      [
        msg("a0", "assistant", PRIOR_ASSISTANT),
        msg("u1", "user", USER),
        msg("a1", "assistant", "", { finishReason: "interrupted" }),
      ],
      STALE,
    );
    expect(preview).toBe(PRIOR_ASSISTANT);
    expect(preview).not.toBe(USER);
    expect(preview).not.toBe(TURN_INTERRUPTED_EMPTY_MESSAGE);
  });

  it("skips stop-copy assistant content and walks to the prior assistant", () => {
    expect(
      previewFromOpenedWindow(
        [
          msg("a0", "assistant", PRIOR_ASSISTANT),
          msg("u1", "user", USER),
          msg("a1", "assistant", TURN_CANCELLED_EMPTY_MESSAGE, {
            finishReason: "cancelled",
          }),
        ],
        STALE,
      ),
    ).toBe(PRIOR_ASSISTANT);
  });
});

describe("buildMessagePreview", () => {
  it("uses the listed server preview as authority", () => {
    expect(
      buildMessagePreview("服务端助手摘要", [
        msg("u1", "user", USER),
        msg("a1", "assistant", "窗口里另一句"),
      ]),
    ).toBe("服务端助手摘要");
  });

  it("does not concatenate 你: from cached user text", () => {
    const preview = buildMessagePreview(null, [
      msg("u1", "user", USER),
      msg("a1", "assistant", PRIOR_ASSISTANT),
    ]);
    expect(preview).toBe(PRIOR_ASSISTANT);
    expect(preview).not.toContain("你:");
    expect(preview).not.toBe(USER);
  });

  it("interrupt listed preview walks to the previous visible assistant, not the user", () => {
    const preview = buildMessagePreview(TURN_INTERRUPTED_EMPTY_MESSAGE, [
      msg("a0", "assistant", PRIOR_ASSISTANT),
      msg("u1", "user", USER),
      msg("a1", "assistant", "", { finishReason: "interrupted" }),
    ]);
    expect(preview).toBe(PRIOR_ASSISTANT);
    expect(preview).not.toBe(USER);
    expect(preview).not.toBe(TURN_INTERRUPTED_EMPTY_MESSAGE);
  });

  it("stop listed preview walks to the previous visible assistant, not the user", () => {
    const preview = buildMessagePreview(TURN_CANCELLED_EMPTY_MESSAGE, [
      msg("a0", "assistant", PRIOR_ASSISTANT),
      msg("u1", "user", USER),
      msg("a1", "assistant", "", { finishReason: "cancelled" }),
    ]);
    expect(preview).toBe(PRIOR_ASSISTANT);
    expect(preview).not.toBe(USER);
    expect(preview).not.toBe(TURN_CANCELLED_EMPTY_MESSAGE);
    expect(preview).not.toContain("你:");
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

  it("does not stamp a user sentence after a cancelled empty assistant", () => {
    seedList([listed("c1", STALE)]);
    useConversationStore.setState({
      currentConversationId: "c1",
      byId: {
        c1: {
          ...EMPTY_RUNTIME,
          messages: [
            msg("u1", "user", USER),
            msg("a1", "assistant", "", { finishReason: "cancelled" }),
          ],
          turnPhase: "completed",
        },
      },
    });

    syncConversationListPreview("c1");

    expect(getConversations()[0].lastMessagePreview).toBe(STALE);
    expect(getConversations()[0].lastMessagePreview).not.toBe(USER);
    expect(getConversations()[0].lastMessagePreview).not.toBe(
      TURN_CANCELLED_EMPTY_MESSAGE,
    );
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
