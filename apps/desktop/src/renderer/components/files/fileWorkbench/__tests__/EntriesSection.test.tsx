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
  getAlwaysQuota: vi.fn(),
  getDocument: vi.fn(),
  createRuleDocument: vi.fn(),
  deleteDocument: vi.fn(),
  renameDocument: vi.fn(),
  setDocumentDisputed: vi.fn(),
  updateDocumentApplyMode: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

import {
  type DocumentDetail,
  type DocumentNode,
  createRuleDocument,
  getAlwaysQuota,
  getDocument,
  listScopeEntries,
  setDocumentDisputed,
  updateDocumentApplyMode,
} from "@/services/documents";
import {
  EntriesSection,
  alwaysMeterTone,
  entryOpenTarget,
  formatAlwaysChars,
  formatMeterHeadline,
  isAiCoreMemoryLeaf,
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

const entryDetail = (over: Partial<DocumentDetail> = {}): DocumentDetail => ({
  ...entry(over),
  content: over.content ?? "",
  version: over.version ?? "v",
  quotaWarning: over.quotaWarning ?? null,
  ...over,
});

function renderScope(scope: "global" | "folder" = "global") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const onOpen = vi.fn();
  const onDeleted = vi.fn();
  const onRenamed = vi.fn();
  const onOpenUpdates = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <EntriesSection
          scope={
            scope === "global"
              ? { kind: "global" }
              : { kind: "folder", folderId: "F1" }
          }
          memoryActivePath={null}
          documentActivePath={null}
          onOpen={onOpen}
          onDeleted={onDeleted}
          onRenamed={onRenamed}
          onOpenUpdates={scope === "global" ? onOpenUpdates : undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onOpen, onDeleted, onRenamed, onOpenUpdates };
}

/** A 偏好.md body: three remembered lines, only one of which the user disputes. */
const PREFERENCES_BODY = `---
apply: always
description: 沟通与工作习惯
---
# 用户记忆
> 本文件由 AI 自动维护，你可随时编辑或删除任何条目。

## 沟通偏好
- 你喜欢简洁的回答 <!-- ts:2026-07-19 -->
- 中文优先，术语保留英文原词

## 工作习惯
- 先给结论再给理由 <!-- ts:2026-08-01 -->
`;

beforeEach(() => {
  // Call history must not leak: the dispute tests assert that nothing was marked.
  vi.clearAllMocks();
  vi.mocked(listScopeEntries).mockResolvedValue([]);
  vi.mocked(getAlwaysQuota).mockResolvedValue({
    usedChars: 100,
    maxChars: 1000,
    percent: 10,
    globalChars: 100,
    projectChars: 0,
  });
  vi.mocked(getDocument).mockResolvedValue(
    entryDetail({ id: "g1", name: "偏好.md", content: PREFERENCES_BODY }),
  );
});

afterEach(() => {
  cleanup();
});

