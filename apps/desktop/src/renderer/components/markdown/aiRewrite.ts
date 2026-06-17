/**
 * AI 选区改写的纯文本辅助：从编辑器状态抽出「选区 + 前后文」，喂给后端 rewrite 端点。
 *
 * 只读 CodeMirror 状态、不产生副作用——改写的落地（替换选区 + `@codemirror/merge`
 * 评审）由 {@link MarkdownSourceEditor} 的命令式句柄负责。
 */

import type { EditorState } from "@codemirror/state";

/** 选区及其前后文（字符偏移 + 文本切片）。 */
export interface SelectionContext {
  /** 选区在文档中的起止偏移（应用改写 / 校验选区未变时用）。 */
  from: number;
  to: number;
  /** 选中文本本身。 */
  selection: string;
  /** 选区之前的上下文（已截断）。 */
  contextBefore: string;
  /** 选区之后的上下文（已截断）。 */
  contextAfter: string;
}

/** 前后文各取多少字符喂给模型：够衔接语气/术语，又不让 prompt 失控膨胀。 */
const DEFAULT_CONTEXT_CHARS = 1500;

/**
 * 从当前主选区抽出 {@link SelectionContext}；无选区（光标空选）返回 `null`。
 *
 * 上下文按字符数对称截断（`ctxChars`），直接从 `Text` 切片——大文档也不全量
 * 字符串化。
 */
export function sliceSelectionContext(
  state: EditorState,
  ctxChars: number = DEFAULT_CONTEXT_CHARS,
): SelectionContext | null {
  const { from, to } = state.selection.main;
  if (from === to) return null;
  const doc = state.doc;
  return {
    from,
    to,
    selection: doc.sliceString(from, to),
    contextBefore: doc.sliceString(Math.max(0, from - ctxChars), from),
    contextAfter: doc.sliceString(to, Math.min(doc.length, to + ctxChars)),
  };
}
