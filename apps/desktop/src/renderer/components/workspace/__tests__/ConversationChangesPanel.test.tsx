import { ConversationChangesPanel } from "@/components/workspace/ConversationChangesPanel";
import type { WorkspaceVersion } from "@/services/localWorkspaceVersions";
import type { WorkspaceSnapshot } from "@/services/workspace";
import type { WorkspaceInfo } from "@/services/workspaces";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import type { Message } from "@/stores/conversation/types";
import { useExecutionStore } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useLocalTurnBaselineIds } = vi.hoisted(() => ({
  useLocalTurnBaselineIds: vi.fn((): ReadonlySet<string> => new Set()),
}));

const { useConversationWorkspace } = vi.hoisted(() => ({
  useConversationWorkspace: vi.fn((): WorkspaceInfo | null => null),
}));

const { hasLocalFiles } = vi.hoisted(() => ({
  hasLocalFiles: vi.fn(() => false),
}));

const { createSnapshot, listSnapshots, restoreSnapshot, downloadSnapshot } =
  vi.hoisted(() => ({
    createSnapshot: vi.fn(async () => ({}) as WorkspaceSnapshot),
    listSnapshots: vi.fn(async (): Promise<WorkspaceSnapshot[]> => []),
    restoreSnapshot: vi.fn(async () => undefined),
    downloadSnapshot: vi.fn(async () => undefined),
  }));

const {
  createLocalVersion,
  deleteLocalVersion,
  listLocalVersions,
  restoreLocalVersion,
} = vi.hoisted(() => ({
  createLocalVersion: vi.fn(async () => ({}) as WorkspaceVersion),
  deleteLocalVersion: vi.fn(async () => undefined),
  listLocalVersions: vi.fn(async (): Promise<WorkspaceVersion[]> => []),
  restoreLocalVersion: vi.fn(async () => ({}) as WorkspaceVersion),
}));

vi.mock("@/hooks/useLocalTurnBaselineIds", () => ({
  useLocalTurnBaselineIds,
}));

vi.mock("@/hooks/useGitRepoStatus", () => ({
  useGitRepoStatus: () => ({ status: null, refresh: vi.fn() }),
}));

vi.mock("@/components/workspace/WorkspaceModeControl", () => ({
  useWorkspaceModeState: () => null,
}));

vi.mock("@/hooks/useWorkspaces", () => ({ useConversationWorkspace }));

vi.mock("@/lib/capabilities", () => ({ hasLocalFiles }));

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn(),
  notifyActionError: vi.fn(),
}));

vi.mock("@/services/workspace", () => ({
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  downloadSnapshot,
}));

vi.mock("@/services/localWorkspaceVersions", () => ({
  createLocalVersion,
  deleteLocalVersion,
  listLocalVersions,
  restoreLocalVersion,
}));

vi.mock("@/components/chat/TurnFileChangesReview", () => ({
  TurnFileChangesReview: ({
    messageId,
    artifacts,
  }: {
    messageId?: string | null;
    artifacts: unknown[];
  }) => (
    <div data-testid={`review-${messageId}`}>artifacts:{artifacts.length}</div>
  ),
}));

function assistant(id: string, at: string, content = "ok"): Message {
  return {
    id,
    role: "assistant",
    content,
    createdAt: at,
    executionId: null,
    isStreaming: false,
  };
}

function snapshot(
  snapshotId: string,
  label: string | null,
  createdAt: string,
): WorkspaceSnapshot {
  return { snapshotId, label, createdAt, sizeBytes: 2048 };
}

function localVersion(
  versionId: string,
  name: string,
  createdAt: string,
): WorkspaceVersion {
  return { versionId, name, createdAt, sizeBytes: 4096 };
}

/** 本机工作区：绑定授权根 + 根内子路径（版本区就落在这个子树下）。 */
const LOCAL_WORKSPACE: WorkspaceInfo = {
  wsId: "folder:f1",
  name: "项目 A",
  location: "local",
  rootId: "root-1",
  subpath: "projects/a",
  hasFiles: true,
};

/** Entry kinds top-to-bottom as rendered by the timeline. */
function renderedKinds(): string[] {
  return screen
    .getAllByTestId("changes-timeline-entry")
    .map((el) => el.getAttribute("data-entry-kind") ?? "");
}

