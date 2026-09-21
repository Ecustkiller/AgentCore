import {
  PROMPT_DRAG_MIME,
  PROMPT_SKILL_DRAG_MIME,
  promptDragPayload,
} from "@/lib/promptCatalogDrag";
import type { Capabilities } from "@/services/capabilities";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptCatalog } from "../PromptCatalog";

vi.mock("@/components/markdown/MarkdownSourceEditor", async () => {
  const React = await import("react");
  let current = "";
  return {
    MarkdownSourceEditor: React.forwardRef(function Stub(
      props: {
        initialDoc?: string;
        onChange?: (value: string) => void;
      },
      ref: React.Ref<unknown>,
    ) {
      if (props.initialDoc != null) current = props.initialDoc;
      React.useImperativeHandle(ref, () => ({
        getValue: () => current,
        getView: () => null,
        getSelectionContext: () => null,
        startRewriteReview: () => false,
        endRewriteReview: () => undefined,
      }));
      return React.createElement("textarea", {
        "aria-label": "正文",
        defaultValue: props.initialDoc,
        onChange: (event: { target: { value: string } }) => {
          current = event.target.value;
          props.onChange?.(event.target.value);
        },
      });
    }),
  };
});
vi.mock("@/components/markdown/sourceToolbar", () => ({
  SourceToolbar: () => null,
}));

vi.mock("@/services/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/documents")>();
  return {
    ...actual,
    listScopeEntries: vi.fn(async () => []),
    listAccountPromptTree: vi.fn(async () => ({
      rulesDirId: "rules",
      folders: [],
      documents: [],
    })),
    createRuleDocument: vi.fn(),
    createRuleFolder: vi.fn(),
    reparentDocument: vi.fn(),
    deleteDocument: vi.fn(),
    getDocument: vi.fn(),
    renameDocument: vi.fn(),
    writeDocument: vi.fn(),
    updateDocumentApplyMode: vi.fn(),
  };
});

vi.mock("@/services/skillCatalog", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/skillCatalog")>();
  return {
    ...actual,
    getSkillCatalog: vi.fn(),
  };
});

vi.mock("@/services/skillStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/skillStore")>();
  return {
    ...actual,
    listMySkillListings: vi.fn(async () => []),
    listInstalledSkills: vi.fn(async () => []),
  };
});

vi.mock("@/hooks/useFolders", () => ({
  getFolders: () => [{ id: "F99", name: "白板" }],
  useFolders: () => [{ id: "F99", name: "白板" }],
}));

vi.mock("@/hooks/useLlmProviders", () => ({
  useLlmProviders: () => ({ data: undefined }),
}));

vi.mock("@/hooks/useModels", () => ({
  useModels: () => ({ data: undefined }),
}));

const { getSkillCatalog } = await import("@/services/skillCatalog");
const { listInstalledSkills } = await import("@/services/skillStore");
const {
  createRuleFolder,
  deleteDocument,
  getDocument,
  listAccountPromptTree,
  listScopeEntries,
  renameDocument,
  reparentDocument,
  updateDocumentApplyMode,
  writeDocument,
} = await import("@/services/documents");

const base: Capabilities = {
  guidelines: {
    shared_base: "共享准则正文",
    worker_leaf: "叶子身份正文",
    worker_captain: "可再委派队员身份正文",
    ceo_addon: "主 Agent 身份正文",
    ceo: "完整 CEO 提示词",
  },
  skills: [
    {
      name: "thin_skill",
      summary: "薄技能",
      body: "thin-body",
      group: "",
      blurb: "",
    },
  ],
  tools: [],
};

