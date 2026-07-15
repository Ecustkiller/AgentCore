import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

/**
 * BYOK OpenAI-compatible LLM configuration (设置·模型配置).
 *
 * The user supplies api_key + base_url + default_model; the server stores only
 * AES-256-GCM ciphertext and ever echoes just the last 4 chars of the key.
 * REST types are generated from the backend OpenAPI spec (`pnpm gen:types`).
 */

type Schemas = components["schemas"];

/**
 * The settings view of the user's key (status dot + last-4); never the plaintext.
 *
 * `free_tier_active`（§每月免费额度）: true when the user has no BYOK key ∧ platform
 * free tier is on ∧ platform credentials exist — keyless users can chat on free quota.
 */
export type LlmKeyStatus = Schemas["LlmKeyStatusResponse"];

export type SetLlmKeyInput = Schemas["SetLlmKeyRequest"];

/** Current key state: configured? endpoint? model? connectivity + tool hint? */
export function getLlmKey(): Promise<LlmKeyStatus> {
  return api.get<LlmKeyStatus>("/v1/users/me/llm-key");
}

/** Store or replace the configuration (encrypted at rest; resets status to 'unchecked'). */
export function setLlmKey(input: SetLlmKeyInput): Promise<LlmKeyStatus> {
  return api.put<LlmKeyStatus>("/v1/users/me/llm-key", input);
}

/** Remove the stored key (BYOK turns then refuse until one is set again). */
export function clearLlmKey(): Promise<{ status: string }> {
  return api.delete<{ status: string }>("/v1/users/me/llm-key");
}

/** Probe the configured endpoint; persists + returns 'active' / 'error' + supports_tools. */
export function testLlmKey(): Promise<LlmKeyStatus> {
  return api.post<LlmKeyStatus>("/v1/users/me/llm-key/test");
}

/** Switch between platform free quota and BYOK. */
export function setBillingPreference(
  billing_preference: "platform" | "byok",
): Promise<LlmKeyStatus> {
  return api.put<LlmKeyStatus>("/v1/users/me/llm-key/billing-preference", {
    billing_preference,
  });
}
