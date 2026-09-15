// @vitest-environment jsdom

import { FolderMembersDialog } from "@/components/folders/FolderMembersDialog";
import { searchUsers } from "@/services/messaging";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const members = vi.hoisted(() => ({
  value: [] as {
    user_id: string;
    display_name?: string | null;
    username?: string | null;
    role: "owner" | "editor" | "viewer";
    state: "pending" | "accepted";
  }[],
}));

const removeMutate = vi.hoisted(() => vi.fn());
const inviteMutateAsync = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useFolderSharing", () => ({
  useFolderMembers: () => ({
    data: members.value,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useInviteFolderMember: () => ({
    mutate: vi.fn(),
    mutateAsync: inviteMutateAsync,
    isPending: false,
  }),
  useChangeFolderMemberRole: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: null,
  }),
  useRemoveOrLeaveFolderMember: () => ({
    mutate: removeMutate,
    isPending: false,
    variables: null,
  }),
}));

vi.mock("@/services/messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/messaging")>();
  return { ...actual, searchUsers: vi.fn() };
});

vi.mock("@/lib/toast", () => ({
  notifyError: vi.fn(),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: (sel: (s: { user: { id: string } }) => unknown) =>
    sel({ user: { id: "me" } }),
}));

const friends = vi.hoisted(() => ({
  value: [] as { id: string; display_name: string; username: string }[],
}));

vi.mock("@/stores/messaging", () => ({
  useMessagingStore: (
    sel: (s: {
      friends: { id: string; display_name: string; username: string }[];
      friendsLoaded: boolean;
      fetchFriends: () => void;
    }) => unknown,
  ) =>
    sel({
      friends: friends.value,
      friendsLoaded: true,
      fetchFriends: vi.fn(),
    }),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

function renderDialog() {
  return render(
    <FolderMembersDialog
      open
      onClose={() => {}}
      folderId="folder-1"
      folderName="协作"
      myRole="owner"
    />,
  );
}

describe("FolderMembersDialog", () => {
  beforeEach(() => {
    members.value = [];
    friends.value = [];
    removeMutate.mockReset();
    inviteMutateAsync.mockReset();
    inviteMutateAsync.mockResolvedValue(undefined);
    vi.mocked(searchUsers).mockReset();
    vi.mocked(searchUsers).mockResolvedValue([]);
  });

  it("搜人失败 is muted, not destructive", async () => {
    vi.mocked(searchUsers).mockRejectedValue(new Error("search down"));
    renderDialog();
    const input = screen.getByLabelText("搜索好友、用户名或 ID");
    await act(async () => {
      fireEvent.change(input, { target: { value: "alice" } });
    });
    const line = await waitFor(() => screen.getByText("搜索失败，请重试"));
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).not.toContain("destructive");
  });

  it("already-member and pending friends stay out of suggestions", () => {
    members.value = [
      {
        user_id: "u-joined",
        display_name: "已加入",
        username: "joined",
        role: "editor",
        state: "accepted",
      },
      {
        user_id: "u-pending",
        display_name: "待接受",
        username: "pending",
        role: "editor",
        state: "pending",
      },
    ];
    friends.value = [
      { id: "u-joined", display_name: "已加入", username: "joined" },
      { id: "u-pending", display_name: "待接受", username: "pending" },
      { id: "u-free", display_name: "可邀请", username: "free" },
    ];
    renderDialog();
    fireEvent.focus(screen.getByLabelText("搜索好友、用户名或 ID"));
    expect(screen.getByRole("button", { name: /@free/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /@joined/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /@pending/ })).toBeNull();
  });

  it("search hit becomes a chip; invite waits for the footer", async () => {
    vi.mocked(searchUsers).mockResolvedValue([
      { id: "u-new", display_name: "Nina", username: "nina" },
    ]);
    renderDialog();
    const input = screen.getByLabelText("搜索好友、用户名或 ID");
    await act(async () => {
      fireEvent.change(input, { target: { value: "nina" } });
    });
    fireEvent.click(await screen.findByRole("button", { name: /Nina/ }));
    expect(inviteMutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "邀请 1 人" }));
    await waitFor(() =>
      expect(inviteMutateAsync).toHaveBeenCalledWith({
        folderId: "folder-1",
        userId: "u-new",
        role: "editor",
      }),
    );
  });

  it("owner can cancel a pending invite", async () => {
    members.value = [
      {
        user_id: "u-pending",
        display_name: "Alice",
        username: "alice",
        role: "editor",
        state: "pending",
      },
    ];
    renderDialog();
    fireEvent.pointerDown(screen.getByLabelText("对 Alice 的操作"));
    fireEvent.click(screen.getByLabelText("对 Alice 的操作"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "取消邀请" }));
    fireEvent.click(screen.getByRole("button", { name: "取消邀请" }));
    expect(removeMutate).toHaveBeenCalledWith(
      { folderId: "folder-1", memberUserId: "u-pending" },
      expect.any(Object),
    );
  });
});