function renderCatalog(
  path = "/toolbox/mine/skills",
  data: Capabilities = base,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/toolbox/official"
            element={<PromptCatalog data={data} />}
          />
          <Route
            path="/toolbox/mine/skills"
            element={<PromptCatalog data={data} />}
          />
          <Route
            path="/toolbox/market"
            element={<div data-testid="market-page" />}
          />
          <Route
            path="/toolbox/guides"
            element={<div data-testid="guides-page" />}
          />
          <Route path="/files" element={<div data-testid="files-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function alwaysRail() {
  return screen.getByTestId("prompt-rail-always");
}

function onDemandRail() {
  return screen.getByTestId("prompt-rail-on-demand");
}

async function openReadDialog(from: HTMLElement, label: string) {
  fireEvent.click(within(from).getByRole("button", { name: label }));
  return screen.findByRole("dialog");
}

function previewText(from: HTMLElement, text: string) {
  return within(from).getByText(text, { exact: false });
}

beforeEach(() => {
  vi.mocked(getSkillCatalog).mockReset();
  vi.mocked(getSkillCatalog).mockResolvedValue({
    slots: [],
    mine: [],
    folderId: null,
    writable: true,
  });
  vi.mocked(listInstalledSkills).mockReset();
  vi.mocked(listInstalledSkills).mockResolvedValue([]);
  vi.mocked(listScopeEntries).mockReset();
  vi.mocked(listScopeEntries).mockResolvedValue([]);
  vi.mocked(createRuleFolder).mockReset();
  vi.mocked(reparentDocument).mockReset();
  vi.mocked(renameDocument).mockReset();
  vi.mocked(writeDocument).mockReset();
  vi.mocked(getDocument).mockReset();
  vi.mocked(listAccountPromptTree).mockReset();
  vi.mocked(listAccountPromptTree).mockResolvedValue({
    rulesDirId: "rules",
    folders: [],
    documents: [],
  });
  vi.mocked(createRuleFolder).mockResolvedValue({
    id: "other-1",
    parentId: "rules",
    folderId: null,
    kind: "folder",
    role: "rule",
    aiMaintained: false,
    applyMode: "on_demand",
    description: "",
    name: "其他",
    frontmatterError: null,
    alwaysChars: null,
    disputedAt: null,
  });
  vi.mocked(updateDocumentApplyMode).mockReset();
  vi.mocked(updateDocumentApplyMode).mockResolvedValue({
    id: "d1",
    parentId: null,
    folderId: null,
    kind: "document",
    role: "rule",
    aiMaintained: false,
    applyMode: "always",
    description: "审合同时用",
    name: "合同审查.md",
    frontmatterError: null,
    alwaysChars: null,
    disputedAt: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("PromptCatalog 概览", () => {
  it("整页概览，不套整页卡片，没有左栏目录", async () => {
    renderCatalog();
    await waitFor(() => {
      expect(screen.getByTestId("prompt-overview")).toBeTruthy();
    });
    const catalog = screen.getByTestId("prompt-catalog");
    expect(catalog.className).not.toContain("rounded-xl");
    expect(catalog.className).not.toContain("bg-card");
    expect(screen.queryByRole("navigation", { name: "提示词目录" })).toBeNull();
  });

  it("无 updates 时按加载档分两区", async () => {
    renderCatalog();
    await waitFor(() => {
      expect(screen.getByTestId("prompt-overview")).toBeTruthy();
    });
    expect(screen.queryByText("自带")).toBeNull();
    expect(screen.getByRole("heading", { name: "必带" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "按需" })).toBeTruthy();
    const title = screen.getByRole("heading", { level: 1, name: "工具箱" });
    expect(title.className).toContain("sr-only");
    const source = screen.getByRole("navigation", { name: "工具箱" });
    expect(within(source).getByLabelText("搜提示词")).toBeTruthy();
    expect(within(source).getByRole("button", { name: /^新建$/ })).toBeTruthy();
    expect(screen.queryByText("下一回合会带这些")).toBeNull();
    expect(screen.queryByText("每回合都带着")).toBeNull();
    expect(screen.queryByText("用到才翻")).toBeNull();
    expect(screen.queryByText("记忆")).toBeNull();
    expect(
      within(onDemandRail()).queryByRole("heading", { name: "官方" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "薄技能" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全员共享准则" })).toBeNull();
    expect(screen.queryByText("偏好")).toBeNull();
    expect(screen.queryByText("画像")).toBeNull();
    expect(screen.queryByRole("button", { name: "概览" })).toBeNull();
    expect(screen.getByRole("button", { name: /^新建$/ })).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "工具箱" })).getByRole(
        "link",
        { name: "市场" },
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "工具箱" })).getByRole(
        "link",
        { name: "官方" },
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "工具箱" })).getByRole(
        "link",
        { name: "我的" },
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "说明书" })).toBeNull();
    expect(screen.queryByTestId("prompt-overview-updates")).toBeNull();
    expect(screen.queryByRole("button", { name: "最近学到" })).toBeNull();
    expect(screen.queryByText("角色身份")).toBeNull();
    expect(screen.queryByTestId("memory-updates-view")).toBeNull();
    expect(screen.getByTestId("prompt-overview")).toBeTruthy();
  });

  it("官方栏打开准则读卡", async () => {
    renderCatalog("/toolbox/official");
    await waitFor(() => {
      expect(screen.getByTestId("prompt-overview")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /^新建$/ })).toBeNull();
    const prompts = screen.getByTestId("prompt-rail-prompts");
    expect(within(prompts).getByText("每回合都在的工作宪法")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "准则" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "教法" })).toBeNull();
    const dialog = await openReadDialog(prompts, "全员共享准则");
    expect(
      within(dialog).getByRole("heading", { name: "全员共享准则" }),
    ).toBeTruthy();
    expect(within(dialog).getByText("官方")).toBeTruthy();
    expect(within(dialog).queryByRole("tab")).toBeNull();
    expect(within(dialog).getByText("共享准则正文")).toBeTruthy();
    expect(within(dialog).queryByText("主 Agent 身份正文")).toBeNull();
    expect(
      within(dialog).queryByText("队员跟全员准则走，专精写在每次派工里。"),
    ).toBeNull();
    expect(within(dialog).queryByText("叶子身份正文")).toBeNull();
    expect(within(dialog).queryByText("三选一")).toBeNull();
    expect(screen.queryByTestId("memory-updates-view")).toBeNull();
    expect(screen.getByTestId("prompt-overview")).toBeTruthy();
  });

  it("官方 HOW 进提示词货架，不进我的必带/按需", async () => {
    renderCatalog("/toolbox/official", {
      ...base,
      skills: [
        {
          name: "run",
          summary: "跑命令 / 启服",
          body: "run-how-body",
          group: "工具",
          blurb: "",
          requires_tools: ["run"],
        },
        {
          name: "staffing",
          summary: "团队拆法",
          body: "staffing-how-body",
          group: "编排",
          blurb: "",
          audience: ["ceo"],
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByTestId("prompt-overview")).toBeTruthy();
    });
    expect(screen.queryByTestId("prompt-rail-always")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-on-demand")).toBeNull();
    const prompts = screen.getByTestId("prompt-rail-prompts");
    expect(
      within(prompts)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))[0],
    ).toBe("全员共享准则");
    expect(
      within(prompts).getByRole("button", {
        name: "团队拆法",
      }),
    ).toBeTruthy();
    expect(
      within(prompts).getByRole("button", {
        name: "跑命令 / 启服",
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("prompt-rail-official")).toBeNull();
  });

  it("无官方 HOW 时提示词货架仍留准则卡", async () => {
    renderCatalog("/toolbox/official", { ...base, skills: [] });
    await waitFor(() => {
      expect(screen.getByTestId("prompt-overview")).toBeTruthy();
    });
    expect(screen.queryByTestId("prompt-rail-how")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-constitution")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-official")).toBeNull();
    expect(screen.queryByRole("heading", { name: "教法" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "准则" })).toBeNull();
    expect(
      within(screen.getByTestId("prompt-rail-prompts")).getByRole("button", {
        name: "全员共享准则",
      }),
    ).toBeTruthy();
  });

  it("自建条目夹里不标我的", async () => {
    vi.mocked(getSkillCatalog).mockResolvedValue({
      slots: [],
      mine: [
        {
          id: "d1",
          name: "合同审查",
          description: "审合同时用",
          content: "HOW",
          version: "v1",
        },
      ],
      folderId: null,
      writable: true,
    });
    renderCatalog();
    await waitFor(() => {
      expect(previewText(onDemandRail(), "合同审查")).toBeTruthy();
    });
    expect(within(onDemandRail()).getByText("其他")).toBeTruthy();
    expect(screen.queryByTestId("my-skills")).toBeTruthy();
    const dialog = await openReadDialog(onDemandRail(), "合同审查");
    expect(within(dialog).queryByText("我的")).toBeNull();
    expect(await screen.findByTestId("mine-skill-editor")).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("tab", { name: "预览" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(within(dialog).getByRole("tab", { name: "编辑" }));
    expect(screen.getByLabelText("名称")).toHaveProperty("value", "合同审查");
    expect(screen.queryByRole("tablist", { name: "加载方式" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停用" })).toBeNull();
  });

  it("市场装来的标题标市场，不标我的", async () => {
    vi.mocked(listInstalledSkills).mockResolvedValue([
      {
        id: "listing-1",
        name: "合同审查",
        description: "审合同时用",
        author: "官方",
        version: "1",
        installed: true,
        hasUpdate: false,
        documentId: null,
        installDocumentId: "d1",
        status: "published",
        group: "legal",
        offersTools: [],
      },
    ]);
    vi.mocked(getSkillCatalog).mockResolvedValue({
      slots: [],
      mine: [
        {
          id: "d1",
          name: "合同审查",
          description: "审合同时用",
          content: "HOW",
          version: "v1",
        },
      ],
      folderId: null,
      writable: true,
    });
    renderCatalog();
    await waitFor(() => {
      expect(previewText(onDemandRail(), "合同审查")).toBeTruthy();
    });
    const dialog = await openReadDialog(onDemandRail(), "合同审查");
    expect(within(dialog).getByText("市场")).toBeTruthy();
    expect(within(dialog).queryByText("我的")).toBeNull();
    expect(within(dialog).getByText("法律合规")).toBeTruthy();
    expect(onDemandRail().textContent).toContain("法律合规");
    expect(screen.queryByRole("button", { name: "上架" })).toBeNull();
  });
});

describe("PromptCatalog 拖拽搬家", () => {
  async function renderMineCatalog() {
    vi.mocked(getSkillCatalog).mockResolvedValue({
      slots: [],
      mine: [
        {
          id: "d1",
          name: "合同审查",
          description: "审合同时用",
          content: "HOW",
          version: "v1",
        },
      ],
      folderId: null,
      writable: true,
    });
    renderCatalog("/toolbox/mine/skills", {
      ...base,
      skills: [
        {
          name: "staffing",
          summary: "团队拆法",
          body: "s",
          group: "编排",
          blurb: "",
        },
      ],
    });
    await waitFor(() => {
      expect(previewText(onDemandRail(), "合同审查")).toBeTruthy();
    });
  }

  function startDrag(name: string, scope?: HTMLElement) {
    const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
    const node = scope ? within(scope).getByText(name) : screen.getByText(name);
    fireEvent.dragStart(node, { dataTransfer });
    return dataTransfer;
  }

  function dropTransfer(mineId: string) {
    const raw = promptDragPayload({ kind: "mine", mineIds: [mineId] });
    return {
      types: [PROMPT_DRAG_MIME],
      getData: (type: string) => (type === PROMPT_DRAG_MIME ? raw : ""),
    };
  }

  function dropSkillTransfer(slot: string) {
    const raw = promptDragPayload({ kind: "skill", slot });
    return {
      types: [PROMPT_SKILL_DRAG_MIME],
      dropEffect: "",
      getData: (type: string) => (type === PROMPT_SKILL_DRAG_MIME ? raw : ""),
    };
  }

  it("手写条目右键可删除，没有这条不对", async () => {
    await renderMineCatalog();
    fireEvent.contextMenu(within(onDemandRail()).getByText("合同审查"));
    expect(await screen.findByText("重命名")).toBeTruthy();
    expect(screen.getByText("删除")).toBeTruthy();
    expect(screen.queryByText("移到根目录")).toBeNull();
    expect(screen.queryByText("移入编排")).toBeNull();
    expect(screen.queryByText("这条不对…")).toBeNull();
    expect(screen.queryByText("恢复使用")).toBeNull();
  });

  it("已 disputed 的手写条目不划掉，没有恢复使用", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      {
        id: "d1",
        parentId: null,
        folderId: null,
        kind: "document",
        role: "rule",
        aiMaintained: false,
        applyMode: "on_demand",
        description: "审合同时用",
        name: "合同审查.md",
        frontmatterError: null,
        alwaysChars: null,
        disputedAt: "2026-07-19T12:00:00Z",
      },
    ]);
    await renderMineCatalog();
    const tile = screen.getByTestId("prompt-tile-mine:d1");
    expect(tile.className).not.toContain("line-through");
    expect(screen.queryByText("已停用")).toBeNull();
    fireEvent.contextMenu(within(tile).getByText("合同审查"));
    expect(screen.queryByText("这条不对…")).toBeNull();
    expect(screen.queryByText("恢复使用")).toBeNull();
    expect(screen.getByText("删除")).toBeTruthy();
  });

  it("手写条目可拖", async () => {
    await renderMineCatalog();
    const started = startDrag("合同审查", onDemandRail());
    expect(started.setData).toHaveBeenCalledWith(
      PROMPT_DRAG_MIME,
      promptDragPayload({ kind: "mine", mineIds: ["d1"] }),
    );
  });

  it("拖到常驻区里的条目也写成常驻", async () => {
    await renderMineCatalog();
    fireEvent.drop(alwaysRail(), {
      dataTransfer: dropTransfer("d1"),
    });
    await waitFor(() => {
      expect(reparentDocument).toHaveBeenCalledWith("d1", "rules", "always");
    });
  });

  it("拖到常驻区头写成常驻", async () => {
    await renderMineCatalog();
    fireEvent.drop(alwaysRail(), {
      dataTransfer: dropTransfer("d1"),
    });
    await waitFor(() => {
      expect(reparentDocument).toHaveBeenCalledWith("d1", "rules", "always");
    });
  });

  it("拖到按需区头进其他", async () => {
    await renderMineCatalog();
    fireEvent.drop(onDemandRail(), {
      dataTransfer: dropTransfer("d1"),
    });
    await waitFor(() => {
      expect(createRuleFolder).toHaveBeenCalledWith("其他");
      expect(reparentDocument).toHaveBeenCalledWith(
        "d1",
        "other-1",
        "on_demand",
      );
    });
  });

  it("我的目录没有官方 HOW 可拖", async () => {
    await renderMineCatalog();
    expect(screen.queryByRole("button", { name: "团队拆法" })).toBeNull();
    expect(screen.queryByTestId("prompt-rail-official")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-how")).toBeNull();
  });

  it("拖进其他调 reparentDocument 不写官方 home", async () => {
    await renderMineCatalog();
    fireEvent.drop(within(onDemandRail()).getByText("其他"), {
      dataTransfer: dropTransfer("d1"),
    });
    await waitFor(() => {
      expect(createRuleFolder).toHaveBeenCalledWith("其他");
      expect(reparentDocument).toHaveBeenCalledWith(
        "d1",
        "other-1",
        "on_demand",
      );
    });
  });

  it("技能拖到根不搬家", async () => {
    await renderMineCatalog();
    fireEvent.drop(alwaysRail(), {
      dataTransfer: dropSkillTransfer("staffing"),
    });
    expect(reparentDocument).not.toHaveBeenCalled();
  });

  it("偏好画像不出现在常驻", async () => {
    await renderMineCatalog();
    expect(screen.queryByText("偏好")).toBeNull();
    expect(screen.queryByText("画像")).toBeNull();
  });
});

const webSearchTool = {
  name: "web_search",
  face: "web" as const,
  resident: true,
  summary: "联网检索",
  blurb: "按关键词在网上找资料和链接",
  description: "联网检索：给出查询词。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索词，建议 2–3 个核心词。" },
    },
    required: ["query"],
  },
  approval: "never" as const,
  available_to: ["ceo", "worker"],
};

