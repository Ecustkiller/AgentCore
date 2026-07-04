/**
 * Heuristic flags on review / QC worker output (简介流水线等).
 * Phase-1 of 中间可见性: surface low scores & direction issues on graph nodes
 * without waiting for structured `contract` (P1).
 */
export type ReviewConcernLevel = "warning" | "critical";

const DIRECTION_PATTERNS = [
  /方向(?:不对|偏|问题|有误)/,
  /整体方向/,
  /建议(?:叫停|重写|推翻)/,
  /致命/,
  /根本性/,
];

const SCORE_RE = /(\d{1,2})\s*\/\s*10/g;

export function detectReviewConcern(
  text: string,
): ReviewConcernLevel | null {
  const trimmed = text.trim();
  if (trimmed.length < 12) return null;

  for (const re of DIRECTION_PATTERNS) {
    if (re.test(trimmed)) return "critical";
  }

  let match: RegExpExecArray | null;
  SCORE_RE.lastIndex = 0;
  while ((match = SCORE_RE.exec(trimmed)) !== null) {
    const score = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(score) && score <= 5) return "critical";
    if (Number.isFinite(score) && score <= 7) return "warning";
  }

  return null;
}
