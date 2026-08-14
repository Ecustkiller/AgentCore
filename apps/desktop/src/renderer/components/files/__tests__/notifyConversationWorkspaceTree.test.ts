import { notifyFileTreeChanged } from "@/components/files/fileTreeBus";
import {
  conversationWorkspaceSourceIds,
  notifyConversationWorkspaceTree,
} from "@/components/files/notifyConversationWorkspaceTree";
import { queryClient } from "@/lib/queryClient";
import { conversationKeys, workspaceKeys } from "@/lib/queryKeys";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/files/fileTreeBus", () => ({
  notifyFileTreeChanged: vi.fn(),
}));

function seedConv(partial: {
  id: string;
  folderId?: string | null;
  localRootId?: string | null;
  localContainerRootId?: string | null;
}) {
  queryClient.setQueryData(conversationKeys.grouped, {
    folders: [],
    conversations: [
      {
        id: partial.id,
        title: "t",
        updatedAt: "",
        messageCount: 0,
        lastMessagePreview: null,
        folderId: partial.folderId ?? null,
        localRootId: partial.localRootId ?? null,
        localContainerRootId: partial.localContainerRootId ?? null,
      },
    ],
  });
}

afterEach(() => {
  queryClient.clear();
  vi.mocked(notifyFileTreeChanged).mockClear();
});

describe("conversationWorkspaceSourceIds", () => {
  it("always includes side-panel fallback and hub conv: ids", () => {
    expect(conversationWorkspaceSourceIds("c1")).toEqual([
      "workspace:c1",
      "workspace:conv:c1",
    ]);
  });

  it("adds folder cloud + local ids when the chat is bound", () => {
    seedConv({ id: "c1", folderId: "f1" });
    queryClient.setQueryData(conversationKeys.grouped, {
      folders: [
        {
          id: "f1",
          name: "proj",
          mode: "local",
          localRootId: "root-1",
          localSubpath: "src",
        },
      ],
      conversations: [
        {
          id: "c1",
          title: "t",
          updatedAt: "",
          messageCount: 0,
          lastMessagePreview: null,
          folderId: "f1",
        },
      ],
    });

    expect(conversationWorkspaceSourceIds("c1")).toEqual(
      expect.arrayContaining([
        "workspace:c1",
        "workspace:conv:c1",
        "workspace:folder:f1",
        "local:root-1:src",
      ]),
    );
  });

  it("adds listed local scratch id", () => {
    seedConv({ id: "c1", localContainerRootId: "ctr" });
    queryClient.setQueryData(workspaceKeys.list, [
      {
        wsId: "conv:c1",
        name: "t",
        location: "local",
        rootId: "ctr",
        subpath: "",
        hasFiles: true,
      },
    ]);

    expect(conversationWorkspaceSourceIds("c1")).toEqual(
      expect.arrayContaining([
        "workspace:c1",
        "workspace:conv:c1",
        "local:ctr:conversations/c1",
      ]),
    );
  });

  it("adds optimistic localRootId when it is not the scratch container", () => {
    seedConv({ id: "c1", localRootId: "bind-root" });
    expect(conversationWorkspaceSourceIds("c1")).toEqual(
      expect.arrayContaining([
        "workspace:c1",
        "workspace:conv:c1",
        "local:bind-root",
      ]),
    );
  });

  it("does not add a bare localRootId that is the scratch container", () => {
    seedConv({
      id: "c1",
      localRootId: "ctr",
      localContainerRootId: "ctr",
    });
    const ids = conversationWorkspaceSourceIds("c1");
    expect(ids).toContain("local:ctr:conversations/c1");
    expect(ids).not.toContain("local:ctr");
  });
});

describe("notifyConversationWorkspaceTree", () => {
  it("broadcasts root change for each candidate source", () => {
    notifyConversationWorkspaceTree("c1");
    expect(notifyFileTreeChanged).toHaveBeenCalledTimes(2);
    expect(notifyFileTreeChanged).toHaveBeenCalledWith({
      sourceId: "workspace:c1",
      dir: "",
    });
    expect(notifyFileTreeChanged).toHaveBeenCalledWith({
      sourceId: "workspace:conv:c1",
      dir: "",
    });
  });

  it("is a no-op for empty id", () => {
    notifyConversationWorkspaceTree("  ");
    expect(notifyFileTreeChanged).not.toHaveBeenCalled();
  });
});
