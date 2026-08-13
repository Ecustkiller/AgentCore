// @vitest-environment jsdom
/**
 * 「某个对话在等你」提示条 —— 停在该对话页时让位、多条显示计数、点按进对话。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

import {
  type AiAttentionEvent,
  __resetAiAttentionForTests,
  applyAiAttention,
} from "@/lib/aiAttention";
import { AiAttentionBanner } from "../AiAttentionBanner";

function attention(over: Partial<AiAttentionEvent> = {}): AiAttentionEvent {
  return {
    type: "ai_attention",
    state: "required",
    conversation_id: "conv-1",
    turn_id: "turn-1",
    interaction_id: "ix-1",
    kind: "ask_user",
    title: "要不要继续部署？",
    ...over,
  };
}

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AiAttentionBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockClear();
  __resetAiAttentionForTests();
});

afterEach(() => {
  cleanup();
  __resetAiAttentionForTests();
});

describe("AiAttentionBanner", () => {
  it("无等待时不渲染", () => {
    const { container } = mount("/");
    expect(container.firstChild).toBeNull();
  });

  it("人在别处时提示，并点按进那个对话", () => {
    applyAiAttention(attention());
    mount("/im");

    expect(screen.getByText("要不要继续部署？")).toBeTruthy();
    fireEvent.click(screen.getByText("去看看"));
    expect(navigate).toHaveBeenCalledWith("/c/conv-1");
  });

  it("停在该对话页时让位给卡片本身", () => {
    applyAiAttention(attention());
    const { container } = mount("/c/conv-1");
    expect(container.firstChild).toBeNull();
  });

  it("该对话的子页（文件）同样让位", () => {
    applyAiAttention(attention());
    const { container } = mount("/c/conv-1/files");
    expect(container.firstChild).toBeNull();
  });

  it("多条只显示最近一条 + 其余计数", () => {
    applyAiAttention(attention());
    applyAiAttention(
      attention({
        interaction_id: "ix-2",
        conversation_id: "conv-2",
        title: "预算超了，继续吗？",
      }),
    );
    mount("/");

    expect(screen.getByText(/预算超了，继续吗？/)).toBeTruthy();
    expect(screen.getByText(/还有 1 个/)).toBeTruthy();
    fireEvent.click(screen.getByText("去看看"));
    expect(navigate).toHaveBeenCalledWith("/c/conv-2");
  });

  it("标题为空时兜底文案", () => {
    applyAiAttention(attention({ title: "" }));
    mount("/");
    expect(screen.getByText("有个对话在等你确认")).toBeTruthy();
  });
});
