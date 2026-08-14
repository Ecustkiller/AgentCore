// @vitest-environment jsdom
/**
 * IM 线程 chrome：icon-btn 顶栏、textarea 输入、Modal sheet；官方号无 composer。
 */
import type { ChatMessageDetail, ChatSummary } from "@/api/messaging";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  getTokens: () => ({ access_token: "a", refresh_token: "r" }),
  BASE_URL: "",
}));

const messaging = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listChats: vi.fn(),
  listMembers: vi.fn(),
  markRead: vi.fn(),
  sendMessage: vi.fn(),
  uploadChatFile: vi.fn(),
  blockUser: vi.fn(),
  leaveChat: vi.fn(),
  fetchChatAttachmentBlob: vi.fn(),
}));

vi.mock("@/api/messaging", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/messaging")>("@/api/messaging");
  return { ...actual, ...messaging };
});

vi.mock("@/api/auth", () => ({
  me: vi.fn(async () => ({
    id: "me",
    username: "me",
    display_name: "我",
    email: null,
    created_at: "2026-01-01T00:00:00Z",
    password_must_change: false,
    role: "user",
  })),
}));

vi.mock("@/lib/keyboardInsets", () => ({
  useKeyboardInsetBridge: vi.fn(),
}));

vi.mock("@/components/Modal", () => ({
  Modal: ({
    children,
    className,
    label,
    onClose,
  }: {
    children: ReactNode;
    className?: string;
    label?: string;
    onClose: () => void;
  }) => (
    // biome-ignore lint/a11y/useSemanticElements: Modal mock — jsdom <dialog> is not exposed as role=dialog unless open.
    <div role="dialog" className={className} aria-label={label}>
      {children}
      <button type="button" onClick={onClose} aria-label="Esc">
        Esc
      </button>
    </div>
  ),
}));

const route = vi.hoisted(() => ({
  chatId: "c1",
  chat: null as ChatSummary | null,
}));

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => ({ chatId: route.chatId }),
    useLocation: () => ({
      state: route.chat ? { chat: route.chat } : {},
    }),
  };
});

import { useKeyboardInsetBridge } from "@/lib/keyboardInsets";
import { ChatThreadPage } from "@/pages/im/ChatThreadPage";

function peer() {
  return {
    id: "u2",
    username: "alice",
    display_name: "Alice",
    group_role: "member" as const,
    is_admin: false,
    muted_by_admin: false,
    online: false,
  };
}

function dmChat(): ChatSummary {
  return {
    id: "c1",
    type: "dm",
    muted: false,
    pinned: false,
    state: "accepted",
    unread: 0,
    peer: peer(),
  };
}

function officialChat(): ChatSummary {
  return {
    id: "c1",
    type: "official",
    muted: false,
    pinned: false,
    state: "accepted",
    unread: 0,
    title: "系统通知",
  };
}

function emptyPage() {
  return {
    messages: [] as ChatMessageDetail[],
    total: 0,
    page: 1,
    pageSize: 100,
  };
}

function sentMsg(content: string): ChatMessageDetail {
  return {
    id: "m-sent",
    chat_id: "c1",
    content,
    content_type: "text",
    created_at: "2026-01-01T00:00:01Z",
    sender_type: "user",
    sender_user_id: "me",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  route.chatId = "c1";
  route.chat = dmChat();
  messaging.listMessages.mockResolvedValue(emptyPage());
  messaging.listMembers.mockResolvedValue([]);
  messaging.markRead.mockResolvedValue(undefined);
  messaging.sendMessage.mockResolvedValue(sentMsg("hello"));
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: () => {},
  });
});

afterEach(cleanup);

describe("ChatThreadPage", () => {
  it("uses icon-btn chrome, textarea composer, and keyboard inset bridge", async () => {
    render(<ChatThreadPage />);
    expect(useKeyboardInsetBridge).toHaveBeenCalled();
    expect(screen.getByLabelText("返回").className).toMatch(/icon-btn/);
    expect(document.querySelector(".bar-title")?.textContent).toBe("Alice");
    expect(screen.getByLabelText("更多").className).toMatch(/icon-btn/);
    expect(screen.queryByText("← 消息")).toBeNull();

    const input = await screen.findByPlaceholderText("发送消息…");
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.className).toMatch(/composer-input/);
  });

  it("opens the thread menu via Modal sheet and keeps DM actions", async () => {
    render(<ChatThreadPage />);
    await screen.findByPlaceholderText("发送消息…");
    fireEvent.click(screen.getByLabelText("更多"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toBe("sheet");
    expect(document.querySelector(".sheet-backdrop")).toBeNull();
    expect(screen.getByText("拉黑此人")).toBeTruthy();
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.queryByText("退出会话")).toBeNull();
  });

  it("does not render a composer on official chats", async () => {
    route.chat = officialChat();
    render(<ChatThreadPage />);
    expect(await screen.findByText("系统通知")).toBeTruthy();
    expect(screen.queryByPlaceholderText("发送消息…")).toBeNull();
    expect(screen.queryByLabelText("发送")).toBeNull();

    fireEvent.click(screen.getByLabelText("更多"));
    expect(screen.getByText("取消")).toBeTruthy();
    expect(screen.queryByText("拉黑此人")).toBeNull();
    expect(screen.queryByText("退出会话")).toBeNull();
  });

  it("keeps the existing send path", async () => {
    render(<ChatThreadPage />);
    const input = await screen.findByPlaceholderText("发送消息…");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByLabelText("发送"));
    await waitFor(() => {
      expect(messaging.sendMessage).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          content: "hello",
          contentType: "text",
        }),
      );
    });
  });
});
