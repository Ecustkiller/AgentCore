// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileArtifactsCard } from "../FileArtifactsCard";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock("@/api/turnFilesDiff", () => ({
  getTurnFilesDiff: vi.fn().mockResolvedValue({
    messageId: "m1",
    baselineSnapshotId: null,
    available: false,
    changes: [],
    total: 0,
    added: 0,
    modified: 0,
    deleted: 0,
  }),
}));

beforeEach(() => {
  navigate.mockClear();
});

describe("FileArtifactsCard acceptance labels", () => {
  it("shows 已验收/未通过 and never 写入/编辑 on acceptance rows", () => {
    render(
      <MemoryRouter>
        <FileArtifactsCard
          conversationId="c1"
          messageId="m1"
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
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("已验收")).toBeTruthy();
    expect(screen.getByText("未通过")).toBeTruthy();
    expect(screen.queryByText("写入")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
  });

  it("write/edit tool rows omit op badges", () => {
    render(
      <MemoryRouter>
        <FileArtifactsCard
          conversationId="c1"
          messageId="m1"
          artifacts={[
            { path: "src/main.ts", name: "main.ts", op: "write" },
            { path: "src/a.ts", name: "a.ts", op: "edit" },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText("写入")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
  });
});

describe("FileArtifactsCard stage labels", () => {
  it("AgentCore/文档/research/debate 路径显示约定文档标签，普通路径零噪音", () => {
    render(
      <MemoryRouter>
        <FileArtifactsCard
          conversationId="c1"
          messageId="m1"
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
            { path: "notes.txt", name: "notes.txt", op: "write" },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("调研约定文档")).toBeTruthy();
    expect(screen.getByText("辩论产物")).toBeTruthy();
    expect(
      screen.getByTitle(
        "在文件页查看约定文档 AgentCore/文档/research/brief.md",
      ),
    ).toBeTruthy();
    expect(screen.getByTitle("在工作区查看 notes.txt")).toBeTruthy();
  });
});

describe("FileArtifactsCard 查看改动", () => {
  it("shows 查看改动 when conversationId+messageId present and expands review", async () => {
    render(
      <MemoryRouter>
        <FileArtifactsCard
          conversationId="c1"
          messageId="m1"
          artifacts={[
            {
              path: "a.ts",
              name: "a.ts",
              op: "write",
              change: {
                kind: "write",
                content: "x",
                mode: "overwrite",
              },
            },
          ]}
          reviewArtifacts={[
            {
              path: "a.ts",
              name: "a.ts",
              op: "write",
              change: {
                kind: "write",
                content: "x",
                mode: "overwrite",
              },
            },
          ]}
        />
      </MemoryRouter>,
    );
    const btn = screen.getByLabelText("查看改动");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(await screen.findByText(/工具参数侧预览/)).toBeTruthy();
  });

  it("hides 查看改动 without messageId and without change previews", () => {
    render(
      <MemoryRouter>
        <FileArtifactsCard
          conversationId="c1"
          artifacts={[{ path: "a.ts", name: "a.ts", acceptance: "accepted" }]}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("查看改动")).toBeNull();
  });
});

describe("FileArtifactsCard open routing", () => {
  it("opens conversation files when no workspaceId", () => {
    render(
      <MemoryRouter>
        <FileArtifactsCard
          conversationId="c1"
          artifacts={[
            { path: "notes.md", name: "notes.md", acceptance: "accepted" },
          ]}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTitle("在工作区查看 notes.md"));
    expect(navigate).toHaveBeenCalledWith("/c/c1/files", {
      state: { openPath: "notes.md" },
    });
  });

  it("opens workspace files desk when workspaceId is set", () => {
    render(
      <MemoryRouter>
        <FileArtifactsCard
          conversationId="c1"
          artifacts={[
            {
              path: "version-a-clean.html",
              name: "version-a-clean.html",
              acceptance: "accepted",
              workspaceId: "folder:proj-1",
            },
          ]}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTitle("在工作区查看 version-a-clean.html"));
    expect(navigate).toHaveBeenCalledWith(
      `/files/${encodeURIComponent("folder:proj-1")}`,
      {
        state: {
          openPath: "version-a-clean.html",
          name: "version-a-clean.html",
          fromConversationId: "c1",
        },
      },
    );
  });
});
