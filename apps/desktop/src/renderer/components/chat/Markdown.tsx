import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeBlock } from "./CodeBlock";

// Stable references so ReactMarkdown doesn't re-init plugins on every keystroke
// of the streaming content.
const remarkPlugins = [remarkGfm, remarkMath];
// `ignoreMissing` keeps an unknown ```lang from throwing mid-stream.
const rehypePlugins = [[rehypeHighlight, { ignoreMissing: true }], rehypeKatex];
const components: Components = { pre: CodeBlock };

/**
 * Assistant-message Markdown: GFM (tables/strikethrough/task lists), syntax
 * highlighting with a per-block copy button, and KaTeX math ($…$ / $$…$$).
 */
export const Markdown = memo(function Markdown({
  content,
}: { content: string }) {
  return (
    <div className="markdown-body text-foreground">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        // biome-ignore lint/suspicious/noExplicitAny: plugin tuple typing is loose across unified versions.
        rehypePlugins={rehypePlugins as any}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
