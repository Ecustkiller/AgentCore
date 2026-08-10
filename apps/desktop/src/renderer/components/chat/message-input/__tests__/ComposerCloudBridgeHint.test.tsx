// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uiState = {
  sidecarPreference: "unset" as "unset" | "on" | "off",
};

vi.mock("@/stores/ui", () => ({
  useUIStore: (sel: (s: typeof uiState) => unknown) => sel(uiState),
}));

vi.mock("@/stores/conversation", async () => {
  const actual = await vi.importActual<typeof import("@/stores/conversation")>(
    "@/stores/conversation",
  );
  return {
    ...actual,
    useActiveExecutionVia: vi.fn(),
  };
});

import { useActiveExecutionVia } from "@/stores/conversation";
import { ComposerCloudBridgeHint } from "../ComposerCloudBridgeHint";

const viaMock = vi.mocked(useActiveExecutionVia);

describe("ComposerCloudBridgeHint", () => {
  beforeEach(() => {
    uiState.sidecarPreference = "unset";
    viaMock.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("cloud_bridge + 未强制关 → 展示弱提示", () => {
    viaMock.mockReturnValue("cloud_bridge");
    render(<ComposerCloudBridgeHint />);
    expect(
      screen.getByTestId("composer-cloud-bridge-hint").textContent,
    ).toContain("本轮经云端协助");
  });

  it("显式强制关 → 不展示（勿吓大众）", () => {
    uiState.sidecarPreference = "off";
    viaMock.mockReturnValue("cloud_bridge");
    render(<ComposerCloudBridgeHint />);
    expect(screen.queryByTestId("composer-cloud-bridge-hint")).toBeNull();
  });

  it("sidecar / null → 不展示", () => {
    viaMock.mockReturnValue("sidecar");
    const { rerender } = render(<ComposerCloudBridgeHint />);
    expect(screen.queryByTestId("composer-cloud-bridge-hint")).toBeNull();
    viaMock.mockReturnValue(null);
    rerender(<ComposerCloudBridgeHint />);
    expect(screen.queryByTestId("composer-cloud-bridge-hint")).toBeNull();
  });
});
