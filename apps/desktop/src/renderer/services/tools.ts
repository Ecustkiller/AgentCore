import { api } from "@/services/api";

/** Tool governance level (mirrors backend ``ToolApproval``). */
export type ToolApproval = "never" | "grantable" | "always";

/** Tool grouping (mirrors backend ``ToolCategory``). */
export type ToolCategory =
  | "filesystem"
  | "search"
  | "execution"
  | "research"
  | "orchestration";

export interface ToolInfo {
  name: string;
  description: string;
  category: ToolCategory;
  approval: ToolApproval;
  /** JSON Schema the model fills to call the tool. */
  parameters: Record<string, unknown>;
}

interface ToolListResponse {
  data: ToolInfo[];
  total: number;
}

/** Load the platform's built-in tool catalog (read-only). */
export async function listTools(): Promise<ToolInfo[]> {
  const res = await api.get<ToolListResponse>("/v1/tools");
  return res.data;
}
