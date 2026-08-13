import { FileArtifactsCard } from "@/components/chat/FileArtifactsCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FileSource } from "@/lib/fileSource";
import { conversationKeys, workspaceKeys } from "@/lib/queryKeys";
import type { FolderMeta } from "@/services/folders";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment jsdom
import {
  type RenderResult,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ReactElement, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

function renderCard(
  ui: ReactElement,
  folders: FolderMeta[] = [],
): RenderResult {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  // TurnFileChangesReview → useConversationWorkspace → useWorkspaces
  client.setQueryData(workspaceKeys.list, []);
  // AutoFolderNoticeLine → useFolders 读 /grouped 的 folders 半边
  client.setQueryData(conversationKeys.grouped, { folders, conversations: [] });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const { showFile, showChanges, openInAppPreview, openWorkspaceHtmlInBrowser } =
  vi.hoisted(() => ({
    showFile: vi.fn(),
    showChanges: vi.fn(),
    openInAppPreview: vi.fn(),
    openWorkspaceHtmlInBrowser: vi.fn(),
  }));

vi.mock("@/stores/disclosure", () => ({
  usePersistentDisclosure: (_key: string | null, initial: boolean) =>
    useState(initial),
}));

vi.mock("@/stores/sidePanel", () => ({
  useSidePanelStore: (
    sel: (s: { showFile: () => void; showChanges: () => void }) => unknown,
  ) => sel({ showFile, showChanges }),
}));

vi.mock("@/hooks/useFileAudit", () => ({
  useFileAudit: () => ({ status: "idle" as const }),
}));

// 能力判定与对话侧栏同一套：卡直接问 useConversationFileSource 挂没挂 openInAppPreview。
vi.mock("@/hooks/useConversationFileSource", () => ({
  useConversationFileSource: vi.fn(() => null),
}));
vi.mock("@/hooks/useWorkspaces", () => ({
  useConversationWorkspace: vi.fn(() => null),
}));
vi.mock("@/lib/openWorkspaceHtmlInBrowser", () => ({
  openWorkspaceHtmlInBrowser,
}));

import { useConversationFileSource } from "@/hooks/useConversationFileSource";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import type { WorkspaceInfo } from "@/services/workspaces";

const sourceWithPreview = {
  openInAppPreview,
} as unknown as FileSource;

const sessionWs: WorkspaceInfo = {
  wsId: "folder:proj",
  name: "项目",
  location: "cloud",
  rootId: null,
  subpath: "",
  hasFiles: true,
};

describe("FileArtifactsCard acceptance labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConversationFileSource).mockReturnValue(null);
    vi.mocked(useConversationWorkspace).mockReturnValue(null);
  });

  it("shows 已验收/未通过 and never 写入/编辑 on acceptance rows", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[
          {
            path: "ok.md",
            name: "ok.md",
            acceptance: "accepted",
          },
          {
            path: "bad.md",
            name: "bad.md",
            acceptance: "rejected",
            acceptanceReason: "citations_unverified",
            acceptanceDetail: "缺引用",
          },
        ]}
      />,
    );
    expect(screen.getByText("已验收")).toBeTruthy();
    expect(screen.getByText("未通过")).toBeTruthy();
    expect(screen.queryByText("写入")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
  });

  it("write/edit tool rows omit op badges", () => {
    renderCard(
      <FileArtifactsCard
        artifacts={[
          { path: "src/main.ts", name: "main.ts", op: "write" },
          {
            path: "src/a.ts",
            name: "a.ts",
            op: "edit",
            change: { kind: "edit", oldText: "a", newText: "b" },
          },
        ]}
      />,
    );
    expect(screen.queryByText("写入")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
  });
});

