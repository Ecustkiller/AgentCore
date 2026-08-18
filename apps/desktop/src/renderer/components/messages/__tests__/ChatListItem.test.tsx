// @vitest-environment jsdom
import type { ChatSummary } from "@/services/messaging";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatListItem } from "../ChatListItem";

vi.mock("@/stores/messaging", () => ({
  useMessagingStore: (
    sel: (s: { mentionAlertByChat: Record<string, boolean> }) => unknown,
  ) => sel({ mentionAlertByChat: {} }),
}));

afterEach(cleanup);

function dm(over: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: "d1",
    type: "dm",
    title: null,
    avatar_url: "/v1/chats/d1/avatar",
    peer: {
      id: "u1",
      username: "alice",
      display_name: "Alice",
      online: false,
      is_admin: false,
      group_role: "member",
      muted_by_admin: false,
      avatar_url: "/v1/users/u1/avatar?v=1",
    },
    last_message_at: null,
    last_message_preview: null,
    unread: 0,
    pinned: false,
    muted: false,
    state: "accepted",
    ...over,
  };
}

describe("ChatListItem avatar source", () => {
  it("renders the peer photo for a dm, not chat.avatar_url", () => {
    const { container } = render(
      <ChatListItem chat={dm()} active={false} onSelect={() => undefined} />,
    );
    const src = container.querySelector("img")?.getAttribute("src") ?? "";
    expect(src).toContain("/v1/users/u1/avatar?v=1");
    expect(src).not.toContain("/v1/chats/");
  });

  it("shows the letter when the peer has no photo, even if chat.avatar_url is set", () => {
    const { container } = render(
      <ChatListItem
        chat={dm({
          peer: {
            id: "u1",
            username: "alice",
            display_name: "Alice",
            online: false,
            is_admin: false,
            group_role: "member",
            muted_by_admin: false,
            avatar_url: null,
          },
        })}
        active={false}
        onSelect={() => undefined}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("A");
  });

  it("uses chat.avatar_url as the session icon for a group", () => {
    const { container } = render(
      <ChatListItem
        chat={{
          id: "g1",
          type: "group",
          title: "内测群",
          avatar_url: "/v1/chats/g1/avatar",
          peer: null,
          last_message_at: null,
          last_message_preview: null,
          unread: 0,
          pinned: false,
          muted: false,
          state: "accepted",
        }}
        active={false}
        onSelect={() => undefined}
      />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toContain(
      "/v1/chats/g1/avatar",
    );
  });
});
