// @vitest-environment jsdom
/**
 * opt-in 实验开关（最后修订 2026-11-04）。
 *
 * 守的是一条移植纪律：上游 `98ea13bf` 卸掉了「人侧文档/表格编辑器」，默认
 * 必须跟随上游关闭。这里同时验证开关本身与路由守卫，防止有人「顺手」把
 * 默认改成 true 或者把守卫去掉而测试还绿。
 */
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LABS_HUMAN_DOCS_TABLES,
  readLabsFlag,
  setLabsFlag,
  useHumanDocsTablesEnabled,
} from "@/lib/labsFlags";
import { HumanDocsTablesGate } from "@/lib/labsGate";
import {
  __clearMemoryUiStorageForTests,
  __setUiStorageBackendForTests,
} from "@/lib/uiStorage";

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
});

afterEach(() => {
  cleanup();
  __clearMemoryUiStorageForTests();
  __setUiStorageBackendForTests(null);
});

describe("labs flags", () => {
  it("默认关闭——这是跟随上游的默认行为，不能改成 true", () => {
    expect(readLabsFlag(LABS_HUMAN_DOCS_TABLES)).toBe(false);
    const { result } = renderHook(() => useHumanDocsTablesEnabled());
    expect(result.current).toBe(false);
  });

  it("显式打开才放行，且能再关回去", () => {
    const { result } = renderHook(() => useHumanDocsTablesEnabled());
    act(() => setLabsFlag(LABS_HUMAN_DOCS_TABLES, true));
    expect(result.current).toBe(true);
    expect(readLabsFlag(LABS_HUMAN_DOCS_TABLES)).toBe(true);
    act(() => setLabsFlag(LABS_HUMAN_DOCS_TABLES, false));
    expect(result.current).toBe(false);
  });

  it("忽略脏值，只有字面 true 才算开", () => {
    memory.set("agentcore:labs.humanDocsTables", '"true"');
    expect(readLabsFlag(LABS_HUMAN_DOCS_TABLES)).toBe(false);
    memory.set("agentcore:labs.humanDocsTables", "not json");
    expect(readLabsFlag(LABS_HUMAN_DOCS_TABLES)).toBe(false);
  });
});

describe("HumanDocsTablesGate", () => {
  function renderDocRoute() {
    return render(
      <MemoryRouter initialEntries={["/docs"]}>
        <Routes>
          <Route
            path="/docs"
            element={
              <HumanDocsTablesGate>
                <div>editor</div>
              </HumanDocsTablesGate>
            }
          />
          <Route path="/files" element={<div>files</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("关闭时 /docs 收向 /files，用户看不到编辑器", () => {
    renderDocRoute();
    expect(screen.getByText("files")).toBeTruthy();
    expect(screen.queryByText("editor")).toBeNull();
  });

  it("打开后放行 /docs", () => {
    act(() => setLabsFlag(LABS_HUMAN_DOCS_TABLES, true));
    renderDocRoute();
    expect(screen.getByText("editor")).toBeTruthy();
    expect(screen.queryByText("files")).toBeNull();
  });

  it("被重定向到 /files 后不会因开关变化自动跳回（需重新点入口）", () => {
    renderDocRoute();
    expect(screen.getByText("files")).toBeTruthy();
    act(() => setLabsFlag(LABS_HUMAN_DOCS_TABLES, true));
    // 地址已经是 /files，守卫不在活动路由上；这与 MemoryRouter 的真实行为一致。
    expect(screen.getByText("files")).toBeTruthy();
  });
});
