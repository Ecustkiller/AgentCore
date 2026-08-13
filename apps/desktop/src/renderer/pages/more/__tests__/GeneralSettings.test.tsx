// @vitest-environment jsdom
/**
 * Tests for 设置·通用 (原「外观」) — 主题 + 从关于页搬来的两个进阶开关。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capabilities")>()),
  hasLocalEngine: vi.fn(() => true),
}));
vi.mock("@/services/sidecarHealth", () => ({ clearSidecarHealth: vi.fn() }));

import { hasLocalEngine } from "@/lib/capabilities";
import { clearSidecarHealth } from "@/services/sidecarHealth";
import { useUIStore } from "@/stores/ui";
import { GeneralSettings } from "../GeneralSettings";

beforeEach(() => {
  vi.mocked(hasLocalEngine).mockReturnValue(true);
  useUIStore.setState({
    theme: "light",
    diagnosticMode: false,
    sidecarPreference: "unset",
    sidecarEnabled: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GeneralSettings · 主题", () => {
  it("marks the active theme and switches on click", () => {
    render(<GeneralSettings />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("通用");

    const light = screen.getByRole("button", { name: /^浅色/ });
    const dark = screen.getByRole("button", { name: /^深色/ });
    expect(light.getAttribute("aria-pressed")).toBe("true");
    expect(dark.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(dark);
    expect(useUIStore.getState().theme).toBe("dark");
  });

  it("tells the 跟随系统 row what it currently resolves to", () => {
    render(<GeneralSettings />);
    const system = screen.getByRole("button", { name: /^跟随系统/ });
    expect(system.textContent).toContain("当前解析为");
  });
});

describe("GeneralSettings · 进阶开关（原在关于页）", () => {
  it("hosts 开发者 / 诊断模式 and writes it to the store", () => {
    render(<GeneralSettings />);
    const toggle = screen.getByRole("switch", { name: "开发者 / 诊断模式" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(useUIStore.getState().diagnosticMode).toBe(true);
  });

  it("reveals 允许本机执行 only under diagnostic mode on a local-engine build", () => {
    const { rerender } = render(<GeneralSettings />);
    expect(screen.queryByRole("switch", { name: "允许本机执行" })).toBeNull();

    useUIStore.setState({ diagnosticMode: true });
    rerender(<GeneralSettings />);
    expect(screen.getByRole("switch", { name: "允许本机执行" })).toBeTruthy();

    vi.mocked(hasLocalEngine).mockReturnValue(false);
    rerender(<GeneralSettings />);
    expect(screen.queryByRole("switch", { name: "允许本机执行" })).toBeNull();
  });

  it("reads 允许本机执行 from the preference, not from sidecarEnabled", () => {
    // unset + sidecarEnabled=false 仍是「允许」——路由默认走同侧引擎。
    useUIStore.setState({ diagnosticMode: true });
    render(<GeneralSettings />);
    expect(
      screen
        .getByRole("switch", { name: "允许本机执行" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("clears cached sidecar health when re-allowing local execution", () => {
    useUIStore.setState({ diagnosticMode: true, sidecarPreference: "off" });
    render(<GeneralSettings />);
    const toggle = screen.getByRole("switch", { name: "允许本机执行" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(useUIStore.getState().sidecarPreference).toBe("on");
    expect(clearSidecarHealth).toHaveBeenCalledTimes(1);
  });
});
