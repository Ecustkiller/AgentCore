// @vitest-environment jsdom
/**
 * TurnComposer variants: `card` 摊开左簇；`bar` 用「＋」收纳会话配置，常显仅输入与发送。
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useLlmProviders", () => ({
  useLlmProviders: () => ({
    data: {
      providers: [
        {
          id: "p1",
          label: "DeepSeek",
          base_url: "https://api.deepseek.com/v1",
          default_model: "deepseek-test",
          status: "active",
          supports_tools: true,
        },
      ],
      default_model_profile_id: "sys-52",
      billing_mode: "byok",
      platform_available: false,
      platform_model: null,
    },
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useLlmModelProfiles", () => ({
  useLlmModelProfiles: () => ({
    data: {
      default_model_profile_id: "sys-52",
      data: [
        {
          id: "sys-52",
          name: "GLM-5.2",
          kind: "system",
          is_default: true,
          main: {
            origin: "byok",
            provider_id: "p1",
            model: "deepseek-test",
          },
          worker: null,
          background: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => [],
  useCreateFolder: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => [],
  useGroupedConversations: () => ({ data: { folders: [] } }),
  patchConversationCache: vi.fn(),
}));
vi.mock("@/hooks/useModels", () => ({
  useModels: () => ({
    data: {
      byok_configured: true,
      current: { id: "deepseek-test", origin: "byok" },
      models: [
        {
          id: "deepseek-test",
          origin: "byok",
          display_name: "DeepSeek Test",
          vendor: "DeepSeek",
          capabilities: [],
          context_length: null,
          price: null,
          available: true,
        },
      ],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: () => false,
  hasLocalEngine: () => false,
  // Desktop Electron under test — keep the web-only「无本地文件夹」chip off.
  isWebRuntime: () => false,
}));
vi.mock("@/services/permissionAxes", () => ({
  RECIPE_LABELS: {
    cautious: { short: "谨慎", description: "问" },
    less_interrupt: { short: "少打断", description: "少" },
    managed: { short: "托管", description: "同权" },
  },
  RECIPE_ORDER: ["cautious", "less_interrupt", "managed"],
  RECIPE_AXES: {
    less_interrupt: {
      file_write: "session",
      command: "auto",
      team_kickoff: "rules",
      host: "session",
    },
  },
  DEFAULT_PERMISSION_AXES: {
    file_write: "session",
    command: "auto",
    team_kickoff: "rules",
    host: "session",
  },
  FILE_WRITE_OPTIONS: [],
  COMMAND_OPTIONS: [],
  TEAM_KICKOFF_OPTIONS: [],
  matchRecipe: () => "less_interrupt",
  axesShortLabel: () => "少打断",
  recipeToAxes: () => ({
    file_write: "session",
    command: "auto",
    team_kickoff: "rules",
    host: "session",
  }),
  resolveDefaultPermissionAxes: () =>
    Promise.resolve({
      file_write: "session",
      command: "auto",
      team_kickoff: "rules",
      host: "session",
    }),
  setConversationPermissionAxes: vi.fn(),
  setComposerDraftAxes: vi.fn(),
  confirmAutoCommandIfNeeded: () => true,
  isIllegalAxes: () => false,
}));
vi.mock("@/components/chat/message-input/useVoiceInput", () => ({
  useVoiceInput: () => ({
    isSupported: false,
    isRecording: false,
    interimText: "",
    duration: 0,
    state: "idle",
    toggle: vi.fn(),
    cancel: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock("@/components/chat/message-input/useComposerDrop", () => ({
  useComposerDrop: () => ({
    dragOver: false,
    dropError: null,
    clearDropError: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    handlePaste: vi.fn(),
  }),
}));

// isGenerating 来自 activeRuntime().isGenerating（非顶层字段），构造完整 runtime 太脆，
// 直接 mock 这个 hook；其余 store 行为（setState / getState）保留真实实现。
const genMock = vi.hoisted(() => ({ value: false }));
const handleSendMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/chat/message-input/useComposerSend", () => ({
  useComposerSend: () => ({ handleSend: handleSendMock }),
}));
vi.mock("@/components/chat/message-input/useMentionMenu", () => ({
  useMentionMenu: () => ({
    menuMode: null,
    sections: [],
    flatItems: [],
    items: [],
    activeIndex: 0,
    indexLoading: false,
    menuError: null,
    query: "",
    sourceCount: 0,
    indexLoadedRef: { current: true },
    searchInputRef: { current: null },
    closeMenu: vi.fn(),
    syncMention: vi.fn(),
    handleMenuNavKey: () => false,
    attachEntry: vi.fn(),
    selectItem: vi.fn(),
    setActiveIndex: vi.fn(),
    setQuery: vi.fn(),
    handleAddRoot: vi.fn(),
    pickLocalFile: vi.fn(),
  }),
}));

vi.mock("@/stores/conversation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/conversation")>();
  return { ...actual, useActiveGenerating: () => genMock.value };
});

import { useConversationStore } from "@/stores/conversation";
import { useServerHealthStore } from "@/stores/serverHealth";
import { TurnComposer } from "../TurnComposer";

function renderComposer(variant?: "card" | "bar") {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <TurnComposer variant={variant} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  genMock.value = false;
  handleSendMock.mockClear();
  useConversationStore.setState({
    currentConversationId: null,
    byId: {},
  } as never);
  useServerHealthStore.setState({
    status: "online",
    reason: null,
    justRecovered: false,
  });
  const { useComposerDraftStore } = await import("@/stores/composer");
  useComposerDraftStore.getState().setValue("__draft__", "");
  useComposerDraftStore.getState().setAttachments("__draft__", []);
});

afterEach(cleanup);

function expectWorkspaceBeforeModel(root: ParentNode = document) {
  const workspace = screen.getByLabelText("在哪工作");
  const model = screen.getByLabelText(/模型组合：/);
  const nodes = root.querySelectorAll("button, [aria-label]");
  const order = [...nodes];
  expect(order.indexOf(workspace)).toBeGreaterThanOrEqual(0);
  expect(order.indexOf(model)).toBeGreaterThan(order.indexOf(workspace));
}

describe("TurnComposer variants", () => {
  it("defaults to card: workspace then model in left cluster, no「更多」", () => {
    const { container } = renderComposer();
    expect(
      container.querySelector('[data-composer-variant="card"]'),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更多选项" })).toBeNull();
    expect(screen.getByLabelText("在哪工作")).toBeTruthy();
    expect(screen.getByLabelText(/模型组合：/)).toBeTruthy();
    expect(screen.getByLabelText(/权限：/)).toBeTruthy();
    expect(screen.getByLabelText("附加文件")).toBeTruthy();
    expectWorkspaceBeforeModel(container);
  });

  it("bar: 「更多选项」收纳左簇；未打开时不占常显", () => {
    renderComposer("bar");
    expect(
      document.querySelector('[data-composer-variant="bar"]'),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "更多选项" })).toBeTruthy();
    // 收纳前：工作区 / 模型 / 附件不在常显条上
    expect(screen.queryByLabelText("在哪工作")).toBeNull();
    expect(screen.queryByLabelText(/模型组合：/)).toBeNull();
    expect(screen.queryByLabelText("附加文件")).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "更多选项" }));
    const menu = screen.getByTestId("composer-plus-menu");
    expect(menu).toBeTruthy();
    expect(screen.getByLabelText("在哪工作")).toBeTruthy();
    expect(screen.getByLabelText(/模型组合：/)).toBeTruthy();
    expect(screen.getByLabelText(/权限：/)).toBeTruthy();
    expect(screen.getByLabelText("附加文件")).toBeTruthy();
    // 菜单内附件带可见文案（非整栏 icon-only）
    expect(within(menu).getByText("附加文件")).toBeTruthy();
    expect(menu.className).not.toMatch(/\bw-72\b/);
    expectWorkspaceBeforeModel(menu);
    expect(within(menu).queryByText("后台云端")).toBeNull();
    expect(within(menu).queryByRole("button", { name: /后台云端/ })).toBeNull();
  });

  it("N4-A: offline hard-disables 发送 even with draft text", async () => {
    useServerHealthStore.setState({
      status: "offline",
      reason: "unreachable",
      justRecovered: false,
    });
    const { useComposerDraftStore } = await import("@/stores/composer");
    useComposerDraftStore.getState().setValue("__draft__", "hello offline");
    renderComposer("bar");
    const send = screen.getByRole("button", { name: "发送" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(/可浏览已缓存的对话与本机文件（只读）/),
    ).toBeTruthy();
  });

  it("generating + empty: bar shows only 停止生成 (no mid-flight send)", () => {
    genMock.value = true;
    renderComposer("bar");
    expect(screen.queryByRole("button", { name: "插入" })).toBeNull();
    expect(screen.queryByRole("button", { name: "排队发送" })).toBeNull();
    expect(screen.queryByRole("button", { name: "插队" })).toBeNull();
    expect(screen.getByRole("button", { name: "停止生成" })).toBeTruthy();
  });

  it("generating + draft: primary 排队发送 covers 停止生成, with 插队 entry", async () => {
    genMock.value = true;
    const { useComposerDraftStore } = await import("@/stores/composer");
    useComposerDraftStore.getState().setValue("__draft__", "下一句");
    renderComposer("bar");
    expect(screen.getByRole("button", { name: "排队发送" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "插队" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "插入" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "插队" }));
    expect(handleSendMock).toHaveBeenCalledWith({ delivery: "steer" });

    handleSendMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "排队发送" }));
    expect(handleSendMock).toHaveBeenCalledWith();
  });

  it("generating + draft: canvas card also shows 排队发送 + 插队", async () => {
    genMock.value = true;
    const { useComposerDraftStore } = await import("@/stores/composer");
    useComposerDraftStore.getState().setValue("__draft__", "下一句");
    renderComposer();
    expect(screen.getByRole("button", { name: "排队发送" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "插队" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull();
  });

  it("generating + draft: Ctrl/Cmd+Enter forces steer", async () => {
    genMock.value = true;
    const { useComposerDraftStore } = await import("@/stores/composer");
    useComposerDraftStore.getState().setValue("__draft__", "插一句");
    renderComposer("bar");
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(handleSendMock).toHaveBeenCalledWith({ delivery: "steer" });
  });

  it("idle: Ctrl/Cmd+Enter matches Enter (no fake queue)", async () => {
    const { useComposerDraftStore } = await import("@/stores/composer");
    useComposerDraftStore.getState().setValue("__draft__", "hello");
    renderComposer("bar");
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(handleSendMock).toHaveBeenCalledWith();
  });

  it("idle: single 发送, no mid-flight / 停止", () => {
    renderComposer("bar");
    expect(screen.queryByRole("button", { name: "插入" })).toBeNull();
    expect(screen.queryByRole("button", { name: "排队发送" })).toBeNull();
    expect(screen.queryByRole("button", { name: "插队" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  });

  it("idle: attachment-only draft enables 发送 (empty text)", async () => {
    const { useComposerDraftStore } = await import("@/stores/composer");
    useComposerDraftStore.getState().setValue("__draft__", "");
    useComposerDraftStore.getState().setAttachments("__draft__", [
      {
        id: "a1",
        key: "file:local:pic.png",
        name: "pic.png",
        path: "pic.png",
        text: "",
        truncated: false,
        kind: "file",
        binary: true,
        workspacePath: "attachments/pic.png",
      },
    ]);
    renderComposer("bar");
    const send = screen.getByRole("button", { name: "发送" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    expect(handleSendMock).toHaveBeenCalledWith();
  });

  it("idle: empty text and no attachments keeps 发送 disabled", () => {
    renderComposer("bar");
    const send = screen.getByRole("button", { name: "发送" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });
});
