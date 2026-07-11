/** 论点标题截断上限（展示层）。 */
export const ARGUMENT_TITLE_MAX = 30;

export interface SpeechArgument {
  id: string;
  title: string;
  body: string;
}

/** 截断为一行摘要：优先在句读处断开。 */
export function summarizeText(text: string, maxLen: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= maxLen) return trimmed;

  const slice = trimmed.slice(0, maxLen);
  const lastPunct = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("；"),
    slice.lastIndexOf("，"),
    slice.lastIndexOf("—"),
    slice.lastIndexOf("–"),
  );
  if (lastPunct > maxLen * 0.45) return slice.slice(0, lastPunct + 1);
  return `${slice}…`;
}

/** 从一段发言正文中提取论点标题（首句 / 冒号标签 / 首行）。 */
export function argumentTitle(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";

  const colonMatch = trimmed.match(/^([^：:\n]{2,24}[：:])\s*/);
  if (colonMatch) {
    const label = colonMatch[1].replace(/[：:]$/, "");
    const after = trimmed.slice(colonMatch[0].length);
    const clause = after.split(/[。；—–-]/)[0]?.trim();
    if (clause) return summarizeText(`${label}：${clause}`, ARGUMENT_TITLE_MAX);
    return summarizeText(label, ARGUMENT_TITLE_MAX);
  }

  const firstLine = trimmed.split("\n")[0] ?? "";
  const firstSentence =
    firstLine.split(/[。；]/)[0]?.trim() || firstLine.trim();
  return summarizeText(firstSentence, ARGUMENT_TITLE_MAX);
}

const HEADER_SPLIT = /(?=^#{1,3}\s+)/m;
const NUMBERED_LINE = /^\d+\.\s+/;
const BULLET_LINE = /^[-*•]\s+/;

function splitBlocks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (HEADER_SPLIT.test(trimmed)) {
    return trimmed
      .split(HEADER_SPLIT)
      .map((b) => b.trim())
      .filter(Boolean);
  }

  const lines = trimmed.split("\n");
  const isNumbered = lines.every(
    (l) => !l.trim() || NUMBERED_LINE.test(l.trim()),
  );
  if (isNumbered && lines.filter((l) => l.trim()).length > 1) {
    return lines.map((l) => l.trim()).filter(Boolean);
  }

  const isBullet = lines.every((l) => !l.trim() || BULLET_LINE.test(l.trim()));
  if (isBullet && lines.filter((l) => l.trim()).length > 1) {
    return lines.map((l) => l.trim()).filter(Boolean);
  }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;

  return [trimmed];
}

function titleFromHeaderBlock(block: string): { title: string; body: string } {
  const lines = block.split("\n");
  const head = lines[0]?.replace(/^#{1,3}\s+/, "").trim() ?? "";
  const body = lines.slice(1).join("\n").trim() || head;
  return {
    title: summarizeText(head, ARGUMENT_TITLE_MAX),
    body: body || block,
  };
}

function stripListMarker(line: string): string {
  return line.replace(/^(?:\d+\.\s+|[-*•]\s+)/, "").trim();
}

/**
 * 明显的开场白 / 引导语：仅保守匹配。
 * 拿不准一律返回 false（宁可漏过滤，不可误删真实论点）。
 */
function isOpeningPreamble(block: string): boolean {
  const text = stripListMarker(block)
    .replace(/^#{1,3}\s+/, "")
    .trim();
  if (!text) return false;

  // 「以下是……的立论/论点/观点/论述」类框架句
  if (
    /^以下是[\s\S]{0,48}(?:的)?(?:立论|论点|观点|论述|发言)/.test(text)
  ) {
    return true;
  }

  // 「现在我已有足够信息来构建/提出论点」类过程句
  if (
    /^现在我(?:已|已经)?有足够(?:的)?信息来(?:构建|提出|阐述)(?:论点|立论|观点)?/.test(
      text,
    )
  ) {
    return true;
  }

  // 「接下来我将从以下几个方面阐述」类目录预告（无实质主张）
  if (
    /^(?:接下来|下面)我(?:将|会|来)?从以下(?:几|数)?个?(?:方面|角度|论点|要点)/.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

function blockToArgument(block: string, i: number): SpeechArgument {
  if (/^#{1,3}\s+/.test(block)) {
    const { title, body } = titleFromHeaderBlock(block);
    return { id: `arg-${i}`, title, body };
  }

  const stripped = stripListMarker(block);
  return {
    id: `arg-${i}`,
    title: argumentTitle(stripped),
    body: stripped,
  };
}

/**
 * 把辩手发言拆成论点列表（展示层纯函数，不改数据契约）。
 * 识别 markdown 标题、有序 / 无序列表、空行分段；单段则整段为一个论点。
 * 首块若明显是开场白/引导语则剔除；过滤后为空则回退保留原块。
 */
export function parseSpeechArguments(text: string): SpeechArgument[] {
  const blocks = splitBlocks(text);
  if (blocks.length === 0) return [];

  const usable =
    blocks.length > 0 && isOpeningPreamble(blocks[0])
      ? blocks.slice(1)
      : blocks;
  const source = usable.length > 0 ? usable : blocks;

  return source.map((block, i) => blockToArgument(block, i));
}
