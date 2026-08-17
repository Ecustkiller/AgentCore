/**
 * 对话列表进程内缓存 —— 铸题不顶位次、message_start bump、缺行 no-op、恢复回组。
 */
import type {
  ConversationSummary,
  FolderGroup,
  GroupedConversations,
} from "@/api/conversations";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetConversationListCacheForTests,
  applyTitle,
  bumpActivity,
  clearConversationListCache,
  getConversationListArchived,
  getConversationListGrouped,
  insertRestored,
  noteConversationStreamEvent,
  patchConversation,
  removeConversation,
  replaceArchived,
  replaceGrouped,
} from "../conversationListCache";

function conv(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "c1",
    title: "对话",
    archived: false,
    context_compacted: false,
    created_at: "2026-01-01T00:00:00Z",
    deep_research_auto: false,
    message_count: 0,
    pinned: false,
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function folder(over: Partial<FolderGroup> = {}): FolderGroup {
  return {
    id: "f1",
    name: "设计",
    mode: "cloud",
    conversations: [],
    ...over,
  };
}

function grouped(
  over: Partial<GroupedConversations> = {},
): GroupedConversations {
  return { folders: [], ungrouped: [], ...over };
}

function findRow(
  id: string,
  snap: GroupedConversations | null = getConversationListGrouped(),
): ConversationSummary | undefined {
  if (!snap) return undefined;
  return (
    snap.ungrouped.find((c) => c.id === id) ??
    snap.folders.flatMap((f) => f.conversations).find((c) => c.id === id)
  );
}

afterEach(() => {
  __resetConversationListCacheForTests();
  vi.useRealTimers();
});

describe("applyTitle / 铸题", () => {
  it("改 title 不写 updated_at", () => {
    const row = conv({
      id: "c1",
      title: "旧题",
      updated_at: "2026-02-01T00:00:00Z",
    });
    replaceGrouped(grouped({ ungrouped: [row] }));
    applyTitle("c1", "新铸标题");
    const next = findRow("c1");
    expect(next?.title).toBe("新铸标题");
    expect(next?.updated_at).toBe("2026-02-01T00:00:00Z");
  });

  it("title_generated 铸题不 bump", () => {
    replaceGrouped(
      grouped({
        ungrouped: [
          conv({
            id: "c1",
            title: "草稿",
            updated_at: "2026-03-01T00:00:00Z",
          }),
        ],
      }),
    );
    noteConversationStreamEvent("c1", {
      type: "title_generated",
      payload: { title: "周报汇总", conversation_id: "c1" },
    });
    const next = findRow("c1");
    expect(next?.title).toBe("周报汇总");
    expect(next?.updated_at).toBe("2026-03-01T00:00:00Z");
  });
});

describe("bumpActivity / message_start", () => {
  it("message_start 把 updated_at 写成 now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T04:00:00.000Z"));
    replaceGrouped(
      grouped({
        ungrouped: [conv({ id: "c1", updated_at: "2026-01-01T00:00:00Z" })],
      }),
    );
    noteConversationStreamEvent("c1", { type: "message_start" });
    expect(findRow("c1")?.updated_at).toBe("2026-08-17T04:00:00.000Z");
  });

  it("content_delta 等其它事件 no-op", () => {
    replaceGrouped(
      grouped({
        ungrouped: [
          conv({ id: "c1", title: "旧", updated_at: "2026-01-01T00:00:00Z" }),
        ],
      }),
    );
    noteConversationStreamEvent("c1", {
      type: "content_delta",
      payload: { delta: "x" },
    });
    noteConversationStreamEvent("c1", { type: "message_end" });
    const next = findRow("c1");
    expect(next?.title).toBe("旧");
    expect(next?.updated_at).toBe("2026-01-01T00:00:00Z");
  });
});

describe("缺行 no-op", () => {
  it("缓存为空时 title_generated / message_start / bump 都不造行", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T04:00:00.000Z"));
    noteConversationStreamEvent("missing", {
      type: "title_generated",
      payload: { title: "不该出现" },
    });
    noteConversationStreamEvent("missing", { type: "message_start" });
    bumpActivity("missing");
    applyTitle("missing", "不该出现");
    expect(getConversationListGrouped()).toBeNull();
    expect(getConversationListArchived()).toBeNull();
  });

  it("有快照但没有该 id 时不改其它行", () => {
    const snap = grouped({
      ungrouped: [
        conv({
          id: "keep",
          title: "留下",
          updated_at: "2026-01-01T00:00:00Z",
        }),
      ],
    });
    replaceGrouped(snap);
    noteConversationStreamEvent("other", {
      type: "title_generated",
      payload: { title: "误伤" },
    });
    noteConversationStreamEvent("other", { type: "message_start" });
    expect(getConversationListGrouped()).toBe(snap);
    expect(findRow("keep")?.title).toBe("留下");
    expect(findRow("keep")?.updated_at).toBe("2026-01-01T00:00:00Z");
  });
});

describe("insertRestored", () => {
  it("按 folder_id 插回对应组头", () => {
    replaceGrouped(
      grouped({
        folders: [
          folder({
            id: "f-cloud",
            conversations: [conv({ id: "stay", folder_id: "f-cloud" })],
          }),
        ],
        ungrouped: [conv({ id: "bare" })],
      }),
    );
    const restored = conv({
      id: "back",
      title: "恢复的",
      folder_id: "f-cloud",
    });
    insertRestored(restored);
    const folders = getConversationListGrouped()?.folders ?? [];
    expect(folders[0]?.conversations.map((c) => c.id)).toEqual([
      "back",
      "stay",
    ]);
    expect(getConversationListGrouped()?.ungrouped.map((c) => c.id)).toEqual([
      "bare",
    ]);
  });

  it("找不到组则进裸聊", () => {
    replaceGrouped(
      grouped({
        folders: [folder({ id: "f-other" })],
        ungrouped: [conv({ id: "bare" })],
      }),
    );
    insertRestored(conv({ id: "orphan", folder_id: "f-missing" }));
    expect(getConversationListGrouped()?.ungrouped.map((c) => c.id)).toEqual([
      "orphan",
      "bare",
    ]);
    expect(getConversationListGrouped()?.folders[0]?.conversations).toEqual([]);
  });

  it("grouped 仍为 null 时 no-op", () => {
    insertRestored(conv({ id: "back", folder_id: "f1" }));
    expect(getConversationListGrouped()).toBeNull();
  });
});

describe("clearConversationListCache", () => {
  it("两边都清掉", () => {
    replaceGrouped(grouped({ ungrouped: [conv()] }));
    replaceArchived([conv({ id: "a1", archived: true })]);
    clearConversationListCache();
    expect(getConversationListGrouped()).toBeNull();
    expect(getConversationListArchived()).toBeNull();
  });
});

describe("replace / patch / remove", () => {
  it("patch title/pinned 不顶位次；remove 从两边去掉", () => {
    replaceGrouped(
      grouped({
        ungrouped: [
          conv({
            id: "c1",
            title: "旧",
            pinned: false,
            updated_at: "2026-04-01T00:00:00Z",
          }),
        ],
      }),
    );
    replaceArchived([conv({ id: "a1", archived: true, title: "归档" })]);
    patchConversation("c1", { title: "手改", pinned: true });
    const live = findRow("c1");
    expect(live?.title).toBe("手改");
    expect(live?.pinned).toBe(true);
    expect(live?.updated_at).toBe("2026-04-01T00:00:00Z");

    removeConversation("c1");
    removeConversation("a1");
    expect(findRow("c1")).toBeUndefined();
    expect(getConversationListArchived()).toEqual([]);
  });
});
