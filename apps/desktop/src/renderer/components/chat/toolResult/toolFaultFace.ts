import { resolveToolWireStatus } from "@/lib/channelRedirect";
import { isVerifyBudgetExceeded } from "./verifyBudget";

const EXEC_TOOLS = new Set(["run", "code_execute", "test_run", "terminal"]);

const LOOKUP_TOOLS = new Set([
  "read",
  "file_list",
  "edit",
  "glob",
  "grep",
  "file_delete",
  "file_move",
  "file_copy",
  "file_batch",
  "web_fetch",
  "read_conversation",
  "search_conversations",
]);

/** Collapsed-row / folded-group word for a tool that didn't work. Uncolored.
 *  Only verification/exec failures hang a word (未通过). Lookup misses and
 *  generic faults stay title-only — the path/verb is the identity; copy lives
 *  in the expanded detail. Redirect and verify-incomplete are not this face. */
export function toolRowFaultLabel(step: {
  tool_name: string;
  status: string;
  failure?: { code?: string | null } | null;
  display?: unknown;
}): string | null {
  const status = resolveToolWireStatus(step.status, step.failure);
  if (status !== "error") return null;
  if (isVerifyBudgetExceeded(step.display)) return null;
  if (EXEC_TOOLS.has(step.tool_name)) return "未通过";
  return null;
}

/** File / lookup misses already name the path on the title — skip the extra sentence. */
export function isSelfExplanatoryLookupError(step: {
  tool_name: string;
  status: string;
  failure?: { code?: string | null } | null;
  display?: unknown;
}): boolean {
  const status = resolveToolWireStatus(step.status, step.failure);
  if (status !== "error") return false;
  if (isVerifyBudgetExceeded(step.display)) return false;
  return LOOKUP_TOOLS.has(step.tool_name);
}

/** One word for a collapsed group. Only 未通过 hangs; mixed/other faults stay silent. */
export function toolGroupFaultLabel(
  tools: Array<{
    tool_name: string;
    status: string;
    failure?: { code?: string | null } | null;
    display?: unknown;
  }>,
): string | null {
  for (const t of tools) {
    if (toolRowFaultLabel(t) === "未通过") return "未通过";
  }
  return null;
}
