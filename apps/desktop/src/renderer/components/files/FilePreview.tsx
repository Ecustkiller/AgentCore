import { formatBytes } from "@/lib/format";
import { useFilesStore } from "@/stores/files";
import type {
  FsResult,
  FilePreview as PreviewData,
} from "@shared/ipc-contract";
import { AlertCircle, FileText, ImageOff, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: FsResult<PreviewData> };

export function FilePreview() {
  const selected = useFilesStore((s) => s.selected);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (!selected) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    window.fsApi
      .readFile(selected.rootId, selected.relPath)
      .then((result) => {
        if (!cancelled) setState({ status: "done", result });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            status: "done",
            result: { ok: false, reason: String(e) },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (!selected) {
    return (
      <Centered>
        <FileText size={28} className="text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">选择文件以预览</p>
      </Centered>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <span className="truncate text-sm font-medium text-foreground">
          {selected.name}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" && (
          <Centered>
            <Loader2 size={22} className="animate-spin text-muted-foreground" />
          </Centered>
        )}
        {state.status === "done" &&
          (state.result.ok ? (
            <PreviewBody data={state.result.data} name={selected.name} />
          ) : (
            <Centered>
              <AlertCircle size={26} className="text-destructive/70" />
              <p className="text-sm text-muted-foreground">
                {state.result.reason}
              </p>
            </Centered>
          ))}
      </div>
    </div>
  );
}

function PreviewBody({ data, name }: { data: PreviewData; name: string }) {
  if (data.kind === "text") {
    return (
      <div className="flex h-full flex-col">
        {data.truncated && (
          <div className="shrink-0 bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
            内容较大，仅显示前 256KB
          </div>
        )}
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
          {data.content}
        </pre>
      </div>
    );
  }

  if (data.kind === "image") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img
            src={data.dataUrl}
            alt={name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
        <div className="shrink-0 border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
          {data.mime} · {formatBytes(data.size)}
        </div>
      </div>
    );
  }

  return (
    <Centered>
      <ImageOff size={26} className="text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">{data.reason}</p>
      <p className="text-xs text-muted-foreground/70">
        {data.mime} · {formatBytes(data.size)}
      </p>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      {children}
    </div>
  );
}
