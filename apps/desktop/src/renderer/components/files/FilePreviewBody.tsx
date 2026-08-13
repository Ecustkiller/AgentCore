import { Button, IconButton } from "@/components/ui";
import type { FilePreviewResult } from "@/lib/fileSource";
import { formatBytes } from "@/lib/format";
import { Download, ExternalLink, FileText, Minus, Plus, X } from "lucide-react";
import { type WheelEvent, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

function clampZoom(n: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100));
}

/**
 * Shared body renderer for a {@link FilePreviewResult} — the source-agnostic
 * inner view used by both file UIs (文件中枢统一). Renders text (with an optional
 * truncation banner), an inline image (zoom + lightbox), PDF iframe, or a
 * non-previewable fallback (binary / too-large). Surrounding chrome (header,
 * download / edit actions) belongs to the caller; this draws content only.
 *
 * 例外是 binary / too-large 的兜底面：那儿「请下载或用系统默认程序打开」是**唯一**出路，
 * 只写一句话等于让用户自己去找头部图标。调用方把两个出口（同一套能力门控，缺哪个就少
 * 哪个按钮）传进来，兜底面直接给可点的主按钮。
 */
export function FilePreviewBody({
  result,
  name,
  onOpenWithOsDefaultApp,
  onDownload,
}: {
  result: FilePreviewResult;
  name: string;
  onOpenWithOsDefaultApp?: () => void;
  onDownload?: () => void;
}) {
  if (result.kind === "text") {
    return (
      <div className="flex h-full flex-col">
        {result.truncated && (
          <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
            内容较大，仅显示前一部分，完整内容请下载查看。
          </div>
        )}
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
          {result.text}
        </pre>
      </div>
    );
  }

  if (result.kind === "image") {
    return (
      <ImagePreviewBody
        dataUrl={result.dataUrl}
        mime={result.mime}
        size={result.size}
        name={name}
      />
    );
  }

  if (result.kind === "pdf") {
    return (
      <div className="flex h-full flex-col">
        <iframe
          src={result.dataUrl}
          title={name}
          className="min-h-0 flex-1 w-full border-0 bg-muted/20"
        />
        <div className="shrink-0 border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
          {result.mime} · {formatBytes(result.size)}
        </div>
      </div>
    );
  }

  // binary | too-large — not previewable inline.
  const meta =
    result.kind === "binary" && result.mime
      ? `${result.mime}${result.size != null ? ` · ${formatBytes(result.size)}` : ""}`
      : null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <FileText size={26} className="text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">
        {result.kind === "too-large" ? "文件过大" : "无法预览此文件"}
      </p>
      <p className="text-xs text-muted-foreground/70">
        {result.kind === "too-large"
          ? "文件过大，不在面板内预览，请下载或用系统默认程序打开。"
          : (result.reason ?? "无法在面板内预览，请下载或用系统默认程序打开。")}
      </p>
      {(onOpenWithOsDefaultApp || onDownload) && (
        <div className="mt-1 flex items-center gap-2">
          {onOpenWithOsDefaultApp && (
            <Button
              onClick={onOpenWithOsDefaultApp}
              icon={<ExternalLink size={13} />}
            >
              用默认程序打开
            </Button>
          )}
          {onDownload && (
            <Button
              variant={onOpenWithOsDefaultApp ? "neutral" : "primary"}
              onClick={onDownload}
              icon={<Download size={13} />}
            >
              下载
            </Button>
          )}
        </div>
      )}
      {meta && <p className="text-xs text-muted-foreground/60">{meta}</p>}
    </div>
  );
}

function ImagePreviewBody({
  dataUrl,
  mime,
  size,
  name,
}: {
  dataUrl: string;
  mime: string;
  size: number;
  name: string;
}) {
  const [scale, setScale] = useState(1);
  const [lightbox, setLightbox] = useState(false);

  const zoomBy = useCallback((delta: number) => {
    setScale((s) => clampZoom(s + delta));
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    },
    [zoomBy],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
          onWheel={onWheel}
        >
          <button
            type="button"
            className="cursor-zoom-in border-0 bg-transparent p-0"
            onClick={() => setLightbox(true)}
            aria-label={`放大预览 ${name}`}
          >
            <img
              src={dataUrl}
              alt={name}
              className="max-h-full max-w-full object-contain transition-transform"
              style={{
                transform: `scale(${scale})`,
                transformOrigin: "center",
              }}
              draggable={false}
            />
          </button>
        </div>
        <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-border bg-card/90 p-1 shadow-sm backdrop-blur">
          <IconButton
            onClick={() => zoomBy(ZOOM_STEP)}
            aria-label="放大"
            title="放大"
          >
            <Plus size={14} />
          </IconButton>
          <span className="min-w-10 px-1 text-center text-xs text-muted-foreground tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <IconButton
            onClick={() => zoomBy(-ZOOM_STEP)}
            aria-label="缩小"
            title="缩小"
          >
            <Minus size={14} />
          </IconButton>
        </div>
      </div>
      <div className="shrink-0 border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
        {mime} · {formatBytes(size)}
      </div>
      {lightbox && (
        <ImageLightbox
          dataUrl={dataUrl}
          name={name}
          onClose={() => setLightbox(false)}
        />
      )}
    </div>
  );
}

function ImageLightbox({
  dataUrl,
  name,
  onClose,
}: {
  dataUrl: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    // biome-ignore lint/a11y/useSemanticElements: lightweight image lightbox — role="dialog" + Esc/backdrop close; native <dialog> would add modal/form semantics we don't need.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name || "图片"}
      className="fixed inset-0 z-50 flex flex-col bg-background/95"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-border border-b px-4">
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {name}
        </span>
        <IconButton onClick={onClose} aria-label="关闭" title="关闭">
          <X size={16} />
        </IconButton>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="flex min-h-0 flex-1 cursor-zoom-out items-center justify-center overflow-auto p-6"
        aria-label="关闭"
      >
        <img
          src={dataUrl}
          alt={name}
          className="max-h-full max-w-full object-contain"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </button>
    </div>,
    document.body,
  );
}