function setMessages(messages: Message[]): void {
  useConversationStore.setState({
    currentConversationId: "c1",
    byId: { c1: { ...EMPTY_RUNTIME, messages } },
  });
}

describe("ConversationChangesPanel P0c entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLocalTurnBaselineIds.mockReturnValue(new Set());
    useConversationWorkspace.mockReturnValue(null);
    hasLocalFiles.mockReturnValue(false);
    listSnapshots.mockResolvedValue([]);
    listLocalVersions.mockResolvedValue([]);
    useAutoSnapshotStore.setState({ failedByConversation: {} });
    useExecutionStore.setState({ byId: {} });
    useSidePanelStore.setState({ changesFocusMessageId: null });
    setMessages([
      {
        id: "u1",
        role: "user",
        content: "hi",
        createdAt: "2026-08-10T10:00:00Z",
        executionId: null,
        isStreaming: false,
      },
      assistant(
        "a-baseline-only",
        "2026-08-10T10:00:00Z",
        "script deleted tree",
      ),
      assistant("a-no-baseline", "2026-08-10T12:00:00Z", "plain reply"),
    ]);
  });

  afterEach(cleanup);

  it("lists baseline-only turns without file_* artifacts", async () => {
    useLocalTurnBaselineIds.mockReturnValue(new Set(["a-baseline-only"]));

    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("review-a-baseline-only")).toBeTruthy();
    });
    expect(screen.getByText("回合 1")).toBeTruthy();
    expect(screen.queryByTestId("review-a-no-baseline")).toBeNull();
    expect(screen.getByTestId("review-a-baseline-only").textContent).toContain(
      "artifacts:0",
    );
  });

  it("empty state offers 留版本 as the entry point", async () => {
    render(<ConversationChangesPanel />);

    expect(screen.getByText("暂无改动")).toBeTruthy();
    expect(
      screen.getByText("可为当前工作区留一个版本，之后随时回到这里。"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "留版本" }));
    fireEvent.change(screen.getByLabelText("版本名"), {
      target: { value: " 发版前 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(createSnapshot).toHaveBeenCalledWith("c1", "发版前");
    });
    // 建完立刻重拉，新版本才会出现在时间轴上。
    await waitFor(() => {
      expect(listSnapshots.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("says so when the version list failed instead of claiming there is none", async () => {
    listSnapshots.mockRejectedValue(new Error("offline"));

    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(
        screen.getByText("版本没能加载出来，这里只有本对话的回合改动。"),
      ).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});

describe("ConversationChangesPanel unified timeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationWorkspace.mockReturnValue({
      wsId: "folder:f1",
      name: "项目 A",
      location: "cloud",
      rootId: null,
      subpath: "",
      hasFiles: true,
    });
    hasLocalFiles.mockReturnValue(false);
    useLocalTurnBaselineIds.mockReturnValue(new Set(["a-turn-1", "a-turn-2"]));
    useAutoSnapshotStore.setState({ failedByConversation: {} });
    useExecutionStore.setState({ byId: {} });
    useSidePanelStore.setState({ changesFocusMessageId: null });
    listLocalVersions.mockResolvedValue([]);
    listSnapshots.mockResolvedValue([
      snapshot(
        "s-handoff",
        "handoff:2026-08-10T13:00:00Z",
        "2026-08-10T13:00:00Z",
      ),
      snapshot("s-kept", "发版前", "2026-08-10T11:00:00Z"),
      snapshot("s-auto", null, "2026-08-10T11:30:00Z"),
      snapshot("s-baseline", "turn-baseline:a-turn-2", "2026-08-10T11:59:00Z"),
    ]);
    setMessages([
      assistant("a-turn-1", "2026-08-10T10:00:00Z"),
      assistant("a-turn-2", "2026-08-10T12:00:00Z"),
    ]);
  });

  afterEach(cleanup);

  it("interleaves turns, kept versions and handoff archives newest first", async () => {
    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(screen.getAllByTestId("changes-timeline-entry").length).toBe(4);
    });
    expect(renderedKinds()).toEqual(["archive", "turn", "version", "turn"]);
    expect(
      screen
        .getAllByTestId("changes-timeline-entry")
        .map((el) => el.getAttribute("data-entry-id")),
    ).toEqual(["s-handoff", "a-turn-2", "s-kept", "a-turn-1"]);
    // 回合能力不变：逐文件 diff / 回滚仍挂在回合条目上。
    expect(screen.getByTestId("review-a-turn-1")).toBeTruthy();
    expect(screen.getByTestId("review-a-turn-2")).toBeTruthy();
  });

  it("does not list auto backups or turn baselines", async () => {
    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(screen.getAllByTestId("changes-timeline-entry").length).toBe(4);
    });
    const ids = screen
      .getAllByTestId("changes-timeline-entry")
      .map((el) => el.getAttribute("data-entry-id"));
    expect(ids).not.toContain("s-auto");
    expect(ids).not.toContain("s-baseline");
    expect(screen.queryByText("自动备份")).toBeNull();
  });

  it("weights kept versions above the turn stream and marks them shared", async () => {
    render(<ConversationChangesPanel />);

    const version = await screen.findByText("发版前");
    const card = version.closest("[data-entry-kind]") as HTMLElement;
    expect(card.getAttribute("data-entry-kind")).toBe("version");
    expect(card.className).toContain("border-primary");
    expect(card.textContent).toContain("留存版本");
    expect(card.textContent).toContain("本项目共享");

    const archive = screen.getByText("本机交接").closest("[data-entry-kind]");
    expect(archive?.getAttribute("data-entry-kind")).toBe("archive");
    expect((archive as HTMLElement).className).not.toContain("border-primary");
    expect(archive?.textContent).toContain("交接存档");
    expect(archive?.textContent).not.toContain("本项目共享");
  });

  it("offers download but no delete on cloud versions (no delete API)", async () => {
    render(<ConversationChangesPanel />);

    const card = (await screen.findByText("发版前")).closest(
      "[data-entry-kind]",
    ) as HTMLElement;
    expect(
      card.querySelector('[aria-label="下载这个版本 (zip)"]'),
    ).toBeTruthy();
    expect(card.querySelector('[aria-label="删除这个版本"]')).toBeNull();
  });
});

