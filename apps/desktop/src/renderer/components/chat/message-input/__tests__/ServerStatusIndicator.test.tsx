// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/serverHealth", () => ({
  probeServerHealth: vi.fn(async () => true),
}));

import { probeServerHealth } from "@/services/serverHealth";
import { useServerHealthStore } from "@/stores/serverHealth";
import { ComposerConnectionNotice } from "../ServerStatusIndicator";

beforeEach(() => {
  useServerHealthStore.setState({
    status: "offline",
    reason: "Nexus 服务暂时不可用，请稍后重试。",
    lastOkAt: null,
    offlineSince: Date.now(),
    justRecovered: false,
  });
});

afterEach(cleanup);

describe("ComposerConnectionNotice", () => {
  it("shows an actionable retry while the backend is offline", () => {
    render(<ComposerConnectionNotice />);
    expect(screen.getByText(/与服务器断开连接/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "立即重试" }));
    expect(probeServerHealth).toHaveBeenCalledTimes(1);
  });
});
