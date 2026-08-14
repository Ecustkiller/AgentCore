// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useConversations", () => ({
  getConversations: () => [
    { id: "c1", title: "当前会话" },
    { id: "c2", title: "其他对话" },
  ],
}));
vi.mock("@/hooks/useFolders", () => ({ getFolders: () => [] }));
vi.mock("@/services/messages", () => ({ fetchMessageWindow: vi.fn() }));
vi.mock("@/services/workspaceBinding", () => ({
  getWorkspaceBinding: vi.fn(),
}));
vi.mock("@/lib/capabilities", () => ({ hasLocalFiles: () => true }));
vi.mock("@/lib/fileIndex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fileIndex")>();
  return {
    ...actual,
    loadFileIndex: vi.fn(async () => ({
      files: [],
      dirs: [],
      sourceCount: 1,
    })),
  };
});
vi.mock("../composerAttachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../composerAttachments")>();
  return {
    ...actual,
    buildMentionSources: vi.fn(async () => []),
  };
});
vi.mock("../resideAttachment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../resideAttachment")>();
  return {
    ...actual,
    pickLocalFileAttachment: vi.fn(),
  };
});

import type {
  PendingAgentMention,
  PendingAttachment,
} from "../composerAttachments";
import { pickLocalFileAttachment } from "../resideAttachment";
import { useMentionMenu } from "../useMentionMenu";

const pick = vi.mocked(pickLocalFileAttachment);

function useMentionHarness(conversationId: string | null, initial = "@") {
  const [value, setValue] = useState(initial);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [agentMentions, setAgentMentions] = useState<PendingAgentMention[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionMenu({
    conversationId,
    value,
    setValue,
    attachments,
    setAttachments,
    agentMentions,
    setAgentMentions,
    textareaRef,
  });
  return { mention, value };
}

function key(name: string): KeyboardEvent {
  return {
    key: name,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe("useMentionMenu 二级目录", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pick.mockReset();
  });

  it("空 @ 停在一级目录，手打高亮团队，团队空态不可钻入", async () => {
    const { result } = renderHook(() => useMentionHarness("c1"));
    await act(async () => {
      result.current.mention.syncMention("@", 1);
    });

    expect(result.current.mention.menuMode).toBe("mention");
    expect(result.current.mention.showCategoryLevel).toBe(true);
    expect(result.current.mention.categories[0]).toMatchObject({
      id: "attach",
      label: "附件",
      hint: "从本机添加",
    });
    expect(result.current.mention.categories[1]).toMatchObject({
      id: "team",
      disabled: true,
    });
    expect(result.current.mention.categories[2]).toMatchObject({
      id: "conversation",
      count: 1,
      disabled: false,
    });
    expect(result.current.mention.activeIndex).toBe(1);
  });

  it("Enter 钻入对话，← 回到一级", async () => {
    const { result } = renderHook(() => useMentionHarness("c1"));
    await act(async () => {
      result.current.mention.syncMention("@", 1);
    });
    await act(async () => {
      result.current.mention.handleMenuNavKey(key("ArrowDown"));
    });

    await act(async () => {
      result.current.mention.handleMenuNavKey(key("Enter"));
    });
    expect(result.current.mention.showCategoryLevel).toBe(false);
    expect(result.current.mention.canGoBack).toBe(true);
    expect(result.current.mention.focusedSectionLabel).toBe("对话");
    expect(result.current.mention.flatItems).toHaveLength(1);
    expect(result.current.mention.flatItems[0]).toMatchObject({
      kind: "conversation",
      name: "其他对话",
    });

    await act(async () => {
      result.current.mention.handleMenuNavKey(key("ArrowLeft"));
    });
    expect(result.current.mention.showCategoryLevel).toBe(true);
    expect(result.current.mention.canGoBack).toBe(false);
  });

  it("有字全局搜；类型前缀跳过一级", async () => {
    const { result } = renderHook(() => useMentionHarness("c1"));
    await act(async () => {
      result.current.mention.syncMention("@readme", 7);
    });
    expect(result.current.mention.showCategoryLevel).toBe(false);
    expect(result.current.mention.canGoBack).toBe(false);

    await act(async () => {
      result.current.mention.syncMention("@对话", 3);
    });
    expect(result.current.mention.showCategoryLevel).toBe(false);
    expect(result.current.mention.canGoBack).toBe(true);
    expect(result.current.mention.focusedSectionLabel).toBe("对话");
  });

  it("browse 搜索框有字时退出已钻入的类，改走全局过滤", async () => {
    const { result } = renderHook(() => useMentionHarness("c1"));
    await act(async () => {
      result.current.mention.openBrowse();
    });
    expect(result.current.mention.showCategoryLevel).toBe(true);

    await act(async () => {
      result.current.mention.drillCategory("file");
    });
    expect(result.current.mention.showCategoryLevel).toBe(false);
    expect(result.current.mention.canGoBack).toBe(true);

    await act(async () => {
      result.current.mention.setQuery("readme");
    });
    expect(result.current.mention.showCategoryLevel).toBe(false);
    expect(result.current.mention.canGoBack).toBe(false);
  });

  it("工具栏 @ 插入并高亮附件；再点关菜单留下 @", async () => {
    const { result } = renderHook(() => useMentionHarness("c1", ""));
    await act(async () => {
      result.current.mention.toggleAtMention();
    });
    expect(result.current.value).toBe("@");
    expect(result.current.mention.menuMode).toBe("mention");
    expect(result.current.mention.showCategoryLevel).toBe(true);
    expect(result.current.mention.activeIndex).toBe(0);

    await act(async () => {
      result.current.mention.toggleAtMention();
    });
    expect(result.current.mention.menuMode).toBeNull();
    expect(result.current.value).toBe("@");

    await act(async () => {
      result.current.mention.toggleAtMention();
    });
    expect(result.current.value).toBe("@");
    expect(result.current.mention.menuMode).toBe("mention");
    expect(result.current.mention.activeIndex).toBe(0);
  });

  it("Esc 只关菜单、留下 @", async () => {
    const { result } = renderHook(() => useMentionHarness("c1"));
    await act(async () => {
      result.current.mention.syncMention("@", 1);
    });
    await act(async () => {
      result.current.mention.handleMenuNavKey(key("Escape"));
    });
    expect(result.current.mention.menuMode).toBeNull();
    expect(result.current.value).toBe("@");
  });

  it("一级附件 Enter 选本机文件并清掉 @query；ArrowRight 不 drill", async () => {
    pick.mockResolvedValue({
      ok: true,
      name: "a.txt",
      path: "a.txt",
      text: "hi",
      truncated: false,
      binary: false,
      workspacePath: "attachments/a.txt",
    });
    const { result } = renderHook(() => useMentionHarness("c1", ""));
    await act(async () => {
      result.current.mention.toggleAtMention();
    });
    await act(async () => {
      result.current.mention.handleMenuNavKey(key("ArrowRight"));
    });
    expect(result.current.mention.showCategoryLevel).toBe(true);
    expect(result.current.mention.canGoBack).toBe(false);

    await act(async () => {
      result.current.mention.handleMenuNavKey(key("Enter"));
    });
    expect(pick).toHaveBeenCalledTimes(1);
    await act(async () => {
      await pick.mock.results[0]?.value;
    });
    expect(result.current.value).toBe("");
    expect(result.current.mention.menuMode).toBeNull();
  });
});
