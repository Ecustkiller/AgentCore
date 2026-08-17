import type {
  ConversationSummary,
  FolderGroup,
  GroupedConversations,
} from "@/api/conversations";
import { buildConversationDrawerRail } from "@/lib/conversationDrawerRail";
import { describe, expect, it } from "vitest";

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

function ids(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id);
}

describe("buildConversationDrawerRail", () => {
  it("lifts pinned bare + foldered chats into the pin zone with no duplicates", () => {
    const pinBare = conv({
      id: "pin-bare",
      pinned: true,
      updated_at: "2026-03-01T00:00:00Z",
    });
    const pinFolder = conv({
      id: "pin-folder",
      pinned: true,
      folder_id: "f1",
      updated_at: "2026-04-01T00:00:00Z",
    });
    const stayFolder = conv({
      id: "stay-folder",
      folder_id: "f1",
      updated_at: "2026-02-01T00:00:00Z",
    });
    const stayFolderOld = conv({
      id: "stay-folder-old",
      folder_id: "f1",
      updated_at: "2026-01-10T00:00:00Z",
    });
    const stayBare = conv({
      id: "stay-bare",
      updated_at: "2026-01-15T00:00:00Z",
    });

    const rail = buildConversationDrawerRail(
      grouped({
        folders: [
          folder({ conversations: [stayFolderOld, pinFolder, stayFolder] }),
        ],
        ungrouped: [pinBare, stayBare],
      }),
    );

    expect(ids(rail.pinned)).toEqual(["pin-folder", "pin-bare"]);
    expect(ids(rail.groups[0].conversations)).toEqual([
      "stay-folder",
      "stay-folder-old",
    ]);
    expect(ids(rail.bare)).toEqual(["stay-bare"]);
    expect(rail.groups[0].conversations.some((c) => c.pinned)).toBe(false);
    expect(rail.bare.some((c) => c.pinned)).toBe(false);
  });

  it("orders groups by max(updated_at) of every member, including lifted pins", () => {
    const oldUnpinned = conv({
      id: "old-in-a",
      folder_id: "fa",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const newPin = conv({
      id: "pin-in-a",
      pinned: true,
      folder_id: "fa",
      updated_at: "2026-04-01T00:00:00Z",
    });
    const midUnpinned = conv({
      id: "mid-in-b",
      folder_id: "fb",
      updated_at: "2026-02-01T00:00:00Z",
    });

    const rail = buildConversationDrawerRail(
      grouped({
        folders: [
          folder({
            id: "fa",
            name: "A",
            conversations: [oldUnpinned, newPin],
          }),
          folder({
            id: "fb",
            name: "B",
            conversations: [midUnpinned],
          }),
        ],
      }),
    );

    expect(ids(rail.groups)).toEqual(["fa", "fb"]);
    expect(ids(rail.groups[0].conversations)).toEqual(["old-in-a"]);
    expect(ids(rail.pinned)).toEqual(["pin-in-a"]);
  });

  it("keeps an empty group header when every member is pinned", () => {
    const pin = conv({
      id: "only-pin",
      pinned: true,
      folder_id: "cloud",
      updated_at: "2026-05-01T00:00:00Z",
    });

    const rail = buildConversationDrawerRail(
      grouped({
        folders: [
          folder({
            id: "cloud",
            name: "云桌",
            mode: "cloud",
            conversations: [pin],
          }),
        ],
      }),
    );

    expect(rail.groups).toHaveLength(1);
    expect(rail.groups[0].id).toBe("cloud");
    expect(rail.groups[0].name).toBe("云桌");
    expect(rail.groups[0].mode).toBe("cloud");
    expect(rail.groups[0].conversations).toEqual([]);
    expect(ids(rail.pinned)).toEqual(["only-pin"]);
  });

  it("drops vacuum groups that the API already sent empty", () => {
    const live = conv({
      id: "in-live",
      folder_id: "live",
      updated_at: "2026-02-01T00:00:00Z",
    });

    const rail = buildConversationDrawerRail(
      grouped({
        folders: [
          folder({ id: "vacuum", name: "空壳", conversations: [] }),
          folder({ id: "live", name: "有人", conversations: [live] }),
        ],
      }),
    );

    expect(ids(rail.groups)).toEqual(["live"]);
    expect(rail.groups.some((g) => g.id === "vacuum")).toBe(false);
  });

  it("keeps bare chats logically independent of folders and pins", () => {
    const foldered = conv({
      id: "in-folder",
      folder_id: "f1",
      updated_at: "2026-06-01T00:00:00Z",
    });
    const pinBare = conv({
      id: "pin-bare",
      pinned: true,
      updated_at: "2026-07-01T00:00:00Z",
    });
    const olderBare = conv({
      id: "bare-old",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const newerBare = conv({
      id: "bare-new",
      updated_at: "2026-03-01T00:00:00Z",
    });

    const rail = buildConversationDrawerRail(
      grouped({
        folders: [folder({ conversations: [foldered] })],
        ungrouped: [olderBare, pinBare, newerBare],
      }),
    );

    expect(ids(rail.bare)).toEqual(["bare-new", "bare-old"]);
    expect(rail.bare.map((c) => c.folder_id).every((id) => !id)).toBe(true);
    expect(ids(rail.groups[0].conversations)).toEqual(["in-folder"]);
    expect(rail.bare.some((c) => c.id === "in-folder")).toBe(false);
    expect(rail.bare.some((c) => c.id === "pin-bare")).toBe(false);
  });

  it("does not cap groups or rows (mobile 全量)", () => {
    const folders = Array.from({ length: 8 }, (_, i) =>
      folder({
        id: `f${i}`,
        name: `组${i}`,
        conversations: [
          conv({
            id: `c${i}`,
            folder_id: `f${i}`,
            updated_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
          }),
        ],
      }),
    );
    const ungrouped = Array.from({ length: 20 }, (_, i) =>
      conv({
        id: `bare${i}`,
        updated_at: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );

    const rail = buildConversationDrawerRail(grouped({ folders, ungrouped }));

    expect(rail.groups).toHaveLength(8);
    expect(rail.bare).toHaveLength(20);
    expect(rail.groups[0].id).toBe("f7");
    expect(rail.bare[0].id).toBe("bare19");
  });

  it("does not mutate the grouped snapshot", () => {
    const stay = conv({ id: "stay", folder_id: "f1" });
    const pin = conv({
      id: "pin",
      pinned: true,
      folder_id: "f1",
      updated_at: "2026-03-01T00:00:00Z",
    });
    const input = grouped({
      folders: [folder({ conversations: [stay, pin] })],
      ungrouped: [conv({ id: "bare-pin", pinned: true })],
    });

    buildConversationDrawerRail(input);

    expect(input.folders[0].conversations.map((c) => c.id)).toEqual([
      "stay",
      "pin",
    ]);
    expect(input.ungrouped).toHaveLength(1);
  });
});