describe("always usage copy helpers", () => {
  // The 0 / 不足千字 buckets survive for the meter (`还剩 0 字` / `还剩不足千字`);
  // rows below the floor render no size at all, which is asserted on the section.
  it("distinguishes 0 from under-a-thousand and coarsens to 千/万", () => {
    expect(formatAlwaysChars(0)).toBe("0 字");
    expect(formatAlwaysChars(450)).toBe("不足千字");
    expect(formatAlwaysChars(4200)).toBe("约 4 千字");
    expect(formatAlwaysChars(12000)).toBe("约 1.2 万字");
  });

  it("leads with remaining capacity so users need no subtraction", () => {
    expect(
      formatMeterHeadline(
        {
          usedChars: 0,
          maxChars: 24000,
          percent: 0,
          globalChars: 0,
          projectChars: 0,
        },
        "global",
      ),
    ).toBe("常驻 · 还剩约 2.4 万字");
    expect(
      formatMeterHeadline(
        {
          usedChars: 4200,
          maxChars: 24000,
          percent: 17.5,
          globalChars: 4200,
          projectChars: 0,
        },
        "global",
      ),
    ).toBe("常驻 · 还剩约 2 万字");
    expect(
      formatMeterHeadline(
        {
          usedChars: 5600,
          maxChars: 24000,
          percent: 23.3,
          globalChars: 4200,
          projectChars: 1400,
        },
        "folder",
      ),
    ).toBe("常驻（含全局） · 还剩约 1.8 万字");
    expect(
      formatMeterHeadline(
        {
          usedChars: 20000,
          maxChars: 24000,
          percent: 83.3,
          globalChars: 20000,
          projectChars: 0,
        },
        "global",
      ),
    ).toBe("常驻 · 快满了，还剩约 4 千字");
    expect(
      formatMeterHeadline(
        {
          usedChars: 28000,
          maxChars: 24000,
          percent: 116.7,
          globalChars: 28000,
          projectChars: 0,
        },
        "global",
      ),
    ).toBe("常驻 · 已满，超出约 4 千字");
  });

  it("tones near-full and over for consequence copy", () => {
    expect(
      alwaysMeterTone({
        usedChars: 4200,
        maxChars: 24000,
        percent: 17.5,
        globalChars: 4200,
        projectChars: 0,
      }),
    ).toBe("ok");
    expect(
      alwaysMeterTone({
        usedChars: 20000,
        maxChars: 24000,
        percent: 83.3,
        globalChars: 20000,
        projectChars: 0,
      }),
    ).toBe("near");
    expect(
      alwaysMeterTone({
        usedChars: 28000,
        maxChars: 24000,
        percent: 116.7,
        globalChars: 28000,
        projectChars: 0,
      }),
    ).toBe("over");
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

describe("EntriesSection (global)", () => {
  it("lists flat entries with 常驻/按需 badges and description — no 记忆/规则 folders", async () => {
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
    // Missing core 偏好.md still appears as a cold-start placeholder.
    expect(screen.getByText("偏好.md")).toBeTruthy();
    expect(screen.getAllByText("常驻").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("按需")).toBeTruthy();
    expect(screen.queryByText("记忆")).toBeNull();
    expect(screen.queryByText("规则")).toBeNull();
    expect(screen.queryByText(/^文档$/)).toBeNull();
    expect(screen.getByText(/还剩不足千字/)).toBeTruthy();
    expect(screen.getByText("约 1 千字")).toBeTruthy();
    // 画像.md is 800 chars: below the row floor, so it prints no size at all.
    expect(screen.queryByText("不足千字")).toBeNull();
    expect(screen.getByText("最近更新")).toBeTruthy();
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
    // Sub-千字 and empty rows say nothing — deleting them would free nothing, and
    // the silence is what makes 画像.md's cold-start placeholder look the same as
    // the written-but-empty entry it becomes.
    expect(screen.queryByText("不足千字")).toBeNull();
    expect(screen.queryByText("0 字")).toBeNull();
  });

  it("keeps a calm meter to the number alone — explainer stays a tooltip", async () => {
    renderScope("global");
    const headline = await screen.findByText(/常驻 · 还剩/);
    // 「每次对话都会带上」only as title; a rendered line would put the calm meter
    // back to the multi-line block this rail was flattened out of.
    expect(headline.getAttribute("title")).toBe("每次对话都会带上");
    expect(screen.queryByText("每次对话都会带上")).toBeNull();
    expect(screen.queryByText(/去整理/)).toBeNull();
  });

  it("shows core placeholders when the scope has no documents yet", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([]);
    const { onOpen } = renderScope("global");
    expect(await screen.findByText("偏好.md")).toBeTruthy();
    expect(screen.getByText("画像.md")).toBeTruthy();
    expect(screen.queryByText(/还没有全局条目/)).toBeNull();
    fireEvent.click(screen.getByText("偏好.md"));
    expect(onOpen).toHaveBeenCalledWith({
      channel: "memory",
      path: "global/preferences",
      name: "偏好.md",
    });
  });

  it("does not toggle apply_mode for AI-maintained entries", async () => {
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
    // Read-only badge (no clickable apply control).
    expect(screen.queryByLabelText(/生效方式：常驻，点击切换/)).toBeNull();
    expect(updateDocumentApplyMode).not.toHaveBeenCalled();
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

  it("toggles apply_mode via the badge", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({ id: "g1", name: "语气.md", applyMode: "always" }),
    ]);
    vi.mocked(updateDocumentApplyMode).mockResolvedValue(
      entry({ id: "g1", name: "语气.md", applyMode: "on_demand" }),
    );
    renderScope("global");
    expect(await screen.findByText("语气.md")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/生效方式：常驻/));
    await waitFor(() =>
      expect(updateDocumentApplyMode).toHaveBeenCalledWith("g1", "on_demand"),
    );
  });

  it("creates a new entry and opens it", async () => {
    vi.mocked(createRuleDocument).mockResolvedValue(
      entryDetail({ id: "new", name: "新条目.md" }),
    );
    const { onOpen } = renderScope("global");
    fireEvent.click(screen.getByLabelText("新建条目"));
    await waitFor(() =>
      expect(createRuleDocument).toHaveBeenCalledWith("新条目.md", null),
    );
    expect(onOpen).toHaveBeenCalledWith({
      channel: "document",
      path: "new",
      name: "新条目.md",
    });
  });

  it("marks a disputed entry as 已停用 and stops counting its always chars", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g1",
        name: "过时偏好.md",
        applyMode: "always",
        alwaysChars: 1200,
        disputedAt: "2026-07-19T12:00:00Z",
      }),
    ]);
    renderScope("global");

    const label = await screen.findByText("过时偏好.md");
    // Kept and readable — dispute is not a delete.
    expect(label.className).toContain("line-through");
    expect(screen.getByText("已停用")).toBeTruthy();
    // Its size is no longer spent, so the row must not advertise a cost.
    expect(screen.queryByText("约 1 千字")).toBeNull();
  });

  it("lets the user mark an entry wrong and undo it from the row menu", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({ id: "g1", name: "偏好.md", applyMode: "always" }),
    ]);
    vi.mocked(setDocumentDisputed).mockResolvedValue(
      entry({ id: "g1", name: "偏好.md", disputedAt: "2026-07-19T12:00:00Z" }),
    );
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("偏好.md"));
    fireEvent.click(await screen.findByText("这条不对…"));
    fireEvent.click(
      await screen.findByRole("button", { name: "停用整个条目" }),
    );
    await waitFor(() =>
      expect(setDocumentDisputed).toHaveBeenCalledWith("g1", true),
    );

    cleanup();
    vi.mocked(setDocumentDisputed).mockClear();
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({
        id: "g1",
        name: "偏好.md",
        applyMode: "always",
        disputedAt: "2026-07-19T12:00:00Z",
      }),
    ]);
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("偏好.md"));
    expect(screen.queryByText("这条不对…")).toBeNull();
    // Undo only gives usage back, so it needs no warning about collateral.
    fireEvent.click(await screen.findByText("恢复使用"));
    await waitFor(() =>
      expect(setDocumentDisputed).toHaveBeenCalledWith("g1", false),
    );
  });

  // The user comes here from a memory card that showed ONE sentence; the mark is
  // entry-level. Naming the entry and counting the lines that go with it is the whole
  // point of the confirm step — without it the click is a blind 误伤.
  it("names the entry and counts the lines the mark will take down with it", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({ id: "g1", name: "偏好.md", aiMaintained: true }),
    ]);
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("偏好.md"));
    fireEvent.click(await screen.findByText("这条不对…"));

    expect(await screen.findByText("停用整个「偏好.md」？")).toBeTruthy();
    expect(await screen.findByText("里面这 3 条会一起停用：")).toBeTruthy();
    expect(screen.getByText("你喜欢简洁的回答")).toBeTruthy();
    expect(screen.getByText("中文优先，术语保留英文原词")).toBeTruthy();
    expect(screen.getByText("先给结论再给理由")).toBeTruthy();
    expect(getDocument).toHaveBeenCalledWith("g1");
    // 停用 ≠ 删除: the always cost stops, the text stays, the mark is undoable.
    expect(screen.getByText(/不再占用常驻额度/)).toBeTruthy();
    expect(screen.getByText(/内容保留在这里/)).toBeTruthy();
    // Nothing happens until the user confirms.
    expect(setDocumentDisputed).not.toHaveBeenCalled();
  });

  it("does not cry collateral for an entry that holds a single line", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({ id: "g1", name: "语气.md" }),
    ]);
    vi.mocked(getDocument).mockResolvedValue(
      entryDetail({
        id: "g1",
        name: "语气.md",
        content: "## 沟通偏好\n- 你喜欢简洁的回答\n",
      }),
    );
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("语气.md"));
    fireEvent.click(await screen.findByText("这条不对…"));

    expect(
      await screen.findByText("里面只有这 1 条，停用它就是停用整个条目："),
    ).toBeTruthy();
  });

  it("backs out without marking anything when the user cancels", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({ id: "g1", name: "偏好.md" }),
    ]);
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("偏好.md"));
    fireEvent.click(await screen.findByText("这条不对…"));
    expect(await screen.findByText("里面这 3 条会一起停用：")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() =>
      expect(screen.queryByText("里面这 3 条会一起停用：")).toBeNull(),
    );
    expect(setDocumentDisputed).not.toHaveBeenCalled();
  });

  it("still says the mark is entry-level when the body cannot be read", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      entry({ id: "g1", name: "偏好.md" }),
    ]);
    vi.mocked(getDocument).mockRejectedValue(new ApiError(404, "missing"));
    renderScope("global");

    fireEvent.contextMenu(await screen.findByText("偏好.md"));
    fireEvent.click(await screen.findByText("这条不对…"));

    expect(await screen.findByText(/读不到条目内容/)).toBeTruthy();
    // No invented count, and the entry-level consequence is still stated.
    expect(screen.queryByText(/里面这 \d+ 条/)).toBeNull();
    expect(screen.getByText(/停用仍然落在整个条目上/)).toBeTruthy();
  });

  it("shows calm unavailable when documents API is missing", async () => {
    vi.mocked(listScopeEntries).mockRejectedValue(new ApiError(404, "missing"));
    renderScope("global");
    expect(await screen.findByText(/条目功能暂不可用/)).toBeTruthy();
  });
});

