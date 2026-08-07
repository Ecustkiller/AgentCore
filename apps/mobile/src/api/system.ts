// Build provenance for the mobile client (设置·关于). Mirrors the desktop
// services/system.ts against the backend GET /version probe.
//
// M17 exemption: OpenAPI `/version` 200 is an anonymous `Record<string, string>`
// (no named schema); camelCase {@link VersionInfo} is a client projection.
import { apiUrl } from "@/api/client";

export interface VersionInfo {
  version: string;
  gitSha: string;
  builtAt: string;
}

/** Wire shape inferred from the probe body (not a named OpenAPI schema). */
interface BackendVersion {
  version: string;
  git_sha: string;
  built_at: string;
}

/** Semantic version + git SHA + build time. `gitSha` / `builtAt` are "unknown" on an
 *  un-stamped (local dev) build. Public probe — no auth needed. */
export async function fetchVersion(): Promise<VersionInfo> {
  const res = await fetch(apiUrl("/version"));
  if (!res.ok) throw new Error(`获取版本信息失败 (${res.status})`);
  const v = (await res.json()) as BackendVersion;
  return { version: v.version, gitSha: v.git_sha, builtAt: v.built_at };
}