const hostTool = {
  name: "host",
  face: "host_browser" as const,
  resident: true,
  summary: "本机",
  blurb: "看本机屏幕、键鼠和已打开的应用",
  description: "本机",
  parameters: { type: "object", properties: {} },
  approval: "grantable" as const,
  available_to: ["worker"],
};

describe("PromptCatalog 工具与 MCP 深链", () => {
  it("常驻条目默认预览，编辑面不出目录句", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      {
        id: "d1",
        parentId: null,
        folderId: null,
        kind: "document",
        role: "rule",
        aiMaintained: false,
        applyMode: "always",
        description: "验证规则目录能否被新对话自动加载的测试条目",
        name: "测试规则.md",
        frontmatterError: null,
        alwaysChars: 80,
        disputedAt: null,
      },
    ]);
    vi.mocked(getSkillCatalog).mockResolvedValue({
      slots: [],
      mine: [
        {
          id: "d1",
          name: "测试规则",
          description: "验证规则目录能否被新对话自动加载的测试条目",
          content:
            "---\napply: always\ndescription: 验证规则目录\n---\n# 测试规则\n\n末行写「规则生效」。\n",
          version: "v1",
        },
      ],
      folderId: null,
      writable: true,
    });
    renderCatalog("/toolbox/mine/skills", {
      ...base,
      tools: [hostTool],
    });
    await waitFor(() => {
      expect(previewText(alwaysRail(), "测试规则")).toBeTruthy();
    });
    const dialog = await openReadDialog(alwaysRail(), "测试规则");
    expect(
      within(dialog)
        .getByRole("tab", { name: "预览" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(within(dialog).getByText("规则生效", { exact: false })).toBeTruthy();
    expect(within(dialog).queryByLabelText("名称")).toBeNull();
    fireEvent.click(within(dialog).getByRole("tab", { name: "编辑" }));
    expect(within(dialog).getByLabelText("名称")).toHaveProperty(
      "value",
      "测试规则",
    );
    expect(within(dialog).queryByLabelText("一句话介绍")).toBeNull();
    expect(within(dialog).queryByText("本机")).toBeNull();
  });

  it("常驻条目正文后到也默认预览，不因空壳先进编辑", async () => {
    vi.mocked(listScopeEntries).mockResolvedValue([
      {
        id: "d1",
        parentId: null,
        folderId: null,
        kind: "document",
        role: "rule",
        aiMaintained: false,
        applyMode: "always",
        description: "验证规则目录",
        name: "测试规则.md",
        frontmatterError: null,
        alwaysChars: 80,
        disputedAt: null,
      },
    ]);
    vi.mocked(getSkillCatalog).mockResolvedValue({
      slots: [],
      mine: [],
      folderId: null,
      writable: true,
    });
    vi.mocked(getDocument).mockResolvedValue({
      id: "d1",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: false,
      applyMode: "always",
      description: "验证规则目录",
      name: "测试规则.md",
      frontmatterError: null,
      alwaysChars: 80,
      disputedAt: null,
      content:
        "---\napply: always\ndescription: 验证规则目录\n---\n# 测试规则\n\n末行写「规则生效」。\n",
      version: "v1",
      quotaWarning: null,
    });
    renderCatalog("/toolbox/mine/skills", { ...base, tools: [hostTool] });
    await waitFor(() => {
      expect(previewText(alwaysRail(), "测试规则")).toBeTruthy();
    });
    const dialog = await openReadDialog(alwaysRail(), "测试规则");
    await waitFor(() => {
      expect(getDocument).toHaveBeenCalledWith("d1");
      expect(
        within(dialog).getByText("规则生效", { exact: false }),
      ).toBeTruthy();
    });
    expect(
      within(dialog)
        .getByRole("tab", { name: "预览" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(within(dialog).queryByLabelText("名称")).toBeNull();
  });

  it("空条目默认编辑", async () => {
    vi.mocked(getSkillCatalog).mockResolvedValue({
      slots: [],
      mine: [
        {
          id: "d1",
          name: "未命名提示词",
          description: "",
          content: "---\napply: on_demand\n---\n",
          version: "v1",
        },
      ],
      folderId: null,
      writable: true,
    });
    renderCatalog();
    await waitFor(() => {
      expect(previewText(onDemandRail(), "未命名提示词")).toBeTruthy();
    });
    const dialog = await openReadDialog(onDemandRail(), "未命名提示词");
    expect(
      within(dialog)
        .getByRole("tab", { name: "编辑" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(within(dialog).getByLabelText("名称")).toHaveProperty(
      "value",
      "未命名提示词",
    );
  });

  it("开场即用的出厂工具铺官方货架卡", async () => {
    renderCatalog("/toolbox/official", {
      ...base,
      tools: [webSearchTool, hostTool],
    });
    await waitFor(() => {
      expect(screen.getByTestId("prompt-overview")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "联网检索" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "本机" })).toBeTruthy();
    expect(screen.queryByTestId("prompt-rail-on-demand-tools")).toBeNull();
    expect(screen.queryByTestId("prompt-rail-official")).toBeNull();
  });

  it("?tool= 直达工具读卡", async () => {
    renderCatalog("/toolbox/official?tool=web_search", {
      ...base,
      tools: [webSearchTool, hostTool],
    });
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "联网检索" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("guides-page")).toBeNull();
  });

  it("?skill= 直达官方 HOW 读卡", async () => {
    renderCatalog("/toolbox/official?skill=thin_skill", {
      ...base,
      skills: [
        {
          name: "thin_skill",
          summary: "薄技能",
          body: "thin-body",
          group: "",
          blurb: "",
        },
      ],
    });
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "薄技能" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("guides-page")).toBeNull();
  });

  it("我的不铺 MCP 列表", async () => {
    renderCatalog("/toolbox/mine/skills", {
      ...base,
      tools: [webSearchTool],
    });
    await waitFor(() => {
      expect(screen.getByTestId("prompt-overview")).toBeTruthy();
    });
    expect(screen.queryByTestId("mcp-list")).toBeNull();
    expect(screen.queryByRole("button", { name: "添加 MCP" })).toBeNull();
    expect(screen.queryByRole("button", { name: "联网检索" })).toBeNull();
  });
});

describe("PromptCatalog 就地命名", () => {
  function ruleFolder(id: string, name: string) {
    return {
      id,
      parentId: "rules",
      folderId: null,
      kind: "folder" as const,
      role: "rule" as const,
      aiMaintained: false,
      applyMode: "on_demand" as const,
      description: "",
      name,
      frontmatterError: null,
      alwaysChars: null,
      disputedAt: null,
    };
  }

  it("点新建夹立刻创建未命名夹并进入改名", async () => {
    const created = ruleFolder("f-new", "未命名夹");
    vi.mocked(createRuleFolder).mockResolvedValue(created);
    renderCatalog();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "新建夹" })).toBeTruthy();
    });
    vi.mocked(listAccountPromptTree).mockResolvedValue({
      rulesDirId: "rules",
      folders: [created],
      documents: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "新建夹" }));
    await waitFor(() => {
      expect(createRuleFolder).toHaveBeenCalledWith("未命名夹");
    });
    expect(screen.getByDisplayValue("未命名夹")).toBeTruthy();
  });

  it("输入夹名回车后改名并出现在按需区", async () => {
    const created = ruleFolder("f-law", "未命名夹");
    vi.mocked(createRuleFolder).mockResolvedValue(created);
    vi.mocked(renameDocument).mockImplementation(async (_id, name) =>
      ruleFolder("f-law", name),
    );
    renderCatalog();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "新建夹" })).toBeTruthy();
    });
    vi.mocked(listAccountPromptTree).mockResolvedValue({
      rulesDirId: "rules",
      folders: [created],
      documents: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "新建夹" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "夹名称" })).toBeTruthy();
    });
    vi.mocked(listAccountPromptTree).mockResolvedValue({
      rulesDirId: "rules",
      folders: [ruleFolder("f-law", "法律")],
      documents: [],
    });
    const input = screen.getByRole("textbox", { name: "夹名称" });
    fireEvent.change(input, { target: { value: "法律" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(renameDocument).toHaveBeenCalledWith("f-law", "法律");
    });
    await waitFor(() => {
      expect(within(onDemandRail()).getByText("法律")).toBeTruthy();
    });
  });

  it("Esc 取消改名仍保留未命名夹", async () => {
    const created = ruleFolder("f-new", "未命名夹");
    vi.mocked(createRuleFolder).mockResolvedValue(created);
    renderCatalog();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "新建夹" })).toBeTruthy();
    });
    vi.mocked(listAccountPromptTree).mockResolvedValue({
      rulesDirId: "rules",
      folders: [created],
      documents: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "新建夹" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "夹名称" })).toBeTruthy();
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "夹名称" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("textbox", { name: "夹名称" })).toBeNull();
    expect(createRuleFolder).toHaveBeenCalledTimes(1);
    expect(renameDocument).not.toHaveBeenCalled();
    expect(within(onDemandRail()).getByText("未命名夹")).toBeTruthy();
  });

  it("右键重命名就地改名", async () => {
    vi.mocked(getSkillCatalog).mockResolvedValue({
      slots: [],
      mine: [
        {
          id: "d1",
          name: "合同审查",
          description: "审合同时用",
          content: "HOW",
          version: "v1",
        },
      ],
      folderId: null,
      writable: true,
    });
    vi.mocked(renameDocument).mockResolvedValue({
      id: "d1",
      parentId: null,
      folderId: null,
      kind: "document",
      role: "rule",
      aiMaintained: false,
      applyMode: "on_demand",
      description: "审合同时用",
      name: "新合同.md",
      frontmatterError: null,
      alwaysChars: null,
      disputedAt: null,
    });
    renderCatalog();
    await waitFor(() => {
      expect(previewText(onDemandRail(), "合同审查")).toBeTruthy();
    });
    fireEvent.contextMenu(within(onDemandRail()).getByText("合同审查"));
    fireEvent.click(await screen.findByText("重命名"));
    const input = screen.getByRole("textbox", { name: "条目名称" });
    expect((input as HTMLInputElement).value).toBe("合同审查");
    fireEvent.change(input, { target: { value: "新合同" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(renameDocument).toHaveBeenCalledWith("d1", "新合同.md");
    });
  });
});

