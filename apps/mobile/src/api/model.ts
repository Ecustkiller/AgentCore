// BYOK model-key REST for the mobile client (设置·模型配置).
//
// The user supplies their own DeepSeek API key (backend config.billing_mode "byok");
// without one, turns can't run — so this page is load-bearing on mobile, not just a
// convenience. REST DTOs track OpenAPI via @agentcore/contract-rest-types.
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** Settings view of the key — never the plaintext. */
export type LlmKeyStatus = Schemas["LlmKeyStatusResponse"];

async function readStatus(
  res: Response,
  fallback: string,
): Promise<LlmKeyStatus> {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return (await res.json()) as LlmKeyStatus;
}

/** Current key state (configured? last-4? last connectivity result?). */
export async function getLlmKey(): Promise<LlmKeyStatus> {
  return readStatus(await apiFetch("/v1/users/me/llm-key"), "加载失败");
}

/** Store or replace the key (encrypted at rest; resets status to 'unchecked'). */
export async function setLlmKey(apiKey: string): Promise<LlmKeyStatus> {
  const res = await apiFetch("/v1/users/me/llm-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  return readStatus(res, "保存失败");
}

/** Remove the stored key (BYOK turns then refuse until one is set again). */
export async function clearLlmKey(): Promise<void> {
  const res = await apiFetch("/v1/users/me/llm-key", { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res, "删除失败"));
}

/** Probe DeepSeek with the stored key; persists + returns 'active' / 'error'. */
export async function testLlmKey(): Promise<LlmKeyStatus> {
  const res = await apiFetch("/v1/users/me/llm-key/test", { method: "POST" });
  return readStatus(res, "测试失败");
}

/** Prefer the backend's user-facing `{error:{message}}` over a generic fallback. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}
