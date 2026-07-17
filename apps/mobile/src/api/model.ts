// BYOK model configuration REST for the mobile client (设置·模型配置).
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** Settings view of the key — never the plaintext. */
export type LlmKeyStatus = Schemas["LlmKeyStatusResponse"];

export interface SetLlmKeyInput {
  api_key?: string | null;
  base_url?: string | null;
  default_model?: string | null;
  price_cache_hit?: string | null;
  price_cache_miss?: string | null;
  price_output?: string | null;
  background_model?: string | null;
}

async function readStatus(
  res: Response,
  fallback: string,
): Promise<LlmKeyStatus> {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return (await res.json()) as LlmKeyStatus;
}

export async function getLlmKey(): Promise<LlmKeyStatus> {
  return readStatus(await apiFetch("/v1/users/me/llm-key"), "加载失败");
}

export async function setLlmKey(input: SetLlmKeyInput): Promise<LlmKeyStatus> {
  const res = await apiFetch("/v1/users/me/llm-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readStatus(res, "保存失败");
}

export async function clearLlmKey(): Promise<void> {
  const res = await apiFetch("/v1/users/me/llm-key", { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res, "删除失败"));
}

export async function testLlmKey(): Promise<LlmKeyStatus> {
  const res = await apiFetch("/v1/users/me/llm-key/test", { method: "POST" });
  return readStatus(res, "测试失败");
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}
