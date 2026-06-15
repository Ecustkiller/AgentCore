import { api } from "@/services/api";

export interface VersionInfo {
  version: string;
  gitSha: string;
  builtAt: string;
}

// Hand-written on purpose: `/version` has no response_model, so the generated
// type is an untyped `{ [k]: string }` dict — this local shape is the precise contract.
interface BackendVersion {
  version: string;
  git_sha: string;
  built_at: string;
}

/**
 * Build provenance from the backend `/version` probe (semantic version + git
 * SHA + build time). `gitSha` / `builtAt` are "unknown" on an un-stamped build.
 */
export async function fetchVersion(): Promise<VersionInfo> {
  const v = await api.get<BackendVersion>("/version");
  return { version: v.version, gitSha: v.git_sha, builtAt: v.built_at };
}
