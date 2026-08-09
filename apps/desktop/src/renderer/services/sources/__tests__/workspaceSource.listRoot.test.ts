// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { listWorkspaceFiles, wsListFiles } = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  wsListFiles: vi.fn(),
}));

vi.mock("@/hooks/useConversations", () => ({
  getConversations: vi.fn(() => []),
}));
vi.mock("@/services/sidecarRouting", () => ({
  resolveConversationLocalTarget: vi.fn(),
}));
vi.mock("@/services/workspace", () => ({
  listWorkspaceFiles,
  readWorkspaceFile: vi.fn(),
  readWorkspaceFileForEdit: vi.fn(),
  writeWorkspaceFileText: vi.fn(),
  uploadWorkspaceFile: vi.fn(),
  createWorkspaceDir: vi.fn(),
  moveWorkspaceFile: vi.fn(),
  deleteWorkspaceFile: vi.fn(),
  downloadWorkspaceFile: vi.fn(),
  exportWorkspaceMdToDocx: vi.fn(),
  openWorkspaceInBrowser: vi.fn(),
}));
vi.mock("@/services/workspaces", () => ({
  wsListFiles,
  wsReadFile: vi.fn(),
  wsReadFileForEdit: vi.fn(),
  wsWriteFileText: vi.fn(),
  wsUploadFile: vi.fn(),
  wsCreateDir: vi.fn(),
  wsMoveFile: vi.fn(),
  wsDeleteFile: vi.fn(),
  wsDownloadFile: vi.fn(),
  wsExportMdToDocx: vi.fn(),
  wsListFileIndex: vi.fn(async () => []),
}));
vi.mock("@/lib/openWorkspaceHtmlInBrowser", () => ({
  openWorkspaceHtmlInBrowser: vi.fn(),
}));
vi.mock("@/lib/capabilities", () => ({
  hasInAppPreview: () => false,
}));

import {
  createCloudWorkspaceSource,
  createWorkspaceSource,
} from "@/services/sources/workspaceSource";

describe("cloud FileSource listing (fc35aece root zip visibility)", () => {
  afterEach(() => {
    listWorkspaceFiles.mockReset();
    wsListFiles.mockReset();
  });

  it("root listDir uses non-recursive list so AI zip is not dropped by recursive cap", async () => {
    listWorkspaceFiles.mockImplementation(
      async (_id: string, recursive: boolean) => {
        if (recursive) {
          // Simulate server alphabetical 100-cap: only site/* survives, root zip gone.
          return Array.from({ length: 100 }, (_, i) => ({
            path: `site/f${String(i).padStart(3, "0")}.html`,
            isDir: false,
          }));
        }
        return [
          { path: "site", isDir: true },
          { path: "独立站整改.zip", isDir: false },
        ];
      },
    );

    const source = createWorkspaceSource("c1");
    expect(source.listTree).toBeUndefined();

    const root = await source.listDir("");
    expect(listWorkspaceFiles).toHaveBeenCalledWith("c1", false);
    expect(root.map((n) => n.path).sort()).toEqual(["site", "独立站整改.zip"]);
  });

  it("subdir listDir still uses recursive + one-level filter", async () => {
    wsListFiles.mockResolvedValue([
      { path: "site", isDir: true },
      { path: "site/index.html", isDir: false },
      { path: "site/a.css", isDir: false },
      { path: "pack.zip", isDir: false },
    ]);

    const source = createCloudWorkspaceSource("conv:c1", "工作区");
    const kids = await source.listDir("site");
    expect(wsListFiles).toHaveBeenCalledWith("conv:c1", true);
    expect(kids.map((n) => n.path).sort()).toEqual([
      "site/a.css",
      "site/index.html",
    ]);
  });

  it("AgentCore expand hides path-aware internal zones; bare index/ stays", async () => {
    wsListFiles.mockResolvedValue([
      { path: "AgentCore", isDir: true },
      { path: "AgentCore/index", isDir: true },
      { path: "AgentCore/trash", isDir: true },
      { path: "AgentCore/baselines", isDir: true },
      { path: "AgentCore/规则", isDir: true },
      { path: "AgentCore/规则/r.md", isDir: false },
      { path: "index", isDir: true },
      { path: "index/user.py", isDir: false },
    ]);

    const source = createCloudWorkspaceSource("conv:c1", "工作区");
    const acKids = await source.listDir("AgentCore");
    expect(acKids.map((n) => n.path).sort()).toEqual(["AgentCore/规则"]);

    // Root path also drops leaked zone entries if a non-recursive payload includes them.
    listWorkspaceFiles.mockResolvedValue([
      { path: "AgentCore", isDir: true },
      { path: "AgentCore/index", isDir: true },
      { path: "index", isDir: true },
    ]);
    const convSource = createWorkspaceSource("c1");
    const rootKids = await convSource.listDir("");
    expect(rootKids.map((n) => n.path).sort()).toEqual(["AgentCore", "index"]);
  });
});
