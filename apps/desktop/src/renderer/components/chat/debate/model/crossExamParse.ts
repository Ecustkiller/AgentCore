/** 质询作答 blob → 逐条 Q↔A 解析。
 *
 * ## 数据路径（权威 → 降级）
 *
 * 1. **结构化（权威）**：`cross_exam[].exchanges[]` 含 `{ question, answer, ok }`——由后端
 *    `parse_cross_exam_response` 在质询 run 完成时产出，经 `debate_round` / `debate_result` 下发。
 *    前端 `projection.ts` 的 `resolveCrossExam` 直接消费，**不经本模块**。
 *
 * 2. **作答 blob 解析（本模块）**：仅在以下场景调用 `parseCrossExamResponse`：
 *    - **live 流式**：质询 run 进行中、`debate_round.cross_exam` 尚未到达，从 `_cx_` run 的
 *      `outputChunks` + `run_context` 问题列表重建（`liveCrossExamPayload`）。
 *    - **旧产物兼容**：`cross_exam` 仍带顶层 `questions[]` 而无 `exchanges[]`（渐进式契约扩展，
 *      已无新产物产出此形态）。
 *
 * 解析策略与后端 `cross_exam_parse.py` 对齐：JSON 数组优先 → 启发式 blob 切分降级。
 *
 * ## 删除条件（TODO）
 *
 * - `buildCrossExamExchanges`（启发式）：后端对 live 流式下发增量 `debate_round.cross_exam`
 *   且历史 turn 无 `questions`-only 产物后可删。
 * - 整个模块：live 与收场均只消费结构化 `exchanges[]` 时可删。 */

export interface CrossExamQaView {
  question: string;
  answer: string;
  ok: boolean;
}

const JSON_ARRAY_FENCE_RE = /```(?:json)?\s*(\[.*?\])\s*```/s;

/** 从辩手质询作答构造与 `questions` 等长的逐条交换（JSON 优先，与后端同策）。 */
export function parseCrossExamResponse(
  questions: readonly string[],
  content: string,
  overallOk = true,
): CrossExamQaView[] {
  const qs = questions.map((q) => q.trim()).filter(Boolean);
  if (qs.length === 0) return [];

  const items = extractJsonArray(content);
  if (items !== null) {
    return exchangesFromJsonItems(qs, items);
  }

  return buildCrossExamExchanges(qs, content, overallOk);
}

/** @deprecated 启发式 blob 切分——仅作 JSON 解析失败时的降级，勿直接调用。 */
export function buildCrossExamExchanges(
  questions: readonly string[],
  answer: string,
  overallOk = true,
): CrossExamQaView[] {
  const qs = questions.map((q) => q.trim()).filter(Boolean);
  if (qs.length === 0) return [];
  const text = answer.trim();
  if (!text) {
    return qs.map((question) => ({ question, answer: "", ok: false }));
  }

  const sections = splitSections(text);
  if (sections.length === qs.length) {
    return qs.map((question, i) => ({
      question,
      answer: sections[i] ?? "",
      ok: qaOk(sections[i] ?? "", overallOk),
    }));
  }
  if (sections.length > 1) {
    const padded =
      sections.length >= qs.length
        ? sections.slice(0, qs.length)
        : [...sections, ...Array(qs.length - sections.length).fill("")];
    return qs.map((question, i) => ({
      question,
      answer: padded[i] ?? "",
      ok: qaOk(padded[i] ?? "", overallOk),
    }));
  }
  if (qs.length === 1) {
    return [{ question: qs[0], answer: text, ok: qaOk(text, overallOk) }];
  }
  const parts = splitBySemicolon(text, qs.length);
  return qs.map((question, i) => ({
    question,
    answer: parts[i] ?? "",
    ok: qaOk(parts[i] ?? "", overallOk),
  }));
}

const SECTION_RE =
  /(?:^|\n)\s*(?:质询[一二三四五六七八九十\d]+|[Qq]\s*\d+|\d+[.、)])\s*[:：.]?\s*/gm;

function extractJsonArray(content: string): unknown[] | null {
  const text = (content ?? "").trim();
  if (!text) return null;

  const fence = JSON_ARRAY_FENCE_RE.exec(text);
  let jsonText: string;
  if (fence) {
    jsonText = fence[1].trim();
  } else {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return null;
    jsonText = text.slice(start, end + 1);
  }

  try {
    const data: unknown = JSON.parse(jsonText);
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

function exchangesFromJsonItems(
  questions: readonly string[],
  items: readonly unknown[],
): CrossExamQaView[] {
  const out: CrossExamQaView[] = questions.map((question) => ({
    question,
    answer: "",
    ok: false,
  }));
  items.forEach((raw, pos) => {
    if (typeof raw !== "object" || raw === null) return;
    const item = raw as Record<string, unknown>;
    const idx = resolveQuestionIndex(item.question_index, pos);
    if (idx === null || idx < 0 || idx >= out.length) return;
    const answer = asAnswerText(item.answer);
    const ok = resolveDirectlyAddressed(item, answer);
    out[idx] = { question: questions[idx], answer, ok };
  });
  return out;
}

function resolveQuestionIndex(value: unknown, position: number): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n >= 1 ? n - 1 : n;
  }
  if (typeof value === "string" && value.trim().length > 0 && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n >= 1 ? n - 1 : n;
  }
  return position;
}

function asAnswerText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  return String(value).trim();
}

function resolveDirectlyAddressed(item: Record<string, unknown>, answer: string): boolean {
  for (const key of ["directly_addressed", "ok"] as const) {
    const val = item[key];
    if (typeof val === "boolean") return val;
  }
  return Boolean(answer.trim());
}

function splitSections(text: string): string[] {
  const matches = [...text.matchAll(SECTION_RE)];
  if (matches.length < 2) return [];
  const sections: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end =
      i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const chunk = text.slice(start, end).trim();
    if (chunk) sections.push(chunk);
  }
  return sections;
}

function splitBySemicolon(text: string, n: number): string[] {
  const chunks = text
    .split(/[；;]\s*/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length >= n) return chunks.slice(0, n);
  if (chunks.length === 1 && n > 1) return [chunks[0], ...Array(n - 1).fill("")];
  return [...chunks, ...Array(Math.max(0, n - chunks.length)).fill("")];
}

function qaOk(answer: string, overallOk: boolean): boolean {
  if (!answer.trim()) return false;
  return overallOk;
}
