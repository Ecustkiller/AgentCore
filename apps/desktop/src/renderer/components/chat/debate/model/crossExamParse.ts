/** 质询作答 blob → 逐条 Q↔A 解析（JSON 数组，与后端 `cross_exam_parse.py` 对齐）。
 *
 * 权威路径是结构化 ``cross_exam[].exchanges[]``（收场后由后端解析下发）；本模块仅在 live
 * 流式阶段、从 ``_cx_`` run 的 ``outputChunks`` 重建作答时调用。dict 项按 ``question_index``；
 * 标量字符串/数字数组按位置映射。非 JSON 作答在结构化事件到达前保持空 answer。 */

export interface CrossExamQaView {
  question: string;
  answer: string;
  ok: boolean;
}

const JSON_ARRAY_FENCE_RE = /```(?:json)?\s*(\[.*?\])\s*```/s;

/** 从辩手质询作答构造与 `questions` 等长的逐条交换。 */
export function parseCrossExamResponse(
  questions: readonly string[],
  content: string,
): CrossExamQaView[] {
  const qs = questions.map((q) => q.trim()).filter(Boolean);
  if (qs.length === 0) return [];

  const items = extractJsonArray(content);
  if (items !== null) {
    return exchangesFromJsonItems(qs, items);
  }

  return qs.map((question) => ({ question, answer: "", ok: false }));
}

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
    // dict 项：按 question_index / 位置取 answer
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const item = raw as Record<string, unknown>;
      const idx = resolveQuestionIndex(item.question_index, pos);
      if (idx === null || idx < 0 || idx >= out.length) return;
      const answer = asAnswerText(item.answer);
      const ok = resolveDirectlyAddressed(item, answer);
      out[idx] = { question: questions[idx], answer, ok };
      return;
    }
    // 标量数组：按位置映射为 answer（兼容少包一层 wrapper 的 ["答一","答二"]）
    if (pos >= out.length) return;
    if (typeof raw !== "string" && typeof raw !== "number") return;
    const answer = asAnswerText(raw);
    out[pos] = {
      question: questions[pos],
      answer,
      ok: Boolean(answer.trim()),
    };
  });
  return out;
}

function resolveQuestionIndex(value: unknown, position: number): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n >= 1 ? n - 1 : n;
  }
  if (
    typeof value === "string" &&
    value.trim().length > 0 &&
    /^\d+$/.test(value.trim())
  ) {
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

function resolveDirectlyAddressed(
  item: Record<string, unknown>,
  answer: string,
): boolean {
  for (const key of ["directly_addressed", "ok"] as const) {
    const val = item[key];
    if (typeof val === "boolean") return val;
  }
  return Boolean(answer.trim());
}
