import type { McpServerListItem } from "@shared/mcp-contract";
import { useCallback, useEffect, useState } from "react";

/** Local desktop MCP configuration and best-effort runtime handshake status. */
export function useMcpConnectors() {
  const api = typeof window !== "undefined" ? window.mcpApi : undefined;
  const [servers, setServers] = useState<McpServerListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!api?.listServers);

  const reload = useCallback(async () => {
    if (!api?.listServers) return;
    try {
      const res = await api.listServers();
      if (!res.ok) {
        setError(res.error.detail);
        setLoaded(true);
        return;
      }
      setError(null);
      setServers(res.servers);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { api, servers, error, loaded, reload, setError };
}
