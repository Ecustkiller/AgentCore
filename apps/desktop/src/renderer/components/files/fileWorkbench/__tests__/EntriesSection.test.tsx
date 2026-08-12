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
  createRuleDocument: vi.fn(),
  deleteDocument: vi.fn(),
  renameDocument: vi.fn(),
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
  listScopeEntries,
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

function renderScope(scope: "global" | "project" = "global") {
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
              : { kind: "project", folderId: "F1" }
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

beforeEach(() => {
  vi.mocked(listScopeEntries).mockResolvedValue([]);
  vi.mocked(getAlwaysQuota).mockResolvedValue({
    usedChars: 100,
    maxChars: 1000,
    percent: 10,
    globalChars: 100,
    projectChars: 0,
  });
});

afterEach(() => {
  cleanup();
});

describe("always usage copy helpers", () => {
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
        "project",
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
    expect(screen.getByText("最近更新")).toBeTruthy();
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
    const { onOpenUpdates } = renderScope("project");
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
    expect(screen.getByText("约 2 千字")).toBeTruthy();
  });
});
