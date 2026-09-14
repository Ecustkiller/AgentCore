/** Markdown body for the creation-tool 文档 (mirrors server `agentcore.doc.body`). */

export const MAX_MARKDOWN_CHARS = 50_000;

export type DocBody = {
  markdown: string;
};

export function emptyDocBody(): DocBody {
  return { markdown: "" };
}

export function parseDocBody(raw: unknown): DocBody {
  if (typeof raw === "string") {
    return { markdown: clipMarkdown(raw) };
  }
  if (!raw || typeof raw !== "object") return emptyDocBody();
  const src = raw as { markdown?: unknown };
  if (typeof src.markdown !== "string") return emptyDocBody();
  return { markdown: clipMarkdown(src.markdown) };
}

function clipMarkdown(value: string): string {
  const text = value.replace(/\0/g, "");
  if (text.length <= MAX_MARKDOWN_CHARS) return text;
  return text.slice(0, MAX_MARKDOWN_CHARS);
}
