// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceMode } from "@/components/workspace/WorkspacePanel";
import type { FileSource } from "@/lib/fileSource";
import { useConversationStore } from "@/stores/conversation";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exportCloudDeskToPickedFolder = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true })),
);
const exportCloudDeskZip = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("@/services/cloudDeskExit", () => ({
  exportCloudDeskToPickedFolder,
  exportCloudDeskZip,
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => [{ id: "c1", folderId: "f1" }],
  getConversations: () => [{ id: "c1", folderId: "f1" }],
}));

vi.mock("@/hooks/useConversationFileSource", () => ({
  useConversationFileSource: () =>
    ({
      id: "workspace:cloud",
      label: "云",
      caps: { watch: false, transfer: true, edit: true, snapshots: true },
    }) as FileSource,
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useConversationWorkspace: () => ({
    wsId: "folder:f1",
    name: "proj",
    location: "cloud" as const,
    rootId: null,
    subpath: "",
    hasFiles: true,
  }),
}));

vi.mock("@/lib/capabilities", () => ({
  hasLocalFiles: () => true,
}));

vi.mock("@/components/workspace/FileBrowser", () => ({
  FileBrowser: ({ trailing }: { trailing?: import("react").ReactNode }) => (
    <div>
      {trailing}
      <div data-testid="file-browser" />
    </div>
  ),
}));

vi.mock("@/components/workspace/ExternalMountsSection", () => ({
  ExternalMountsSection: () => null,
}));

vi.mock("@/components/workspace/WorkspaceModeBar", () => ({
  WorkspaceModeBar: () => null,
}));

vi.mock("@/components/workspace/WorkspaceClientTools", () => ({
  WorkspaceClientTools: () => null,
}));

afterEach(cleanup);

describe("WorkspaceMode · 导出菜单", () => {
  beforeEach(() => {
    exportCloudDeskToPickedFolder.mockClear();
    exportCloudDeskZip.mockClear();
    useConversationStore.setState({ currentConversationId: "c1" });
  });

  it("云桌导出菜单点 ZIP", async () => {
    render(
      <TooltipProvider>
        <WorkspaceMode />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.click(screen.getByText("导出 ZIP"));
    await vi.waitFor(() => {
      expect(exportCloudDeskZip).toHaveBeenCalledWith("c1");
    });
  });

  it("云桌导出菜单点到本机文件夹", async () => {
    render(
      <TooltipProvider>
        <WorkspaceMode />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.click(screen.getByText("导出到本机文件夹"));
    await vi.waitFor(() => {
      expect(exportCloudDeskToPickedFolder).toHaveBeenCalledWith("c1");
    });
  });
});
