import { StreamError, describeError } from "@/lib/errors";
import { type FileSource, baseName } from "@/lib/fileSource";
import { ApiError, NetworkError } from "@/services/api";

/**
 * 批量文件动作的执行与结果口径。
 *
 * 后端没有批量端点，批量必然是**逐项调既有单项端点**，所以「部分成功」是常态而非例外。这里
 * 强制把每一项的成败都留在结果里：调用方拿到的是 `{done, failures[]}`，没有「一条 toast 说
 * 整批失败」这个选项，也没有静默跳过——失败项连名字带原因一起报出去。
 */

/** 一项失败：路径 + 显示名 + 用户能看懂的原因。 */
export interface BatchFailure {
  path: string;
  name: string;
  reason: string;
}

export interface BatchOutcome {
  /** 真正做成的项数。 */
  done: number;
  failures: BatchFailure[];
}

/**
 * 把一项失败成文。
 *
 * 后端 / 网络错误交给共享的 {@link describeError}（与单项操作的 toast 同一套 zh 口径）；本地
 * 抛出的判断（同名冲突、粘到自己里面…）自带用户可读原因，直接用它——走 describeError 会被
 * 「操作失败，请重试」这类兜底吞掉，那正是「看不到为什么失败」的来源。
 */
export function batchFailureReason(err: unknown): string {
  if (
    err instanceof ApiError ||
    err instanceof NetworkError ||
    err instanceof StreamError
  ) {
    const described = describeError(err);
    if (described?.message) return described.message;
  }
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return "未知原因";
}

/**
 * 逐项跑一个批量动作（**串行**：并发打同一个工作区既容易撞限流，也让失败归因变糊）。
 * 单项抛错只记一笔失败，绝不中断整批——中断会把后面的项变成「既没做也没说」。
 */
export async function runBatch(
  paths: readonly string[],
  op: (path: string) => Promise<void>,
): Promise<BatchOutcome> {
  const failures: BatchFailure[] = [];
  let done = 0;
  for (const path of paths) {
    try {
      await op(path);
      done++;
    } catch (e) {
      failures.push({
        path,
        name: baseName(path),
        reason: batchFailureReason(e),
      });
    }
  }
  return { done, failures };
}

/** 合并（先算好的跳过项 + 实跑结果），顺序保持「跳过在前」。 */
export function withSkipped(
  skipped: readonly BatchFailure[],
  outcome: BatchOutcome,
): BatchOutcome {
  if (skipped.length === 0) return outcome;
  return { done: outcome.done, failures: [...skipped, ...outcome.failures] };
}

/**
 * 删除后还能不能捞回来——单项删除与批量删除共用一句，免得两条路径对同一个源给出不同承诺。
 * 按能力位成文（`snapshots` = 云端软删区；`watch` = 本地 FS 系统回收站），不猜源类型。
 */
export function deleteRestoreHint(source: FileSource): string {
  if (source.caps.snapshots) return "可从软删区还原。";
  if (source.caps.watch) return "可从系统回收站还原。";
  return "此操作不可撤销。";
}

/**
 * 结果标题：全成功 / 部分失败 / 全失败三态都报数。部分失败**不**说成「已完成」，也不
 * 说成「失败」——两种说法各撒一半谎。
 */
export function batchResultTitle(verb: string, outcome: BatchOutcome): string {
  const failed = outcome.failures.length;
  if (failed === 0) return `已${verb} ${outcome.done} 项`;
  if (outcome.done === 0) return `${failed} 项${verb}失败`;
  return `已${verb} ${outcome.done} 项，${failed} 项失败`;
}
