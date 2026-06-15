import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/** Tool governance level (generated from backend `ToolApproval`). */
export type ToolApproval = Schemas["ToolApproval"];
/** Tool grouping (generated from backend `ToolCategory`). */
export type ToolCategory = Schemas["ToolCategory"];
/** A built-in tool's public catalog entry; `parameters` is the call JSON Schema. */
export type ToolInfo = Schemas["ToolInfo"];

type ToolListResponse = Schemas["ToolListResponse"];

/** Load the platform's built-in tool catalog (read-only). */
export async function listTools(): Promise<ToolInfo[]> {
  const res = await api.get<ToolListResponse>("/v1/tools");
  return res.data;
}
