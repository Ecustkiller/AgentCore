/**
 * 流式 Markdown 的「已完成前缀 / 在写尾块」切分（流式渲染性能）。
 *
 * 回合流式期间，`Markdown` 每收到一批 delta 就重渲染一次；若每次都把累积的全文重新解析，
 * 整轮是 O(n²)。这里把内容切成一个**冻结前缀** `stable`（已写完的块）+ 一个**在写尾块**
 * `tail`，配合记忆化：前缀仅在「又写完一个块」时才重解析，每批 delta 只重解析很小的尾块。
 *
 * 安全性：只在**栅栏代码块之外**、且**下一非空行不是列表/引用/缩进续行**的空行处切分，因此
 * 两侧各自都是「独立合法的 Markdown」——冻结前缀的渲染结果与它在整篇文档里时完全一致，松散
 * 列表 / 多行引用 / 代码块都不会被从中劈开。调用方对**收尾后的最终内容仍按整篇渲染一次**，
 * 故本切分保守漏掉的跨块引用（如 `[ref]` 链接定义）会在终态被正确解析。
 */
export interface StreamingSplit {
  /** 已写完、可冻结的前缀（含其后的空行）；无完整块时为空串。 */
  stable: string;
  /** 仍在写的尾块（最后一个块边界之后的全部内容）。 */
  tail: string;
}

/** 续行：列表项 / 有序列表项 / 引用 / 缩进（≥2 空格或 Tab）。绝不在这类行之前切分，
 *  以免把松散列表、多行引用、缩进代码从中劈开。 */
const CONTINUATION = /^(?:\s*(?:[-*+]|\d+[.)])\s|>|\s{2,}\S|\t)/;
/** 栅栏围栏：``` 或 ~~~（长度 ≥ 3），允许少量前导空格。 */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * 把流式内容切成 `{ stable, tail }`，恒满足 `stable + tail === content`。
 *
 * 仅供流式期调用；收尾后整篇渲染，无需切分。
 */
export function splitStreamingMarkdown(content: string): StreamingSplit {
  // 连一个空行都没有 → 没有可冻结的完整块，整体当尾块。
  if (!content.includes("\n\n")) return { stable: "", tail: content };

  const lines = content.split("\n");
  // 每行在原串中的起始字符下标（用于把行号换算回切分点）。
  const starts = new Array<number>(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = off;
    off += lines[i].length + 1; // +1 为被 split 掉的 "\n"
  }

  let inFence = false;
  let fenceChar = "";
  let boundary = 0; // tail 的起始字符下标；保留 0 表示无可冻结前缀
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) continue;
    if (lines[i].trim() !== "") continue;

    // 一个栅栏外的空行：找它之后的下一非空行来判定能否在此切。
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length) break; // 末尾只剩空行——其后无内容可冻结
    if (CONTINUATION.test(lines[j])) continue; // 是续行 → 保持整组不切
    boundary = starts[j];
  }

  if (boundary <= 0) return { stable: "", tail: content };
  return { stable: content.slice(0, boundary), tail: content.slice(boundary) };
}
