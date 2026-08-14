import {
  BARE_LIMIT_SOLO,
  BARE_LIMIT_WITH_GROUPS,
  MAX_GROUP_VISIBLE,
  MAX_PER_GROUP,
  isGroupExpanded,
  pickBareVisible,
  pickGroupVisible,
} from "@/lib/sidebarRailVisibility";
import type { Conversation } from "@/stores/conversation";
import { describe, expect, it } from "vitest";

const conv = (
  id: string,
  opts: { at?: string; archived?: boolean } = {},
): Conversation => ({
  id,
  title: id,
  updatedAt: opts.at ?? "2026-01-01T00:00:00Z",
  messageCount: 0,
  lastMessagePreview: null,
  archived: opts.archived,
});

function ids(list: Conversation[]): string[] {
  return list.map((c) => c.id);
}

describe("pickGroupVisible", () => {
  const rows = [
    conv("n1", { at: "2026-06-06T00:00:00Z" }),
    conv("n2", { at: "2026-06-05T00:00:00Z" }),
    conv("n3", { at: "2026-06-04T00:00:00Z" }),
    conv("n4", { at: "2026-06-03T00:00:00Z" }),
    conv("n5", { at: "2026-06-02T00:00:00Z" }),
    conv("old-req", { at: "2026-01-01T00:00:00Z" }),
    conv("older", { at: "2025-12-01T00:00:00Z" }),
  ];

  it("required 已在 Top 5 时不重复、不加长", () => {
    expect(ids(pickGroupVisible(rows, new Set(["n2"])))).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
  });

  it("无 required 仍 Top 5", () => {
    expect(ids(pickGroupVisible(rows, new Set()))).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
    expect(MAX_PER_GROUP).toBe(5);
  });

  it("帽外 required 挤进且总数 ≤6，保持 recency 序", () => {
    const shown = pickGroupVisible(rows, new Set(["old-req"]));
    expect(ids(shown)).toEqual(["n1", "n2", "n3", "n4", "n5", "old-req"]);
    expect(shown).toHaveLength(MAX_GROUP_VISIBLE);
  });

  it("多个 required 优先于普通行，仍 ≤6", () => {
    const many = [
      ...rows,
      conv("req-a", { at: "2026-02-01T00:00:00Z" }),
      conv("req-b", { at: "2026-02-02T00:00:00Z" }),
    ];
    const shown = pickGroupVisible(
      many,
      new Set(["old-req", "req-a", "req-b"]),
    );
    expect(ids(shown)).toContain("old-req");
    expect(ids(shown)).toContain("req-a");
    expect(ids(shown)).toContain("req-b");
    expect(shown.length).toBeLessThanOrEqual(MAX_GROUP_VISIBLE);
  });

  it("归档 required 不拉回组内", () => {
    const withArchived = [
      ...rows.slice(0, 5),
      conv("arch-req", { at: "2026-01-01T00:00:00Z", archived: true }),
    ];
    expect(ids(pickGroupVisible(withArchived, new Set(["arch-req"])))).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
  });
});

describe("pickBareVisible", () => {
  const bare = Array.from({ length: 16 }, (_, i) =>
    conv(`b${i}`, {
      at: `2026-06-${String(16 - i).padStart(2, "0")}T00:00:00Z`,
    }),
  );

  it("帽外 required 像 currentId 一样回塞", () => {
    const shown = pickBareVisible(bare, {
      limit: BARE_LIMIT_WITH_GROUPS,
      currentId: null,
      requiredIds: new Set(["b15"]),
    });
    expect(ids(shown).slice(0, BARE_LIMIT_WITH_GROUPS)).toEqual(
      bare.slice(0, BARE_LIMIT_WITH_GROUPS).map((c) => c.id),
    );
    expect(ids(shown)).toContain("b15");
  });

  it("currentId 与 required 都回塞", () => {
    const shown = pickBareVisible(bare, {
      limit: BARE_LIMIT_SOLO,
      currentId: "b15",
      requiredIds: new Set(["b14"]),
    });
    expect(ids(shown)).toContain("b15");
    expect(ids(shown)).toContain("b14");
  });

  it("归档 required 不拉回裸聊区", () => {
    const list = [
      ...bare.slice(0, 3),
      conv("arch", { archived: true, at: "2020-01-01T00:00:00Z" }),
    ];
    const shown = pickBareVisible(list, {
      limit: 2,
      currentId: null,
      requiredIds: new Set(["arch"]),
    });
    expect(ids(shown)).toEqual(["b0", "b1"]);
  });
});

describe("isGroupExpanded", () => {
  it("required 期间盖过 persist 折叠", () => {
    expect(
      isGroupExpanded({
        stored: false,
        isActiveFolder: false,
        hasRequired: true,
      }),
    ).toBe(true);
  });

  it("required 消失后回到 persist 折叠", () => {
    expect(
      isGroupExpanded({
        stored: false,
        isActiveFolder: false,
        hasRequired: false,
      }),
    ).toBe(false);
  });

  it("无 persist 时当前对话所在组仍默认展开", () => {
    expect(
      isGroupExpanded({
        stored: undefined,
        isActiveFolder: true,
        hasRequired: false,
      }),
    ).toBe(true);
  });
});
