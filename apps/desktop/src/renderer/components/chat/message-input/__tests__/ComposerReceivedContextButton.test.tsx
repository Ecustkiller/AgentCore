// @vitest-environment jsdom

import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message } from "@/stores/conversation";
import { useConversationStore } from "@/stores/conversation";
import { EMPTY_RUNTIME } from "@/stores/conversation/runtime";
import type { ContextBlockWire } from "@/types/events";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerReceivedContextButton } from "../ComposerReceivedContextButton";

vi.mock("@/hooks/useModels", () => ({
  useModels: () => ({
    data: {
      byok_configured: false,
      current: { id: "deepseek-v4-flash", origin: "platform" },
      models: [
        {
          id: "deepseek-v4-flash",
          origin: "platform",
          display_name: "Flash",
          vendor: "DeepSeek",
          ref: "@platform/deepseek-v4-flash",
          capabilities: [],
          context_length: 1_000_000,
          price: null,
          available: true,
        },
      ],
    },
  }),
}));
vi.mock("@/lib/composerModelProfile", () => ({
  useComposerActiveProfile: () => ({
    id: "sys-flash",
    name: "Flash",
    kind: "system",
    is_default: true,
    main: { model: "deepseek-v4-flash", origin: "platform" },
  }),
}));

vi.mock("@/components/chat/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => (
    <pre data-testid="prompt-body">{content}</pre>
  ),
}));

const CID = "conv-ctx";

function block(
  overrides: Partial<ContextBlockWire> & Pick<ContextBlockWire, "channel">,
): ContextBlockWire {
  return {
    heading: "heading",
    body: "正文",
    chars: 2,
    truncated: false,
    files: [],
    source_role: "",
    source_run_id: "",
    fidelity: "",
    ...overrides,
  };
}

function assistant(over: Partial<Message> = {}): Message {
  return {
    id: "a1",
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    executionId: null,
    isStreaming: false,
    ...over,
  };
}

function user(over: Partial<Message> = {}): Message {
  return {
    id: "u1",
    role: "user",
    content: "hi",
    createdAt: new Date().toISOString(),
    executionId: null,
    isStreaming: false,
    ...over,
  };
}

function seed(messages: Message[], id: string | null = CID): void {
  useConversationStore.setState({
    currentConversationId: id,
    byId: id
      ? {
          [id]: {
            ...EMPTY_RUNTIME,
            messages,
          },
        }
      : {},
  });
}

function renderButton() {
  return render(
    <TooltipProvider>
      <ComposerReceivedContextButton />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  seed([], null);
});

afterEach(() => {
  cleanup();
  seed([], null);
});

describe("ComposerReceivedContextButton", () => {
  it("no last assistant context → no chrome", () => {
    seed([user()]);
    const { container } = renderButton();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("composer-received-context")).toBeNull();
  });

  it("assistant without captainContext stays quiet", () => {
    seed([assistant({ isStreaming: true })]);
    const { container } = renderButton();
    expect(container.firstChild).toBeNull();
  });

  it("lights up as soon as the last assistant has blocks — still streaming", () => {
    seed([
      assistant({
        isStreaming: true,
        captainContext: [
          block({ channel: "request", body: "调研竞品定价。", chars: 7 }),
        ],
      }),
    ]);
    renderButton();
    expect(screen.getByRole("button", { name: "收到的上下文" })).toBeTruthy();
    const glyph = screen
      .getByRole("button", { name: "收到的上下文" })
      .querySelector("svg");
    expect(glyph?.getAttribute("width")).toBe("16");
    expect(glyph?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("skips a trailing user bubble and still binds the last assistant", () => {
    seed([
      assistant({
        captainContext: [block({ channel: "history", body: "昨天" })],
      }),
      user({ id: "u2", content: "下一问" }),
    ]);
    renderButton();
    expect(screen.getByTestId("composer-received-context")).toBeTruthy();
  });

  it("click opens the same reader; later blocks show up without waiting for turn end", () => {
    seed([
      assistant({
        isStreaming: true,
        captainContext: [
          block({ channel: "request", body: "调研竞品定价。", chars: 7 }),
        ],
      }),
    ]);
    renderButton();
    fireEvent.click(screen.getByTestId("composer-received-context"));
    expect(screen.getByRole("dialog", { name: "收到的上下文" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /原始请求/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /回传/ })).toBeNull();

    act(() => {
      seed([
        assistant({
          isStreaming: true,
          captainContext: [
            block({ channel: "request", body: "调研竞品定价。", chars: 7 }),
            block({
              channel: "team_result",
              body: "队员成稿",
              chars: 4,
              source_role: "研究员",
            }),
          ],
          process: [
            {
              kind: "tool",
              id: "t1",
              tool_name: "consult",
              arguments: { name: "定价口径" },
              result: "查阅回执",
              status: "success",
              display: { name: "定价口径", origin: "user" },
            },
          ],
        }),
      ]);
    });

    expect(screen.getByRole("button", { name: /回传/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /查阅 · 定价口径/ }),
    ).toBeTruthy();
  });

  it("switching conversations closes the dialog", () => {
    seed([
      assistant({
        captainContext: [block({ channel: "request", body: "A" })],
      }),
    ]);
    renderButton();
    fireEvent.click(screen.getByTestId("composer-received-context"));
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => {
      seed(
        [
          assistant({
            id: "a-other",
            captainContext: [block({ channel: "request", body: "B" })],
          }),
        ],
        "conv-other",
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("composer-received-context")).toBeTruthy();
  });

  it("shows window fill from last_prompt / catalog context_length", () => {
    seed([
      assistant({
        captainContext: [block({ channel: "request", body: "调研竞品定价。" })],
        usage: {
          input: 200_000,
          output: 40,
          reasoning: 0,
          cache_hit: 0,
          cache_miss: 200_000,
          last_prompt: 120_000,
        },
      }),
    ]);
    renderButton();
    const btn = screen.getByTestId("composer-received-context");
    expect(btn.getAttribute("data-window-percent")).toBe("12");
  });

  it("keeps an empty ring until last_prompt exists — never fakes % from chars", () => {
    seed([
      assistant({
        isStreaming: true,
        captainContext: [
          block({
            channel: "request",
            body: "x".repeat(80_000),
            chars: 80_000,
          }),
        ],
      }),
    ]);
    renderButton();
    expect(
      screen
        .getByTestId("composer-received-context")
        .getAttribute("data-window-percent"),
    ).toBeNull();
  });
});
