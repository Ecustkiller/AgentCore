import { BASE_URL, api } from "@/services/api";
import type { SidecarFoldersAuth } from "@shared/sidecar-contract";

/**
 * 桌面侧「folders 窄票」获取器（定案甲 · sidecar 问云账号名册）。
 *
 * 与 {@link ./inferenceToken.ts} 同构：cookie 会话兑换作用域受限的短期令牌，拼出 sidecar
 * 需要的 `{baseUrl, apiKey}`——**绝不**把 access / cookie 打进 sidecar。
 *
 * - `baseUrl` = `${BASE_URL}/v1/folders`：folders 集合 URL（与 server sidecar 解析约定一致）。
 * - `apiKey` = folders 窄票本身（非平台 key / 非 access）。
 *
 * 铸票路径 `POST /v1/folders/token`，响应 `{token, expires_in_sec}`（亦兼容 `expires_at`）。
 * TTL+skew 内复用；`startTurn` / `resume` 走缓存。鉴权失败时由调用方
 * `clearSidecarFoldersAuth` + `force: true` remint 一次（见 `streamConversationViaSidecar`）。
 */

interface FoldersTokenResponse {
  token: string;
  /** ISO-8601 或 unix 秒/毫秒（server 落地形态）。 */
  expires_at?: string | number;
  /** 与 inference 铸票同形时的备选字段。 */
  expires_in_sec?: number;
}

/** 已缓存的令牌与其绝对过期时刻（ms）。null = 尚未铸过 / 已失效。 */
let cached: { token: string; expiresAtMs: number } | null = null;

const RENEW_SKEW_MS = 60_000;

function expiresAtMsFromResponse(res: FoldersTokenResponse): number {
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
    // Heuristic: values that look like ms since epoch vs unix seconds.
    return res.expires_at > 1e12 ? res.expires_at : res.expires_at * 1000;
  }
  // No expiry in body → treat as already stale so the next resolve remints.
  return Date.now();
}

async function mint(): Promise<{ token: string; expiresAtMs: number }> {
  const res = await api.post<FoldersTokenResponse>("/v1/folders/token");
  if (!res?.token || typeof res.token !== "string" || !res.token.trim()) {
    throw new Error("folders token response missing token");
  }
  return {
    token: res.token.trim(),
    expiresAtMs: expiresAtMsFromResponse(res),
  };
}

export interface ResolveSidecarFoldersAuthOptions {
  /** 跳过缓存、立刻向云端兑换新令牌（401 remint 用）。 */
  force?: boolean;
}

/**
 * 解析出一次本地回合可用的 folders 云名册凭据；取不到则返回 `null`。
 *
 * 取不到时由调用方带 `undefined`——工具侧无凭据走旧行为 / 诚实失败，勿假装成功。
 */
export async function resolveSidecarFoldersAuth(
  options?: ResolveSidecarFoldersAuthOptions,
): Promise<SidecarFoldersAuth | null> {
  try {
    const force = options?.force === true;
    if (force || !cached || cached.expiresAtMs - RENEW_SKEW_MS <= Date.now()) {
      cached = await mint();
    }
    return {
      baseUrl: `${BASE_URL}/v1/folders`,
      apiKey: cached.token,
    };
  } catch (err) {
    console.error("[sidecar] 取 folders 令牌失败", err);
    cached = null;
    return null;
  }
}

/** 丢弃缓存令牌（登出 / 鉴权失败后调），使下次回合重新兑换。 */
export function clearSidecarFoldersAuth(): void {
  cached = null;
}

/** 文案 / 错误码是否像「folders 窄票失效」（云名册 401/403）。 */
export function looksLikeFoldersTokenFailure(err: unknown): boolean {
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
    lower.includes("folders_cloud_unauthorized") ||
    (lower.includes("folders") &&
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
    (err as { code?: string }).code === "folders_cloud_unauthorized"
  ) {
    return true;
  }
  return false;
}
