import { hasInAppPreview } from "@/lib/capabilities";
import { useSidePanelStore } from "@/stores/sidePanel";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openWorkspaceDeliverable } from "../openWorkspaceDeliverable";
import { openWorkspaceHtmlInBrowser } from "../openWorkspaceHtmlInBrowser";

vi.mock("@/lib/capabilities", () => ({
  hasInAppPreview: vi.fn(() => false),
}));

vi.mock("@/lib/openWorkspaceHtmlInBrowser", () => ({
  openWorkspaceHtmlInBrowser: vi.fn(),
}));

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
    expect(openHtml).not.toHaveBeenCalled();
  });

  it("sends HTML to the in-app browser when preview is available", () => {
    preview.mockReturnValue(true);
    openWorkspaceDeliverable("c1", "site/index.html");
    expect(openHtml).toHaveBeenCalledWith("c1", "site/index.html", undefined);
    expect(openFileTab).not.toHaveBeenCalled();
  });

  it("opens csv as a file, never as a table", () => {
    openWorkspaceDeliverable("c1", "客户.csv", "folder:f1");
    expect(openFileTab).toHaveBeenCalledWith(
      "客户.csv",
      "客户.csv",
      "folder:f1",
    );
    openWorkspaceDeliverable("c1", "草稿.csv");
    expect(openFileTab).toHaveBeenCalledWith("草稿.csv", "草稿.csv", undefined);
  });
});
