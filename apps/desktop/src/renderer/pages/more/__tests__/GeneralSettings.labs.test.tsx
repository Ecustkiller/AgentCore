// @vitest-environment jsdom
/**
 * 实验开关的设置页入口（最后修订 2026-11-04）。
 *
 * 关键断言是「默认关」：上游 `98ea13bf` 已下架人侧文档/表格编辑器，跟随上游
 * 的默认行为不能被一次 UI 改动悄悄覆盖。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capabilities")>()),
  hasLocalEngine: vi.fn(() => false),
}));
vi.mock("@/services/sidecarHealth", () => ({ clearSidecarHealth: vi.fn() }));

import { LABS_HUMAN_DOCS_TABLES, readLabsFlag } from "@/lib/labsFlags";
import {
  __clearMemoryUiStorageForTests,
  __setUiStorageBackendForTests,
} from "@/lib/uiStorage";
import { useUIStore } from "@/stores/ui";
import { GeneralSettings } from "../GeneralSettings";

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  __setUiStorageBackendForTests({
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
    keys: () => [...memory.keys()],
  });
  useUIStore.setState({
    theme: "light",
    sidecarPreference: "unset",
    sidecarEnabled: false,
  });
});

afterEach(() => {
  cleanup();
  __clearMemoryUiStorageForTests();
  __setUiStorageBackendForTests(null);
  vi.clearAllMocks();
});

describe("通用设置 · 实验功能", () => {
  it("默认关闭，并说明上游已下架", () => {
    render(<GeneralSettings />);
    expect(screen.getByRole("heading", { name: "实验功能" })).toBeTruthy();
    const toggle = screen.getByRole("switch", {
      name: "人侧文档 / 表格编辑器",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/上游已下架此功能，默认关闭/)).toBeTruthy();
    expect(readLabsFlag(LABS_HUMAN_DOCS_TABLES)).toBe(false);
  });

  it("用户主动打开后才写 true，再点一次可关回去", () => {
    render(<GeneralSettings />);
    const toggle = screen.getByRole("switch", {
      name: "人侧文档 / 表格编辑器",
    });
    fireEvent.click(toggle);
    expect(readLabsFlag(LABS_HUMAN_DOCS_TABLES)).toBe(true);
    expect(
      screen
        .getByRole("switch", { name: "人侧文档 / 表格编辑器" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("switch", { name: "人侧文档 / 表格编辑器" }),
    );
    expect(readLabsFlag(LABS_HUMAN_DOCS_TABLES)).toBe(false);
  });
});
