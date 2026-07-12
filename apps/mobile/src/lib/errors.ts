/**
 * Mobile error triage for chat transport refusals (parity with desktop
 * `lib/errors.ts` · RetryBanner「去配置」). Shared code catalog from
 * `@agentcore/contract-types` so both clients route the same BYOK codes.
 */
import { KEY_CONFIG_ERROR_CODES } from "@agentcore/contract-types";

/** One-click remedy that routes the user to fix the cause (not a retry). */
export interface ErrorAction {
  label: string;
  href: string;
}

/** Mobile model-config route (对齐桌面 `/more/model`). */
export const MODEL_CONFIG_PATH = "/more/model";

/**
 * A non-OK SSE channel response that arrived as plain JSON
 * `{ error: { code, message } }` (e.g. 402 LLM_KEY_REQUIRED before the stream
 * opens) rather than an event stream.
 */
export class StreamHttpError extends Error {
  constructor(
    public status: number,
    public code?: string,
    public serverMessage?: string,
  ) {
    super(serverMessage ?? `请求失败 (${status})`);
    this.name = "StreamHttpError";
  }
}

/** Map a backend error `code` to the model-config remedy, or null. */
export function errorActionForCode(
  code: string | undefined,
): ErrorAction | null {
  if (
    code !== undefined &&
    (KEY_CONFIG_ERROR_CODES as readonly string[]).includes(code)
  ) {
    return { label: "去配置", href: MODEL_CONFIG_PATH };
  }
  return null;
}

/** zh message + optional「去配置」 for a refused SSE turn. */
export function describeStreamHttpError(err: StreamHttpError): {
  message: string;
  action: ErrorAction | null;
} {
  let message: string;
  if (err.code === "LLM_KEY_REQUIRED") {
    message =
      err.serverMessage ??
      "请先在「设置 · 模型配置」中填入你的 API Key，再发起对话。";
  } else if (err.serverMessage) {
    message = err.serverMessage;
  } else {
    message = `请求失败 (${err.status})`;
  }
  return { message, action: errorActionForCode(err.code) };
}

/**
 * 账号是否已具备发消息的模型接入 —— 与桌面 `hasModelAccess` 对齐。
 * `configured` 覆盖 BYOK；`billing_mode === "platform"` 覆盖平台代付路径，
 * 避免代付用户在聊天空态被误判为「未配置」而看到接入引导。
 */
export function hasModelAccess(
  status:
    | { configured?: boolean | null; billing_mode?: string | null }
    | null
    | undefined,
): boolean {
  if (!status) return false;
  if (status.configured) return true;
  return status.billing_mode === "platform";
}

/**
 * Draft / empty-chat copy given BYOK key status. Pure helper so the empty-state
 * branch stays unit-testable without mounting ChatPage.
 */
export function emptyChatCopy(configured: boolean): {
  title: string;
  subtitle: string;
  action: ErrorAction | null;
} {
  if (!configured) {
    return {
      title: "先连接你的模型",
      subtitle: "在「更多 → 模型配置」填入你的 API Key，即可开始对话。",
      action: { label: "去配置", href: MODEL_CONFIG_PATH },
    };
  }
  return {
    title: "开始新对话",
    subtitle: "向你的 Agent 团队提问，或交派一个任务。",
    action: null,
  };
}