describe("FileArtifactsCard 导出件主推 / 中间稿折叠", () => {
  const md = "抚养费起诉状-昝雯.md";
  const docx = "抚养费起诉状-昝雯.docx";
  const exported = [
    { path: md, name: md, acceptance: "accepted" as const, kind: "md" },
    {
      path: docx,
      name: docx,
      acceptance: "accepted" as const,
      kind: "docx",
      derivedFrom: md,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConversationFileSource).mockReturnValue(null);
    vi.mocked(useConversationWorkspace).mockReturnValue(null);
  });

  it("Word 直接可点，源 md 收进中间稿折叠区（计数仍是 2）", () => {
    renderCard(<FileArtifactsCard conversationId="c1" artifacts={exported} />);

    expect(screen.getByTitle(`在工作区预览 ${docx}`)).toBeTruthy();
    expect(screen.queryByTitle(`在工作区预览 ${md}`)).toBeNull();
    expect(screen.getByText("中间稿 1 份")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("折叠 ≠ 删除：展开中间稿仍能打开源 md", () => {
    renderCard(<FileArtifactsCard conversationId="c1" artifacts={exported} />);

    fireEvent.click(screen.getByText("中间稿 1 份"));
    fireEvent.click(screen.getByTitle(`在工作区预览 ${md}`));
    expect(showFile).toHaveBeenCalledWith(md, md, undefined);
  });

  it("没自报派生关系：两份并列，无中间稿区", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[
          { path: "报告.md", name: "报告.md", acceptance: "accepted" },
          { path: "报告.docx", name: "报告.docx", acceptance: "accepted" },
        ]}
      />,
    );
    expect(screen.getByTitle("在工作区预览 报告.md")).toBeTruthy();
    expect(screen.getByTitle("在工作区预览 报告.docx")).toBeTruthy();
    expect(screen.queryByText(/中间稿/)).toBeNull();
  });
});

describe("FileArtifactsCard stage labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConversationFileSource).mockReturnValue(null);
    vi.mocked(useConversationWorkspace).mockReturnValue(null);
  });

  it("AgentCore/文档/research/debate 路径显示约定文档标签，普通路径零噪音", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[
          {
            path: "AgentCore/文档/research/brief.md",
            name: "brief.md",
            op: "write",
          },
          {
            path: "AgentCore/文档/debate/round.md",
            name: "round.md",
            op: "write",
          },
          { path: "src/main.ts", name: "main.ts", op: "write" },
        ]}
      />,
    );
    expect(screen.getByText("调研约定文档")).toBeTruthy();
    expect(screen.getByText("辩论产物")).toBeTruthy();
    expect(
      screen.getByTitle(
        "在文件页查看约定文档 AgentCore/文档/research/brief.md",
      ),
    ).toBeTruthy();
    expect(screen.getByTitle("在工作区预览 src/main.ts")).toBeTruthy();
    // 普通文件不应出现约定文档标签（仅两处约定标签）
    expect(screen.getAllByText(/约定文档|产物/).length).toBe(2);
  });
});

