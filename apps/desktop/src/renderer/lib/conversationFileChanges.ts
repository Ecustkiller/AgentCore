/**
 * 本对话「改动 / 恢复」入场 —— 与 {@link ConversationChangesPanel} /
 * 产物卡同源（process + execution → fileArtifacts），并含 Local zip 基线
 *（不依赖 file_*；脚本删事故仍可进 restore）。
 * 供右坞「改动」tab 条件显隐（前端UX设计.md §十 · P0c）。
 */

import {
  fileArtifactsFromExecution,
  fileArtifactsFromProcess,
  mergeArtifacts,
} from "@/lib/fileArtifacts";
import { assistantProjectionId } from "@/stores/conversation/runtime";
import type { Message } from "@/stores/conversation/types";
import { type ExecutionRuntime, projectRuntime } from "@/stores/execution";

/** 当前对话 messages 是否已有至少一条成功的 AI 文件改动。 */
export function conversationHasFileArtifacts(
  messages: Message[],
  byId: Record<string, ExecutionRuntime>,
): boolean {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const messageId = assistantProjectionId(msg);
    const rt = byId[messageId];
    const execution = rt ? projectRuntime(rt) : null;
    const artifacts = mergeArtifacts(
      fileArtifactsFromProcess(msg.process),
      fileArtifactsFromExecution(execution),
    );
    if (artifacts.length > 0) return true;
  }
  return false;
}

/** 本对话是否有可恢复入口：file_* 产物或（已发现的）回合基线。 */
export function conversationHasRestorableEntry(
  messages: Message[],
  byId: Record<string, ExecutionRuntime>,
  baselineMessageIds: ReadonlySet<string>,
): boolean {
  if (conversationHasFileArtifacts(messages, byId)) return true;
  if (baselineMessageIds.size === 0) return false;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (baselineMessageIds.has(assistantProjectionId(msg))) return true;
  }
  return false;
}

/** 改动 tab 某回合是否应列出（产物 / 基线 / 深链聚焦）。 */
export function shouldIncludeChangesTurn(opts: {
  artifactsLength: number;
  messageId: string;
  baselineMessageIds: ReadonlySet<string>;
  focusMessageId: string | null;
}): boolean {
  if (opts.artifactsLength > 0) return true;
  if (opts.baselineMessageIds.has(opts.messageId)) return true;
  if (opts.focusMessageId != null && opts.messageId === opts.focusMessageId) {
    return true;
  }
  return false;
}
