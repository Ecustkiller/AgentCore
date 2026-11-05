import type { McpServerListItem } from "@shared/mcp-contract";

export interface McpAvailability {
  label: string;
  tone: "muted" | "success" | "destructive";
}

/**
 * Compact, honest MCP state for discovery surfaces such as the slash menu.
 *
 * "Enabled" is deliberately distinct from "connected": a local config can be
 * valid before any server has completed a handshake. Failures win over success
 * counts because that is the state the user needs to act on.
 */
export function describeMcpAvailability({
  desktop,
  loaded,
  error,
  servers,
}: {
  desktop: boolean;
  loaded: boolean;
  error: string | null;
  servers: readonly McpServerListItem[];
}): McpAvailability {
  if (!desktop) return { label: "仅桌面", tone: "muted" };
  if (!loaded) return { label: "检查中", tone: "muted" };
  if (error) return { label: "读取失败", tone: "destructive" };

  const enabled = servers.filter((server) => server.enabled);
  const failed = enabled.filter(
    (server) => server.runtimeStatus === "failed" || server.runtimeError,
  );
  if (failed.length > 0) {
    return { label: `${failed.length} 个异常`, tone: "destructive" };
  }

  const ready = enabled.filter((server) => server.runtimeStatus === "ready");
  if (ready.length > 0) {
    return {
      label:
        ready.length === enabled.length
          ? `${ready.length} 个已连接`
          : `${ready.length}/${enabled.length} 已连接`,
      tone: "success",
    };
  }
  if (enabled.length > 0) {
    return { label: `${enabled.length} 个已启用`, tone: "muted" };
  }
  return { label: "未连接", tone: "muted" };
}