describe("FileArtifactsCard — HTML 产物直达完整预览", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConversationFileSource).mockReturnValue(null);
    vi.mocked(useConversationWorkspace).mockReturnValue(null);
  });

  it("会话具备完整预览能力：点 HTML 行直达完整预览 tab，非 HTML 仍走 showFile", () => {
    vi.mocked(useConversationFileSource).mockReturnValue(sourceWithPreview);
    vi.mocked(useConversationWorkspace).mockReturnValue(sessionWs);
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[
          { path: "site/index.html", name: "index.html", op: "write" },
          { path: "data.csv", name: "data.csv", op: "write" },
        ]}
      />,
    );

    fireEvent.click(screen.getByTitle("打开完整预览 site/index.html"));
    expect(openWorkspaceHtmlInBrowser).toHaveBeenCalledWith(
      "c1",
      "site/index.html",
      "folder:proj",
    );
    expect(showFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("在工作区预览 data.csv"));
    expect(showFile).toHaveBeenCalledWith("data.csv", "data.csv", undefined);
    expect(openWorkspaceHtmlInBrowser).toHaveBeenCalledOnce();
  });

  it("artifact.workspaceId 优先于会话工作区 desk", () => {
    vi.mocked(useConversationFileSource).mockReturnValue(sourceWithPreview);
    vi.mocked(useConversationWorkspace).mockReturnValue(sessionWs);
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[
          {
            path: "site/index.html",
            name: "index.html",
            acceptance: "accepted",
            workspaceId: "folder:other",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByTitle("打开完整预览 site/index.html"));
    expect(openWorkspaceHtmlInBrowser).toHaveBeenCalledWith(
      "c1",
      "site/index.html",
      "folder:other",
    );
  });

  it("非 HTML 产物带 workspaceId 时 showFile 跟落地桌；无则回退会话桌", () => {
    vi.mocked(useConversationFileSource).mockReturnValue(sourceWithPreview);
    vi.mocked(useConversationWorkspace).mockReturnValue(sessionWs);
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[
          {
            path: "notes.md",
            name: "notes.md",
            op: "write",
            workspaceId: "folder:landed",
          },
          { path: "readme.md", name: "readme.md", op: "write" },
        ]}
      />,
    );

    fireEvent.click(screen.getByTitle("在工作区预览 notes.md"));
    expect(showFile).toHaveBeenCalledWith(
      "notes.md",
      "notes.md",
      "folder:landed",
    );

    fireEvent.click(screen.getByTitle("在工作区预览 readme.md"));
    expect(showFile).toHaveBeenCalledWith("readme.md", "readme.md", undefined);
  });

  it("无能力（本地会话 / web）：HTML 行回落 showFile 进文件视图", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[
          { path: "site/index.html", name: "index.html", op: "write" },
        ]}
      />,
    );

    fireEvent.click(screen.getByTitle("在工作区预览 site/index.html"));
    expect(showFile).toHaveBeenCalledWith(
      "site/index.html",
      "index.html",
      undefined,
    );
    expect(openWorkspaceHtmlInBrowser).not.toHaveBeenCalled();
  });
});

describe("FileArtifactsCard — A1 查看改动", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConversationFileSource).mockReturnValue(null);
    vi.mocked(useConversationWorkspace).mockReturnValue(null);
  });

  it("有 change 预览时显示「查看改动」，点击聚焦右坞改动 tab", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        turnKey="msg-1"
        artifacts={[
          {
            path: "src/a.ts",
            name: "a.ts",
            op: "edit",
            change: { kind: "edit", oldText: "a", newText: "b" },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText("查看改动"));
    expect(showChanges).toHaveBeenCalledWith("msg-1");
    expect(screen.queryByText(/改动已写入工作区/)).toBeNull();
  });

  it("无 change 预览时不显示「查看改动」", () => {
    renderCard(
      <FileArtifactsCard
        artifacts={[{ path: "src/a.ts", name: "a.ts", op: "write" }]}
      />,
    );
    expect(screen.queryByLabelText("查看改动")).toBeNull();
  });
});

