// BYOK 多服务商配置 REST for the mobile client (设置·模型配置).
//
// Account default combination lives on `/v1/users/me/llm-model-profiles`
// (`default_model_profile_id`); this module only covers provider CRUD + deployment caps.
// REST DTOs track OpenAPI via @agentcore/contract-rest-types.
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** Settings view of one BYOK provider — never the plaintext key. */
export type LlmProviderView = Schemas["LlmProviderView"];

/** The full 设置·模型配置 provider state + deployment caps. */
export type LlmProvidersResponse = Schemas["LlmProvidersResponse"];

/** Add one provider (first provider auto-becomes the chat default). `api_key` required. */
export type CreateLlmProviderInput = Schemas["CreateLlmProviderRequest"];

/** Partial update — omit `api_key` to keep the stored ciphertext (edit endpoint/model). */
export type UpdateLlmProviderInput = Schemas["UpdateLlmProviderRequest"];

/** Same phrasing as desktop LoginPage — admin sessions cannot use product APIs. */
export const ADMIN_PRODUCT_FORBIDDEN_MESSAGE =
  "此账号为管理员账号，请使用管理后台登录";

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    if (body.error?.code === "ADMIN_PRODUCT_FORBIDDEN") {
      return ADMIN_PRODUCT_FORBIDDEN_MESSAGE;
    }
    return body.error?.message ?? `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

async function readProviders(
  res: Response,
  fallback: string,
): Promise<LlmProvidersResponse> {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return (await res.json()) as LlmProvidersResponse;
}

async function readProvider(
  res: Response,
  fallback: string,
): Promise<LlmProviderView> {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return (await res.json()) as LlmProviderView;
}

/** List the account's providers + deployment capabilities. */
export async function listLlmProviders(): Promise<LlmProvidersResponse> {
  return readProviders(
    await apiFetch("/v1/users/me/llm-providers"),
    "加载失败",
  );
}

/** Add one OpenAI-compatible provider (returns the created provider view). */
export async function createLlmProvider(
  input: CreateLlmProviderInput,
): Promise<LlmProviderView> {
  const res = await apiFetch("/v1/users/me/llm-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readProvider(res, "保存失败");
}

/** Update one provider (endpoint / model / label; key optional to keep). */
export async function updateLlmProvider(
  id: string,
  input: UpdateLlmProviderInput,
): Promise<LlmProviderView> {
  const res = await apiFetch(`/v1/users/me/llm-providers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return readProvider(res, "保存失败");
}

/** Remove one provider. */
export async function deleteLlmProvider(id: string): Promise<void> {
  const res = await apiFetch(`/v1/users/me/llm-providers/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await errorMessage(res, "删除失败"));
}

/** Probe one provider's endpoint and persist 'active' / 'error' + supports_tools. */
export async function testLlmProvider(id: string): Promise<LlmProviderView> {
  const res = await apiFetch(`/v1/users/me/llm-providers/${id}/test`, {
    method: "POST",
  });
  return readProvider(res, "测试失败");
}
