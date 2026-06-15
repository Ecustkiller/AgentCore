import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

/**
 * BYOK DeepSeek API key management (设置·模型配置).
 *
 * The user supplies their own DeepSeek key (config.billing_mode "byok"); the
 * server stores only AES-256-GCM ciphertext and ever echoes just the last 4
 * chars. REST types are GENERATED from the backend OpenAPI spec
 * (`types/api.generated.ts`, via `pnpm gen:api`) so they track `api/schemas.py`
 * with zero hand-written drift (API 开发规范).
 */

type Schemas = components["schemas"];

/** The settings view of the user's key (status dot + last-4); never the plaintext. */
export type LlmKeyStatus = Schemas["LlmKeyStatusResponse"];

/** Current key state: configured? last-4? last connectivity result? */
export function getLlmKey(): Promise<LlmKeyStatus> {
  return api.get<LlmKeyStatus>("/v1/users/me/llm-key");
}

/** Store or replace the key (encrypted at rest; resets status to 'unchecked'). */
export function setLlmKey(apiKey: string): Promise<LlmKeyStatus> {
  return api.put<LlmKeyStatus>("/v1/users/me/llm-key", { api_key: apiKey });
}

/** Remove the stored key (BYOK turns then refuse until one is set again). */
export function clearLlmKey(): Promise<{ status: string }> {
  return api.delete<{ status: string }>("/v1/users/me/llm-key");
}

/** Probe DeepSeek with the stored key; persists + returns 'active' / 'error'. */
export function testLlmKey(): Promise<LlmKeyStatus> {
  return api.post<LlmKeyStatus>("/v1/users/me/llm-key/test");
}
