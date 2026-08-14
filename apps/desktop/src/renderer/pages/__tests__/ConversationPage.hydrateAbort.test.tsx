// @vitest-environment jsdom
/**
 * 页 AbortSignal 只取消该 effect 的窗 GET：cleanup 先 cancelled 再 abort，
 * overlay 只认 cancelled —— 切走不得把第二条对话打成「加载失败」。
 */
import { useConversationStore } from "@/stores/conversation";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMessageWindow =
  vi.fn<typeof import("@/services/messages").fetchMessageWindow>();
const loadLatestWindow = vi.fn<
  typeof import("@/services/messages").loadLatestWindow
>(async () => true);
const jumpToMessage = vi.fn<typeof import("@/services/messages").jumpToMessage>(
  async () => {},
);
const scheduleHydrateAttachSettle =
  vi.fn<typeof import("@/services/turns").scheduleHydrateAttachSettle>();
const syncConversationFollow =
  vi.fn<
    typeof import("@/services/turns/conversationFollow").syncConversationFollow
  >();
const loadRecovery = vi.fn<typeof import("@/services/resume").loadRecovery>(
  async () => ({
    sidecarLive: false,
    cloudLive: false,
    cloudKnown: true,
    pausedCount: 0,
    unsynced: [],
  }),
);
const loadCachedConversation = vi.fn<
  typeof import("@/services/offlineCache").loadCachedConversation
>(async () => null);

vi.mock("@/components/chat/ChatView", () => ({ ChatView: () => null }));
vi.mock("@/components/graph/ConversationCanvas", () => ({
  ConversationCanvas: () => null,
}));
vi.mock("@/components/layout/SidePanel", () => ({ SidePanel: () => null }));
vi.mock("@/components/layout/SidePanelToggle", () => ({
  SidePanelToggle: () => null,
}));
vi.mock("@/services/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/messages")>();
  return {
    ...actual,
    fetchMessageWindow: (
      ...args: Parameters<typeof actual.fetchMessageWindow>
    ) => fetchMessageWindow(...args),
    loadLatestWindow: (...args: Parameters<typeof actual.loadLatestWindow>) =>
      loadLatestWindow(...args),
    jumpToMessage: (...args: Parameters<typeof actual.jumpToMessage>) =>
      jumpToMessage(...args),
  };
});
vi.mock("@/services/resume", () => ({
  loadRecovery: (
    ...args: Parameters<typeof import("@/services/resume").loadRecovery>
  ) => loadRecovery(...args),
}));
vi.mock("@/services/offlineCache", () => ({
  loadCachedConversation: (
    ...args: Parameters<
      typeof import("@/services/offlineCache").loadCachedConversation
    >
  ) => loadCachedConversation(...args),
  persistOpenedCache: vi.fn(async () => {}),
}));
vi.mock("@/services/turns", () => ({
  scheduleHydrateAttachSettle: (
    ...args: Parameters<
      typeof import("@/services/turns").scheduleHydrateAttachSettle
    >
  ) => scheduleHydrateAttachSettle(...args),
}));
vi.mock("@/services/turns/conversationFollow", () => ({
  syncConversationFollow: (
    ...args: Parameters<typeof syncConversationFollow>
  ) => syncConversationFollow(...args),
  stopAllConversationFollows: vi.fn(),
}));
vi.mock("@/stores/bookmarks", () => ({
  useBookmarkStore: Object.assign(
    (sel: (s: { hydrateForConversation: () => void }) => unknown) =>
      sel({ hydrateForConversation: () => {} }),
    { getState: () => ({ hydrateForConversation: () => {} }) },
  ),
}));
vi.mock("@/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/lib/detachLocalBrowserHost", () => ({
  detachLocalBrowserHost: vi.fn().mockResolvedValue(undefined),
}));

import { ConversationPage } from "../ConversationPage";

function hangUntilAborted(
  ...[_id, _query, signal]: Parameters<
    typeof import("@/services/messages").fetchMessageWindow
  >
): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener("abort", fail, { once: true });
  });
}

function Harness({ initial }: { initial: string }) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/c/:id" element={<ConversationPage />} />
      </Routes>
      <Switcher />
    </MemoryRouter>
  );
}

function Switcher() {
  const navigate = useNavigate();
  useEffect(() => {
    const t = window.setTimeout(() => navigate("/c/conv-b"), 20);
    return () => window.clearTimeout(t);
  }, [navigate]);
  return null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useConversationStore.setState({ currentConversationId: null, byId: {} });
});

describe("ConversationPage hydrate abort", () => {
  beforeEach(() => {
    fetchMessageWindow.mockImplementation(hangUntilAborted);
    useConversationStore.setState({ currentConversationId: null, byId: {} });
  });

  it("cancelled abort does not paint 对话加载失败 on the next conversation", async () => {
    render(<Harness initial="/c/conv-a" />);
    expect(await screen.findByLabelText("正在加载对话")).toBeTruthy();

    await waitFor(() => {
      expect(syncConversationFollow).toHaveBeenCalledWith(null);
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("对话加载失败")).toBeNull();
    expect(await screen.findByLabelText("正在加载对话")).toBeTruthy();
  });
});
