import { hasInAppPreview } from "@/lib/capabilities";
import { useSidePanelStore } from "@/stores/sidePanel";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWorkspaceDeliverable } from "../openWorkspaceDeliverable";
import { openWorkspaceHtmlInBrowser } from "../openWorkspaceHtmlInBrowser";

const { tryNavigateSeededCsv } = vi.hoisted(() => ({
  tryNavigateSeededCsv: vi.fn(async () => false),
}));

vi.mock("@/lib/capabilities", () => ({
  hasInAppPreview: vi.fn(() => false),
}));

vi.mock("@/lib/openWorkspaceHtmlInBrowser", () => ({
  openWorkspaceHtmlInBrowser: vi.fn(),
}));

vi.mock("@/lib/openSeededCsvTable", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/openSeededCsvTable")>();
  return { ...actual, tryNavigateSeededCsv };
});

vi.mock("@/stores/sidePanel", () => ({
  useSidePanelStore: {
    getState: () => ({ showFile: vi.fn(), openFileTab: vi.fn() }),
  },
}));

const showFile = vi.fn();
const openFileTab = vi.fn();
const preview = vi.mocked(hasInAppPreview);
const openHtml = vi.mocked(openWorkspaceHtmlInBrowser);

describe("openWorkspaceDeliverable", () => {
  beforeEach(() => {
    showFile.mockReset();
    openFileTab.mockReset();
    openHtml.mockReset();
    tryNavigateSeededCsv.mockReset();
    tryNavigateSeededCsv.mockResolvedValue(false);
    preview.mockReturnValue(false);
    vi.mocked(useSidePanelStore).getState = () =>
      ({ showFile, openFileTab }) as never;
  });

  it("opens a markdown path in the File tab", () => {
    openWorkspaceDeliverable("c1", "AgentCore/文档/工作稿/白板PRD.md");
    expect(openFileTab).toHaveBeenCalledWith(
      "AgentCore/文档/工作稿/白板PRD.md",
      "白板PRD.md",
      undefined,
    );
    expect(tryNavigateSeededCsv).not.toHaveBeenCalled();
    expect(openHtml).not.toHaveBeenCalled();
  });

  it("sends HTML to the in-app browser when preview is available", () => {
    preview.mockReturnValue(true);
    openWorkspaceDeliverable("c1", "site/index.html");
    expect(openHtml).toHaveBeenCalledWith("c1", "site/index.html", undefined);
    expect(openFileTab).not.toHaveBeenCalled();
  });

  it("opens an ingested csv as the live table", async () => {
    tryNavigateSeededCsv.mockResolvedValueOnce(true);
    openWorkspaceDeliverable("c1", "客户.csv", "folder:f1");
    await vi.waitFor(() => {
      expect(tryNavigateSeededCsv).toHaveBeenCalledWith({
        path: "客户.csv",
        workspaceId: "folder:f1",
        conversationId: "c1",
      });
    });
    expect(openFileTab).not.toHaveBeenCalled();
  });

  it("falls back to the File tab when the csv is not ingested", async () => {
    openWorkspaceDeliverable("c1", "草稿.csv");
    await vi.waitFor(() => {
      expect(openFileTab).toHaveBeenCalledWith(
        "草稿.csv",
        "草稿.csv",
        undefined,
      );
    });
  });
});
