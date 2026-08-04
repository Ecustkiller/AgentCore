import {
  type FileArtifact,
  fileArtifactsFromProcess,
  mergeArtifacts,
} from "@/lib/fileArtifacts";
import type { ExecutionJournal } from "@/stores/execution/types";
import type { ProcessStep } from "@/types/events";

/**
 * B′paste：本轮成功写盘产物——复用 fileArtifactsFromProcess（成功 file_* / str_replace）。
 * 多 Agent：合并 journal.runProcesses 各 run（与 unproductive 同源 journal；
 * 勿把 delivery_status 验收 artifacts 当写盘成功）。
 */
export function collectSuccessfulFileWrites(
  process: ProcessStep[] | undefined,
  journal?: ExecutionJournal | null,
): FileArtifact[] {
  const lists: FileArtifact[][] = [fileArtifactsFromProcess(process)];
  const runProcesses = journal?.runProcesses;
  if (runProcesses) {
    for (const steps of Object.values(runProcesses)) {
      lists.push(fileArtifactsFromProcess(steps));
    }
  }
  return mergeArtifacts(...lists);
}

/**
 * 窄启发式：正文像「请用户整文件替换交差」。
 * 禁止扫长文猜意图；宁漏勿误伤真贴码教学。
 */
const WHOLE_FILE_HANDOFF_PATTERNS: readonly RegExp[] = [
  /直接替换整个文件/,
  /请你.{0,40}替换.{0,40}整个文件/,
  /整文件自行粘贴/,
  /自行粘贴.{0,20}整个?文件/,
  /把整个文件.{0,20}替换/,
  /替换整个文件/,
];

export function looksLikeWholeFilePasteHandoff(
  content: string | undefined,
): boolean {
  const text = (content ?? "").trim();
  if (!text) return false;
  return WHOLE_FILE_HANDOFF_PATTERNS.some((re) => re.test(text));
}

/**
 * 窄触发：无写盘成功 + 正文像整文件交差 + 非空正文。
 * 空正文已有合成失败卡时勿叠；流式由挂载方闸。
 */
export function shouldShowWholeFilePasteHint(opts: {
  content: string | undefined;
  hasSuccessfulWrites: boolean;
}): boolean {
  if (opts.hasSuccessfulWrites) return false;
  if (!(opts.content ?? "").trim()) return false;
  return looksLikeWholeFilePasteHandoff(opts.content);
}

/** 人话短句：点明未写入工作区；可忽略。 */
export function formatWholeFilePasteHint(): string {
  return "本轮未写入工作区；聊天整文件≠代改";
}
