// @vitest-environment jsdom
import type { ErrorAction } from "@/lib/errors";
import {
  RECONNECTING_BANNER,
  RECONNECT_INTERRUPTED_BANNER,
} from "@/services/turns/helpers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerSendErrorNotice } from "../ComposerSendErrorNotice";

let composerError: { message: string; action: ErrorAction | null } | null =
  null;
let sessionError: string | null = null;
let sessionAction: ErrorAction | null = null;

vi.mock("@/stores/composerSendError", () => ({
  useComposerSendError: () => composerError,
  clearComposerSendError: vi.fn(),
}));

vi.mock("@/stores/conversation", () => ({
  useActiveError: () => sessionError,
  useActiveErrorAction: () => sessionAction,
  useConversationStore: {
    getState: () => ({ clearError: vi.fn() }),
  },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

afterEach(() => {
  cleanup();
  composerError = null;
  sessionError = null;
  sessionAction = null;
});

describe("ComposerSendErrorNotice", () => {
  it("uses neutral chrome for a rate-limit refusal", () => {
    composerError = {
      message: "上游限流，暂时无法继续本回合。请约 2 秒后再试。",
      action: null,
    };
    render(<ComposerSendErrorNotice draftKey="__draft__" />);
    const banner = screen.getByTestId("composer-send-error");
    expect(banner.className).toContain("bg-muted/40");
    expect(banner.className).not.toContain("destructive");
  });

  it("uses notice chrome for a quiet reconnect session banner", () => {
    sessionError = RECONNECTING_BANNER;
    render(<ComposerSendErrorNotice draftKey="__draft__" />);
    const banner = screen.getByTestId("composer-send-error");
    expect(banner.getAttribute("data-banner-tone")).toBe("notice");
    expect(banner.className).toContain("bg-muted/40");
  });

  it("uses alert chrome for an interrupted session banner", () => {
    sessionError = RECONNECT_INTERRUPTED_BANNER;
    render(<ComposerSendErrorNotice draftKey="__draft__" />);
    const banner = screen.getByTestId("composer-send-error");
    expect(banner.getAttribute("data-banner-tone")).toBe("alert");
    expect(banner.className).toContain("bg-muted/40");
  });

  it("uses primary chrome when a config action is offered", () => {
    composerError = {
      message: "请先在「设置 · 服务商」中填入你的 API Key，再发起对话。",
      action: { label: "去设置", href: "/more/providers" },
    };
    render(<ComposerSendErrorNotice draftKey="__draft__" />);
    const banner = screen.getByTestId("composer-send-error");
    expect(banner.className).toContain("bg-primary/10");
    expect(banner.className).not.toContain("destructive");
    expect(screen.getByRole("button", { name: "去设置" })).toBeTruthy();
  });
});
