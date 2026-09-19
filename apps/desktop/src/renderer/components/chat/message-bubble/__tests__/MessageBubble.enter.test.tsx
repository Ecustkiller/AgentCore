// @vitest-environment jsdom
import { MessageBubble } from "@/components/chat/message-bubble";
import {
  type Message,
  getRuntime,
  useConversationStore,
} from "@/stores/conversation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CID = "conv-bubble-enter";

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
});

function assistant(extra: Partial<Message> = {}): Message {
  return {
    id: "a1",
    role: "assistant",
    content: extra.content ?? "",
    createdAt: "2026-01-01T00:00:00Z",
    executionId: null,
    isStreaming: extra.isStreaming ?? false,
    ...extra,
  };
}

function user(): Message {
  return {
    id: "u1",
    role: "user",
    content: "你好",
    createdAt: "2026-01-01T00:00:00Z",
    executionId: null,
    isStreaming: false,
  };
}

function renderBubble(message: Message) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MessageBubble message={message} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function bubbleWrap(container: HTMLElement): Element | null {
  return container.querySelector(".scroll-mt-6");
}

describe("MessageBubble enter animation", () => {
  it("skips enter on a streaming assistant placeholder", () => {
    const { container } = renderBubble(assistant({ isStreaming: true }));
    expect(bubbleWrap(container)?.className).not.toMatch(
      /animate-message-enter/,
    );
  });

  it("plays enter on a user bubble and a settled assistant", () => {
    const userView = renderBubble(user());
    expect(bubbleWrap(userView.container)?.className).toMatch(
      /animate-message-enter/,
    );
    userView.unmount();
    const settled = renderBubble(
      assistant({ content: "好", isStreaming: false }),
    );
    expect(bubbleWrap(settled.container)?.className).toMatch(
      /animate-message-enter/,
    );
  });
});

describe("MessageBubble empty hide", () => {
  beforeEach(() => {
    useConversationStore.setState({ currentConversationId: null, byId: {} });
  });

  it("omits an idle empty assistant with no verdict", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(assistant({ isStreaming: false }), CID);
    const msg = getRuntime(CID).messages[0];
    const { container } = renderBubble(msg);
    expect(bubbleWrap(container)).toBeNull();
  });

  it("keeps an empty last assistant while the turn is still writing", () => {
    const store = useConversationStore.getState();
    store.switchConversation(CID);
    store.addMessage(user(), CID);
    store.addMessage(assistant({ isStreaming: false, content: "" }), CID);
    store.setGenerating(true, CID);
    const msg = getRuntime(CID).messages.at(-1);
    if (!msg) throw new Error("expected assistant");
    renderBubble(msg);
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });
});
