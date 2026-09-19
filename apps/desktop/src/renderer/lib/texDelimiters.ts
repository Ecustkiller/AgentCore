/**
 * LLM math delimiters → remark-math dollars.
 *
 * Chat Markdown is remark-math (only `$` / `$$`). Claude-class models emit
 * `\(...\)` / `\[...\]`; converting at render time keeps those formulas in the
 * bubble without teaching delimiter dialect in the system prompt.
 *
 * Skips fenced / inline code so a snippet of `\(` stays literal.
 */

export type TexMathSpan = {
  from: number;
  to: number;
  tex: string;
  display: boolean;
};

function isEscaped(source: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && source[k] === "\\"; k--) n++;
  return n % 2 === 1;
}

function atLineStart(source: string, i: number): boolean {
  return i === 0 || source[i - 1] === "\n";
}

function fenceMarkerAt(
  source: string,
  i: number,
): { char: "`" | "~"; len: number } | null {
  let j = i;
  let spaces = 0;
  while (spaces < 4 && source[j] === " ") {
    j++;
    spaces++;
  }
  const ch = source[j];
  if (ch !== "`" && ch !== "~") return null;
  let len = 0;
  while (source[j + len] === ch) len++;
  if (len < 3) return null;
  return { char: ch, len };
}

/** End index after a matching inline-code span; -1 if this backtick is not a fence. */
function skipInlineCode(source: string, i: number): number {
  const n = source.length;
  let len = 0;
  while (i + len < n && source[i + len] === "`") len++;
  if (len === 0) return -1;
  let j = i + len;
  while (j < n) {
    if (source[j] === "`") {
      let k = 0;
      while (j + k < n && source[j + k] === "`") k++;
      if (k === len) return j + k;
      j += k;
      continue;
    }
    if (source[j] === "\n") return -1;
    j++;
  }
  return -1;
}

function findClose(
  source: string,
  from: number,
  close: "\\)" | "\\]",
): number {
  const n = source.length;
  let j = from;
  while (j < n) {
    if (atLineStart(source, j) && fenceMarkerAt(source, j)) return -1;
    if (source.startsWith(close, j) && !isEscaped(source, j)) return j;
    j++;
  }
  return -1;
}

export function findTexMathSpans(source: string): TexMathSpan[] {
  const spans: TexMathSpan[] = [];
  const n = source.length;
  let i = 0;
  let fence: { char: "`" | "~"; len: number } | null = null;

  while (i < n) {
    if (atLineStart(source, i)) {
      const marker = fenceMarkerAt(source, i);
      if (marker) {
        if (!fence) {
          fence = marker;
        } else if (marker.char === fence.char && marker.len >= fence.len) {
          fence = null;
        }
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? n : nl + 1;
        continue;
      }
    }
    if (fence) {
      i++;
      continue;
    }

    if (source[i] === "`") {
      const end = skipInlineCode(source, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }

    if (source[i] === "\\" && !isEscaped(source, i)) {
      const next = source[i + 1];
      if (next === "(" || next === "[") {
        const display = next === "[";
        const close = display ? "\\]" : "\\)";
        const closeAt = findClose(source, i + 2, close);
        if (closeAt !== -1) {
          const tex = source.slice(i + 2, closeAt);
          if (tex.trim()) {
            spans.push({
              from: i,
              to: closeAt + 2,
              tex,
              display: display || tex.includes("\n"),
            });
            i = closeAt + 2;
            continue;
          }
        }
      }
    }

    i++;
  }
  return spans;
}

/** Rewrite `\(`/`\[` into `$` / `$$` for remark-math. Idempotent on dollar math. */
export function texDelimitersToDollars(source: string): string {
  const spans = findTexMathSpans(source);
  if (spans.length === 0) return source;
  let out = "";
  let i = 0;
  for (const span of spans) {
    out += source.slice(i, span.from);
    if (span.display) {
      out += `$$${span.tex}$$`;
    } else {
      out += `$${span.tex.trim()}$`;
    }
    i = span.to;
  }
  out += source.slice(i);
  return out;
}
