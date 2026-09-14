// @vitest-environment jsdom
import { MessageBubble } from "@/components/chat/message-bubble";
import type { Message } from "@/stores/conversation";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

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
  return render(
    <MemoryRouter>
      <MessageBubble message={message} />
    </MemoryRouter>,
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
