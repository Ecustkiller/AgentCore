// @vitest-environment jsdom
/**
 * Render test for the input-box model badge (输入框「当前模型」徽章).
 *
 * The badge must be HONEST about the model each conversation's turn actually ran on: a
 * local (sidecar) turn reports its real model (useTurnModelStore) — the only place a turn
 * diverges from the account config (dev fallback → local platform model). With no per-turn
 * signal (fresh / cloud conversation) it falls back to the account-config label. This
 * asserts both the per-turn override and the account fallback via the visible label.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useLlmKey", () => ({ useLlmKey: vi.fn() }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useLlmKey } from "@/hooks/useLlmKey";
import { useConversationStore } from "@/stores/conversation";
import { useTurnModelStore } from "@/stores/turnModel";
import { CurrentModelBadge } from "../CurrentModelBadge";

const useLlmKeyMock = vi.mocked(useLlmKey);

/** Shape just the two fields the badge reads off the useLlmKey query result. */
function llmKey(
  data:
    | {
        default_model?: string;
        platform_model?: string;
        configured?: boolean;
        billing_mode?: string;
      }
    | undefined,
  isLoading = false,
): void {
  useLlmKeyMock.mockReturnValue({
    data,
    isLoading,
  } as unknown as ReturnType<typeof useLlmKey>);
}

function renderBadge() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <CurrentModelBadge />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useConversationStore.setState({ currentConversationId: null, byId: {} });
  useTurnModelStore.setState({ byConversation: {} });
  useLlmKeyMock.mockReset();
});

afterEach(cleanup);

describe("CurrentModelBadge", () => {
  it("shows the account-config model on a fresh conversation (no per-turn model yet)", () => {
    llmKey({ default_model: "deepseek-account", configured: true });
    renderBadge();
    expect(screen.getByText("deepseek-account")).toBeTruthy();
  });

  it("shows the conversation's last actually-used model over the account config", () => {
    // Account is configured for deepseek, but this conversation's last local turn fell
    // back to the platform model — the badge must reflect what actually ran.
    llmKey({ default_model: "deepseek-account", configured: true });
    useConversationStore.setState({ currentConversationId: "c1", byId: {} });
    useTurnModelStore.setState({ byConversation: { c1: "gpt-5.5" } });

    renderBadge();

    expect(screen.getByText("gpt-5.5")).toBeTruthy();
    expect(screen.queryByText("deepseek-account")).toBeNull();
  });

  it("does not leak another conversation's model into a fresh one", () => {
    llmKey({ default_model: "deepseek-account", configured: true });
    // A different conversation ran on the fallback; the active one has no record.
    useConversationStore.setState({ currentConversationId: "c2", byId: {} });
    useTurnModelStore.setState({ byConversation: { c1: "gpt-5.5" } });

    renderBadge();

    expect(screen.getByText("deepseek-account")).toBeTruthy();
    expect(screen.queryByText("gpt-5.5")).toBeNull();
  });

  it("makes the 未配置 badge a button that links to model settings", () => {
    llmKey({ configured: false, billing_mode: "byok" });
    renderBadge();
    expect(screen.getByRole("button", { name: /未配置模型/ })).toBeTruthy();
  });
});
