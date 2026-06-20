// 回合产物盘点 —— 聊天流内联「本回合改动的文件」卡的纯数据源。
//
// Agent 写/改/删/移文件都经 builtin file_ops 工具（file_write / str_replace /
// file_delete / file_move）。这里把已折好的工具步里「成功的文件变更」抽成一张回合级
// 清单：单聊读 message.process 的 tool 步；多 Agent 读 Execution 各 agent（含 CEO captain
// run）的 toolCalls，再与 CEO 直接调用（也落在 process）合并去重。
//
// 纯函数、只读已有运行时状态，不碰协议 fold（故不触发 conformance、零持久化）。卡片
// 只是把「文件去哪了」可视化，真相仍以工作区文件树为准。

import type { Execution } from "@/stores/execution";
import type { ProcessStep } from "@/types/events";

/** 文件变更类型 —— 决定图标 / 文案 / 是否可预览（删除态无文件可看）。 */
export type FileOp = "write" | "edit" | "delete" | "move";

export interface FileArtifact {
  /** 变更后的路径（move 取目的地，其余取 path）；同时作为回合内去重键。 */
  path: string;
  /** 展示用文件名（path 的 basename）。 */
  name: string;
  op: FileOp;
  /** 仅 move：源路径，用于「源 → 目的」展示。 */
  fromPath?: string;
}

/**
 * 写文件的 builtin 工具名 → 变更类型。只读工具（file_read / list 等）与未知/外部
 * 工具不在表内 —— 它们不产出文件，不进卡。
 */
const OP_BY_TOOL: Record<string, FileOp> = {
  file_write: "write",
  str_replace: "edit",
  file_delete: "delete",
  file_move: "move",
};

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 把一次工具调用映射成文件产物；非文件工具 / 未成功 / 缺路径 → null（不进卡）。 */
function artifactFromTool(
  toolName: string,
  args: Record<string, unknown>,
  succeeded: boolean,
): FileArtifact | null {
  if (!succeeded) return null;
  const op = OP_BY_TOOL[toolName];
  if (!op) return null;
  if (op === "move") {
    const to = asStr(args.destination);
    if (!to) return null;
    const from = asStr(args.source);
    return { path: to, name: basename(to), op, fromPath: from || undefined };
  }
  const path = asStr(args.path);
  if (!path) return null;
  return { path, name: basename(path), op };
}

/**
 * 按最终路径折叠：同一文件回合内多次改只留最后一次动作（= 回合终态），保留首见顺序。
 * 幂等，故可对已去重的列表再 merge 而不出错。
 */
function dedupe(ordered: FileArtifact[]): FileArtifact[] {
  const byPath = new Map<string, FileArtifact>();
  const order: string[] = [];
  for (const a of ordered) {
    if (!byPath.has(a.path)) order.push(a.path);
    byPath.set(a.path, a);
  }
  return order.map((p) => byPath.get(p) as FileArtifact);
}

/** 单聊：从内联过程时间线（message.process）抽成功的文件变更。 */
export function fileArtifactsFromProcess(
  process: ProcessStep[] | undefined,
): FileArtifact[] {
  if (!process?.length) return [];
  const out: FileArtifact[] = [];
  for (const step of process) {
    if (step.kind !== "tool") continue;
    const a = artifactFromTool(
      step.tool_name,
      step.arguments,
      step.status === "success",
    );
    if (a) out.push(a);
  }
  return dedupe(out);
}

/** 多 Agent：从团队执行快照各 agent（含 CEO captain run）的 toolCalls 跨 worker 汇总。 */
export function fileArtifactsFromExecution(
  execution: Execution | null,
): FileArtifact[] {
  if (!execution) return [];
  const out: FileArtifact[] = [];
  for (const agent of execution.agents) {
    for (const tc of agent.toolCalls) {
      const a = artifactFromTool(
        tc.toolName,
        tc.arguments,
        tc.status === "success",
      );
      if (a) out.push(a);
    }
  }
  return dedupe(out);
}

/** 合并多个来源（如多 Agent 回合的 CEO process + 团队 execution）后统一去重。 */
export function mergeArtifacts(...lists: FileArtifact[][]): FileArtifact[] {
  return dedupe(lists.flat());
}
