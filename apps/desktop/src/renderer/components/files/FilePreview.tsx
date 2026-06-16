import { FilePreviewBody } from "@/components/files/FilePreviewBody";
import type { FilePreviewResult, FileSource } from "@/lib/fileSource";
import { AlertCircle, FileText, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; result: FilePreviewResult }
  | { status: "error"; reason: string };

/**
 * Source-agnostic file preview pane for the file hub: reads the selected file
 * through whichever {@link FileSource} the active project exposes (cloud REST or
 * local IPC) and renders it via the shared {@link FilePreviewBody}. The parent
 * memoizes `source` per project and `file` per click so this read effect fires
 * only on a real selection change.
 */
export function FilePreview({
  source,
  file,
}: {
  source: FileSource | null;
  file: { path: string; name: string } | null;
}) {
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (!source || !file) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    source
      .read(file.path)
      .then((result) => {
        if (!cancelled) setState({ status: "ok", result });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, file]);

  if (!source || !file) {
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
          {file.name}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" && (
          <Centered>
            <Loader2 size={22} className="animate-spin text-muted-foreground" />
          </Centered>
        )}
        {state.status === "ok" && (
          <FilePreviewBody result={state.result} name={file.name} />
        )}
        {state.status === "error" && (
          <Centered>
            <AlertCircle size={26} className="text-destructive/70" />
            <p className="text-sm text-muted-foreground">{state.reason}</p>
          </Centered>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      {children}
    </div>
  );
}
