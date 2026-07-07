/** 论点标题 / 摘要截断上限（展示层）。 */
export const ARGUMENT_TITLE_MAX = 30;
export const TEXT_SUMMARY_MAX = 80;

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
 * 把辩手发言拆成论点列表（展示层纯函数，不改数据契约）。
 * 识别 markdown 标题、有序 / 无序列表、空行分段；单段则整段为一个论点。
 */
export function parseSpeechArguments(text: string): SpeechArgument[] {
  const blocks = splitBlocks(text);
  if (blocks.length === 0) return [];

  return blocks.map((block, i) => {
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
  });
}

/** 一方核心立场摘要：首个论点标题，否则全文摘要。 */
export function sidePositionSummary(
  output: string,
  maxLen = TEXT_SUMMARY_MAX,
): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  const args = parseSpeechArguments(trimmed);
  const raw = args.length > 0 && args[0].title ? args[0].title : trimmed;
  return summarizeText(raw, maxLen);
}