describe("ConversationChangesPanel local version track", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationWorkspace.mockReturnValue(LOCAL_WORKSPACE);
    hasLocalFiles.mockReturnValue(true);
    useLocalTurnBaselineIds.mockReturnValue(new Set(["a-turn-1", "a-turn-2"]));
    useAutoSnapshotStore.setState({ failedByConversation: {} });
    useExecutionStore.setState({ byId: {} });
    useSidePanelStore.setState({ changesFocusMessageId: null });
    listSnapshots.mockResolvedValue([]);
    listLocalVersions.mockResolvedValue([
      localVersion("v-2", "发版前", "2026-08-10T11:00:00Z"),
    ]);
    setMessages([
      assistant("a-turn-1", "2026-08-10T10:00:00Z"),
      assistant("a-turn-2", "2026-08-10T12:00:00Z"),
    ]);
  });

  afterEach(cleanup);

  it("puts local versions on the same track as cloud ones", async () => {
    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(screen.getAllByTestId("changes-timeline-entry").length).toBe(3);
    });
    expect(renderedKinds()).toEqual(["turn", "version", "turn"]);
    expect(listLocalVersions).toHaveBeenCalledWith({
      rootId: "root-1",
      subpath: "projects/a",
    });
    // 本机版本轨不经云：一次云端快照请求都不该发。
    expect(listSnapshots).not.toHaveBeenCalled();

    // 同一张卡：书签描边 + 「留存版本」，与云端版本无视觉分叉。
    const card = screen.getByText("发版前").closest("[data-entry-kind]");
    expect(card?.getAttribute("data-entry-kind")).toBe("version");
    expect((card as HTMLElement).className).toContain("border-primary");
    expect(card?.textContent).toContain("留存版本");
  });

  it("keeps a version through the local service instead of the cloud API", async () => {
    render(<ConversationChangesPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "留版本" }));
    fireEvent.change(screen.getByLabelText("版本名"), {
      target: { value: " 本机版 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(createLocalVersion).toHaveBeenCalledWith(
        { rootId: "root-1", subpath: "projects/a" },
        "本机版",
      );
    });
    expect(createSnapshot).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(listLocalVersions.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it("restores overlay-style through the local service", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ConversationChangesPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "恢复到这个版本" }),
    );

    await waitFor(() => {
      expect(restoreLocalVersion).toHaveBeenCalledWith(
        { rootId: "root-1", subpath: "projects/a" },
        "v-2",
      );
    });
    // 诚实文案不退化：overlay 覆盖、之后新建的文件不删。
    expect(confirm.mock.calls[0]?.[0]).toContain("overlay 覆盖同名文件");
    expect(restoreSnapshot).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("deletes a local version (they are never auto-pruned)", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ConversationChangesPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "删除这个版本" }),
    );

    await waitFor(() => {
      expect(deleteLocalVersion).toHaveBeenCalledWith(
        { rootId: "root-1", subpath: "projects/a" },
        "v-2",
      );
    });
    expect(confirm.mock.calls[0]?.[0]).toContain("不可恢复");
    // 删完重拉，卡片才会从时间轴上消失。
    await waitFor(() => {
      expect(listLocalVersions.mock.calls.length).toBeGreaterThan(1);
    });
    confirm.mockRestore();
  });

  it("keeps the delete confirm honest — a cancel deletes nothing", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ConversationChangesPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "删除这个版本" }),
    );

    expect(deleteLocalVersion).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("has no download entry — the zip is already on the user's disk", async () => {
    render(<ConversationChangesPanel />);

    const card = (await screen.findByText("发版前")).closest(
      "[data-entry-kind]",
    ) as HTMLElement;
    expect(card.querySelector('[aria-label="下载这个版本 (zip)"]')).toBeNull();
  });

  it("says so when the local version zone could not be read", async () => {
    listLocalVersions.mockRejectedValue(new Error("denied"));

    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(
        screen.getByText("版本没能加载出来，这里只有本对话的回合改动。"),
      ).toBeTruthy();
    });
  });

  it("drops the version track when the disk is out of reach (web runtime)", async () => {
    hasLocalFiles.mockReturnValue(false);

    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(screen.getAllByTestId("changes-timeline-entry").length).toBe(2);
    });
    expect(renderedKinds()).toEqual(["turn", "turn"]);
    expect(screen.queryByRole("button", { name: "留版本" })).toBeNull();
    expect(listLocalVersions).not.toHaveBeenCalled();
    // 本机工作区没有云端快照可列，别拿云端历史冒充。
    expect(listSnapshots).not.toHaveBeenCalled();
  });
});

