// @vitest-environment jsdom
/**
 * EntriesSection — flat AgentCore entries by scope (no 记忆/规则/文档 folders).
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/services/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/documents", () => ({
  listScopeEntries: vi.fn(),
  createRuleDocument: vi.fn(),
  deleteDocument: vi.fn(),
  renameDocument: vi.fn(),
  updateDocumentApplyMode: vi.fn(),
}));
vi.mock("@/services/memory", () => ({
  writeMemoryFile: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

import {
  type DocumentNode,
  deleteDocument,
  listScopeEntries,
} from "@/services/documents";
import { writeMemoryFile } from "@/services/memory";
import {
  EntriesSection,
  coreMemoryLeafKind,
  entryOpenTarget,
  formatAlwaysChars,
  isAiCoreMemoryLeaf,
  isTopicEntryName,
  topicEntryDisplayName,
} from "../EntriesSection";

const entry = (over: Partial<DocumentNode> = {}): DocumentNode => ({
  id: "e",
  parentId: null,
  folderId: null,
  kind: "document",
  role: "rule",
  aiMaintained: false,
  applyMode: "always",
  description: "",
  name: "e.md",
  frontmatterError: null,
  disputedAt: null,
  alwaysChars: over.applyMode === "on_demand" ? null : 1200,
  ...over,
});

function renderScope(
  scope: "global" | "folder" = "global",
  extra?: { memoryActivePath?: string | null },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
  const onOpen = vi.fn();
  const onDeleted = vi.fn();
  const onRenamed = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <EntriesSection
          scope={
            scope === "global"
              ? { kind: "global" }
              : { kind: "folder", folderId: "F1" }
          }
          memoryActivePath={extra?.memoryActivePath ?? null}
          documentActivePath={null}
          onOpen={onOpen}
          onDeleted={onDeleted}
          onRenamed={onRenamed}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onOpen, onDeleted, onRenamed };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listScopeEntries).mockResolvedValue([]);
  vi.mocked(writeMemoryFile).mockResolvedValue({
    ok: true,
    conflict: false,
    version: "",
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("always usage copy helpers", () => {
  // Rows below the floor render no size at all, which is asserted on the section.
  it("distinguishes 0 from under-a-thousand and coarsens to 千/万", () => {
    expect(formatAlwaysChars(0)).toBe("0 字");
    expect(formatAlwaysChars(450)).toBe("不足千字");
    expect(formatAlwaysChars(4200)).toBe("约 4 千字");
    expect(formatAlwaysChars(12000)).toBe("约 1.2 万字");
  });
});

describe("entryOpenTarget", () => {
  it("routes AI-maintained cores to memory synthetic paths", () => {
    expect(
      entryOpenTarget(entry({ aiMaintained: true, name: "偏好.md" })),
    ).toEqual({
      channel: "memory",
      path: "global/preferences",
      name: "偏好.md",
    });
    expect(
      entryOpenTarget(
        entry({
          aiMaintained: true,
          name: "画像.md",
          folderId: "F1",
        }),
      ),
    ).toEqual({
      channel: "memory",
      path: "project/F1/profile",
      name: "画像.md",
    });
    expect(
      entryOpenTarget(
        entry({
          aiMaintained: true,
          name: "主题/部署.md",
          folderId: null,
        }),
      ),
    ).toEqual({
      channel: "memory",
      path: "global/topics/部署",
      name: "主题/部署.md",
    });
  });

  it("routes user-owned entries to document ids", () => {
    expect(entryOpenTarget(entry({ id: "d9", name: "语气.md" }))).toEqual({
      channel: "document",
      path: "d9",
      name: "语气.md",
    });
  });
});

describe("isAiCoreMemoryLeaf", () => {
  it("marks AI 画像/偏好/导航 as cores; topics and user docs are not", () => {
    expect(
      isAiCoreMemoryLeaf(entry({ aiMaintained: true, name: "画像.md" })),
    ).toBe(true);
    expect(
      isAiCoreMemoryLeaf(entry({ aiMaintained: true, name: "偏好.md" })),
    ).toBe(true);
    expect(
      isAiCoreMemoryLeaf(entry({ aiMaintained: true, name: "导航.md" })),
    ).toBe(true);
    expect(
      isAiCoreMemoryLeaf(entry({ aiMaintained: true, name: "主题/部署.md" })),
    ).toBe(false);
    expect(
      isAiCoreMemoryLeaf(entry({ aiMaintained: false, name: "画像.md" })),
    ).toBe(false);
  });
});

describe("coreMemoryLeafKind", () => {
  it("maps cores onto the per-file memory write kinds", () => {
    expect(
      coreMemoryLeafKind(entry({ aiMaintained: true, name: "偏好.md" })),
    ).toBe("preferences");
    expect(
      coreMemoryLeafKind(entry({ aiMaintained: true, name: "画像.md" })),
    ).toBe("profile");
    expect(
      coreMemoryLeafKind(
        entry({ aiMaintained: true, name: "导航.md", folderId: "F1" }),
      ),
    ).toBe("navigation");
    expect(
      coreMemoryLeafKind(entry({ aiMaintained: true, name: "主题/部署.md" })),
    ).toBeNull();
  });
});

describe("EntriesSection (global)", () => {
  it("lists flat entries with description — no 记忆/规则 folders", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g1",
        name: "语气.md",
        applyMode: "always",
        description: "回复语气",
        alwaysChars: 1200,
      }),
      entry({
        id: "g2",
        name: "画像.md",
        aiMaintained: true,
        applyMode: "always",
        description: "用户画像",
        alwaysChars: 800,
      }),
      entry({
        id: "g3",
        name: "偶发.md",
        applyMode: "on_demand",
        description: "",
        alwaysChars: null,
      }),
    ]);
    renderScope("global");

    expect(await screen.findByText("语气.md")).toBeTruthy();
    expect(screen.getByText("回复语气")).toBeTruthy();
    expect(screen.getByText("用户画像")).toBeTruthy();
    expect(screen.getByText("偶发.md")).toBeTruthy();
    expect(screen.queryByText("偏好.md")).toBeNull();
    expect(screen.queryByText("常驻")).toBeNull();
    expect(screen.queryByText("按需")).toBeNull();
    expect(screen.queryByText("记忆")).toBeNull();
    expect(screen.queryByText("规则")).toBeNull();
    expect(screen.queryByText(/^文档$/)).toBeNull();
    expect(screen.getByText("约 1 千字")).toBeTruthy();
    // 画像.md is 800 chars: below the row floor, so it prints no size at all.
    expect(screen.queryByText("不足千字")).toBeNull();
    expect(screen.queryByText(/还剩约/)).toBeNull();
    expect(screen.queryByText(/快满了/)).toBeNull();
    expect(screen.queryByText(/已满，超出/)).toBeNull();
    expect(screen.queryByText(/用量加载失败/)).toBeNull();
    expect(screen.queryByLabelText("新建条目")).toBeNull();
    expect(screen.queryByText("最近更新")).toBeNull();
  });

  it("prints a row size only for entries that actually hold the pool", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({ id: "g1", name: "语气.md", alwaysChars: 4200 }),
      entry({ id: "g2", name: "小规则.md", alwaysChars: 450 }),
      entry({
        id: "g3",
        name: "偏好.md",
        aiMaintained: true,
        alwaysChars: 0,
      }),
    ]);
    renderScope("global");

    expect(await screen.findByText("约 4 千字")).toBeTruthy();
    // Sub-千字 and empty rows say nothing — deleting them would free nothing.
    expect(screen.queryByText("不足千字")).toBeNull();
    expect(screen.queryByText("0 字")).toBeNull();
  });

  it("does not fetch always-quota and does not render a usage meter", async () => {
    renderScope("global");
    expect(await screen.findByText("还没有全局条目")).toBeTruthy();
    expect(screen.queryByText(/还剩约/)).toBeNull();
    expect(screen.queryByText(/快满了/)).toBeNull();
    expect(screen.queryByText(/已满，超出/)).toBeNull();
    expect(screen.queryByText(/用量加载失败/)).toBeNull();
    expect(screen.queryByLabelText("新建条目")).toBeNull();
  });

  it("shows an empty hint when the scope has no documents yet", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([]);
    const { onOpen } = renderScope("global");
    expect(await screen.findByText("还没有全局条目")).toBeTruthy();
    expect(screen.queryByText("偏好.md")).toBeNull();
    expect(screen.queryByText("画像.md")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not expose apply_mode on AI-maintained rows", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g2",
        name: "画像.md",
        aiMaintained: true,
        applyMode: "always",
      }),
    ]);
    renderScope("global");
    expect(await screen.findByText("画像.md")).toBeTruthy();
    expect(screen.queryByLabelText(/生效方式/)).toBeNull();
    expect(screen.queryByText("常驻")).toBeNull();
    expect(screen.queryByText("设为常驻")).toBeNull();
    expect(screen.queryByText("设为按需")).toBeNull();
  });

  it("surfaces frontmatter_error as 不生效", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "bad",
        name: "坏.md",
        frontmatterError: "unclosed frontmatter",
      }),
    ]);
    renderScope("global");
    expect(await screen.findByText("不生效")).toBeTruthy();
    expect(screen.getByText("unclosed frontmatter")).toBeTruthy();
  });

  it("does not mark a disputed leftover as 已停用", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g1",
        name: "过时偏好.md",
        applyMode: "always",
        alwaysChars: null,
        disputedAt: "2026-07-19T12:00:00Z",
      }),
    ]);
    renderScope("global");

    const label = await screen.findByText("过时偏好.md");
    expect(label.className).not.toContain("line-through");
    expect(screen.queryByText("已停用")).toBeNull();
    expect(screen.queryByText("约 1 千字")).toBeNull();
  });

  it("does not offer 这条不对 / 恢复使用 / 已停用 on AI-maintained cores", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g1",
        name: "偏好.md",
        aiMaintained: true,
        applyMode: "always",
        disputedAt: "2026-07-19T12:00:00Z",
      }),
    ]);
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("偏好.md"));
    expect(screen.queryByText("这条不对…")).toBeNull();
    expect(screen.queryByText("恢复使用")).toBeNull();
    expect(screen.queryByText("已停用")).toBeNull();
    expect(screen.getByText("清空")).toBeTruthy();
  });

  it("does not offer 这条不对 on handwritten entries; delete remains", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({ id: "g1", name: "语气.md" }),
    ]);
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("语气.md"));
    expect(screen.queryByText("这条不对…")).toBeNull();
    expect(screen.queryByText("停用整个「语气.md」？")).toBeNull();
    expect(screen.getByText("删除")).toBeTruthy();
  });

  it("does not offer 已停用 or 恢复使用 on a disputed leftover; delete remains", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g1",
        name: "语气.md",
        disputedAt: "2026-07-19T12:00:00Z",
      }),
    ]);
    renderScope("global");

    const label = await screen.findByText("语气.md");
    expect(label.className).not.toContain("line-through");
    expect(screen.queryByText("已停用")).toBeNull();

    fireEvent.contextMenu(label);
    expect(screen.queryByText("这条不对…")).toBeNull();
    expect(screen.queryByText("恢复使用")).toBeNull();
    expect(screen.getByText("删除")).toBeTruthy();
  });

  it("shows calm unavailable when documents API is missing", async () => {
    vi.mocked(listScopeEntries).mockRejectedValue(new ApiError(404, "missing"));
    renderScope("global");
    expect(await screen.findByText(/条目功能暂不可用/)).toBeTruthy();
  });

  it("条目列表加载失败 is muted, not destructive", async () => {
    vi.mocked(listScopeEntries).mockRejectedValue(new Error("list down"));
    renderScope("global");
    const btn = await screen.findByText("加载失败，点此重试");
    expect(btn.className).toContain("text-muted-foreground");
    expect(btn.className).not.toContain("destructive");
  });

  it("clears global 偏好 via empty memory PUT after confirm; cancel writes nothing", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g1",
        name: "偏好.md",
        aiMaintained: true,
        folderId: null,
      }),
    ]);
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("偏好.md"));
    expect(screen.queryByText("删除")).toBeNull();
    fireEvent.click(screen.getByText("清空"));
    expect(await screen.findByText("清空「偏好.md」？")).toBeTruthy();
    expect(screen.queryByText(/下一句对话/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(writeMemoryFile).not.toHaveBeenCalled();

    fireEvent.contextMenu(await screen.findByText("偏好.md"));
    fireEvent.click(screen.getByText("清空"));
    fireEvent.click(await screen.findByRole("button", { name: "清空" }));
    await waitFor(() =>
      expect(writeMemoryFile).toHaveBeenCalledWith(
        "preferences",
        "",
        null,
        null,
      ),
    );
    expect(deleteDocument).not.toHaveBeenCalled();
  });
});

describe("EntriesSection (project)", () => {
  it("loads the project scope without empty 画像/导航 slots", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "p1",
        folderId: "F1",
        name: "导航.md",
        aiMaintained: true,
        description: "项目路由",
        alwaysChars: 2400,
      }),
    ]);
    renderScope("folder");
    expect(await screen.findByText("导航.md")).toBeTruthy();
    expect(screen.getByText("项目路由")).toBeTruthy();
    expect(screen.queryByText("画像.md")).toBeNull();
    expect(screen.queryByText("最近更新")).toBeNull();
    expect(listScopeEntries).toHaveBeenCalledWith("F1");
    expect(screen.getByText("约 2 千字")).toBeTruthy();
    expect(screen.queryByText(/还剩约/)).toBeNull();
    expect(screen.queryByText(/快满了/)).toBeNull();
    expect(screen.queryByText(/已满，超出/)).toBeNull();
    expect(screen.queryByText(/用量加载失败/)).toBeNull();
    expect(screen.queryByLabelText("新建条目")).toBeNull();
  });

  it("clears a folder 画像 via empty memory PUT, and does not offer 删除", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "p1",
        folderId: "F1",
        name: "画像.md",
        aiMaintained: true,
      }),
    ]);
    const { onDeleted } = renderScope("folder");

    fireEvent.contextMenu(await screen.findByText("画像.md"));
    expect(screen.queryByText("删除")).toBeNull();
    fireEvent.click(screen.getByText("清空"));
    expect(await screen.findByText("清空「画像.md」？")).toBeTruthy();
    expect(screen.queryByText(/下一句对话/)).toBeNull();
    expect(writeMemoryFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    await waitFor(() =>
      expect(writeMemoryFile).toHaveBeenCalledWith("profile", "", null, "F1"),
    );
    expect(onDeleted).toHaveBeenCalledWith({
      channel: "memory",
      path: "project/F1/profile",
      name: "画像.md",
    });
    expect(deleteDocument).not.toHaveBeenCalled();
  });
});

describe("topicEntryDisplayName / isTopicEntryName", () => {
  it("strips the 主题/ prefix for rail labels", () => {
    expect(isTopicEntryName("主题/部署.md")).toBe(true);
    expect(isTopicEntryName("画像.md")).toBe(false);
    expect(topicEntryDisplayName("主题/部署.md")).toBe("部署.md");
    expect(topicEntryDisplayName("语气.md")).toBe("语气.md");
  });
});

describe("EntriesSection topic folder", () => {
  it("nests topics under a collapsed 主题 row and keeps user rules at the top", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g1",
        name: "语气.md",
        applyMode: "always",
        description: "回复语气",
      }),
      entry({
        id: "t1",
        name: "主题/部署.md",
        aiMaintained: true,
        applyMode: "on_demand",
        description: "怎么发",
        alwaysChars: null,
      }),
      entry({
        id: "t2",
        name: "主题/直播伴侣.md",
        aiMaintained: true,
        applyMode: "on_demand",
        alwaysChars: null,
      }),
    ]);
    renderScope("global");

    expect(await screen.findByText("语气.md")).toBeTruthy();
    expect(screen.getByText("主题 · 2")).toBeTruthy();
    expect(screen.queryByText("部署.md")).toBeNull();
    expect(screen.queryByText("主题/部署.md")).toBeNull();
    expect(screen.queryByText("直播伴侣.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "主题，2 条" }));
    expect(await screen.findByText("部署.md")).toBeTruthy();
    expect(screen.getByText("直播伴侣.md")).toBeTruthy();
    expect(screen.getByText("怎么发")).toBeTruthy();
    expect(screen.queryByText("主题/部署.md")).toBeNull();
  });

  it("expands the topic folder when a topic leaf is the active path", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "t1",
        name: "主题/部署.md",
        aiMaintained: true,
        applyMode: "on_demand",
        alwaysChars: null,
      }),
    ]);
    renderScope("global", { memoryActivePath: "global/topics/部署" });
    expect(await screen.findByText("部署.md")).toBeTruthy();
  });

  it("does not expand a folder 主题 row for a global topic path", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "t1",
        name: "主题/部署.md",
        aiMaintained: true,
        applyMode: "on_demand",
        alwaysChars: null,
      }),
    ]);
    renderScope("folder", { memoryActivePath: "global/topics/部署" });
    expect(await screen.findByText("主题 · 1")).toBeTruthy();
    expect(screen.queryByText("部署.md")).toBeNull();
  });
});
