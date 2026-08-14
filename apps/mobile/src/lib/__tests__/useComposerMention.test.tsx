// @vitest-environment jsdom
/**
 * 手打 @ 打开同一张分类 sheet；选各类必须真进草稿（conversation / agent_mentions / file / dir）。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listConversations,
  getMessages,
  listCloudFolders,
  listWorkspaceFiles,
  listWorkspaceFilesByWs,
  downloadWorkspaceFile,
  prepareAttachment,
} = vi.hoisted(() => ({
  listConversations: vi.fn(),
  getMessages: vi.fn(),
  listCloudFolders: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  listWorkspaceFilesByWs: vi.fn(),
  downloadWorkspaceFile: vi.fn(),
  prepareAttachment: vi.fn(),
}));

vi.mock("@/api/conversations", () => ({
  listConversations,
  getMessages,
}));
vi.mock("@/api/folders", () => ({
  listCloudFolders,
}));
vi.mock("@/api/workspace", () => ({
  listWorkspaceFiles,
  downloadWorkspaceFile,
}));
vi.mock("@/api/workspaces", () => ({
  listWorkspaceFilesByWs,
  downloadWorkspaceFileByWs: vi.fn(),
}));
vi.mock("@/lib/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/attachments")>();
  return { ...actual, prepareAttachment };
});
vi.mock("@/protocol/fold", () => ({
  fold: (events: { type?: string }[]) => ({
    agents: events.some((e) => e.type === "plan")
      ? [{ id: "w1", role: "研究员" }]
      : [],
  }),
}));

import type { MessageAttachment } from "@/lib/attachments";
import type { PendingAgentMention } from "@/lib/composerMention";
import { useComposerMention } from "@/lib/useComposerMention";
import type { SSEEvent } from "@agentcore/contract-types";

const onPickAttach = vi.fn();
const onError = vi.fn();

function useHarness(opts?: {
  conversationId?: string | null;
  input?: string;
  history?: {
    role: string;
    runs?: { events?: SSEEvent[] } | null;
  }[];
}) {
  const [input, setInput] = useState(opts?.input ?? "");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [agentMentions, setAgentMentions] = useState<PendingAgentMention[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mention = useComposerMention({
    conversationId: opts?.conversationId ?? "c1",
    input,
    setInput,
    attachments,
    setAttachments,
    agentMentions,
    setAgentMentions,
    history: opts?.history ?? [],
    turns: [],
    textareaRef,
    onPickAttach,
    onError,
  });
  return {
    mention,
    input,
    setInput,
    attachments,
    agentMentions,
  };
}

beforeEach(() => {
  listConversations.mockReset();
  getMessages.mockReset();
  listCloudFolders.mockReset();
  listWorkspaceFiles.mockReset();
  listWorkspaceFilesByWs.mockReset();
  downloadWorkspaceFile.mockReset();
  prepareAttachment.mockReset();
  listConversations.mockResolvedValue([
    { id: "c1", title: "当前" },
    { id: "c2", title: "上周复盘" },
  ]);
  listCloudFolders.mockResolvedValue([{ id: "f1", name: "设计稿" }]);
  listWorkspaceFiles.mockResolvedValue({
    entries: [
      { path: "notes/a.md", is_dir: false },
      { path: "notes/b.md", is_dir: false },
    ],
    truncated: false,
  });
  listWorkspaceFilesByWs.mockResolvedValue({
    entries: [{ path: "brief.md", is_dir: false }],
    truncated: false,
  });
  getMessages.mockResolvedValue({
    messages: [
      { role: "user", content: "问" },
      { role: "assistant", content: "答" },
    ],
    hasMoreBefore: false,
  });
  downloadWorkspaceFile.mockResolvedValue({
    blob: new Blob(["hello"], { type: "text/plain" }),
    filename: "a.md",
    contentType: "text/plain",
  });
  onPickAttach.mockReset();
  onError.mockReset();
  prepareAttachment.mockResolvedValue({
    ok: true,
    attachment: {
      name: "a.md",
      path: "a.md",
      text: "hello",
      truncated: false,
      kind: "file",
    },
  });
});

describe("useComposerMention", () => {
  it("opens the same sheet on typed @ and from browse", async () => {
    const { result } = renderHook(() => useHarness());
    expect(result.current.mention.open).toBe(false);

    act(() => {
      result.current.mention.syncMention("@", 1);
    });
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    expect(result.current.mention.open).toBe(true);
    expect(result.current.mention.showCategoryLevel).toBe(true);
    expect(result.current.mention.categories.map((c) => c.id)).toEqual([
      "attach",
      "team",
      "conversation",
      "folder",
      "file",
    ]);

    act(() => {
      result.current.mention.close();
    });
    act(() => {
      result.current.mention.openBrowse();
    });
    await waitFor(() => expect(result.current.mention.open).toBe(true));
    expect(result.current.mention.mode).toBe("browse");
  });

  it("picks attach via the system picker and strips the @ query", async () => {
    const { result } = renderHook(() => useHarness({ input: "看 @" }));
    act(() => {
      result.current.mention.syncMention("看 @", 3);
    });
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    act(() => {
      result.current.mention.pickAttach();
    });
    expect(onPickAttach).toHaveBeenCalled();
    expect(result.current.mention.open).toBe(false);
    expect(result.current.input).toBe("看 ");
  });

  it("selects a conversation into the draft as kind=conversation", async () => {
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.mention.syncMention("@", 1);
    });
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    await act(async () => {
      result.current.mention.selectItem({
        kind: "conversation",
        id: "c2",
        title: "上周复盘",
        label: "上周复盘",
      });
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    const att = result.current.attachments[0];
    expect(att?.kind).toBe("conversation");
    expect(att?.conversation_id).toBe("c2");
    expect(att?.text).toContain("用户: 问");
  });

  it("selects a team agent into agentMentions", async () => {
    const { result } = renderHook(() =>
      useHarness({
        history: [
          {
            role: "assistant",
            runs: {
              events: [
                {
                  type: "plan",
                  timestamp: "",
                  payload: {},
                } as unknown as SSEEvent,
              ],
            },
          },
        ],
      }),
    );
    act(() => {
      result.current.mention.syncMention("@", 1);
    });
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    const team = result.current.mention.categories.find((c) => c.id === "team");
    expect(team?.disabled).toBe(false);
    act(() => {
      result.current.mention.selectItem({
        kind: "agent",
        agentId: "w1",
        role: "研究员",
        label: "研究员",
      });
    });
    expect(result.current.agentMentions).toEqual([
      expect.objectContaining({ agentId: "w1", role: "研究员" }),
    ]);
  });

  it("selects a cloud folder as kind=dir with a file listing", async () => {
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.mention.openBrowse();
    });
    await waitFor(() => expect(listCloudFolders).toHaveBeenCalled());
    await act(async () => {
      result.current.mention.selectItem({
        kind: "folder",
        source: "cloud",
        id: "f1",
        name: "设计稿",
        label: "设计稿",
        wsId: "folder:f1",
      });
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    const att = result.current.attachments[0];
    expect(att?.kind).toBe("dir");
    expect(att?.text).toContain("brief.md");
    expect(listWorkspaceFilesByWs).toHaveBeenCalledWith("folder:f1");
  });

  it("selects a workspace file via existing prepareAttachment", async () => {
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.mention.openBrowse();
    });
    await waitFor(() => expect(listWorkspaceFiles).toHaveBeenCalledWith("c1"));
    await act(async () => {
      result.current.mention.selectItem({
        kind: "file",
        desk: "conv",
        deskId: "c1",
        path: "notes/a.md",
        name: "a.md",
        label: "a.md",
      });
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(downloadWorkspaceFile).toHaveBeenCalledWith("c1", "notes/a.md");
    expect(prepareAttachment).toHaveBeenCalled();
    expect(result.current.attachments[0]?.kind).toBe("file");
    expect(result.current.attachments[0]?.text).toBe("hello");
  });

  it("keeps typing after @ while an async mention pick is in flight", async () => {
    let resolveMessages!: (value: {
      messages: { role: string; content: string }[];
      hasMoreBefore: boolean;
    }) => void;
    getMessages.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMessages = resolve;
      }),
    );
    const { result } = renderHook(() => useHarness({ input: "看 @" }));
    act(() => {
      result.current.mention.syncMention("看 @", 3);
    });
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    act(() => {
      void result.current.mention.selectItem({
        kind: "conversation",
        id: "c2",
        title: "上周复盘",
        label: "上周复盘",
      });
    });
    act(() => {
      result.current.setInput("看 @ 续打内容");
    });
    await act(async () => {
      resolveMessages({
        messages: [
          { role: "user", content: "问" },
          { role: "assistant", content: "答" },
        ],
        hasMoreBefore: false,
      });
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.input).toContain("续打内容");
    expect(result.current.input).not.toMatch(/@/);
  });

  it("reports untruncated folder count on the category row", async () => {
    listCloudFolders.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        id: `f${i}`,
        name: `文件夹${i}`,
      })),
    );
    listWorkspaceFiles.mockResolvedValue({ entries: [], truncated: false });
    listWorkspaceFilesByWs.mockResolvedValue({ entries: [], truncated: false });
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.mention.syncMention("@", 1);
    });
    await waitFor(() => expect(listCloudFolders).toHaveBeenCalled());
    await waitFor(() => {
      const folder = result.current.mention.categories.find(
        (c) => c.id === "folder",
      );
      expect(folder?.count).toBe(8);
    });
    expect(result.current.mention.items).toHaveLength(0);
  });
});