describe("PromptCatalog 我的条目多选", () => {
  async function renderTwoMine() {
    vi.mocked(getSkillCatalog).mockResolvedValue({
      slots: [],
      mine: [
        {
          id: "d1",
          name: "合同审查",
          description: "审合同时用",
          content: "HOW",
          version: "v1",
        },
        {
          id: "d2",
          name: "尽调清单",
          description: "尽调时用",
          content: "HOW",
          version: "v1",
        },
      ],
      folderId: null,
      writable: true,
    });
    renderCatalog();
    await waitFor(() => {
      expect(previewText(onDemandRail(), "合同审查")).toBeTruthy();
      expect(previewText(onDemandRail(), "尽调清单")).toBeTruthy();
    });
  }

  it("Ctrl 点两张卡进入选区，不打开读卡；≥2 项出条", async () => {
    await renderTwoMine();
    fireEvent.click(
      within(onDemandRail()).getByRole("button", { name: "合同审查" }),
      { ctrlKey: true },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("prompt-selection-bar")).toBeNull();
    fireEvent.click(
      within(onDemandRail()).getByRole("button", { name: "尽调清单" }),
      { ctrlKey: true },
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("prompt-selection-bar").textContent).toContain(
      "已选择 2 项",
    );
  });

  it("Shift 从锚点连选；Esc 清空", async () => {
    await renderTwoMine();
    fireEvent.click(
      within(onDemandRail()).getByRole("button", { name: "合同审查" }),
      { ctrlKey: true },
    );
    fireEvent.click(
      within(onDemandRail()).getByRole("button", { name: "尽调清单" }),
      { shiftKey: true },
    );
    expect(screen.getByTestId("prompt-selection-bar")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("prompt-selection-bar")).toBeNull();
  });

  it("官方 HOW Ctrl 点不进选区", async () => {
    renderCatalog("/toolbox/official");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "薄技能" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "薄技能" }), {
      ctrlKey: true,
    });
    expect(screen.queryByTestId("prompt-selection-bar")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("选区右键只出整批删除；确认后逐条删除", async () => {
    vi.mocked(deleteDocument).mockReset();
    vi.mocked(deleteDocument).mockResolvedValue({
      ok: true,
      version: "v",
      conflict: false,
      frontmatterError: null,
      quotaWarning: null,
    });
    await renderTwoMine();
    fireEvent.click(
      within(onDemandRail()).getByRole("button", { name: "合同审查" }),
      { ctrlKey: true },
    );
    fireEvent.click(
      within(onDemandRail()).getByRole("button", { name: "尽调清单" }),
      { ctrlKey: true },
    );
    fireEvent.contextMenu(within(onDemandRail()).getByText("合同审查"));
    expect(await screen.findByText("删除 2 项")).toBeTruthy();
    expect(screen.queryByText("重命名")).toBeNull();
    fireEvent.click(screen.getByText("删除 2 项"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("删除这 2 条？")).toBeTruthy();
    expect(within(dialog).getByText(/不可撤销/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(deleteDocument).toHaveBeenCalledWith("d1");
      expect(deleteDocument).toHaveBeenCalledWith("d2");
    });
  });

  it("拖选区发出整批 mineIds", async () => {
    await renderTwoMine();
    fireEvent.click(
      within(onDemandRail()).getByRole("button", { name: "合同审查" }),
      { ctrlKey: true },
    );
    fireEvent.click(
      within(onDemandRail()).getByRole("button", { name: "尽调清单" }),
      { ctrlKey: true },
    );
    const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(within(onDemandRail()).getByText("合同审查"), {
      dataTransfer,
    });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      PROMPT_DRAG_MIME,
      promptDragPayload({ kind: "mine", mineIds: ["d1", "d2"] }),
    );
  });

  it("单项删除走确认框，不再用 window.confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    vi.mocked(deleteDocument).mockReset();
    vi.mocked(deleteDocument).mockResolvedValue({
      ok: true,
      version: "v",
      conflict: false,
      frontmatterError: null,
      quotaWarning: null,
    });
    await renderTwoMine();
    fireEvent.contextMenu(within(onDemandRail()).getByText("合同审查"));
    fireEvent.click(await screen.findByText("删除"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("删除「合同审查」？")).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(deleteDocument).toHaveBeenCalledWith("d1");
    });
    confirmSpy.mockRestore();
  });
});
