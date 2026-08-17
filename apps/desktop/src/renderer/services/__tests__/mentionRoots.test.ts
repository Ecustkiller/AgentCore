import { describe, expect, it } from "vitest";
import {
  FALLBACK_MENTION_ROOT_LIMIT,
  type MentionRootCandidate,
  type RootUseEvent,
  buildLocalMentionPicks,
  collapseNestedRoots,
  collectRootUseEvents,
  disambiguateRootLabels,
  isNestedRootPath,
  pickFallbackMentionRoots,
  selectBoundMentionRoot,
} from "../mentionRoots";

const local = (rootId: string): { mode: "local"; rootId: string } => ({
  mode: "local",
  rootId,
});

function root(
  id: string,
  name: string,
  absPath?: string,
): MentionRootCandidate {
  return absPath ? { id, name, absPath } : { id, name };
}

/** 用户本机那套嵌套授权根的缩影。 */
const NESTED_ROOTS: MentionRootCandidate[] = [
  root("proj", "Project", "C:\\Project"),
  root("ac1", "AgentCore", "C:\\Project\\AgentCore"),
  root("eval-a", "ws-a", "C:\\Project\\AgentCore\\evals\\ws-a"),
  root("eval-b", "ws-b", "C:\\Project\\AgentCore\\evals\\ws-b"),
  root("eval-c", "ws-c", "C:\\Project\\AgentCore\\evals\\ws-c"),
  root("eval-d", "ws-d", "C:\\Project\\AgentCore\\evals\\ws-d"),
  root("desk", "Desktop", "C:\\Users\\1\\OneDrive\\Desktop"),
  root("desk-a", "notes", "C:\\Users\\1\\OneDrive\\Desktop\\notes"),
  root("desk-b", "clips", "C:\\Users\\1\\OneDrive\\Desktop\\clips"),
  root("ac2", "AgentCore", "D:\\work\\AgentCore"),
  root("other", "reports", "E:\\reports"),
];

describe("isNestedRootPath", () => {
  it("treats Windows parent/child as nested, ignoring separators and case", () => {
    expect(isNestedRootPath("C:\\Project", "C:\\Project\\AgentCore")).toBe(
      true,
    );
    expect(
      isNestedRootPath("c:/project", "C:\\Project\\AgentCore\\evals\\ws-a"),
    ).toBe(true);
    expect(isNestedRootPath("C:\\Project", "C:\\Project")).toBe(false);
    expect(isNestedRootPath("C:\\Project\\AgentCore", "C:\\Project")).toBe(
      false,
    );
  });
});

describe("有绑定时只出绑定根", () => {
  it("returns only the bound root, including its workspace subpath", () => {
    const picks = buildLocalMentionPicks({
      binding: local("ac1"),
      roots: NESTED_ROOTS,
      subpath: "apps/desktop",
      uses: NESTED_ROOTS.map((r, i) => ({
        rootId: r.id,
        usedAt: 1_000 + i,
      })),
    });
    expect(picks).toEqual([
      { id: "ac1", label: "AgentCore", subpath: "apps/desktop" },
    ]);
  });

  it("ignores other authorized roots even when they were used more recently", () => {
    const bound = selectBoundMentionRoot(local("eval-a"), NESTED_ROOTS);
    expect(bound?.id).toBe("eval-a");
    expect(bound?.subpath).toBe("");
  });

  it("falls back when the bound root is missing on this device", () => {
    const picks = buildLocalMentionPicks({
      binding: local("gone"),
      roots: NESTED_ROOTS,
      uses: [
        { rootId: "ac2", usedAt: 50 },
        { rootId: "other", usedAt: 10 },
      ],
    });
    expect(picks.map((p) => p.id)).toEqual(["ac2", "other"]);
    expect(picks).toHaveLength(2);
  });

  it("does not bind a cloud-mode conversation to local roots", () => {
    expect(
      selectBoundMentionRoot({ mode: "cloud", rootId: null }, NESTED_ROOTS),
    ).toBeNull();
  });
});

