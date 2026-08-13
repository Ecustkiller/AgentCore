import { ApiError, BASE_URL, api } from "@/services/api";
import type { SidecarInference } from "@shared/sidecar-contract";

/**
 * 桌面侧的「云推理凭据」获取器（双模式工作区 §一.1 / Slice 4a）。
 *
 * sidecar 跑在用户机器上，但平台 LLM key **绝不下放本机**：引擎的 LLM 调用改指向云端推理代理
 * `POST /v1/inference/v1/chat/completions`，以一枚**作用域受限的短期令牌**（inference token）
 * 作 Bearer 鉴权。本模块负责拿这枚令牌并拼出 sidecar 需要的 `{baseUrl, apiKey, model}`：
 *
 * - `baseUrl` = `${BASE_URL}/v1/inference/v1`：`OpenAICompatibleProvider` 在其后拼 `/chat/completions`，
 *   命中代理路由 `/v1/inference/v1/chat/completions`（见服务端 `api/routes/inference/proxy.py`）。
 * - `apiKey` = 令牌本身（非平台 key）。
 * - `model` = 服务端按**该会话**（body `conversation_id`）计费/BYOK 解析的 chat 模型名，
 *   与推理代理对该会话的上游选择一致；无会话 id 时回落账号默认。
 *
 * 令牌经 cookie 会话向 `POST /v1/inference/token` 兑换（与其余 API 同源鉴权）；有会话时 body
 * 传 `{ conversation_id }`。令牌有 TTL（服务端 `inference_token_expire_minutes`，默认 12h）。
 * 缓存按会话键隔离（`null` = 账号默认）：同会话在 TTL+skew 内复用；**会话切换**、临近过期或
 * `force: true`（401 / remint）才重铸。`startTurn` / `resume` 走缓存并传入当前 `conversationId`。
 */

interface InferenceTokenResponse {
  token: string;
  expires_in_sec: number;
  model: string;
}

/** 缓存键：会话 id；`null` = 未带会话（账号默认模型）。 */
type CacheConversationKey = string | null;

/** 已缓存的令牌、会话键与绝对过期时刻（ms）。null = 尚未铸过 / 已失效。 */
let cached: {
  conversationId: CacheConversationKey;
  token: string;
  expiresAtMs: number;
  model: string;
} | null = null;

// 提前续铸的安全余量：在真正过期前 1 分钟就重铸，规避时钟偏移与「铸好到用上」之间的 TTL 损耗。
const RENEW_SKEW_MS = 60_000;

function normalizeConversationKey(
  conversationId: string | null | undefined,
): CacheConversationKey {
  if (typeof conversationId === "string" && conversationId.trim()) {
    return conversationId;
  }
  return null;
}

async function mint(conversationId: CacheConversationKey): Promise<{
  conversationId: CacheConversationKey;
  token: string;
  expiresAtMs: number;
  model: string;
}> {
  const res =
    conversationId != null
      ? await api.post<InferenceTokenResponse>("/v1/inference/token", {
          conversation_id: conversationId,
        })
      : await api.post<InferenceTokenResponse>("/v1/inference/token");
  return {
    conversationId,
    token: res.token,
    expiresAtMs: Date.now() + res.expires_in_sec * 1000,
    model: res.model,
  };
}

export interface ResolveSidecarInferenceOptions {
  /** 跳过缓存、立刻向云端兑换新令牌（401 remint 用）。 */
  force?: boolean;
  /**
   * 当前会话 id：铸票 body `conversation_id`，并使缓存按会话隔离。
   * 省略 / 空 = 账号默认（缓存键 `null`）。
   */
  conversationId?: string | null;
}

/**
 * 解析出一次本地回合可用的云推理凭据；取不到则返回 `null`。
 *
 * 取不到（会话过期 / 服务端不可达等）时由调用方诚实失败：开跑前 force remint 一次仍无票
 * → `INFERENCE_TOKEN_EXPIRED`，不发 startTurn / resume RPC。引擎 `build_turn_router` 亦硬拒
 * 空凭据——无「回落 sidecar 本机平台模型」退路；本机工作区回合亦不得改道云端链路。
 *
 * **例外**：铸票被 CSRF 拒（`CSRF_FAILED`）原样上抛，不回落 `null`——见下方 catch。
 */
export async function resolveSidecarInference(
  options?: ResolveSidecarInferenceOptions,
): Promise<SidecarInference | null> {
  try {
    const force = options?.force === true;
    const conversationKey = normalizeConversationKey(options?.conversationId);
    const cacheHit =
      !force &&
      cached != null &&
      cached.conversationId === conversationKey &&
      cached.expiresAtMs - RENEW_SKEW_MS > Date.now();
    if (!cacheHit) {
      cached = await mint(conversationKey);
    }
    if (cached == null) {
      return null;
    }
    return {
      baseUrl: `${BASE_URL}/v1/inference/v1`,
      apiKey: cached.token,
      model: cached.model,
    };
  } catch (err) {
    cached = null;
    // CSRF 拒是**别的**故障：安全中间件把铸票请求挡在处理器之前，这枚推理票既没过期也没被
    // 撤。吞成 `null` 会让调用方报 `INFERENCE_TOKEN_EXPIRED`，用户读到「推理凭证失效」——
    // 照着这句去重登、去查服务商配置都修不好它。原样上抛，交给统一错误映射说出真因（可自愈
    // 的那种 403 已在 api 层自动重放过一次，能到这里的是后端拒绝补票的那种）。
    if (err instanceof ApiError && err.code === "CSRF_FAILED") {
      throw err;
    }
    console.error("[sidecar] 取推理令牌失败", err);
    return null;
  }
}

/** 丢弃缓存令牌（登出 / 鉴权失败后调），使下次回合重新兑换。 */
export function clearSidecarInference(): void {
  cached = null;
}

/** 文案 / 错误码是否像「推理 JWT 失效」（兼容旧版仍报 LLM_KEY_INVALID 的引擎）。 */
export function looksLikeInferenceTokenFailure(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err ?? "");
  const lower = msg.toLowerCase();
  if (lower.includes("inference token") || lower.includes("inference_token")) {
    return true;
  }
  if (
    lower.includes("推理凭证") &&
    (lower.includes("失效") || lower.includes("过期"))
  ) {
    return true;
  }
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "INFERENCE_TOKEN_EXPIRED"
  ) {
    return true;
  }
  return false;
}