describe("FileArtifactsCard — 成品 / 过程材料分组", () => {
  const WORKROOM = "AgentCore/文档/工作稿";
  const product = {
    path: "起诉状.docx",
    name: "起诉状.docx",
    acceptance: "accepted" as const,
    promotedFrom: `${WORKROOM}/起诉状.docx`,
  };
  const material = {
    path: `${WORKROOM}/取证清单.md`,
    name: "取证清单.md",
    acceptance: "accepted" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConversationFileSource).mockReturnValue(null);
    vi.mocked(useConversationWorkspace).mockReturnValue(null);
  });

  it("有成品：成品组在前显示归位后的路径，其余已验收退到过程材料组", () => {
    renderCard(
      <FileArtifactsCard conversationId="c1" artifacts={[material, product]} />,
    );

    const productHeader = screen.getByText("成品");
    const materialHeader = screen.getByText("过程材料");
    // 成品在前、过程材料在后（与文件页「AI 工作间」排同级最后同一心智）。
    expect(
      productHeader.compareDocumentPosition(materialHeader) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // 归位是移动：只显示新路径，AI 工作间里的旧路径已失效。
    const productRow = screen.getByTitle("在工作区预览 起诉状.docx");
    expect(
      screen.queryByTitle(`在工作区预览 ${WORKROOM}/起诉状.docx`),
    ).toBeNull();
    fireEvent.click(productRow);
    expect(showFile).toHaveBeenCalledWith(
      "起诉状.docx",
      "起诉状.docx",
      undefined,
    );

    // 两组各自成列，过程材料不混进成品。
    const materialRow = screen.getByTitle(
      `在工作区预览 ${WORKROOM}/取证清单.md`,
    );
    expect(productRow.closest("ul")).not.toBe(materialRow.closest("ul"));
  });

  it("零归位：不渲染成品组，其余照常——中间幕是合法状态，不加提示语", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[material, { ...product, promotedFrom: undefined }]}
      />,
    );

    expect(screen.queryByText("成品")).toBeNull();
    expect(screen.getByText("过程材料")).toBeTruthy();
    expect(screen.getByTitle("在工作区预览 起诉状.docx")).toBeTruthy();
    expect(
      screen.getByTitle(`在工作区预览 ${WORKROOM}/取证清单.md`),
    ).toBeTruthy();
    expect(screen.queryByText(/未归位|尚未|无成品|本轮没有/)).toBeNull();
  });

  it("未通过维持现状：不进成品组，也不混进过程材料组", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[
          product,
          material,
          {
            path: "报告.md",
            name: "报告.md",
            acceptance: "rejected" as const,
            acceptanceDetail: "缺引用",
          },
        ]}
      />,
    );

    expect(screen.getByText("未通过")).toBeTruthy();
    const rejectedList = screen
      .getByTitle("在工作区预览 报告.md")
      .closest("ul");
    expect(rejectedList).not.toBe(
      screen.getByTitle("在工作区预览 起诉状.docx").closest("ul"),
    );
    expect(rejectedList).not.toBe(
      screen.getByTitle(`在工作区预览 ${WORKROOM}/取证清单.md`).closest("ul"),
    );
  });
});

describe("FileArtifactsCard — 裸聊落点告知并进卡头", () => {
  const autoFolder = { folderId: "f-auto", name: "季度复盘" };
  const autoFolderMeta: FolderMeta = {
    id: "f-auto",
    name: "季度复盘",
    mode: "cloud",
    localRootId: null,
    localSubpath: null,
    relPath: "季度复盘",
    parentRelPath: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useConversationFileSource).mockReturnValue(null);
    vi.mocked(useConversationWorkspace).mockReturnValue(null);
  });

  it("给了 autoFolder：落点在卡头，排在文件行之前", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        turnKey="msg-1"
        autoFolder={autoFolder}
        artifacts={[{ path: "notes.md", name: "notes.md", op: "write" }]}
      />,
      [autoFolderMeta],
    );

    const notice = screen.getByTestId("auto-folder-notice");
    const fileRow = screen.getByTitle("在工作区预览 notes.md");
    expect(
      notice.compareDocumentPosition(fileRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("清单收起后落点仍在（收起文件也得看得见文件去哪了）", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        turnKey="msg-1"
        autoFolder={autoFolder}
        artifacts={[{ path: "notes.md", name: "notes.md", op: "write" }]}
      />,
      [autoFolderMeta],
    );

    fireEvent.click(screen.getByText("本回合产出文件"));
    expect(screen.queryByTitle("在工作区预览 notes.md")).toBeNull();
    expect(screen.getByTestId("auto-folder-notice")).toBeTruthy();
  });

  it("没建桌的普通回合零噪音", () => {
    renderCard(
      <FileArtifactsCard
        conversationId="c1"
        artifacts={[{ path: "notes.md", name: "notes.md", op: "write" }]}
      />,
    );
    expect(screen.queryByTestId("auto-folder-notice")).toBeNull();
  });
});
