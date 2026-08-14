// @vitest-environment jsdom

import { SharedSpaceMembersDialog } from "@/components/files/sharedSpaces/SharedSpaceMembersDialog";
import { searchUsers } from "@/services/messaging";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useSharedSpaces", () => ({
  useSharedSpaceMembers: () => ({
    data: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useInviteSharedMember: () => ({ mutate: vi.fn(), isPending: false }),
  useChangeSharedMemberRole: () => ({
    mutate: vi.fn(),
    isPending: false,
    variables: null,
  }),
  useRemoveOrLeaveSharedMember: () => ({
    mutate: vi.fn(),
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

vi.mock("@/stores/messaging", () => ({
  useMessagingStore: (
    sel: (s: {
      friends: [];
      friendsLoaded: boolean;
      fetchFriends: () => void;
    }) => unknown,
  ) => sel({ friends: [], friendsLoaded: true, fetchFriends: vi.fn() }),
}));

describe("SharedSpaceMembersDialog search failure tone", () => {
  it("搜人失败 is muted, not destructive", async () => {
    vi.mocked(searchUsers).mockRejectedValue(new Error("search down"));
    render(
      <SharedSpaceMembersDialog
        open
        onClose={() => {}}
        spaceId="space-1"
        spaceName="协作"
        myRole="owner"
      />,
    );
    const input = screen.getByLabelText("按用户名或 ID 邀请成员");
    await act(async () => {
      fireEvent.change(input, { target: { value: "alice" } });
    });
    const line = await waitFor(() => screen.getByText("搜索失败，请重试"));
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).not.toContain("destructive");
  });
});
