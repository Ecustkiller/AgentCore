import { BASE_URL, api } from "@/services/api";
import type { SidecarWorkspacesAuth } from "@shared/sidecar-contract";

/**
 * 桌面侧「workspaces 窄票」获取器（sidecar 坐无本机绑定的云桌时写云卷）。
 *
 * 与 {@link ./foldersToken.ts} / {@link ./accountToken.ts} 同构：cookie 会话兑换
 * 作用域受限的短期令牌，拼出 sidecar 需要的 `{baseUrl, apiKey}`——**绝不**把
 * access / cookie 打进 sidecar。
 *
 * - `baseUrl` = `${BASE_URL}/v1/workspaces`：工作区文件 REST 根。
 * - `apiKey` = workspaces 窄票本身（非平台 key / 非 access / 非 folders / 非 account）。
 *
 * 铸票路径 `POST /v1/workspaces/token`，响应 `{token, expires_in_sec}`（亦兼容 `expires_at`）。
 * TTL+skew 内复用；`startTurn` / `resume` 走缓存。鉴权失败时由调用方
 * `clearSidecarWorkspacesAuth` + `force: true` remint 一次（见 `streamConversationViaSidecar`）。
 */

interface WorkspacesTokenResponse {
  token: string;
  /** ISO-8601 或 unix 秒/毫秒（server 落地形态）。 */
  expires_at?: string | number;
  /** 与 folders / account / inference 铸票同形时的备选字段。 */
  expires_in_sec?: number;
}

/** 已缓存的令牌与其绝对过期时刻（ms）。null = 尚未铸过 / 已失效。 */
let cached: { token: string; expiresAtMs: number } | null = null;

const RENEW_SKEW_MS = 60_000;

function expiresAtMsFromResponse(res: WorkspacesTokenResponse): number {
  if (
    typeof res.expires_in_sec === "number" &&
    Number.isFinite(res.expires_in_sec)
  ) {
    return Date.now() + res.expires_in_sec * 1000;
  }
  if (typeof res.expires_at === "string" && res.expires_at.trim()) {
    const ms = Date.parse(res.expires_at);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof res.expires_at === "number" && Number.isFinite(res.expires_at)) {
    return res.expires_at > 1e12 ? res.expires_at : res.expires_at * 1000;
  }
  return Date.now();
}

async function mint(): Promise<{ token: string; expiresAtMs: number }> {
  const res = await api.post<WorkspacesTokenResponse>("/v1/workspaces/token");
  if (!res?.token || typeof res.token !== "string" || !res.token.trim()) {
    throw new Error("workspaces token response missing token");
  }
  return {
    token: res.token.trim(),
    expiresAtMs: expiresAtMsFromResponse(res),
  };
}

export interface ResolveSidecarWorkspacesAuthOptions {
  /** 跳过缓存、立刻向云端兑换新令牌（401 remint 用）。 */
  force?: boolean;
}

/**
 * 解析出一次本地回合可用的云桌文件凭据；取不到则返回 `null`。
 *
 * 取不到时由调用方带 `undefined`——工具侧无凭据诚实失败，勿假装成功。
 */
export async function resolveSidecarWorkspacesAuth(
  options?: ResolveSidecarWorkspacesAuthOptions,
): Promise<SidecarWorkspacesAuth | null> {
  try {
    const force = options?.force === true;
    if (force || !cached || cached.expiresAtMs - RENEW_SKEW_MS <= Date.now()) {
      cached = await mint();
    }
    return {
      baseUrl: `${BASE_URL}/v1/workspaces`,
      apiKey: cached.token,
    };
  } catch (err) {
    console.error("[sidecar] 取 workspaces 令牌失败", err);
    cached = null;
    return null;
  }
}

/** 丢弃缓存令牌（登出 / 鉴权失败后调），使下次回合重新兑换。 */
export function clearSidecarWorkspacesAuth(): void {
  cached = null;
}

/** 文案 / 错误码是否像「workspaces 窄票失效」（云桌文件 401/403）。 */
export function looksLikeWorkspacesTokenFailure(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err ?? "");
  const lower = msg.toLowerCase();
  if (
    lower.includes("workspaces_cloud_unauthorized") ||
    (lower.includes("workspaces") &&
      (lower.includes("unauthorized") ||
        lower.includes("401") ||
        lower.includes("403")))
  ) {
    return true;
  }
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "workspaces_cloud_unauthorized"
  ) {
    return true;
  }
  return false;
}
