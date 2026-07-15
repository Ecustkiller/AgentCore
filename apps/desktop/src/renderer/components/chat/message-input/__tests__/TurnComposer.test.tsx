// @vitest-environment jsdom
/**
 * TurnComposer variant smoke: `card` keeps the full toolbar; `bar` collapses
 * extras behind the「更多」entry and exposes `data-composer-variant`.
 */

import { TooltipProvider } from "@/components/ui/tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useLlmKey", () => ({
  useLlmKey: () => ({
    data: {
      configured: true,
      default_model: "deepseek-test",
      supports_tools: true,
    },
    isLoading: false,
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
vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: () => false,
}));
vi.mock("@/services/permissionPreset", () => ({
  PERMISSION_PRESET_LABELS: {
    observe: { short: "观察", description: "只读" },
    workspace: { short: "开工授权", description: "写工作区" },
    full_trust: { short: "完全信任", description: "同权" },
  },
  isPermissionDowngrade: () => false,
  resolveDefaultPermissionPreset: () => Promise.resolve("workspace"),
  setConversationPermissionPreset: vi.fn(),
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
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    handlePaste: vi.fn(),
    disposeDropTimer: vi.fn(),
  }),
}));
vi.mock("@/components/chat/message-input/useComposerSend", () => ({
  useComposerSend: () => ({ handleSend: vi.fn() }),
}));
vi.mock("@/components/chat/message-input/useMentionMenu", () => ({
  useMentionMenu: () => ({
    menuMode: null,
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
    setActiveIndex: vi.fn(),
    setQuery: vi.fn(),
    handleAddRoot: vi.fn(),
    pickLocalFile: vi.fn(),
  }),
}));

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

beforeEach(() => {
  useConversationStore.setState({
    currentConversationId: null,
    byId: {},
    activeGenerating: false,
  } as never);
  useServerHealthStore.setState({
    status: "online",
    reason: null,
    justRecovered: false,
  });
});

afterEach(cleanup);

describe("TurnComposer variants", () => {
  it("defaults to card: toolbar badges visible, no「更多」entry", () => {
    const { container } = renderComposer();
    expect(
      container.querySelector('[data-composer-variant="card"]'),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更多选项" })).toBeNull();
    expect(screen.getByLabelText(/当前模型/)).toBeTruthy();
    expect(screen.getByLabelText("附加本机文件")).toBeTruthy();
  });

  it("bar: single-row chrome with「更多」popover hosting the four extras", async () => {
    const { container } = renderComposer("bar");
    expect(
      container.querySelector('[data-composer-variant="bar"]'),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "更多选项" })).toBeTruthy();
    expect(screen.getByLabelText("附加本机文件")).toBeTruthy();
    // Badges live inside the popover — not in the bar until opened.
    expect(screen.queryByLabelText(/当前模型/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "更多选项" }));
    expect(await screen.findByLabelText(/当前模型/)).toBeTruthy();
    expect(screen.getByLabelText(/权限模式/)).toBeTruthy();
    expect(screen.getByLabelText("在哪工作")).toBeTruthy();
  });

  it("bar: healthy server shows no status red-dot on「更多」", () => {
    renderComposer("bar");
    const more = screen.getByRole("button", { name: "更多选项" });
    expect(more.querySelector(".bg-destructive")).toBeNull();
  });

  it("bar: offline server hangs a destructive red-dot on「更多」", () => {
    useServerHealthStore.setState({
      status: "offline",
      reason: "unreachable",
      justRecovered: false,
    });
    renderComposer("bar");
    const more = screen.getByRole("button", { name: "更多选项" });
    expect(more.querySelector(".bg-destructive")).toBeTruthy();
  });
});
