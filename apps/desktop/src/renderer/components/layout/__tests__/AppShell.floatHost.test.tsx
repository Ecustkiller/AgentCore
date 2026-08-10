// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useConversations", () => ({
  useGroupedConversations: () => undefined,
}));
vi.mock("@/lib/theme", () => ({
  useApplyTheme: () => undefined,
}));
vi.mock("@/lib/capabilities", () => ({
  isWebClient: () => true,
}));
vi.mock("@/services/realtime", () => ({
  startRealtime: vi.fn(),
  stopRealtime: vi.fn(),
}));
vi.mock("@/services/serverHealth", () => ({
  startServerHealthMonitor: () => () => undefined,
}));
vi.mock("@/services/teamActivityNotifications", () => ({
  startTeamActivityNotifications: () => () => undefined,
  startNativeNotificationRouting: () => () => undefined,
}));
vi.mock("@/stores/productNotices", () => ({
  useProductNoticesStore: {
    getState: () => ({ startPolling: () => () => undefined }),
  },
}));
vi.mock("@/stores/standingInbox", () => ({
  useStandingInboxStore: {
    getState: () => ({ startPolling: () => () => undefined }),
  },
}));
vi.mock("@/stores/updates", () => ({
  startUpdates: () => () => undefined,
}));
vi.mock("@/stores/usage", () => ({
  useUsageStore: {
    getState: () => ({ fetchSummary: () => Promise.resolve() }),
  },
}));
vi.mock("@/components/sidebar/Sidebar", () => ({
  Sidebar: () => null,
}));
vi.mock("@/components/layout/TitleBar", () => ({
  TitleBar: () => null,
}));
vi.mock("@/components/layout/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("@/components/layout/ForceUpdateGate", () => ({
  ForceUpdateGate: () => null,
}));
vi.mock("@/components/layout/ProductNoticeBanner", () => ({
  ProductNoticeBanner: () => null,
}));
vi.mock("@/components/layout/ProductNoticeModal", () => ({
  ProductNoticeModal: () => null,
}));
vi.mock("@/components/layout/UpdateAvailableDialog", () => ({
  UpdateAvailableDialog: () => null,
}));
vi.mock("@/components/layout/WorkspaceChannelBanner", () => ({
  WorkspaceChannelBanner: () => null,
}));
vi.mock("@/components/conversation/ShareConversationDialog", () => ({
  ShareConversationDialog: () => null,
}));
vi.mock("@/components/folders/CreateFolderMenu", () => ({
  CreateFolderMenuHost: () => null,
}));
vi.mock("@/components/files/CloneRepoDialog", () => ({
  ConnectGitDialogHost: () => null,
  CloneRepoDialog: () => null,
}));
vi.mock("@/components/files/ImportToCloudDialog", () => ({
  ImportToCloudDialogHost: () => null,
  ImportToCloudDialog: () => null,
}));
vi.mock("@/components/workspace/MergeLandingReview", () => ({
  MergeLandingReviewHost: () => null,
}));
vi.mock("@/components/layout/SidePanelFloatHost", () => ({
  SidePanelFloatHost: () => <div data-testid="side-panel-float-host" />,
}));

import { AppShell } from "@/components/layout/AppShell";

afterEach(() => {
  cleanup();
});

describe("AppShell SidePanelFloatHost mount", () => {
  it("keeps the float host mounted on non-conversation routes", () => {
    render(
      <MemoryRouter initialEntries={["/more"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/more" element={<div>more</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("side-panel-float-host")).toBeTruthy();
    expect(screen.getByText("more")).toBeTruthy();
  });
});
