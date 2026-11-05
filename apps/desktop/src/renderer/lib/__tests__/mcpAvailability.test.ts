import { describeMcpAvailability } from "@/lib/mcpAvailability";
import type { McpServerListItem } from "@shared/mcp-contract";
import { describe, expect, it } from "vitest";

function server(
  id: string,
  overrides: Partial<McpServerListItem> = {},
): McpServerListItem {
  return {
    id,
    name: id,
    enabled: true,
    command: "npx",
    args: [],
    ...overrides,
  };
}

describe("describeMcpAvailability", () => {
  it("distinguishes desktop-only, loading, and read failures", () => {
    expect(
      describeMcpAvailability({
        desktop: false,
        loaded: true,
        error: null,
        servers: [],
      }),
    ).toEqual({ label: "仅桌面", tone: "muted" });
    expect(
      describeMcpAvailability({
        desktop: true,
        loaded: false,
        error: null,
        servers: [],
      }),
    ).toEqual({ label: "检查中", tone: "muted" });
    expect(
      describeMcpAvailability({
        desktop: true,
        loaded: true,
        error: "读配置失败",
        servers: [],
      }),
    ).toEqual({ label: "读取失败", tone: "destructive" });
  });

  it("shows enabled, connected, and failed counts without overstating readiness", () => {
    expect(
      describeMcpAvailability({
        desktop: true,
        loaded: true,
        error: null,
        servers: [server("a"), server("b")],
      }),
    ).toEqual({ label: "2 个已启用", tone: "muted" });

    expect(
      describeMcpAvailability({
        desktop: true,
        loaded: true,
        error: null,
        servers: [
          server("a", { runtimeStatus: "ready" }),
          server("b", { runtimeStatus: "ready" }),
        ],
      }),
    ).toEqual({ label: "2 个已连接", tone: "success" });

    expect(
      describeMcpAvailability({
        desktop: true,
        loaded: true,
        error: null,
        servers: [
          server("a", { runtimeStatus: "ready" }),
          server("b", { runtimeStatus: "failed" }),
          server("off", { enabled: false, runtimeStatus: "failed" }),
        ],
      }),
    ).toEqual({ label: "1 个异常", tone: "destructive" });
  });
});