describe("EntriesSection (project)", () => {
  it("loads the project scope and hides 最近更新", async () => {
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
    vi.mocked(getAlwaysQuota).mockResolvedValue({
      usedChars: 9800,
      maxChars: 12000,
      percent: 81.7,
      globalChars: 4200,
      projectChars: 5600,
    });
    const { onOpenUpdates } = renderScope("folder");
    expect(await screen.findByText("导航.md")).toBeTruthy();
    expect(screen.getByText("项目路由")).toBeTruthy();
    // Missing project 画像.md still listed as a placeholder.
    expect(screen.getByText("画像.md")).toBeTruthy();
    expect(screen.queryByText("最近更新")).toBeNull();
    expect(onOpenUpdates).not.toHaveBeenCalled();
    expect(listScopeEntries).toHaveBeenCalledWith("F1");
    expect(getAlwaysQuota).toHaveBeenCalledWith("F1");
    expect(
      screen.getByText(/常驻（含全局） · 快满了，还剩约 2 千字/),
    ).toBeTruthy();
    // Consequence copy earns its line back once the pool is 快满 — that is the
    // whole point of collapsing the calm state.
    expect(screen.getByText("AI 快记不下新东西了，去整理")).toBeTruthy();
    expect(screen.getByText("约 2 千字")).toBeTruthy();
  });
});