describe("无绑定时的回退策略", () => {
  const uses: RootUseEvent[] = [
    { rootId: "proj", usedAt: 100 },
    { rootId: "ac1", usedAt: 400 },
    { rootId: "desk", usedAt: 300 },
    { rootId: "desk-a", usedAt: 350 },
    { rootId: "other", usedAt: 50 },
  ];

  it("does not return every authorized root", () => {
    const picks = pickFallbackMentionRoots(NESTED_ROOTS, uses);
    expect(picks.length).toBeLessThan(NESTED_ROOTS.length);
    expect(picks.length).toBeLessThanOrEqual(FALLBACK_MENTION_ROOT_LIMIT);
    expect(picks.map((p) => p.id)).not.toContain("proj");
  });

  it("ranks by recent conversation/folder use after collapsing parents", () => {
    const picks = pickFallbackMentionRoots(NESTED_ROOTS, uses);
    expect(picks.map((p) => p.id)).toEqual(["ac1", "desk-a", "other"]);
  });

  it("collects recency from folder-bound conversations and container roots", () => {
    const events = collectRootUseEvents(
      [
        {
          folderId: "f1",
          localContainerRootId: "ignored",
          updatedAt: "2026-08-17T10:00:00.000Z",
        },
        {
          folderId: null,
          localContainerRootId: "desk",
          updatedAt: "2026-08-17T09:00:00.000Z",
        },
      ],
      [{ id: "f1", localRootId: "ac1" }],
    );
    expect(events.map((e) => e.rootId)).toEqual(["ac1", "desk"]);
    const picks = pickFallbackMentionRoots(NESTED_ROOTS, events);
    expect(picks[0]?.id).toBe("ac1");
  });

  it("without any use records, still caps after collapse instead of listing all", () => {
    const picks = pickFallbackMentionRoots(NESTED_ROOTS, []);
    expect(picks.length).toBeLessThanOrEqual(FALLBACK_MENTION_ROOT_LIMIT);
    expect(picks.length).toBeLessThan(NESTED_ROOTS.length);
    expect(picks.map((p) => p.id)).not.toContain("proj");
    expect(picks.map((p) => p.id)).not.toContain("desk");
  });
});

describe("嵌套根折叠后无重复", () => {
  it("keeps only the most specific root in each nest", () => {
    const collapsed = collapseNestedRoots(NESTED_ROOTS);
    expect(collapsed.map((r) => r.id).sort()).toEqual(
      [
        "ac2",
        "desk-a",
        "desk-b",
        "eval-a",
        "eval-b",
        "eval-c",
        "eval-d",
        "other",
      ].sort(),
    );
    expect(collapsed.map((r) => r.id)).not.toContain("proj");
    expect(collapsed.map((r) => r.id)).not.toContain("ac1");
    expect(collapsed.map((r) => r.id)).not.toContain("desk");
  });

  it("drops a parent when the fallback set also contains its child", () => {
    const picks = pickFallbackMentionRoots(NESTED_ROOTS, [
      { rootId: "proj", usedAt: 10 },
      { rootId: "ac1", usedAt: 20 },
      { rootId: "eval-a", usedAt: 30 },
    ]);
    expect(picks.map((p) => p.id)).toEqual(["eval-a"]);
  });

  it("dedupes two roots that point at the same physical path", () => {
    const collapsed = collapseNestedRoots([
      root("a", "AgentCore", "C:\\Project\\AgentCore"),
      root("b", "AgentCore", "C:\\Project\\AgentCore\\"),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.id).toBe("a");
  });

  it("distinguishes same-name roots that are not nested", () => {
    const labels = disambiguateRootLabels([
      root("ac1", "AgentCore", "C:\\Project\\AgentCore"),
      root("ac2", "AgentCore", "D:\\work\\AgentCore"),
    ]);
    expect(labels.get("ac1")).toBe("Project/AgentCore");
    expect(labels.get("ac2")).toBe("work/AgentCore");
    expect(labels.get("ac1")).not.toBe(labels.get("ac2"));
  });
});
