// Lazy mermaid renderer for the mobile Markdown stack (前端技术与架构 §七 · 富渲染).
//
// mermaid is heavy (~500KB), so it is dynamically imported only when a ```mermaid block
// actually appears — it never lands in the main bundle (the "minimal deps / lazy mermaid"
// decision). On a render error we fall back to the raw source as a code block.
import { inlineMermaidWidthPx } from "@/lib/inlineMermaidWidth";
import { normalizeMermaidSource } from "@/lib/mermaidNormalize";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Initialize once, module-wide (re-init on every render would reset config + leak work).
let mermaidMod: typeof import("mermaid").default | null = null;
async function getMermaid() {
  if (!mermaidMod) {
    const mod = (await import("mermaid")).default;
    mod.initialize({
      startOnLoad: false,
      theme: "neutral", // light only — 手机端暂不做暗色
      securityLevel: "strict",
    });
    mermaidMod = mod;
  }
  return mermaidMod;
}

function readMermaidNativeWidth(svg: string): number {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const el = doc.documentElement;
    if (!el || el.tagName.toLowerCase() !== "svg") return 0;
    const maxW = /max-width:\s*([\d.]+)px/i.exec(
      el.getAttribute("style") ?? "",
    );
    if (maxW) {
      const n = Number.parseFloat(maxW[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const attr = el.getAttribute("width");
    if (attr && !attr.includes("%")) {
      const n = Number.parseFloat(attr);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const vb = el
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (vb && vb.length === 4 && vb[2] > 0) return vb[2];
  } catch {
    /* ignore */
  }
  return 0;
}

function MermaidInline({ svg }: { svg: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const nativeW = readMermaidNativeWidth(svg);
  const [widthPx, setWidthPx] = useState(() =>
    nativeW > 0 ? inlineMermaidWidthPx(nativeW, 0) : undefined,
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const apply = () => {
      const w = inlineMermaidWidthPx(nativeW, host.clientWidth);
      if (w > 0) setWidthPx(w);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    return () => ro.disconnect();
  }, [nativeW]);

  return (
    <div className="mermaid-wrap">
      <div ref={hostRef} className="mermaid-inline-host">
        <div
          className="mermaid-inline"
          style={widthPx ? { width: widthPx } : undefined}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, sanitized mermaid SVG
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // A unique, DOM-id-safe render target per instance.
  const idRef = useRef(`m${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    const normalized = normalizeMermaidSource(chart);
    getMermaid()
      .then((m) =>
        m.parse(normalized).then(() => m.render(idRef.current, normalized)),
      )
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (failed) return <pre className="tool-pre">{chart}</pre>;
  if (!svg) return <div className="mermaid-wrap muted">绘制图表中…</div>;
  return <MermaidInline svg={svg} />;
}