describe("ConversationChangesPanel auto-backup failure notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationWorkspace.mockReturnValue(null);
    hasLocalFiles.mockReturnValue(false);
    useLocalTurnBaselineIds.mockReturnValue(new Set(["a-turn-1"]));
    useAutoSnapshotStore.setState({ failedByConversation: {} });
    useExecutionStore.setState({ byId: {} });
    useSidePanelStore.setState({ changesFocusMessageId: null });
    listSnapshots.mockResolvedValue([]);
    listLocalVersions.mockResolvedValue([]);
    setMessages([assistant("a-turn-1", "2026-08-10T10:00:00Z")]);
  });

  afterEach(cleanup);

  const NOTICE =
    "最近一次自动备份失败。回合已正常完成；可手动留版本，或等下次改文件回合重试。";

  it("stays quiet while auto-backup is healthy", async () => {
    render(<ConversationChangesPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("changes-timeline")).toBeTruthy();
    });
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("surfaces the SSE-marked failure above the timeline", async () => {
    useAutoSnapshotStore.getState().markFailed("c1");

    render(<ConversationChangesPanel />);

    const notice = await screen.findByText(NOTICE);
    const timeline = screen.getByTestId("changes-timeline");
    expect(
      notice.compareDocumentPosition(timeline) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows it on the empty state too, then clears when a backup succeeds", async () => {
    useLocalTurnBaselineIds.mockReturnValue(new Set());
    useAutoSnapshotStore.getState().markFailed("c1");

    render(<ConversationChangesPanel />);

    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.getByText("暂无改动")).toBeTruthy();

    act(() => useAutoSnapshotStore.getState().clearFailed("c1"));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
